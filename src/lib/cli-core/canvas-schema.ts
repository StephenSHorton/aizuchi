/**
 * Canvas wire schema — the SINGLE source of truth for the node-canvas
 * contract, imported by BOTH the typed IPC client (`client.ts`) and the
 * bundled MCP server (`mcp-server/src/index.ts`). No hand-mirror on the TS
 * side; only the Rust `serde` structs in `src-tauri/src/canvas.rs` are a
 * second representation.
 *
 * Design rules carried from agility-platform's scratch pad:
 *  - Topology (nodes/edges) and geometry (positions/pinned) are separate.
 *    The AI emits topology ONLY; the app owns geometry. So effects never
 *    carry coordinates.
 *  - `nodeType`/`relation` are LOOSE on the persisted document (forward-
 *    migration: a board written by a newer build still loads) but the
 *    agent-facing tool inputs are CLOSED enums (tools-over-prompts fence).
 *  - A node's `id` is an agent-chosen stable slug; reusing it upserts. That
 *    is the cross-agent address — two agents collaborate by reusing ids, no
 *    out-of-band uuid exchange.
 *
 * Relation string values intentionally match Aizuchi's existing
 * `EdgeRelation` (src/lib/aizuchi/schemas.ts) so the canvas reuses the
 * meeting canvas's relation styling + d3-force link tuning unchanged.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Closed vocabularies (agent-facing)
// ---------------------------------------------------------------------------

/** Node kinds. Scratch-pad family + agent-work family on one canvas. */
export const NodeKindSchema = z.enum([
	// scratch-pad family
	"note",
	"topic",
	"list",
	"richview",
	// agent-work family
	"task",
	"agent",
	"artifact",
	"finding",
	"blocker",
	"milestone",
	"decision",
]);
export type NodeKind = z.infer<typeof NodeKindSchema>;

/** Edge relations. Values match Aizuchi's existing EdgeRelation strings. */
export const EdgeRelationSchema = z.enum([
	"owns",
	"depends_on",
	"blocks",
	"related_to",
	"decides",
	"assigned_to",
	"causes",
	"contradicts",
	"supports",
	"example_of",
	"alternative_to",
	"precedes",
	"resolves",
	"clarifies",
	"part_of",
	"produces",
]);
export type EdgeRelation = z.infer<typeof EdgeRelationSchema>;

/** Work lifecycle status — a field on task/milestone payloads. */
export const WorkStatusSchema = z.enum([
	"pending",
	"in_progress",
	"blocked",
	"done",
	"failed",
]);
export type WorkStatus = z.infer<typeof WorkStatusSchema>;

// ---------------------------------------------------------------------------
// Per-kind payloads (agent-facing, for `add_node`). Closed shapes; the
// persisted node payload is a loose record so future kinds round-trip.
// ---------------------------------------------------------------------------

export const NoteNodePayloadSchema = z.object({
	title: z.string().optional(),
	markdown: z.string().default(""),
});

export const TopicNodePayloadSchema = z.object({
	label: z.string(),
});

export const ListNodePayloadSchema = z.object({
	title: z.string().optional(),
	items: z.array(z.string()).default([]),
});

export const TaskNodePayloadSchema = z.object({
	title: z.string(),
	status: WorkStatusSchema.default("pending"),
	detail: z.string().optional(),
});

export const AgentNodePayloadSchema = z.object({
	label: z.string(),
	agentId: z.string().optional(),
	cwd: z.string().optional(),
	gitBranch: z.string().optional(),
});

export const ArtifactNodePayloadSchema = z.object({
	label: z.string(),
	artifactType: z.enum(["file", "pr", "diff", "commit", "output", "url"]),
	ref: z.string().optional(),
});

export const FindingNodePayloadSchema = z.object({
	text: z.string(),
	severity: z.enum(["info", "decision", "risk"]).optional(),
});

export const BlockerNodePayloadSchema = z.object({
	label: z.string(),
	reason: z.string().optional(),
});

export const MilestoneNodePayloadSchema = z.object({
	label: z.string(),
	status: WorkStatusSchema.optional(),
});

export const DecisionNodePayloadSchema = z.object({
	label: z.string(),
	detail: z.string().optional(),
	alternative: z.string().optional(),
});

/** richview body — OpenUI-Lang spec rendered against Aizuchi's OpenUI palette. */
export const RichviewNodePayloadSchema = z.object({
	spec: z.string(),
});

// ---------------------------------------------------------------------------
// Persisted shapes (loose — mirror the Rust serde structs)
// ---------------------------------------------------------------------------

export const UserMetaSchema = z.object({
	noteForAI: z.string().optional(),
	pinned: z.boolean().optional(),
});
export type UserMeta = z.infer<typeof UserMetaSchema>;

export const CanvasNodeSchema = z.object({
	id: z.string(),
	/** Loose on read (forward-migration); closed on the agent-write path. */
	nodeType: z.string(),
	payload: z.record(z.string(), z.unknown()).default({}),
	userMeta: UserMetaSchema.optional(),
	createdBy: z.string().optional(),
});
export type CanvasNode = z.infer<typeof CanvasNodeSchema>;

