import { describe, expect, it } from "bun:test";
import { normalizeDiff } from "./normalize";
import {
	applyDiff,
	type Graph,
	type GraphDiff,
	type Node,
	type NodeUpdate,
} from "./schemas";

const RISK_BODY = [
	"root = Card([head, callout])",
	'head = CardHeader("Campaign inconsistency")',
	'callout = Callout("warning", "Medium likelihood / high impact", "Flipping between the two campaigns causes bugs.")',
].join("\n");

function riskGraph(): Graph {
	const risk: Node = {
		id: "campaign_risk",
		label: "Campaign inconsistency",
		type: "risk",
		body: RISK_BODY,
	};
	return { nodes: [risk], edges: [] };
}

function emptyDiff(): GraphDiff {
	return {
		no_changes: false,
		add_nodes: [],
		add_edges: [],
		update_nodes: [],
		merge_nodes: [],
		remove_nodes: [],
		remove_edges: [],
		notes: [],
	};
}

function diffWithUpdate(u: NodeUpdate): GraphDiff {
	return { ...emptyDiff(), update_nodes: [u] };
}

describe("normalizeDiff — body_patch resolution", () => {
	it("merges a valid patch into the node's current body", () => {
		const graph = riskGraph();
		const diff = diffWithUpdate({
			id: "campaign_risk",
			body_patch:
				'callout = Callout("danger", "High likelihood / high impact", "Now confirmed customer-visible bugs.")',
		});

		const { diff: normalized, report } = normalizeDiff(graph, diff);
		expect(report.bodyPatchesApplied).toBe(1);
		expect(report.bodyPatchesFailed).toBe(0);

		const update = normalized.update_nodes[0];
		expect(update.body).toBeDefined();
		expect(update.body).toContain("danger");
		// unmentioned statement survives the merge
		expect(update.body).toContain("Campaign inconsistency");
		// patch field is stripped from the normalized diff
		expect(update.body_patch).toBeUndefined();

		// and it actually lands on the node via applyDiff
		const next = applyDiff(graph, normalized);
		const node = next.nodes.find((n) => n.id === "campaign_risk");
		expect(node?.body).toContain("danger");
		expect(node?.body).not.toContain('"warning"');
	});

	it("falls back to the existing body when the patch dangles a reference", () => {
		const graph = riskGraph();
		const diff = diffWithUpdate({
			id: "campaign_risk",
			// references `ghost`, never defined → invalid merge → fallback
			body_patch: "root = Card([head, callout, ghost])",
		});

		const { diff: normalized, report } = normalizeDiff(graph, diff);
		expect(report.bodyPatchesApplied).toBe(0);
		expect(report.bodyPatchesFailed).toBe(1);

		// no body override => applyDiff preserves the last-known-good body
		expect(normalized.update_nodes[0].body).toBeUndefined();
		const next = applyDiff(graph, normalized);
		const node = next.nodes.find((n) => n.id === "campaign_risk");
		expect(node?.body).toBe(RISK_BODY);
	});

	it("keeps the existing body on a status-only update (never synthesizes over it)", () => {
		const graph = riskGraph();
		const diff = diffWithUpdate({ id: "campaign_risk", status: "resolved" });

		const { diff: normalized } = normalizeDiff(graph, diff);
		expect(normalized.update_nodes[0].body).toBeUndefined();

		const next = applyDiff(graph, normalized);
		const node = next.nodes.find((n) => n.id === "campaign_risk");
		expect(node?.status).toBe("resolved");
		// rich body untouched
		expect(node?.body).toBe(RISK_BODY);
	});

	it("accepts a valid full-body replacement but drops an invalid one", () => {
		const graph = riskGraph();
		const good = 'root = Card([h])\nh = CardHeader("Rewritten")';
		const okDiff = diffWithUpdate({ id: "campaign_risk", body: good });
		const okNorm = normalizeDiff(graph, okDiff).diff;
		expect(applyDiff(graph, okNorm).nodes[0].body).toBe(good);

		const badDiff = diffWithUpdate({
			id: "campaign_risk",
			body: 'root = Card([h, missing])\nh = CardHeader("x")',
		});
		const badNorm = normalizeDiff(graph, badDiff).diff;
		// invalid full body dropped → existing body preserved
		expect(badNorm.update_nodes[0].body).toBeUndefined();
		expect(applyDiff(graph, badNorm).nodes[0].body).toBe(RISK_BODY);
	});

	it("ignores body_patch when the node has no existing body", () => {
		const graph: Graph = {
			nodes: [{ id: "bare", label: "Bare", type: "decision" }],
			edges: [],
		};
		const diff = diffWithUpdate({
			id: "bare",
			body_patch: 'callout = Callout("info", "x", "y")',
		});
		const { diff: normalized, report } = normalizeDiff(graph, diff);
		expect(report.bodyPatchesFailed).toBe(1);
		expect(normalized.update_nodes[0].body).toBeUndefined();
	});
});
