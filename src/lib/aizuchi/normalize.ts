import type { ExtractionMode } from "./persistence";
import type {
	Edge,
	EdgeRelation,
	Graph,
	GraphDiff,
	Node,
	NodeType,
} from "./schemas";

// AIZ-52 — only these node types are allowed to carry an OpenUI Lang
// `body`. Bodies on other types are an over-emission by Gemma — silently
// dropped here so the frontend doesn't try to render Card-shells for
// every context/work_item node and crowd out the canvas.
const RICH_BODY_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
	"decision",
	"risk",
	"metric",
	"event",
]);

function stripStrayBody<T extends { type?: NodeType; body?: string }>(
	node: T,
): T {
	if (
		node.body !== undefined &&
		node.type !== undefined &&
		!RICH_BODY_TYPES.has(node.type)
	) {
		const { body: _body, ...rest } = node;
		return rest as T;
	}
	return node;
}

/**
 * AIZ-52 — string literal escape for OpenUI Lang DSL. Same shape as JSON
 * string literals (double-quoted, backslash escapes), but we serialize via
 * JSON.stringify which handles every edge case (quotes, newlines, unicode).
 */
function lit(s: string | undefined | null): string {
	return JSON.stringify(s ?? "");
}

function severityVariant(
	likelihood: string | undefined,
	impact: string | undefined,
): string {
	const score = (s?: string) =>
		s === "high" ? 2 : s === "medium" ? 1 : s === "low" ? 0 : 0.5;
	const total = score(likelihood) + score(impact);
	if (total >= 3) return "danger"; // both high, or high+medium
	if (total >= 1.5) return "warning"; // at least one medium-or-up
	return "info";
}

/**
 * AIZ-52 — type-aware fallback body. Fires when Gemma classified a node as
 * a rich type but forgot to emit \`body\`. The model dropping a required
 * field is common in \`generateObject\` flows where Zod marks it optional;
 * we'd rather render a minimal-but-distinct card than fall back to a pill
 * that contradicts the user's "rich type = OpenUI body" model.
 *
 * Bodies are tailored per type so they don't all look identical:
 *   - risk → Callout, variant picked from likelihood/impact severity.
 *   - decision → CardHeader (the choice) + rationale + optional alternative.
 *   - metric → x-large-heavy value tile + target line + label header.
 *   - event → CardHeader title+subtitle (occurredAt as subtitle).
 *
 * Returns undefined when no plausible synthesis exists — caller leaves
 * \`body\` absent in that case (rare; the label + description fallback
 * should always work).
 */
function synthesizeFallbackBody(node: {
	label: string;
	type: NodeType;
	description?: string;
	likelihood?: string;
	impact?: string;
	value?: string;
	target?: string;
	unit?: string;
	occurredAt?: string;
	alternative?: string;
}): string | undefined {
	const desc = node.description?.trim() || "";
	switch (node.type) {
		case "risk": {
			const variant = severityVariant(node.likelihood, node.impact);
			const headline =
				node.likelihood && node.impact
					? `${node.likelihood} likelihood / ${node.impact} impact`
					: "Risk";
			return [
				"root = Card([callout])",
				`callout = Callout(${lit(variant)}, ${lit(headline)}, ${lit(desc || node.label)})`,
			].join("\n");
		}
		case "metric": {
			const lines = [
				"root = Card([head, val])",
				`head = CardHeader(${lit(node.label)})`,
			];
			const value = node.value
				? node.unit
					? `${node.value} ${node.unit}`
					: node.value
				: desc || node.label;
			lines.push(`val = TextContent(${lit(value)}, "x-large-heavy")`);
			if (node.target) {
				const targetLine = `Target: ${node.target}${node.unit ? ` ${node.unit}` : ""}`;
				lines[0] = "root = Card([head, val, sub])";
				lines.push(`sub = TextContent(${lit(targetLine)}, "small")`);
			}
			return lines.join("\n");
		}
		case "event": {
			const head = node.occurredAt
				? `head = CardHeader(${lit(node.label)}, ${lit(node.occurredAt)})`
				: `head = CardHeader(${lit(node.label)})`;
			if (!desc) {
				return ["root = Card([head])", head].join("\n");
			}
			return [
				"root = Card([head, body])",
				head,
				`body = TextContent(${lit(desc)})`,
			].join("\n");
		}
		case "decision": {
			const lines = [
				"root = Card([head, body])",
				`head = CardHeader(${lit(node.label)})`,
				`body = TextContent(${lit(desc || "Decision made.")})`,
			];
			if (node.alternative) {
				lines[0] = "root = Card([head, body, alt])";
				lines.push(
					`alt = TextCallout("info", ${lit(`Alternative weighed: ${node.alternative}.`)})`,
				);
			}
			return lines.join("\n");
		}
		default:
			return undefined;
	}
}