export const CanvasEdgeSchema = z.object({
	id: z.string(),
	from: z.string(),
	to: z.string(),
	relation: z.string(),
	animated: z.boolean().optional(),
	label: z.string().optional(),
});
export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>;

export const CanvasPositionSchema = z.object({ x: z.number(), y: z.number() });
export type CanvasPosition = z.infer<typeof CanvasPositionSchema>;

/** User-set card size (client-owned geometry). `height` is set only when the
 * user manually resizes it; otherwise height is content-driven (auto). */
export const CanvasSizeSchema = z.object({
	width: z.number(),
	height: z.number().optional(),
});
export type CanvasSize = z.infer<typeof CanvasSizeSchema>;

export const CanvasDocumentSchema = z.object({
	schemaVersion: z.number().int().default(1),
	projectId: z.string(),
	kind: z.string().default("scratch_pad"),
	title: z.string().default(""),
	nodes: z.array(CanvasNodeSchema).default([]),
	edges: z.array(CanvasEdgeSchema).default([]),
	positions: z.record(z.string(), CanvasPositionSchema).default({}),
	sizes: z.record(z.string(), CanvasSizeSchema).default({}),
	pinned: z.array(z.string()).default([]),
	/** Monotonic CAS counter; bumps on every mutation. */
	version: z.number().int().nonnegative().default(0),
	updatedAt: z.string().optional(),
	updatedBy: z.string().optional(),
});
export type CanvasDocument = z.infer<typeof CanvasDocumentSchema>;

export const ProjectMetaSchema = z.object({
	projectId: z.string(),
	kind: z.string(),
	title: z.string(),
	nodeCount: z.number().int(),
	edgeCount: z.number().int(),
	version: z.number().int(),
	updatedAt: z.string().nullish(),
});
export type ProjectMeta = z.infer<typeof ProjectMetaSchema>;

// ---------------------------------------------------------------------------
// Effect union — mirrors the Rust `CanvasEffect` (internally tagged on `op`).
// Geometry ops are absent BY DESIGN (the AI never sets position).
// ---------------------------------------------------------------------------

export const CanvasEffectSchema = z.discriminatedUnion("op", [
	z.object({ op: z.literal("add"), node: CanvasNodeSchema }),
	z.object({ op: z.literal("connect"), edge: CanvasEdgeSchema }),
	z.object({
		op: z.literal("update"),
		id: z.string(),
		payload: z.record(z.string(), z.unknown()).default({}),
	}),
	z.object({
		op: z.literal("set_relation"),
		id: z.string(),
		relation: z.string(),
	}),
	z.object({ op: z.literal("remove"), id: z.string() }),
	z.object({ op: z.literal("remove_edge"), id: z.string() }),
	z.object({ op: z.literal("clear") }),
]);
export type CanvasEffect = z.infer<typeof CanvasEffectSchema>;

/** POST /v1/canvas/:id/effects request body. */
export const EffectsBodySchema = z.object({
	effects: z.array(CanvasEffectSchema).min(1),
	author: z.string().optional(),
});
export type EffectsBody = z.infer<typeof EffectsBodySchema>;

/** POST /v1/canvas/:id/effects response. */
export const EffectsAckSchema = z.object({
	version: z.number().int(),
	applied: z.number().int(),
	affected: z.array(z.string()),
});
export type EffectsAck = z.infer<typeof EffectsAckSchema>;

// ---------------------------------------------------------------------------
// Agent-facing add-node input (closed payload by kind) — used by the MCP
// `canvas_add_node` tool to validate before constructing an `add` effect.
// ---------------------------------------------------------------------------

export const AddNodeInputSchema = z.discriminatedUnion("kind", [
	z.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
		kind: z.literal("note"),
		payload: NoteNodePayloadSchema,
	}),
	z.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
		kind: z.literal("topic"),
		payload: TopicNodePayloadSchema,
	}),
	z.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
		kind: z.literal("list"),
		payload: ListNodePayloadSchema,
	}),
	z.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
		kind: z.literal("task"),
		payload: TaskNodePayloadSchema,
	}),
	z.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
		kind: z.literal("agent"),
		payload: AgentNodePayloadSchema,
	}),
	z.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
		kind: z.literal("artifact"),
		payload: ArtifactNodePayloadSchema,
	}),
	z.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
		kind: z.literal("finding"),
		payload: FindingNodePayloadSchema,
	}),
	z.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
		kind: z.literal("blocker"),
		payload: BlockerNodePayloadSchema,
	}),
	z.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
		kind: z.literal("milestone"),
		payload: MilestoneNodePayloadSchema,
	}),
	z.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
		kind: z.literal("decision"),
		payload: DecisionNodePayloadSchema,
	}),
]);
export type AddNodeInput = z.infer<typeof AddNodeInputSchema>;
