// Metrics — per-pass record + JSONL writer.
//
// What's actually measurable from a Swift iOS app (see report.md §3 for the full
// survey). Short version of what's in / out:
//
//   * ProcessInfo.thermalState: discrete 4-state enum (nominal/fair/serious/critical).
//     No documented update frequency; lags reality by tens of seconds in practice.
//     We poll at every pass *and* subscribe to thermalStateDidChangeNotification.
//   * UIDevice.batteryLevel: 0.0–1.0, 5% granularity on iOS 17+ (anti-fingerprinting).
//     Requires UIDevice.current.isBatteryMonitoringEnabled = true.
//   * os_proc_available_memory(): uint64_t bytes, iOS 13+, accurate.
//   * Wall-clock latency: CFAbsoluteTimeGetCurrent / DispatchTime.
//
// NOT available without Instruments / private API:
//   * Per-component CPU/GPU/NPU utilization. No public API. Instruments only.
//   * Chassis temperature in degrees. ProcessInfo gives a state, not a number.
//   * Time-on-NPU vs CPU for a Foundation Models call. Not exposed.
//   * Tokens/sec for FM. Not exposed; we measure wall-clock latency to fixed-shape output.
//
// References:
//   developer.apple.com/documentation/foundation/processinfo/thermalstate
//   developer.apple.com/documentation/uikit/uidevice/batterylevel
//   developer.apple.com/documentation/os/os_proc_available_memory

import Foundation
import UIKit
import os

enum ThermalStateString: String, Codable {
	case nominal, fair, serious, critical, unknown

	init(_ s: ProcessInfo.ThermalState) {
		switch s {
		case .nominal: self = .nominal
		case .fair: self = .fair
		case .serious: self = .serious
		case .critical: self = .critical
		@unknown default: self = .unknown
		}
	}
}

struct PassRecord: Codable {
	let runId: String
	let runKind: String          // "idle" | "asr_only" | "full_llm"
	let passIndex: Int
	let timestampISO: String
	let elapsedSec: Double       // seconds since run start
	let latencyMs: Double?       // nil for idle/asr_only
	let outputValid: Bool?       // nil for idle/asr_only
	let outputBytes: Int?        // nil for idle/asr_only
	let thermalState: ThermalStateString
	let batteryLevel: Float      // 0.0–1.0, –1 if unknown
	let batteryStateRaw: Int     // UIDevice.BatteryState rawValue
	let availableMemoryBytes: UInt64
	let activeProcessorCount: Int
	let lowPowerModeEnabled: Bool
	let errorKind: String?       // populated on failure
}

@MainActor
final class MetricsRecorder {
	let runId: String
	let runKind: String
	let startedAt: Date
	let fileURL: URL
	private let handle: FileHandle
	private let encoder = JSONEncoder()
	private let isoFmt: ISO8601DateFormatter = {
		let f = ISO8601DateFormatter()
		f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		return f
	}()
	private let logger = Logger(subsystem: "app.aizuchi.thermalbench", category: "metrics")

	init(runKind: String) throws {
		self.runKind = runKind
		self.startedAt = Date()
		let id = "\(runKind)-\(Int(startedAt.timeIntervalSince1970))"
		self.runId = id
		let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
			.appendingPathComponent("thermalbench", isDirectory: true)
		try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		self.fileURL = dir.appendingPathComponent("\(id).jsonl")
		FileManager.default.createFile(atPath: fileURL.path, contents: nil)
		self.handle = try FileHandle(forWritingTo: fileURL)
		try handle.seekToEnd()
		// Make sure battery monitoring is on so we get a non -1 reading.
		UIDevice.current.isBatteryMonitoringEnabled = true
		logger.info("MetricsRecorder started run=\(id, privacy: .public) at \(self.fileURL.path, privacy: .public)")
	}

	deinit {
		try? handle.close()
	}

	func snapshot(
		passIndex: Int,
		latencyMs: Double?,
		outputValid: Bool?,
		outputBytes: Int?,
		errorKind: String?
	) -> PassRecord {
		let pi = ProcessInfo.processInfo
		let device = UIDevice.current
		return PassRecord(
			runId: runId,
			runKind: runKind,
			passIndex: passIndex,
			timestampISO: isoFmt.string(from: Date()),
			elapsedSec: Date().timeIntervalSince(startedAt),
			latencyMs: latencyMs,
			outputValid: outputValid,
			outputBytes: outputBytes,
			thermalState: ThermalStateString(pi.thermalState),
			batteryLevel: device.batteryLevel,
			batteryStateRaw: device.batteryState.rawValue,
			availableMemoryBytes: UInt64(os_proc_available_memory()),
			activeProcessorCount: pi.activeProcessorCount,
			lowPowerModeEnabled: pi.isLowPowerModeEnabled,
			errorKind: errorKind
		)
	}

	func write(_ record: PassRecord) {
		do {
			var data = try encoder.encode(record)
			data.append(0x0A) // newline -> JSONL
			handle.write(data)
		} catch {
			logger.error("encode failed: \(error.localizedDescription, privacy: .public)")
		}
	}

	/// Flush is best-effort. We also close on deinit; we sync here so an early
	/// AirDrop / share works even if the user backgrounds the app mid-run.
	func sync() {
		try? handle.synchronize()
	}
}
