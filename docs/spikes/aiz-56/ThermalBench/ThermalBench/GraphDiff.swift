// GraphDiff — minimal stub mirroring AIZ-55's @Generable types.
// Kept deliberately small so the harness compiles standalone; if AIZ-55's
// richer GraphDiff lands first, replace this file with its types and the rest
// of the harness will keep working (the only call site is Runner.runOnePass).

import Foundation
import FoundationModels

@Generable
struct GraphNodeAdd: Equatable {
	@Guide(description: "Stable identifier for the new node, 1-32 chars")
	var id: String

	@Guide(description: "Short human-readable label, max 80 chars")
	var label: String

	@Guide(description: "Optional node kind: topic, person, decision, action")
	var kind: String?
}

@Generable
struct GraphEdgeAdd: Equatable {
	var from: String
	var to: String
	@Guide(description: "Relationship: relates_to, supports, contradicts, follows")
	var relation: String
}

@Generable
struct GraphNote: Equatable {
	@Guide(description: "Short AI-generated note about the meeting state")
	var text: String
}

@Generable
struct GraphDiff: Equatable {
	@Guide(description: "Nodes to add, 0-8 per pass")
	var addNodes: [GraphNodeAdd]

	@Guide(description: "Edges to add, 0-12 per pass")
	var addEdges: [GraphEdgeAdd]

	@Guide(description: "Notes about meeting state, 0-3 per pass")
	var notes: [GraphNote]
}
