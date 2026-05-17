// AIZ-55 — Bench: 50-trial loop reporting latency percentiles + validity.
//
// Sample fixtures (small/medium/large/evicted) match the four scenarios
// in ../../token_budget.py so the Swift run and the Python budget
// numbers line up.

#if canImport(FoundationModels)
import Foundation

public struct Trial: Sendable {
    public var label: String
    public var systemPrompt: String
    public var userPrompt: String
}

public struct BenchReport: Sendable {
    public var label: String
    public var trials: Int
    public var successes: Int
    public var p50LatencyMs: Double
    public var p95LatencyMs: Double
    public var p99LatencyMs: Double
    public var avgFirstTokenMs: Double?
    public var errorBreakdown: [String: Int]

    public var validityRate: Double {
        trials == 0 ? 0 : Double(successes) / Double(trials)
    }
}

public enum Bench {

    public static func run(
        trial: Trial,
        iterations: Int = 50,
        prewarm: Bool = true
    ) async -> BenchReport {
        let runner = Runner(systemPrompt: trial.systemPrompt)
        if prewarm {
            await runner.prewarm()
            // Apple docs: wait ≥1s after prewarm before invoking respond.
            try? await Task.sleep(for: .seconds(1))
        }

        var latencies: [Double] = []
        latencies.reserveCapacity(iterations)
        var firstTokenLatencies: [Double] = []
        var successes = 0
        var errors: [String: Int] = [:]

        for _ in 0..<iterations {
            let outcome = await runner.runOnce(userPrompt: trial.userPrompt)
            latencies.append(outcome.totalLatencyMs)
            if let f = outcome.firstTokenLatencyMs { firstTokenLatencies.append(f) }
            if outcome.success {
                successes += 1
            } else if let e = outcome.errorDescription {
                errors[e, default: 0] += 1
            }
        }

        latencies.sort()
        return BenchReport(
            label: trial.label,
            trials: iterations,
            successes: successes,
            p50LatencyMs: percentile(latencies, 0.50),
            p95LatencyMs: percentile(latencies, 0.95),
            p99LatencyMs: percentile(latencies, 0.99),
            avgFirstTokenMs: firstTokenLatencies.isEmpty
                ? nil
                : firstTokenLatencies.reduce(0, +) / Double(firstTokenLatencies.count),
            errorBreakdown: errors
        )
    }

    private static func percentile(_ sorted: [Double], _ p: Double) -> Double {
        guard !sorted.isEmpty else { return 0 }
        let i = min(sorted.count - 1, Int((Double(sorted.count - 1) * p).rounded()))
        return sorted[i]
    }

    public static func format(_ report: BenchReport) -> String {
        var s = """
        === \(report.label) ===
        trials:        \(report.trials)
        validity rate: \(String(format: "%.1f", report.validityRate * 100))%
        p50 latency:   \(String(format: "%.0f", report.p50LatencyMs)) ms
        p95 latency:   \(String(format: "%.0f", report.p95LatencyMs)) ms
        p99 latency:   \(String(format: "%.0f", report.p99LatencyMs)) ms
        """
        if let f = report.avgFirstTokenMs {
            s += "\navg first-token: \(String(format: "%.0f", f)) ms"
        }
        if !report.errorBreakdown.isEmpty {
            s += "\nerrors:"
            for (k, v) in report.errorBreakdown.sorted(by: { $0.value > $1.value }) {
                s += "\n  \(v)x  \(k)"
            }
        }
        return s
    }
}

// MARK: - Fixtures used by the executable

public enum Fixtures {

    /// Returns four trials matching the token-budget scenarios:
    /// - small/medium/large baselines against the compact system prompt
    /// - evicted (17-of-30) against the compact system prompt
    ///
    /// The graph JSON / transcript / chunk are passed in by the caller so
    /// this file stays free of repository-specific data. In the executable
    /// target we wire these to JSON fixtures shipped alongside the package.
    public static func trials(
        smallGraphJSON: String,
        mediumGraphJSON: String,
        largeGraphJSON: String,
        evictedGraphJSON: String,
        previousThoughtsJSON: String,
        recentTranscript: String,
        newChunk: String,
        systemPrompt: String = Prompt.kCompactSystemPrompt
    ) -> [Trial] {
        func build(_ label: String, _ graphJSON: String) -> Trial {
            let user = Prompt.buildUserPrompt(.init(
                currentGraphJSON: graphJSON,
                previousThoughtsJSON: previousThoughtsJSON,
                recentTranscript: recentTranscript,
                newChunk: newChunk
            ))
            return Trial(label: label, systemPrompt: systemPrompt, userPrompt: user)
        }
        return [
            build("small 5 nodes", smallGraphJSON),
            build("medium 15 nodes", mediumGraphJSON),
            build("large 30 nodes", largeGraphJSON),
            build("evicted 17 of 30", evictedGraphJSON),
        ]
    }
}
#endif
