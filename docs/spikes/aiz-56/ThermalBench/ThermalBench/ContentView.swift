// ContentView — minimal UI: pick a run, watch progress, export the JSONL.
//
// One-tap export: tap "Share JSONL" after a run; UIActivityViewController
// opens with AirDrop, Files, Mail, etc. so the user can move the file off
// the device for analysis with docs/spikes/aiz-56/analyze.py.

import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
	@StateObject private var bench = Bench()
	@State private var showShare = false

	var body: some View {
		NavigationStack {
			Form {
				Section("Device") {
					LabeledContent("FoundationModels", value: bench.fmAvailability)
					LabeledContent("Thermal", value: ThermalStateString(ProcessInfo.processInfo.thermalState).rawValue)
				}
				Section("Run") {
					ForEach(RunKind.allCases) { kind in
						Button {
							bench.start(kind: kind)
						} label: {
							HStack {
								Text(kind.label)
								Spacer()
								if bench.currentKind == kind && bench.isRunning {
									ProgressView()
								}
							}
						}
						.disabled(bench.isRunning)
					}
					if bench.isRunning {
						Button("Stop", role: .destructive) { bench.stop() }
					}
				}
				Section("Status") {
					Text(bench.statusLine).font(.footnote.monospaced())
					if let p = bench.lastProgress, let r = p.lastRecord {
						Text("Pass \(p.passIndex+1)/\(p.totalPasses)").font(.footnote)
						Text("Thermal: \(r.thermalState.rawValue)").font(.footnote)
						Text("Battery: \(Int(r.batteryLevel * 100))%").font(.footnote)
						if let lat = r.latencyMs {
							Text("Latency: \(Int(lat)) ms").font(.footnote)
						}
						Text("Free mem: \(r.availableMemoryBytes / (1024*1024)) MB").font(.footnote)
					}
				}
				Section("Export") {
					Button("Share JSONL") { showShare = true }
						.disabled(bench.lastFileURL == nil)
					if let url = bench.lastFileURL {
						Text(url.lastPathComponent).font(.caption2.monospaced())
					}
				}
				Section("Test rig") {
					Text("Plug in to wall charger, set brightness to 25%, enable Airplane Mode, disable auto-lock. See docs/spikes/aiz-56/report.md §6.")
						.font(.footnote)
						.foregroundStyle(.secondary)
				}
			}
			.navigationTitle("ThermalBench")
		}
		.sheet(isPresented: $showShare) {
			if let url = bench.lastFileURL {
				ShareSheet(items: [url])
			}
		}
	}
}

struct ShareSheet: UIViewControllerRepresentable {
	let items: [Any]
	func makeUIViewController(context: Context) -> UIActivityViewController {
		UIActivityViewController(activityItems: items, applicationActivities: nil)
	}
	func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
