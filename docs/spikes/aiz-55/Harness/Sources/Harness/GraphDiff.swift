// AIZ-55 — Swift @Generable mirror of the Aizuchi GraphDiff schema.
//
// Source of truth lives at src/lib/aizuchi/schemas.ts (Zod). This file
// translates that shape into Swift types annotated with @Generable so
// the Foundation Models framework can constrain decoding via the
// guided-generation path (TN3193 / Generating Swift data structures
// with guided generation).
//
// Key translation notes:
//
// 1. Apple's @Generable supports nested @Generable structs/enums, plus
//    @Guide attributes for descriptions and constraints. We pass the
//    enum-case set via Swift `enum` cases — FoundationModels emits a
//    constrained-decoding grammar from the cases, no @Guide description
//    needed per case (and per the docs in
//    /websites/developer_apple_foundationmodels, enum descriptions are
//    not currently supported the way struct-field @Guides are).
//
// 2. Dynamic-length arrays need a count guide. Aizuchi's diffs are
//    bounded in practice — a single pass rarely emits more than ~10
//    items per array. We bound each array at .maximumCount(12) to keep
//    constrained decoding fast and to fail fast if the model spirals.
//    (Use .count(N) when you want exact-N; .maximumCount(N) is the
//    open-ended upper bound. The Apple docs we consulted in Context7
//    show both forms.)
//
// 3. Optional fields are modelled with Swift `Optional` — Apple's
//    generated PartiallyGenerated type makes every property optional
//    automatically for streaming, so callers can render partials as
//    they arrive without changing this declaration.
//
// 4. We deliberately do NOT include the speaker field on Node when
//    running in substance mode — gate that at the prompt layer, not
//    here. The schema-level union is the same as today's.

#if canImport(FoundationModels)
import FoundationModels

// MARK: - Enumerations

@Generable
public enum NodeType: String, CaseIterable, Codable, Sendable {
    case person
    case topic
    case work_item
    case blocker
    case decision
    case action_item
    case question
    case context
    case risk
    case assumption
    case constraint
    case hypothesis
    case metric
    case artifact
    case event
    case sentiment
}

@Generable
public enum EdgeRelation: String, CaseIterable, Codable, Sendable {
    case owns
    case depends_on
    case blocks
    case related_to
    case decides
    case asks
    case answers
    case mentions
    case assigned_to
    case causes
    case contradicts
    case supports
    case example_of
    case alternative_to
    case precedes
    case resolves
    case clarifies
}

@Generable
public enum NodeStatus: String, CaseIterable, Codable, Sendable {
    case active
    case resolved
    case parked
}

@Generable
public enum NodeConfidence: String, CaseIterable, Codable, Sendable {
    case high
    case medium
    case low
}

@Generable
public enum Severity: String, CaseIterable, Codable, Sendable {
    case low
    case medium
    case high
}

@Generable
public enum ThoughtIntent: String, CaseIterable, Codable, Sendable {
    case question
    case observation
    case unresolved
    case pattern
    case fyi
}

// MARK: - Node

@Generable(description: "A single node on the live mind map.")
public struct Node: Codable, Sendable, Equatable {
    @Guide(description: "Stable snake_case identifier derived from the label. Must be unique.")
    public var id: String

    @Guide(description: "Short human-readable label shown on the map.")
    public var label: String

    public var type: NodeType

    @Guide(description: "Optional one-sentence context for the node.")
    public var description: String?

    @Guide(description: "Who introduced or owns this in the meeting, if attributable.")
    public var speaker: String?

    @Guide(description: "Does this still need attention? Default 'active' (omit).")
    public var status: NodeStatus?

    @Guide(description: "How sure you are about this extraction. Default 'high' (omit).")
    public var confidence: NodeConfidence?

    @Guide(description: "Verbatim transcript snippet, ≤200 chars, that grounded this node.")
    public var quote: String?

    @Guide(description: "Free-form lowercase tags.", .maximumCount(8))
    public var tags: [String]?

    // Type-specific fields. All optional; the model fills them when the
    // node type warrants it.
    @Guide(description: "For risk nodes — how likely the bad outcome is.")
    public var likelihood: Severity?

