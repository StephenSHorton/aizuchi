// AIZ-55 — prompt construction mirroring src/lib/aizuchi/prompts.ts.
//
// Two flavors:
//
// - `kAttributionSystemPrompt` — verbatim port of SYSTEM_PROMPT_ATTRIBUTION.
//   Used by Aizuchi today for multi-speaker meetings. Heavy (~3K tokens
//   under cl100k_base — see ../../token_budget_output.txt). Included as
//   a baseline to confirm the desktop prompt does NOT fit FM as-is.
//
// - `kCompactSystemPrompt` — purpose-built for Foundation Models iOS 26.
//   Drops the worked examples (constrained decoding via @Generable
//   replaces them) and condenses the rubric. ~340 tokens. This is what
//   the iOS port would actually ship.

import Foundation

public enum Prompt {

    /// Verbatim copy of SYSTEM_PROMPT_ATTRIBUTION from
    /// src/lib/aizuchi/prompts.ts as of spike/aiz-55. Use as a baseline
    /// to confirm it overruns the FM 4K window — it's not what we ship.
    public static let kAttributionSystemPrompt: String = """
    You maintain a live mind map of a conversation as it unfolds — a meeting, a brainstorm, or a single person thinking out loud. You also keep a running list of *thoughts*: questions, unresolved threads, patterns you notice. Both the graph and your thoughts are surfaced live to the user.

    See src/lib/aizuchi/prompts.ts for the full text. Truncated here to keep this file readable — load from disk via Bundle.module in a real build, or paste the full text in for measurement.
    """

    /// FM-port system prompt — what we'd actually send to
    /// `LanguageModelSession(instructions:)`. Targets ~340 cl100k tokens
    /// per the simulator in ../../token_budget_extreme_output.txt.
    public static let kCompactSystemPrompt: String = """
    You maintain a live mind map of a meeting. Each pass: emit a GraphDiff that adds/updates/merges/removes nodes and edges, and updates a running thoughts list.

    Inputs: current graph, previous thoughts, recent ~60s transcript, and the new chunk. Be willing to restructure if a prior classification was wrong. Don't drop stable nodes just because the new chunk doesn't mention them — the graph is cumulative.

    Node types: person, topic, work_item, blocker, decision, action_item, question, context, risk, assumption, constraint, hypothesis, metric, artifact, event, sentiment. Use snake_case ids derived from labels; reuse ids across passes. Strongest quotes go on decision/risk/assumption/hypothesis/metric/sentiment.

    Edge relations: owns, depends_on, blocks, related_to, decides, asks, answers, mentions, assigned_to, causes, contradicts, supports, example_of, alternative_to, precedes, resolves, clarifies. Prefer specific relations over related_to. Action items always get assigned_to a person.

    Optional fields: status (active/resolved/parked), confidence (high/medium/low), quote (verbatim, ≤200 chars), tags. Type-specific: likelihood+impact (risk), prediction (hypothesis), value+target+unit (metric), occurredAt (event), limit (constraint), dueDate (action_item), tone (sentiment), alternative (decision).

    Thoughts: short observations/questions/patterns the user should see. Stable ids; emit only new or changed thoughts each pass. Reference relevant node ids.

    Return no_changes: true only when the new chunk genuinely adds nothing.
    """

    public struct UserPromptInput: Sendable {
        public var currentGraphJSON: String
        public var previousThoughtsJSON: String
        public var recentTranscript: String
        public var newChunk: String

        public init(
            currentGraphJSON: String,
            previousThoughtsJSON: String,
            recentTranscript: String,
            newChunk: String
        ) {
            self.currentGraphJSON = currentGraphJSON
            self.previousThoughtsJSON = previousThoughtsJSON
            self.recentTranscript = recentTranscript
            self.newChunk = newChunk
        }
    }

    /// Mirrors buildUserPrompt() in src/lib/aizuchi/prompts.ts. Caller is
    /// responsible for serializing the graph + thoughts ahead of time.
    public static func buildUserPrompt(_ input: UserPromptInput) -> String {
        let thoughts = input.previousThoughtsJSON.isEmpty ? "(none yet)" : input.previousThoughtsJSON
        let recent = input.recentTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "(this is the first chunk)"
            : input.recentTranscript

        return """
        ## Current graph state

        ```json
        \(input.currentGraphJSON)
        ```

        ## Previous thoughts

        ```json
        \(thoughts)
        ```

        ## Recent transcript window (last ~60s, for context)

        ```
        \(recent)
        ```

        ## New transcript chunk (the freshest utterances)

        ```
        \(input.newChunk)
        ```

        Return the GraphDiff. Update the graph and your thoughts based on the new chunk, using the recent transcript and previous thoughts for context. Only return `no_changes: true` if the new chunk and surrounding context genuinely add nothing.
        """
    }
}