function fillMissingBody<T extends { type?: NodeType; body?: string }>(
	node: T,
): T {
	if (
		node.type !== undefined &&
		RICH_BODY_TYPES.has(node.type) &&
		(node.body === undefined || node.body.trim().length === 0)
	) {
		// Need label at minimum to synthesize. NodeUpdate may omit label;
		// in that case skip — we don't have enough to invent.
		const candidate = node as T & {
			label?: string;
			description?: string;
			likelihood?: string;
			impact?: string;
			value?: string;
			target?: string;
			unit?: string;
			occurredAt?: string;
			alternative?: string;
		};
		if (!candidate.label) return node;
		const body = synthesizeFallbackBody({
			label: candidate.label,
			type: node.type,
			description: candidate.description,
			likelihood: candidate.likelihood,
			impact: candidate.impact,
			value: candidate.value,
			target: candidate.target,
			unit: candidate.unit,
			occurredAt: candidate.occurredAt,
			alternative: candidate.alternative,
		});
		if (body) return { ...node, body };
	}
	return node;
}

const SPECIFIC_RELATIONS: ReadonlySet<EdgeRelation> = new Set([
	"owns",
	"depends_on",
	"blocks",
	"decides",
	"assigned_to",
	"answers",
	// AIZ-12 — richer vocabulary; all dominate `related_to` for the same pair.
	"causes",
	"contradicts",
	"supports",
	"example_of",
	"alternative_to",
	"precedes",
	"resolves",
	"clarifies",
]);

/**
 * AIZ-33 — substance-mode meta-commitment patterns. The model keeps
 * surfacing ticket/tracking process-management as `action_item` in
 * substance mode (e.g. "Creating Linear tasks to track updates"). Even
 * with a tightened prompt definition the model rephrases the same
 * meta-commentary; this filter strips them after the fact.
 *
 * These patterns are intentionally narrow — they target the failure
 * mode without filtering legitimate substance action_items like "Ship
 * the Postgres migration by Friday" or "Write a one-pager on the badge
 * UX." Each pattern matches what a "vague" candidate looks like in
 * label or description, NOT in the upstream transcript itself.
 */
const SUBSTANCE_VAGUE_ACTION_PATTERNS: readonly RegExp[] = [
	/\bthe commitment to\b/i,
	/\bcommit(?:ment|ting|s)? to (?:track|create|file|open)\b/i,
	/\bcreat(?:e|ing|ion of)\b[^.]*?\b(?:tasks?|tickets?|issues?|cards?)\b/i,
	/\btrack(?:ing|s)?\b[^.]*?\b(?:these|those|the\s+\w+|necessary|updates?)\b/i,
];

function speakerToId(speaker: string): string {
	return speaker.trim().toLowerCase().replace(/\s+/g, "_");
}

function pairKey(from: string, to: string): string {
	return `${from}|${to}`;
}

export interface NormalizeReport {
	addedPersonNodes: string[];
	droppedRedundantRelatedTo: number;
	droppedTrivialMentions: number;
	droppedSelfLoops: number;
	droppedDuplicateEdges: number;
	droppedPersonMerges: number;
	droppedDuplicateThoughts: number;
	thrashGuardTriggered: boolean;
	droppedVagueActionItems: number;
	addedAssignedToEdges: number;
}

export interface NormalizeResult {
	diff: GraphDiff;
	report: NormalizeReport;
}

/**
 * Reject a diff that would delete more than this fraction of the existing
 * graph in one pass. Catches model-side thrashing where the LLM forgets
 * the cumulative-memory rule and tries to start over.
 */
const THRASH_NODE_REMOVAL_FRACTION = 0.5;

/**
 * Post-process a model-produced diff to handle structural correctness the
 * prompt can't reliably enforce:
 *
 *   1. Auto-create person nodes for any 'speaker' field reference that
 *      lacks a corresponding person node (model frequently forgets this).
 *   2. Drop 'related_to' edges when a more specific edge (owns, depends_on,
 *      blocks, decides, assigned_to, answers) already covers the same pair.
 *   3. Drop 'mentions' edges from a person to a target the same person owns.
 *   4. (AIZ-33) Drop vague action_item nodes that fail the per-mode bar:
 *      attribution requires an `assigned_to` edge; substance rejects
 *      labels/descriptions matching meta-tracking patterns.
 */
