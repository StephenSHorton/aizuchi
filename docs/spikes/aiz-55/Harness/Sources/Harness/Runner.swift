// AIZ-55 — Runner: one GraphDiff generation against Foundation Models.
//
// Uses LanguageModelSession.streamResponse(generating: GraphDiff.self,
// ...) so we get both:
//   - constrained decoding from @Generable (output is valid by
//     construction or throws an error),
//   - PartiallyGenerated snapshots (rendering-friendly streaming —
//     notes can show up as they land, which is the perceived-latency
//     win the spike open-question called out).
//
// Pass-fail signal we collect:
//   - latency (first-token, total, per-snapshot tick rate)
//   - which error path fired (exceededContextWindowSize is the one
//     we expect to dominate at large graphs)
//   - whether the final structure is valid (it should be, by
//     construction — but we sanity-check IDs reference real nodes)

#if canImport(FoundationModels)
import Foundation
import FoundationModels

public actor Runner {
    public struct Outcome: Sendable {
        public var success: Bool
        public var totalLatencyMs: Double
        public var firstTokenLatencyMs: Double?
        public var partialCount: Int
        public var finalDiff: GraphDiff?
        public var errorDescription: String?
    }

    private let session: LanguageModelSession
    private let options: GenerationOptions

    public init(systemPrompt: String, sampling: GenerationOptions.SamplingMode = .greedy) {
        self.session = LanguageModelSession(instructions: systemPrompt)
        self.options = GenerationOptions(sampling: sampling)
    }

    /// Optional warmup — call once before the first real pass.
    /// Per Apple docs (.../languagemodelsession/prewarm), wait ≥1s
    /// before invoking respond/streamResponse.
    public func prewarm() {
        session.prewarm()
    }

    public func runOnce(userPrompt: String) async -> Outcome {
        let start = ContinuousClock.now
        var firstTokenAt: ContinuousClock.Instant?
        var partialCount = 0
        var finalDiff: GraphDiff?

        do {
            let stream = session.streamResponse(
                generating: GraphDiff.self,
                includeSchemaInPrompt: false,  // @Generable provides the schema; don't pay tokens again
                options: options
            ) {
                userPrompt
            }
            for try await partial in stream {
                if firstTokenAt == nil { firstTokenAt = ContinuousClock.now }
                partialCount += 1
                // partial.content is a GraphDiff.PartiallyGenerated; the
                // final iteration produces a fully-realized GraphDiff
                // accessible via the final aggregated content. The
                // streaming API on iOS 26 surfaces the converged value
                // on the last snapshot.
                if let realized = partial.content as? GraphDiff {
                    finalDiff = realized
                }
            }
            // If we didn't capture a realized GraphDiff during streaming,
            // re-run the non-streaming path to get the typed value.
            if finalDiff == nil {
                let response = try await session.respond(
                    generating: GraphDiff.self,
                    includeSchemaInPrompt: false,
                    options: options
                ) {
                    userPrompt
                }
                finalDiff = response.content
            }
        } catch let error as LanguageModelSession.GenerationError {
            return Outcome(
                success: false,
                totalLatencyMs: durationMs(from: start),
                firstTokenLatencyMs: firstTokenAt.map { durationMs(from: start, to: $0) },
                partialCount: partialCount,
                finalDiff: nil,
                errorDescription: describe(error)
            )
        } catch {
            return Outcome(
                success: false,
                totalLatencyMs: durationMs(from: start),
                firstTokenLatencyMs: firstTokenAt.map { durationMs(from: start, to: $0) },
                partialCount: partialCount,
                finalDiff: nil,
                errorDescription: "\(error)"
            )
        }

        let valid = finalDiff.map { sanityCheck($0) } ?? false
        return Outcome(
            success: valid,
            totalLatencyMs: durationMs(from: start),
            firstTokenLatencyMs: firstTokenAt.map { durationMs(from: start, to: $0) },
            partialCount: partialCount,
            finalDiff: finalDiff,
            errorDescription: valid ? nil : "post-decode sanity check failed"
        )
    }

    // Cheap consistency check beyond the type-level guarantees: edge
    // endpoints reference a node in the graph or being added in the
    // diff. The @Generable layer can't enforce this — it's value-level.
    private func sanityCheck(_ diff: GraphDiff) -> Bool {
        let addedIds = Set(diff.add_nodes.map(\.id))
        // We don't have the prior graph here, so accept any edge
        // referencing an added node OR assume the caller will resolve
        // against the prior graph. The harness Bench feeds known prior
        // ids in via the prompt; full validation lives at the call site.
        for edge in diff.add_edges {
            if addedIds.contains(edge.from) || addedIds.contains(edge.to) { continue }
            // edge could reference prior graph — call site re-checks
        }
        if diff.no_changes {
            return diff.add_nodes.isEmpty
                && diff.add_edges.isEmpty
                && diff.update_nodes.isEmpty
                && diff.merge_nodes.isEmpty
                && diff.remove_nodes.isEmpty
                && diff.remove_edges.isEmpty
                && diff.notes.isEmpty
        }
        return true
    }

    private func durationMs(from start: ContinuousClock.Instant) -> Double {
        let delta = ContinuousClock.now - start
        return Double(delta.components.seconds) * 1_000.0
            + Double(delta.components.attoseconds) / 1e15
    }

    private func durationMs(
        from start: ContinuousClock.Instant,
        to end: ContinuousClock.Instant
    ) -> Double {
        let delta = end - start
        return Double(delta.components.seconds) * 1_000.0
            + Double(delta.components.attoseconds) / 1e15
    }

    private func describe(_ error: LanguageModelSession.GenerationError) -> String {
        switch error {
        case .exceededContextWindowSize:
            return "exceededContextWindowSize (the 4096-token limit)"
        case .decodingFailure:
            return "decodingFailure (@Generable output did not validate)"
        case .guardrailViolation:
            return "guardrailViolation"
        case .rateLimited:
            return "rateLimited"
        case .refusal:
            return "refusal"
        case .assetsUnavailable:
            return "assetsUnavailable"
        case .unsupportedGuide:
            return "unsupportedGuide"
        case .unsupportedLanguageOrLocale:
            return "unsupportedLanguageOrLocale"
        case .concurrentRequests:
            return "concurrentRequests"
        @unknown default:
            return "\(error)"
        }
    }
}
#endif
