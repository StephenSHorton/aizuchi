// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AizuchiAudioPlugin
//
// Owns the `AVAudioSession` + `AVAudioEngine` for the host app. Captures
// 16 kHz mono PCM from the input node and streams it back to Rust via
// the Tauri `Channel`. Survives screen-lock, phone calls, Siri, and
// AirPods route changes (provided the host app has `UIBackgroundModes:
// [audio]` and the `NSMicrophoneUsageDescription` privacy string).
//
// Reference structure: tauri-apps/plugins-workspace plugins/haptics.
//
// STATUS: skeleton (compile-checked structure, NOT device-verified).
// TODOs are marked `TODO(AIZ-57):` and gated to the work that still
// needs a physical iPhone.

import AVFoundation
import Foundation
import SwiftRs
import Tauri
import UIKit
import WebKit

// MARK: - Argument decoding

class StartCaptureArgs: Decodable {
    let sampleRate: UInt32?
    let channels: UInt16?
    let frameSamples: UInt32?
    let silenceGate: Bool?

    // Tauri passes the Channel as a token that the framework wires up to
    // a callable closure on the Swift side. `Channel` here is the type
    // provided by the `Tauri` Swift package; it deserializes from the
    // bridge automatically when declared as a property.
    let onEvent: Channel
}

class StopCaptureArgs: Decodable {
    let id: String
}

// MARK: - Plugin

class AizuchiAudioPlugin: Plugin {
    // MARK: State

    private let audioEngine = AVAudioEngine()
    private var captureID: String?
    private var eventChannel: Channel?
    private var startTime: TimeInterval = 0
    private var frameSeq: UInt64 = 0

    // Energy-threshold VAD state. Only used when `silenceGate == true`.
    private var silenceGate = false
    private var silenceThreshold: Float = 0.005

    // Output format we hand to Rust. We force a resample if the input
    // node doesn't already deliver 16 kHz mono.
    private let targetSampleRate: Double = 16_000
    private let targetChannels: AVAudioChannelCount = 1

    // MARK: Lifecycle

