// Bench — the user-facing controller. Wraps a Runner + MetricsRecorder, owns
// the @Published state SwiftUI binds to, and exposes the JSONL file URL for
// export.

import Foundation
import FoundationModels
import SwiftUI
import UIKit
import os

@MainActor
final class Bench: ObservableObject {
	@Published var isRunning: Bool = false
	@Published var currentKind: RunKind? = nil
	@Published var lastProgress: RunProgress? = nil
	@Published var currentRecorder: MetricsRecorder? = nil
	@Published var lastFileURL: URL? = nil
	@Published var statusLine: String = "Idle"
	@Published var fmAvailability: String = "unknown"

	private var runner: Runner? = nil
	private let logger = Logger(subsystem: "app.aizuchi.thermalbench", category: "bench")

	init() {
		refreshFoundationModelsAvailability()
	}

	func refreshFoundationModelsAvailability() {
		let avail = SystemLanguageModel.default.availability
		switch avail {
		case .available:
			fmAvailability = "available"
		case .unavailable(let reason):
			fmAvailability = "unavailable(\(reason))"
		@unknown default:
			fmAvailability = "unknown"
		}
	}

	func start(kind: RunKind, durationSec: Double = 1800, cadenceSec: Double = 10) {
		guard !isRunning else { return }
		do {
			let rec = try MetricsRecorder(runKind: kind.rawValue)
			currentRecorder = rec
			let r = Runner(kind: kind, cadenceSec: cadenceSec, durationSec: durationSec)
			runner = r
			isRunning = true
			currentKind = kind
			let total = Int((durationSec / cadenceSec).rounded())
			statusLine = "Running \(kind.label) — 0/\(total)"
			Task {
				await r.start(metrics: rec) { progress in
					Task { @MainActor in
						self.lastProgress = progress
						let suffix = progress.aborted ? " ABORT(\(progress.abortReason ?? "?"))" : ""
						self.statusLine = "\(kind.label) — \(progress.passIndex + 1)/\(progress.totalPasses)\(suffix)"
					}
				}
				await MainActor.run {
					self.isRunning = false
					self.lastFileURL = rec.fileURL
					self.statusLine = "Finished. File: \(rec.fileURL.lastPathComponent)"
				}
			}
		} catch {
			statusLine = "Failed to start: \(error.localizedDescription)"
			logger.error("start failed: \(error.localizedDescription, privacy: .public)")
		}
	}

	func stop() {
		guard let r = runner else { return }
		Task { await r.stop() }
		statusLine = "Stop requested…"
	}
}
