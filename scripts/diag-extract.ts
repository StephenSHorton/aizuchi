#!/usr/bin/env bun

/**
 * AIZ-52 diagnostic — runs `mutateGraph` against a fixture transcript that
 * exercises every rich type (decision, risk, metric, event), and prints
 * the body Gemma produced for each new node. Use this to iterate on the
 * extraction prompt without re-recording meetings.
 *
 *   bun run scripts/diag-extract.ts
 */

import { mutateGraph } from "../src/lib/aizuchi/graph-mutation";
import type { Graph } from "../src/lib/aizuchi/schemas";

const startGraph: Graph = { nodes: [], edges: [] };

const FIXTURE = `Maya: Quick decision: we're going with Postgres over MySQL for the analytics migration. We weighed both — MySQL had simpler ops, but the window-function performance on Postgres is too valuable to give up.
Maya: There's a real risk around the campaign config inconsistency between Co-CI and Solomar — it's high likelihood, high impact, the constant flipping is causing customer-visible bugs.
Travis: Quick metric note — our p95 latency on the new endpoint is 180ms. Target is 200ms, so we're under.
Travis: The migration itself is set to ship Friday EOD. That's the cutover window.`;

const result = await mutateGraph(startGraph, FIXTURE, {
	extractionMode: "attribution",
	recentTranscript: "",
	previousThoughts: [],
});

console.log("=== full diff ===");
console.log(JSON.stringify(result.diff, null, 2));

console.log("\n=== body extraction summary ===");
const richTypes = new Set(["decision", "risk", "metric", "event"]);
for (const node of result.diff.add_nodes) {
	const isRich = richTypes.has(node.type);
	const tag = isRich ? "RICH" : "    ";
	const body = node.body
		? `\n      body: ${JSON.stringify(node.body)}`
		: isRich
			? " ⚠️ MISSING BODY"
			: "";
	console.log(`[${tag}] ${node.id} (${node.type})${body}`);
}