    @objc public override func load(webview: WKWebView) {
        // We *don't* activate the session here — only when capture
        // starts. Activating on `load` would force the red-mic indicator
        // before the user has even opened a meeting.
        registerSessionObservers()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: Permissions

    @objc public override func checkPermissions(_ invoke: Invoke) {
        let status: String
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: status = "granted"
            case .denied: status = "denied"
            case .undetermined: status = "prompt"
            @unknown default: status = "prompt"
            }
        } else {
            switch AVAudioSession.sharedInstance().recordPermission {
            case .granted: status = "granted"
            case .denied: status = "denied"
            case .undetermined: status = "prompt"
            @unknown default: status = "prompt"
            }
        }
        invoke.resolve(["microphone": status])
    }

    @objc public override func requestPermissions(_ invoke: Invoke) {
        let handler: (Bool) -> Void = { granted in
            invoke.resolve(["microphone": granted ? "granted" : "denied"])
        }
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: handler)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(handler)
        }
    }

    // MARK: Tauri commands

    @objc public func startCapture(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(StartCaptureArgs.self)

        guard captureID == nil else {
            invoke.reject("capture already running")
            return
        }

        self.silenceGate = args.silenceGate ?? false
        self.eventChannel = args.onEvent
        self.frameSeq = 0
        self.startTime = Date().timeIntervalSince1970

        do {
            try configureSession()
            try installTapAndStart(frameSamples: args.frameSamples ?? 1_600)
        } catch {
            invoke.reject("failed to start: \(error.localizedDescription)")
            return
        }

        let id = UUID().uuidString
        self.captureID = id
        invoke.resolve(["id": id])
    }

    @objc public func stopCapture(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(StopCaptureArgs.self)
        guard args.id == captureID else {
            invoke.reject("unknown capture id")
            return
        }
        tearDown()
        invoke.resolve()
    }

    // MARK: AVAudioSession setup

    private func configureSession() throws {
        let session = AVAudioSession.sharedInstance()

        // Category: `.playAndRecord` rather than `.record`. `.record`
        // alone *deactivates* other audio (e.g. the user listening to
        // Spotify), which is hostile for a meeting tool. `.playAndRecord
        // + .mixWithOthers` lets the user keep their music on.
        //
        // Mode: `.measurement`. Critical choice — see the spike report.
        // `.measurement` disables the iOS-applied input chain (AGC,
        // noise suppression, EQ) so what we hand whisper.cpp is the raw
        // microphone signal. `.voiceChat` would activate AEC tuned for
        // two-way calls (we don't have a playback signal to cancel).
        // `.spokenAudio` is for output-side speech playback (audiobooks)
        // and doesn't apply here.
        //
        // Options:
        // - `.mixWithOthers`  : don't kill the user's music.
        // - `.allowBluetooth` : let AirPods / BT headsets be the input.
        //   Note: `.allowBluetoothA2DP` is *output-only* (high-quality
        //   Bluetooth playback) — it does not enable BT mic input.
        try session.setCategory(
            .playAndRecord,
            mode: .measurement,
            options: [.mixWithOthers, .allowBluetooth, .defaultToSpeaker]
        )

        // Hint to the system that we'd like the engine to deliver close
        // to the target sample rate, reducing the resample cost in the
        // tap. iOS may ignore this depending on hardware.
        try session.setPreferredSampleRate(targetSampleRate)
        try session.setPreferredIOBufferDuration(0.02) // ~20 ms

        try session.setActive(true, options: [.notifyOthersOnDeactivation])
    }

    // MARK: Engine + tap

    private func installTapAndStart(frameSamples: UInt32) throws {
        let input = audioEngine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)

        // Target format we *emit* to Rust. 16 kHz mono Int16-equivalent
        // (we'll quantize floats from the tap to Int16 in the closure).
        guard
            let outputFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: targetSampleRate,
                channels: targetChannels,
                interleaved: false)
        else {
            throw NSError(
                domain: "AizuchiAudio", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "failed to build output format"])
        }

        // We use an explicit converter (rather than relying on the tap
        // doing automatic SRC) so we control quality and resample
        // latency. `AVAudioConverter` handles rate, channel, and format
        // changes.
        let converter = AVAudioConverter(from: inputFormat, to: outputFormat)

        // Tap buffer size: we ask the engine for a buffer big enough to
        // hold our target frame after resampling. The OS may give us
        // something different — we accumulate in a holding buffer
        // (TODO).
        let tapBufferSize: AVAudioFrameCount = AVAudioFrameCount(
            Double(frameSamples) * inputFormat.sampleRate / targetSampleRate
        )

        input.removeTap(onBus: 0) // belt-and-braces
        input.installTap(
            onBus: 0,
            bufferSize: tapBufferSize,
            format: inputFormat
        ) { [weak self] buffer, _ in
            guard let self = self else { return }
            self.handleTap(buffer: buffer, converter: converter, outputFormat: outputFormat)
        }

        audioEngine.prepare()
        try audioEngine.start()
    }

    private func handleTap(
        buffer: AVAudioPCMBuffer,
        converter: AVAudioConverter?,
        outputFormat: AVAudioFormat
    ) {
        // TODO(AIZ-57): real implementation needs to (1) accumulate
        // tap buffers into our exact 100 ms frame size, (2) run the
        // converter, (3) optionally apply VAD, (4) quantize Float32 ->
        // Int16, (5) send via channel. The skeleton below sketches the
        // call sites but does not handle accumulation or quantization.

        // Resample to our target format.
        guard let converter = converter,
              let convertedBuffer = AVAudioPCMBuffer(
                pcmFormat: outputFormat,
                frameCapacity: AVAudioFrameCount(targetSampleRate * 0.2))
        else { return }

        var error: NSError?
        var consumed = false
        converter.convert(to: convertedBuffer, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if let error = error {
            log("converter error: \(error.localizedDescription)")
            return
        }

        // VAD: simple peak-energy gate. Only used when silenceGate is on.
        if silenceGate, let channelData = convertedBuffer.floatChannelData {
            let count = Int(convertedBuffer.frameLength)
            var peak: Float = 0
            for i in 0..<count {
                let s = abs(channelData[0][i])
                if s > peak { peak = s }
            }
            if peak < silenceThreshold {
                return  // skip — this frame is silence
            }
        }

        // Quantize Float32 -> Int16. TODO(AIZ-57): vectorize via Accelerate.
        var samples: [Int16] = []
        if let channelData = convertedBuffer.floatChannelData {
            let count = Int(convertedBuffer.frameLength)
            samples.reserveCapacity(count)
            for i in 0..<count {
                let s = channelData[0][i]
                let clamped = max(-1.0, min(1.0, s))
                samples.append(Int16(clamped * Float(Int16.max)))
            }
        }

        let elapsedMs = UInt64((Date().timeIntervalSince1970 - startTime) * 1000)
        frameSeq += 1

        eventChannel?.send([
            "kind": "frame",
            "seq": frameSeq,
            "timestampMs": elapsedMs,
            "sampleRate": UInt32(targetSampleRate),
            "channels": targetChannels,
            "samples": samples,
        ])
    }

    private func tearDown() {
        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        captureID = nil
        eventChannel = nil
    }

    // MARK: Interruption + route change

    private func registerSessionObservers() {
        let nc = NotificationCenter.default
        nc.addObserver(
            self, selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance())
        nc.addObserver(
            self, selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance())
        nc.addObserver(
            self, selector: #selector(handleMediaServicesReset(_:)),
            name: AVAudioSession.mediaServicesWereResetNotification,
            object: AVAudioSession.sharedInstance())
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
            let typeRaw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: typeRaw)
        else { return }

        switch type {
        case .began:
            // Phone call / Siri took over. Engine will be paused by the
            // system. Notify Rust so meeting state can mark a gap.
            eventChannel?.send([
                "kind": "interruption",
                "began": true,
            ])
        case .ended:
            var shouldResume = false
            if let optsRaw = info[AVAudioSessionInterruptionOptionsKey] as? UInt {
                let opts = AVAudioSession.InterruptionOptions(rawValue: optsRaw)
                shouldResume = opts.contains(.shouldResume)
            }
            if shouldResume {
                do {
                    try AVAudioSession.sharedInstance().setActive(
                        true, options: [.notifyOthersOnDeactivation])
                    try audioEngine.start()
                } catch {
                    log("resume failed after interruption: \(error.localizedDescription)")
                    eventChannel?.send([
                        "kind": "error",
                        "message": "failed to resume after interruption: \(error.localizedDescription)",
                    ])
                    return
                }
            }
            eventChannel?.send([
                "kind": "interruption",
                "began": false,
                "shouldResume": shouldResume,
            ])
        @unknown default:
            break
        }
    }

    @objc private func handleRouteChange(_ notification: Notification) {
        guard let info = notification.userInfo,
            let reasonRaw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
            let reason = AVAudioSession.RouteChangeReason(rawValue: reasonRaw)
        else { return }

        let reasonName: String
        switch reason {
        case .newDeviceAvailable: reasonName = "newDeviceAvailable"
        case .oldDeviceUnavailable: reasonName = "oldDeviceUnavailable"
        case .categoryChange: reasonName = "categoryChange"
        case .override: reasonName = "override"
        case .wakeFromSleep: reasonName = "wakeFromSleep"
        case .noSuitableRouteForCategory: reasonName = "noSuitableRouteForCategory"
        case .routeConfigurationChange: reasonName = "routeConfigurationChange"
        case .unknown: reasonName = "unknown"
        @unknown default: reasonName = "unknown"
        }

        let newInput = AVAudioSession.sharedInstance()
            .currentRoute.inputs.first?.portName

        // For old-device-unavailable (AirPods yanked out of ears) iOS
        // pauses the engine. We need to restart it pointing at the new
        // default input — typically built-in mic. TODO(AIZ-57): verify
        // on device; the engine restart is subtle because the inputNode
        // format may have changed and the tap is now bound to a stale
        // format.
        if reason == .oldDeviceUnavailable {
            do {
                if audioEngine.isRunning { audioEngine.stop() }
                audioEngine.inputNode.removeTap(onBus: 0)
                // Re-install tap with whatever the new input gives us.
                // This will only work if `captureID != nil` (capture is
                // still active).
                if captureID != nil {
                    try installTapAndStart(frameSamples: 1_600)
                }
            } catch {
                log("route-change restart failed: \(error.localizedDescription)")
                eventChannel?.send([
                    "kind": "error",
                    "message": "failed to restart engine after route change: \(error.localizedDescription)",
                ])
            }
        }

        eventChannel?.send([
            "kind": "routeChange",
            "reason": reasonName,
            "newInput": newInput ?? NSNull(),
        ])
    }

    @objc private func handleMediaServicesReset(_ notification: Notification) {
        // mediaserverd died. Engine is invalid; the entire session has
        // to be rebuilt. This is rare but documented — see "Responding
        // to a Media Server Shutdown" in AVFoundation.
        // TODO(AIZ-57): full rebuild — tear down + reconfigure +
        // re-install tap. For now we surface it to Rust as a fatal
        // error and let the host decide.
        eventChannel?.send([
            "kind": "error",
            "message": "media services reset; capture must be restarted",
        ])
        tearDown()
    }

    // MARK: Helpers

    private func log(_ msg: String) {
        // The `Plugin` base class has its own log channel; this is a
        // placeholder. TODO(AIZ-57): use the Tauri logger.
        NSLog("[AizuchiAudio] %@", msg)
    }
}

// MARK: - C entry point

@_cdecl("init_plugin_aizuchi_audio")
func initPlugin() -> Plugin {
    return AizuchiAudioPlugin()
}
