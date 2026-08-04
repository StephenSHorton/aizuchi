// AIZ-55 — quick executable entry point. Loads the fixture JSON files
// next to the package and runs the four-trial benchmark.
//
// Build & run on macOS 26+ with the iOS-26-era toolchain:
//
//   swift run harness-cli
//
// Or vendor the Harness target into an iOS-26 app and call Bench.run
// from a SwiftUI button — running on-device is where the latency
// numbers actually matter.

#if canImport(FoundationModels)
import Foundation
import Harness

@main
struct CLI {
    static func main() async {
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let fixtures = cwd.appendingPathComponent("Fixtures")

        func read(_ name: String) -> String {
            (try? String(contentsOf: fixtures.appendingPathComponent(name), encoding: .utf8)) ?? "{}"
        }

        let trials = Fixtures.trials(
            smallGraphJSON: read("graph_small.json"),
            mediumGraphJSON: read("graph_medium.json"),
            largeGraphJSON: read("graph_large.json"),
            evictedGraphJSON: read("graph_evicted.json"),
            previousThoughtsJSON: read("previous_thoughts.json"),
            recentTranscript: read("recent_transcript.txt"),
            newChunk: read("new_chunk.txt")
        )

        for trial in trials {
            let report = await Bench.run(trial: trial, iterations: 50)
            print(Bench.format(report))
            print()
        }
    }
}
#else
@main
struct CLI {
    static func main() {
        print("FoundationModels framework not available — this harness requires iOS 26 / macOS 26.")
    }
}
#endif
