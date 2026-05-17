// ThermalBench — Aizuchi AIZ-56
// Sustained-inference thermal measurement harness for Apple Foundation Models on iOS 26.
//
// This is a self-contained SwiftUI app meant to be opened in Xcode 26+ as a single-target
// iOS app. It does not depend on AIZ-55's harness; if that harness lands first, the
// `Runner` and `Bench` here can be merged with it post-hoc (see report.md §6).
//
// Run on an iPhone 17 Pro and iPhone 15 Pro per AIZ-56's test rig requirements.

import SwiftUI

@main
struct ThermalBenchApp: App {
	var body: some Scene {
		WindowGroup {
			ContentView()
		}
	}
}