    @Guide(description: "For risk nodes — how bad the outcome would be.")
    public var impact: Severity?

    @Guide(description: "For hypothesis nodes — the predicted outcome.")
    public var prediction: String?

    @Guide(description: "For metric nodes — the headline value as spoken.")
    public var value: String?

    @Guide(description: "For metric nodes — the target/threshold being compared against.")
    public var target: String?

    @Guide(description: "For metric nodes — unit when separable from value.")
    public var unit: String?

    @Guide(description: "For event nodes — ISO date when known, natural language otherwise.")
    public var occurredAt: String?

    @Guide(description: "For constraint nodes — the actual hard limit.")
    public var limit: String?

    @Guide(description: "For action_item nodes — when this is due.")
    public var dueDate: String?

    @Guide(description: "For sentiment nodes — emotion as a single word.")
    public var tone: String?

    @Guide(description: "For decision nodes — the rejected option, when one was explicitly weighed.")
    public var alternative: String?
}

// MARK: - Edge

@Generable(description: "A directed relation between two nodes.")
public struct Edge: Codable, Sendable, Equatable {
    @Guide(description: "Stable identifier, typically '{from}-{relation}-{to}'.")
    public var id: String

    @Guide(description: "Source node id.")
    public var from: String

    @Guide(description: "Target node id.")
    public var to: String

    public var relation: EdgeRelation

    public var description: String?
}

// MARK: - NodeUpdate

@Generable(description: "A patch to apply to an existing node, identified by id.")
public struct NodeUpdate: Codable, Sendable, Equatable {
    public var id: String
    public var label: String?
    public var description: String?
    public var type: NodeType?
    public var status: NodeStatus?
    public var confidence: NodeConfidence?
    public var quote: String?
    @Guide(.maximumCount(8))
    public var tags: [String]?
    public var likelihood: Severity?
    public var impact: Severity?
    public var prediction: String?
    public var value: String?
    public var target: String?
    public var unit: String?
    public var occurredAt: String?
    public var limit: String?
    public var dueDate: String?
    public var tone: String?
    public var alternative: String?
}

// MARK: - NodeMerge

@Generable(description: "Merge two or more nodes into one. Edges rewire automatically.")
public struct NodeMerge: Codable, Sendable, Equatable {
    @Guide(description: "Id of the node to keep.")
    public var keep: String

    @Guide(description: "Ids of duplicate nodes to absorb into 'keep'.", .maximumCount(6))
    public var absorb: [String]
}

// MARK: - AIThought

@Generable(description: "A running observation, question, or pattern about the conversation.")
public struct AIThought: Codable, Sendable, Equatable {
    @Guide(description: "Stable snake_case id; reuse across passes to update an existing thought.")
    public var id: String

    @Guide(description: "One short sentence — the observation, question, or note.")
    public var text: String

    public var intent: ThoughtIntent

    @Guide(description: "Optional node ids this thought relates to.", .maximumCount(8))
    public var references: [String]?
}

// MARK: - GraphDiff (top-level return type)

@Generable(description: "A diff to apply to the live mind map after this pass.")
public struct GraphDiff: Codable, Sendable, Equatable {
    @Guide(description: "True when this pass produces no changes. When true, all other arrays must be empty.")
    public var no_changes: Bool

    @Guide(description: "Nodes to add to the graph.", .maximumCount(12))
    public var add_nodes: [Node]

    @Guide(description: "Edges to add. Endpoints must reference nodes in the graph or being added in this diff.", .maximumCount(16))
    public var add_edges: [Edge]

    @Guide(description: "Patches to apply to existing nodes.", .maximumCount(10))
    public var update_nodes: [NodeUpdate]

    @Guide(description: "Duplicate-node merges. Edges rewire automatically.", .maximumCount(4))
    public var merge_nodes: [NodeMerge]

    @Guide(description: "Node ids to drop entirely.", .maximumCount(8))
    public var remove_nodes: [String]

    @Guide(description: "Edge ids to drop.", .maximumCount(8))
    public var remove_edges: [String]

    @Guide(description: "Running observations about the meeting. Emit only new or changed thoughts.", .maximumCount(6))
    public var notes: [AIThought]
}

#endif  // canImport(FoundationModels)
