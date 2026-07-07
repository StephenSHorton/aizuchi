// Prompt — fixed, realistic system instructions + a stub graph state and a rotating
// transcript snippet. The prompt is intentionally close to what AIZ-55's fit-check
// uses so the thermal numbers are workload-comparable. If AIZ-55 ships a different
// final prompt, swap PromptBank.systemInstructions and PromptBank.graphSnapshot.

import Foundation

enum PromptBank {
	static let systemInstructions = """
	You are Aizuchi, an assistant that maintains a live mind-map of a meeting.
	On each pass you receive: the current graph state, the latest 30 seconds of
	transcript, and your previous notes. You emit a GraphDiff containing
	additive nodes, additive edges, and at most three short notes describing
	what just happened. Be conservative: prefer 0-3 nodes per pass to keeping
	the graph clean. Never restate prior content. Refer to nodes by id.
	"""

	// Stub ~20-node / ~30-edge graph state. Stable across passes so we measure
	// model behavior, not prompt churn.
	static let graphSnapshot = """
	{
	  "nodes": [
	    {"id":"n1","label":"Q3 roadmap"}, {"id":"n2","label":"Mobile rewrite"},
	    {"id":"n3","label":"Foundation Models"}, {"id":"n4","label":"Thermal risk"},
	    {"id":"n5","label":"Hybrid arch"}, {"id":"n6","label":"Capture-only mode"},
	    {"id":"n7","label":"Cloud fallback"}, {"id":"n8","label":"AIZ-56 spike"},
	    {"id":"n9","label":"iPhone 17 Pro"}, {"id":"n10","label":"iPhone 15 Pro"},
	    {"id":"n11","label":"Battery budget"}, {"id":"n12","label":"Latency p95"},
	    {"id":"n13","label":"Streaming notes"}, {"id":"n14","label":"Eviction"},
	    {"id":"n15","label":"Stephen"}, {"id":"n16","label":"Alex"},
	    {"id":"n17","label":"Action: ship by Q3"}, {"id":"n18","label":"Decision: iOS first"},
	    {"id":"n19","label":"GraphDiff schema"}, {"id":"n20","label":"30-min bench"}
	  ],
	  "edges": [
	    {"from":"n2","to":"n3","r":"uses"}, {"from":"n3","to":"n4","r":"raises"},
	    {"from":"n4","to":"n5","r":"motivates"}, {"from":"n5","to":"n6","r":"contains"},
	    {"from":"n5","to":"n7","r":"contains"}, {"from":"n8","to":"n4","r":"measures"},
	    {"from":"n8","to":"n9","r":"targets"}, {"from":"n8","to":"n10","r":"targets"},
	    {"from":"n8","to":"n11","r":"measures"}, {"from":"n8","to":"n12","r":"measures"},
	    {"from":"n13","to":"n12","r":"improves"}, {"from":"n14","to":"n3","r":"mitigates"},
	    {"from":"n15","to":"n17","r":"owns"}, {"from":"n16","to":"n18","r":"proposed"},
	    {"from":"n17","to":"n2","r":"about"}, {"from":"n18","to":"n2","r":"about"},
	    {"from":"n19","to":"n3","r":"depends_on"}, {"from":"n20","to":"n8","r":"part_of"},
	    {"from":"n1","to":"n2","r":"contains"}, {"from":"n1","to":"n18","r":"contains"},
	    {"from":"n9","to":"n11","r":"affects"}, {"from":"n10","to":"n11","r":"affects"},
	    {"from":"n6","to":"n7","r":"escalates_to"}, {"from":"n4","to":"n11","r":"correlates"},
	    {"from":"n4","to":"n12","r":"correlates"}, {"from":"n13","to":"n19","r":"extends"},
	    {"from":"n14","to":"n19","r":"shapes"}, {"from":"n20","to":"n11","r":"records"},
	    {"from":"n20","to":"n12","r":"records"}, {"from":"n3","to":"n19","r":"constrains"}
	  ]
	}
	"""

	// Rotating transcript snippets. The benchmark cycles through these so the
	// model sees varied input but the *byte budget* per pass is stable, which
	// is what we want for thermal measurement.
	static let transcripts: [String] = [
		"Stephen: ok so the thermal risk is the big unknown for mobile. Alex: right, the published papers all say five to ten queries per hour before throttling. We need our own number.",
		"Alex: I think we ship capture-only for v1. Stephen: maybe — but if 17 Pro holds up under sustained load we have options. The vapor chamber claims are real, just unverified for our workload.",
		"Stephen: AIZ-55 will tell us if GraphDiff fits the context window. AIZ-56 tells us if it survives 30 minutes. Alex: and we want a green light on both before we lock the hybrid arch.",
		"Alex: latency p95 under three seconds, battery under ten percent per hour, thermal capped at fair. Stephen: that's the green criteria. Yellow we adapt cadence, red we drop on-device synthesis.",
		"Stephen: one query every ten seconds, 360 per hour, that's our target cadence. Alex: which is 30-70x what the third-party benchmarks tested. Apple's NPU scheduling might save us. Might not.",
		"Alex: we should also baseline the device idle and the device running ASR only. Stephen: yes, otherwise we can't tell how much is the LLM and how much is the audio path.",
	]

	static func transcript(forPass passIndex: Int) -> String {
		transcripts[passIndex % transcripts.count]
	}

	static func userPrompt(forPass passIndex: Int) -> String {
		let t = transcript(forPass: passIndex)
		return """
		Current graph state:
		\(graphSnapshot)

		Latest transcript (last 30s):
		\(t)

		Emit a GraphDiff. Be conservative.
		"""
	}
}