export function normalizeDiff(
	graph: Graph,
	diff: GraphDiff,
	mode?: ExtractionMode,
): NormalizeResult {
	const report: NormalizeReport = {
		addedPersonNodes: [],
		droppedRedundantRelatedTo: 0,
		droppedTrivialMentions: 0,
		droppedSelfLoops: 0,
		droppedDuplicateEdges: 0,
		droppedPersonMerges: 0,
		droppedDuplicateThoughts: 0,
		thrashGuardTriggered: false,
		droppedVagueActionItems: 0,
		addedAssignedToEdges: 0,
	};

	if (diff.no_changes) {
		return { diff, report };
	}

	// Thrash guard — if the model is trying to wipe most of the existing
	// graph in one pass, drop the removes (keep additions / updates / notes).
	let removeNodes = diff.remove_nodes;
	let removeEdges = diff.remove_edges;
	if (
		graph.nodes.length > 4 &&
		removeNodes.length / graph.nodes.length > THRASH_NODE_REMOVAL_FRACTION
	) {
		report.thrashGuardTriggered = true;
		removeNodes = [];
		removeEdges = [];
	}

	// AIZ-33 — auto-fix + drop pass for action_item nodes.
	//
	// Auto-fix (attribution): if the model emits an action_item with a
	// `speaker` field but forgets the `assigned_to` edge, add the edge
	// ourselves. The model frequently does this because the prompt asks
	// it to do two things (set speaker AND add edge) and only one lands.
	//
	// Drop (attribution): action_items must have an `assigned_to` edge
	// to a person — after auto-fix runs.
	//
	// Drop (substance): no owner anchor; fall back to keyword-based
	// meta-commitment detection on label + description.
	const droppedActionIds = new Set<string>();
	const synthesizedAssignedEdges: Edge[] = [];
	if (mode === "attribution") {
		const personIdsForCheck = new Set<string>();
		for (const n of graph.nodes)
			if (n.type === "person") personIdsForCheck.add(n.id);
		for (const n of diff.add_nodes)
			if (n.type === "person") personIdsForCheck.add(n.id);
		// Speakers will be lifted to person nodes later in this pass.
		// Pre-compute their ids so the assigned_to auto-fix can target
		// a person even before the person node is materialized.
		for (const n of [...graph.nodes, ...diff.add_nodes]) {
			if (n.speaker) personIdsForCheck.add(speakerToId(n.speaker));
		}

		const assignedToTargets = new Map<string, string>(); // action_item id → person id
		const recordAssigned = (e: Edge) => {
			if (e.relation === "assigned_to") assignedToTargets.set(e.from, e.to);
		};
		for (const e of graph.edges) recordAssigned(e);
		for (const e of diff.add_edges) recordAssigned(e);

		for (const n of diff.add_nodes) {
			if (n.type !== "action_item") continue;
			let target = assignedToTargets.get(n.id);
			if (!target && n.speaker) {
				const candidate = speakerToId(n.speaker);
				if (personIdsForCheck.has(candidate)) {
					target = candidate;
					assignedToTargets.set(n.id, candidate);
					synthesizedAssignedEdges.push({
						id: `${n.id}-assigned_to-${candidate}`,
						from: n.id,
						to: candidate,
						relation: "assigned_to",
					});
				}
			}
			if (!target || !personIdsForCheck.has(target)) {
				droppedActionIds.add(n.id);
			}
		}
		report.addedAssignedToEdges = synthesizedAssignedEdges.length;
	} else if (mode === "substance") {
		// No owner anchor available — fall back to keyword-based meta-
		// commitment detection on label + description.
		for (const n of diff.add_nodes) {
			if (n.type !== "action_item") continue;
			const haystack = `${n.label}\n${n.description ?? ""}`;
			if (SUBSTANCE_VAGUE_ACTION_PATTERNS.some((re) => re.test(haystack))) {
				droppedActionIds.add(n.id);
			}
		}
	}

	report.droppedVagueActionItems = droppedActionIds.size;

	const filteredAddNodes =
		droppedActionIds.size === 0
			? diff.add_nodes
			: diff.add_nodes.filter((n) => !droppedActionIds.has(n.id));
	const filteredUpdateNodes =
		droppedActionIds.size === 0
			? diff.update_nodes
			: diff.update_nodes.filter((u) => !droppedActionIds.has(u.id));
	const addEdgesAfterActionFilter =
		droppedActionIds.size === 0
			? [...diff.add_edges, ...synthesizedAssignedEdges]
			: [
					...diff.add_edges.filter(
						(e) => !droppedActionIds.has(e.from) && !droppedActionIds.has(e.to),
					),
					...synthesizedAssignedEdges,
				];

	// Dedupe thoughts within a single diff by id (keep the last occurrence).
	const thoughtById = new Map<string, (typeof diff.notes)[number]>();
	for (const t of diff.notes) {
		if (thoughtById.has(t.id)) report.droppedDuplicateThoughts++;
		thoughtById.set(t.id, t);
	}
	const dedupedThoughts = [...thoughtById.values()];

	// 1. Ensure every referenced speaker has a person node.
	const personIds = new Set<string>();
	for (const n of graph.nodes) if (n.type === "person") personIds.add(n.id);
	for (const n of filteredAddNodes)
		if (n.type === "person") personIds.add(n.id);

	// Refuse merges that would absorb a person into another person — different
	// people are never duplicates of each other.
	const filteredMerges = diff.merge_nodes.filter((m) => {
		const keepIsPerson = personIds.has(m.keep);
		const absorbHasPerson = m.absorb.some((id) => personIds.has(id));
		if (keepIsPerson && absorbHasPerson) {
			report.droppedPersonMerges++;
			return false;
		}
		return true;
	});

	const speakers = new Set<string>();
	for (const n of [...graph.nodes, ...filteredAddNodes]) {
		if (n.speaker) speakers.add(n.speaker);
	}

	const addedPersonNodes: Node[] = [];
	for (const speaker of speakers) {
		const id = speakerToId(speaker);
		if (!personIds.has(id)) {
			addedPersonNodes.push({ id, label: speaker, type: "person" });
			personIds.add(id);
			report.addedPersonNodes.push(id);
		}
	}

	// 2 & 3. Filter add_edges with the post-merge picture in mind.
	const relationsByPair = new Map<string, Set<EdgeRelation>>();
	const recordPair = (e: Edge) => {
		const key = pairKey(e.from, e.to);
		let set = relationsByPair.get(key);
		if (!set) {
			set = new Set();
			relationsByPair.set(key, set);
		}
		set.add(e.relation);
	};
	for (const e of graph.edges) recordPair(e);
	for (const e of addEdgesAfterActionFilter) recordPair(e);

	const personOwnsTarget = (from: string, to: string): boolean => {
		const has = (edges: Edge[]) =>
			edges.some(
				(e) => e.from === from && e.to === to && e.relation === "owns",
			);
		return has(graph.edges) || has(addEdgesAfterActionFilter);
	};

	const filteredEdges: Edge[] = [];
	const tripleKey = (e: Edge) => `${e.from}|${e.to}|${e.relation}`;
	const existingTriples = new Set<string>(graph.edges.map(tripleKey));
	const seenInDiff = new Set<string>();
	for (const e of addEdgesAfterActionFilter) {
		if (e.from === e.to) {
			report.droppedSelfLoops++;
			continue;
		}
		const triple = tripleKey(e);
		if (existingTriples.has(triple) || seenInDiff.has(triple)) {
			report.droppedDuplicateEdges++;
			continue;
		}
		if (e.relation === "related_to") {
			const relations = relationsByPair.get(pairKey(e.from, e.to));
			const hasSpecific =
				relations && [...relations].some((r) => SPECIFIC_RELATIONS.has(r));
			if (hasSpecific) {
				report.droppedRedundantRelatedTo++;
				continue;
			}
		}
		if (e.relation === "mentions" && personOwnsTarget(e.from, e.to)) {
			report.droppedTrivialMentions++;
			continue;
		}
		seenInDiff.add(triple);
		filteredEdges.push(e);
	}

	return {
		diff: {
			...diff,
			add_nodes: [...filteredAddNodes, ...addedPersonNodes]
				.map(stripStrayBody)
				.map(fillMissingBody),
			add_edges: filteredEdges,
			update_nodes: filteredUpdateNodes
				.map(stripStrayBody)
				.map(fillMissingBody),
			merge_nodes: filteredMerges,
			remove_nodes: removeNodes,
			remove_edges: removeEdges,
			notes: dedupedThoughts,
		},
		report,
	};
}
