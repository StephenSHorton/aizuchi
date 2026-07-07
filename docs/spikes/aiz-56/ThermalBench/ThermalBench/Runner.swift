// Runner — drives one of three benches at the configured cadence and writes
// PassRecords to the active MetricsRecorder.
//
// The contract is intentionally narrow so this file can be replaced with
// AIZ-55's Runner once that lands. The only required surface is:
//
//   actor Runner {
//     init(kind: RunKind, cadenceSec: Double, durationSec: Double)
//     func start(metrics: MetricsRecorder, onProgress: @escaping (Progress) -> Void) async
//     func stop()
//   }
//
// Auto-stop: if ProcessInfo.thermalState == .critical we abort the run and
// flush; ditto if available memory drops below 50 MB.

import Foundation
import FoundationModels
import UIKit
import os

enum RunKind: String, CaseIterable, Identifiable, Codable {
	case idle = "idle"
	case asrOnly = "asr_only"
	case fullLLM = "full_llm"

	var id: String { rawValue }

	var label: String {
		switch self {
		case .idle: return "Idle baseline"
		case .asrOnly: return "ASR-only baseline (stub)"
		case .fullLLM: return "Full Aizuchi cadence (LLM)"
		}
	}
}

struct RunProgress {
	let passIndex: Int
	let totalPasses: Int
	let lastRecord: PassRecord?
	let aborted: Bool
	let abortReason: String?
}

actor Runner {
	let kind: RunKind
	let cadenceSec: Double
	let durationSec: Double
	private(set) var isRunning: Bool = false
	private var shouldStop: Bool = false
	private let logger = Logger(subsystem: "app.aizuchi.thermalbench", category: "runner")

	init(kind: RunKind, cadenceSec: Double = 10.0, durationSec: Double = 1800.0) {
		self.kind = kind
		self.cadenceSec = cadenceSec
		self.durationSec = durationSec
	}

	func stop() {
		shouldStop = true
	}

	func start(
		metrics: MetricsRecorder,
		onProgress: @escaping @Sendable (RunProgress) -> Void
	) async {
		isRunning = true
		shouldStop = false
		let totalPasses = max(1, Int((durationSec / cadenceSec).rounded()))
		let session: LanguageModelSession?
		if kind == .fullLLM {
			let s = LanguageModelSession {
				PromptBank.systemInstructions
			}
			// Prewarm so the first pass doesn't include cold-load latency.
			s.prewarm()
			session = s
		} else {
			session = nil
		}

		let runStart = Date()
		var passIndex = 0
		while !shouldStop {
			let passStart = Date()
			let (latencyMs, outputValid, outputBytes, errorKind): (Double?, Bool?, Int?, String?) =
				await runOnePass(kind: kind, session: session, passIndex: passIndex)

			let rec = await MainActor.run {
				metrics.snapshot(
					passIndex: passIndex,
					latencyMs: latencyMs,
					outputValid: outputValid,
					outputBytes: outputBytes,
					errorKind: errorKind
				)
			}
			await MainActor.run { metrics.write(rec) }

			// Auto-stop guards: protect the device.
			let critical = (rec.thermalState == .critical)
			let lowMem = rec.availableMemoryBytes < 50 * 1024 * 1024
			let elapsed = Date().timeIntervalSince(runStart)
			let timeUp = elapsed >= durationSec

			let aborted = critical || lowMem
			let abortReason: String? = critical ? "thermal_critical"
				: lowMem ? "low_memory" : nil
			onProgress(RunProgress(
				passIndex: passIndex,
				totalPasses: totalPasses,
				lastRecord: rec,
				aborted: aborted,
				abortReason: abortReason
			))

			if aborted || timeUp {
				logger.info("run finished kind=\(self.kind.rawValue, privacy: .public) aborted=\(aborted) reason=\(abortReason ?? "ok", privacy: .public)")
				break
			}

			// Sleep until next cadence boundary (relative to passStart, not now,
			// so latency variance doesn't drift the schedule).
			let target = passStart.addingTimeInterval(cadenceSec)
			let toSleep = max(0, target.timeIntervalSinceNow)
			if toSleep > 0 {
				try? await Task.sleep(nanoseconds: UInt64(toSleep * 1_000_000_000))
			}
			passIndex += 1
		}

		await MainActor.run { metrics.sync() }
		isRunning = false
	}

	/// One pass. For .idle this just sleeps (the metrics snapshot still
	/// captures thermal/battery for the baseline). For .asrOnly we simulate
	/// the CPU/IO cost of pulling and resampling a 30s audio chunk without
	/// invoking the LLM. For .fullLLM we run a real Foundation Models call.
	private func runOnePass(
		kind: RunKind,
		session: LanguageModelSession?,
		passIndex: Int
	) async -> (Double?, Bool?, Int?, String?) {
		switch kind {
		case .idle:
			return (nil, nil, nil, nil)

		case .asrOnly:
			// Stub: do ~80ms of synthetic audio work to mimic the realtime
			// resampler + VAD pass without ever calling the model. Tuned to
			// match what AIZ-55's ASR stub does; replace with the real
			// pipeline once it lands.
			let start = CFAbsoluteTimeGetCurrent()
			let chunkBytes = 16_000 * 2 * 30 // 16kHz mono int16, 30s
			var acc: UInt64 = 0
			let work = Data(count: chunkBytes)
			for byte in work { acc &+= UInt64(byte) }
			_ = acc
			let dt = (CFAbsoluteTimeGetCurrent() - start) * 1000
			return (dt, nil, chunkBytes, nil)

		case .fullLLM:
			guard let session else {
				return (nil, false, nil, "no_session")
			}
			let userPrompt = PromptBank.userPrompt(forPass: passIndex)
			let start = CFAbsoluteTimeGetCurrent()
			do {
				let response = try await session.respond(
					to: userPrompt,
					generating: GraphDiff.self,
					options: GenerationOptions(temperature: 0.4)
				)
				let dt = (CFAbsoluteTimeGetCurrent() - start) * 1000
				let diff = response.content
				let bytes = (try? JSONEncoder().encode(diff).count) ?? 0
				// "Valid" = decoded into our struct AND not pathologically empty.
				let valid = !(diff.addNodes.isEmpty && diff.addEdges.isEmpty && diff.notes.isEmpty)
				return (dt, valid, bytes, nil)
			} catch let err as LanguageModelSession.GenerationError {
				let dt = (CFAbsoluteTimeGetCurrent() - start) * 1000
				let kind = String(describing: err).split(separator: "(").first.map(String.init) ?? "GenerationError"
				return (dt, false, nil, kind)
			} catch {
				let dt = (CFAbsoluteTimeGetCurrent() - start) * 1000
				return (dt, false, nil, "error:\(type(of: error))")
			}
		}
	}
}
