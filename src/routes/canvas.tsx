import "@xyflow/react/dist/style.css";

import { Renderer } from "@openuidev/react-lang";
import { openuiChatLibrary, ThemeProvider } from "@openuidev/react-ui";
import { createFileRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
	Background,
	BackgroundVariant,
	type Connection,
	ConnectionMode,
	Controls,
	Handle,
	type NodeProps,
	NodeToolbar,
	Position,
	ReactFlow,
	ReactFlowProvider,
	type Edge as RFEdge,
	type Node as RFNode,
	useEdgesState,
	useNodesInitialized,
	useNodesState,
	useReactFlow,
} from "@xyflow/react";
import { useTheme } from "next-themes";
import {
	createContext,
	memo,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { FloatingEdge } from "@/components/canvas/floating-edge";
import { type PinMap, useForceLayout } from "@/hooks/useForceLayout";
import { NoteEditor } from "@/lexical/NoteEditor";
import type {
	EdgeRelation,
	Graph,
	Node as LayoutNode,
} from "@/lib/aizuchi/schemas";
import type {
	CanvasDocument,
	CanvasEffect,
	CanvasNode as DocNode,
} from "@/lib/cli-core/canvas-schema";

export const Route = createFileRoute("/canvas")({
	component: CanvasPage,
});

// Which board this window shows. Read once from the URL (`/canvas?project=work`
// for the agent-work graph); a window's project is fixed for its lifetime.
function currentProject(): string {
	if (typeof window === "undefined") return "scratch-pad";
	return (
		new URLSearchParams(window.location.search).get("project") ?? "scratch-pad"
	);
}

// ─── edit context (lets editing nodes re-render in isolation) ────────────────

interface EditCtxValue {
	editingId: string | null;
	beginEdit: (id: string) => void;
	endEdit: () => void;
	updateNote: (id: string, payload: Record<string, unknown>) => void;
	removeNode: (id: string) => void;
	resize: (id: string, geom: ResizeGeom, phase: ResizePhase) => void;
	/** Set a fixed height, or `null` to restore content-driven (auto) height. */
	setHeight: (id: string, height: number | null) => void;
}
const EditCtx = createContext<EditCtxValue | null>(null);
const useEdit = () => useContext(EditCtx);

// ─── node rendering ──────────────────────────────────────────────────────────

interface CanvasNodeData extends Record<string, unknown> {
	node: DocNode;
	/** User-set card width (px). Undefined → kind default. */
	width?: number;
	/** User-set card height (px). Undefined → content-driven (auto). */
	height?: number;
}
type FlowNode = RFNode<CanvasNodeData, "canvas">;

// Content-rich kinds open wider; work nodes (task/agent/…) stay compact.
const MIN_NODE_WIDTH = 180;
const MIN_NODE_HEIGHT = 60;

// Auto fit-on-open zoom bounds. maxZoom keeps a sparse board from blowing up
// to fill the viewport; minZoom is the "max zoom-out" floor — open a big board
// and we fit/center as much as possible but never pull back past this, so cards
// stay legible instead of becoming a field of dots. Only clamps the programmatic
// open-fit; the ReactFlow minZoom={0.1} still lets the user pinch out further by
// hand. Keep FIT_MIN_ZOOM < FIT_MAX_ZOOM or the floor silently collapses.
const FIT_MIN_ZOOM = 0.35;
const FIT_MAX_ZOOM = 1;
function defaultWidth(kind: string): number {
	return kind === "note" || kind === "richview" || kind === "list" ? 360 : 240;
}

type ResizeGeom = { width?: number; height?: number; x?: number; y?: number };
type ResizePhase = "start" | "move" | "end";

interface FrameHandle {
	key: string;
	h?: "l" | "r";
	v?: "t" | "b";
	pos: string;
	cursor: string;
}
// 8 handles around the card edge (corners + edge midpoints), Figma-style.
const FRAME_HANDLES: FrameHandle[] = [
	{
		key: "tl",
		h: "l",
		v: "t",
		pos: "-left-1.5 -top-1.5",
		cursor: "cursor-nwse-resize",
	},
	{
		key: "t",
		v: "t",
		pos: "-top-1.5 left-1/2 -translate-x-1/2",
		cursor: "cursor-ns-resize",
	},
	{
		key: "tr",
		h: "r",
		v: "t",
		pos: "-right-1.5 -top-1.5",
		cursor: "cursor-nesw-resize",
	},
	{
		key: "r",
		h: "r",
		pos: "-right-1.5 top-1/2 -translate-y-1/2",
		cursor: "cursor-ew-resize",
	},
	{
		key: "br",
		h: "r",
		v: "b",
		pos: "-bottom-1.5 -right-1.5",
		cursor: "cursor-nwse-resize",
	},
	{
		key: "b",
		v: "b",
		pos: "-bottom-1.5 left-1/2 -translate-x-1/2",
		cursor: "cursor-ns-resize",
	},
	{
		key: "bl",
		h: "l",
		v: "b",
		pos: "-bottom-1.5 -left-1.5",
		cursor: "cursor-nesw-resize",
	},
	{
		key: "l",
		h: "l",
		pos: "-left-1.5 top-1/2 -translate-y-1/2",
		cursor: "cursor-ew-resize",
	},
];

// Selection frame drawn OUTSIDE the card. Right/bottom keep the top-left origin
// fixed; left/top handles move the node's origin (card grows up/left) — the
// parent reconciles position + re-pins on release. Start geometry is read live
// (card DOM size + node position) so it works at any zoom or height mode.
function ResizeFrame({
	nodeId,
	onResize,
}: {
	nodeId: string;
	onResize: (geom: ResizeGeom, phase: ResizePhase) => void;
}) {
	const rf = useReactFlow();
	const start = useRef<{
		cx: number;
		cy: number;
		x: number;
		y: number;
		w: number;
		h: number;
	} | null>(null);
	return (
		<>
			{FRAME_HANDLES.map((hdl) => (
				<div
					key={hdl.key}
					className={`nodrag nopan absolute z-50 h-2.5 w-2.5 rounded-[3px] border border-primary bg-background shadow-sm ${hdl.pos} ${hdl.cursor}`}
					onPointerDown={(e) => {
						e.stopPropagation();
						const node = rf.getNode(nodeId);
						const card = e.currentTarget.parentElement
							?.firstElementChild as HTMLElement | null;
						if (!node || !card) return;
						(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
						start.current = {
							cx: e.clientX,
							cy: e.clientY,
							x: node.position.x,
							y: node.position.y,
							w: card.offsetWidth,
							h: card.offsetHeight,
						};
						onResize({}, "start");
					}}
					onPointerMove={(e) => {
						const s = start.current;
						if (!s) return;
						const zoom = rf.getZoom();
						const dx = (e.clientX - s.cx) / zoom;
						const dy = (e.clientY - s.cy) / zoom;
						const geom: ResizeGeom = {};
						if (hdl.h === "r") {
							geom.width = Math.max(MIN_NODE_WIDTH, Math.round(s.w + dx));
						} else if (hdl.h === "l") {
							const w = Math.max(MIN_NODE_WIDTH, Math.round(s.w - dx));
							geom.width = w;
							geom.x = Math.round(s.x + (s.w - w));
						}
						if (hdl.v === "b") {
							geom.height = Math.max(MIN_NODE_HEIGHT, Math.round(s.h + dy));
						} else if (hdl.v === "t") {
							const h = Math.max(MIN_NODE_HEIGHT, Math.round(s.h - dy));
							geom.height = h;
							geom.y = Math.round(s.y + (s.h - h));
						}
						onResize(geom, "move");
					}}
					onPointerUp={(e) => {
						if (!start.current) return;
						start.current = null;
						(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
						onResize({}, "end");
					}}
				/>
			))}
		</>
	);
}

const STATUS_STYLE: Record<
	string,
	{ border: string; badge: string; text: string }
> = {
	pending: { border: "#94a3b8", badge: "#e2e8f0", text: "#475569" },
	in_progress: { border: "#3b82f6", badge: "#dbeafe", text: "#1e40af" },
	blocked: { border: "#f59e0b", badge: "#fef3c7", text: "#92400e" },
	done: { border: "#22c55e", badge: "#dcfce7", text: "#166534" },
	failed: { border: "#ef4444", badge: "#fee2e2", text: "#991b1b" },
};

const KIND_ACCENT: Record<string, string> = {
	note: "#eab308",
	topic: "#6366f1",
	list: "#0ea5e9",
	task: "#3b82f6",
	agent: "#8b5cf6",
	artifact: "#14b8a6",
	finding: "#64748b",
	blocker: "#ef4444",
	milestone: "#a855f7",
	decision: "#7c3aed",
	richview: "#0ea5e9",
};

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function nodeTitle(n: DocNode): string {
	const p = n.payload as Record<string, unknown>;
	return str(p.title) ?? str(p.label) ?? str(p.text) ?? n.id;
}

function NoteBody({ node }: { node: DocNode }) {
	const { resolvedTheme } = useTheme();
	const ctx = useEdit();
	const editing = ctx?.editingId === node.id;
	const md = str((node.payload as Record<string, unknown>).markdown) ?? "";
	const color = resolvedTheme === "dark" ? "#e5e7eb" : "#1f2937";

	if (!editing && !md) {
		return (
			<div className="text-[12px] italic text-muted-foreground">
				empty — double-click to edit
			</div>
		);
	}
	// Always render through Lexical so markdown is FORMATTED (headings, bold,
	// lists) rather than shown raw. `editable` toggles in place; only swallow
	// pointer events while editing so a read-only note stays drag-to-move.
	return (
		<div
			className={editing ? "nodrag cursor-text" : undefined}
			onPointerDown={editing ? (e) => e.stopPropagation() : undefined}
		>
			<NoteEditor
				body={md}
				editable={editing}
				textColor={color}
				onChange={(nb) => ctx?.updateNote(node.id, { markdown: nb })}
			/>
		</div>
	);
}

const CanvasNodeView = memo(function CanvasNodeView({
	data,
	selected,
}: NodeProps<FlowNode>) {
	const { resolvedTheme } = useTheme();
	const ctx = useEdit();
	const n = data.node;
	const p = n.payload as Record<string, unknown>;
	const accent = KIND_ACCENT[n.nodeType] ?? "#94a3b8";
	const status = str(p.status);
	const statusStyle = status ? STATUS_STYLE[status] : undefined;
	const isNote = n.nodeType === "note";
	const editing = ctx?.editingId === n.id;
	const nodeWidth = data.width ?? defaultWidth(n.nodeType);
	const nodeHeight = data.height; // undefined → content-driven (auto)

	let body: ReactNode = null;
	if (isNote) {
		body = <NoteBody node={n} />;
	} else if (n.nodeType === "richview" && str(p.spec)) {
		body = (
			<div className="max-h-[280px] overflow-y-auto">
				<ThemeProvider mode={resolvedTheme === "dark" ? "dark" : "light"}>
					<Renderer library={openuiChatLibrary} response={str(p.spec) ?? ""} />
				</ThemeProvider>
			</div>
		);
	} else if (n.nodeType === "list" && Array.isArray(p.items)) {
		body = (
			<ul className="list-disc pl-4 text-[12px] leading-snug text-foreground/80">
				{(p.items as unknown[]).map((it, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: static list render
					<li key={i}>{String(it)}</li>
				))}
			</ul>
		);
	} else {
		const detail = str(p.detail) ?? str(p.reason) ?? str(p.ref);
		if (detail) {
			body = (
				<div className="text-[12px] leading-snug text-foreground/70">
					{detail}
				</div>
			);
		}
	}

	return (
		// Outer wrapper shrink-wraps the card (w-fit) and is NOT clipped, so the
		// selection-frame handles can sit just outside the card edges.
		<div className="relative w-fit">
			<div
				data-node-id={n.id}
				className={`relative flex flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm ${selected ? "ring-2 ring-primary/60" : ""}`}
				style={{
					width: nodeWidth,
					height: nodeHeight,
					borderLeft: `4px solid ${statusStyle?.border ?? accent}`,
				}}
			>
				<NodeToolbar
					isVisible={selected}
					position={Position.Top}
					className="flex gap-1 rounded-md border bg-popover p-1 shadow-md"
				>
					{isNote ? (
						<button
							type="button"
							onClick={() => ctx?.beginEdit(n.id)}
							className="rounded px-2 py-0.5 text-[11px] hover:bg-accent"
						>
							Edit
						</button>
					) : null}
					<button
						type="button"
						onClick={() => ctx?.setHeight(n.id, nodeHeight ? null : 320)}
						className="rounded px-2 py-0.5 text-[11px] hover:bg-accent"
						title={
							nodeHeight
								? "Restore auto height (fit content)"
								: "Set a fixed, compact height (scrolls inside)"
						}
					>
						{nodeHeight ? "Auto height" : "Compact"}
					</button>
					<button
						type="button"
						onClick={() => ctx?.removeNode(n.id)}
						className="rounded px-2 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
					>
						Delete
					</button>
				</NodeToolbar>

				<Handle
					type="target"
					position={Position.Top}
					className="!h-2 !w-2 !border !border-background !bg-muted-foreground/50"
				/>
				<Handle
					type="source"
					position={Position.Bottom}
					className="!h-2 !w-2 !border !border-background !bg-muted-foreground/50"
				/>

				<div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-2">
					<span
						className="text-[9px] font-semibold uppercase tracking-wide"
						style={{ color: accent }}
					>
						{n.nodeType}
					</span>
					{status && statusStyle ? (
						<span
							className="rounded px-1.5 py-0.5 text-[9px] font-semibold"
							style={{ background: statusStyle.badge, color: statusStyle.text }}
						>
							{status.replace("_", " ")}
						</span>
					) : null}
				</div>

				{isNote && editing ? (
					<input
						// biome-ignore lint/a11y/noAutofocus: focus the title on entering edit mode
						autoFocus
						defaultValue={str(p.title) ?? ""}
						placeholder="Title…"
						className="nodrag w-full shrink-0 bg-transparent px-3 pb-1 pt-0.5 text-[13px] font-semibold leading-tight outline-none"
						onPointerDown={(e) => e.stopPropagation()}
						onBlur={(e) => ctx?.updateNote(n.id, { title: e.target.value })}
						onKeyDown={(e) => {
							if (e.key === "Enter") (e.target as HTMLInputElement).blur();
						}}
					/>
				) : (
					<div className="shrink-0 px-3 pb-1 pt-0.5 text-[13px] font-semibold leading-tight">
						{nodeTitle(n)}
					</div>
				)}

				{body ? (
					<div
						className={`min-h-0 flex-1 px-3 pb-2.5 ${nodeHeight ? "nowheel overflow-auto" : ""}`}
					>
						{body}
					</div>
				) : (
					<div className="pb-1.5" />
				)}
			</div>
			{selected ? (
				<ResizeFrame
					nodeId={n.id}
					onResize={(geom, phase) => ctx?.resize(n.id, geom, phase)}
				/>
			) : null}
		</div>
	);
});

const nodeTypes = { canvas: CanvasNodeView };
const edgeTypes = { floating: FloatingEdge };

// ─── layout-graph adaptation (canvas doc → useForceLayout's Graph) ───────────

// Relations the meeting force-layout link table knows. Canvas-only relations
// (part_of/produces) coerce to related_to for layout; the visual edge keeps
// its real relation + styling.
const LAYOUT_RELATIONS = new Set<EdgeRelation>([
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
]);

function toLayoutRelation(r: string): EdgeRelation {
	return LAYOUT_RELATIONS.has(r as EdgeRelation)
		? (r as EdgeRelation)
		: "related_to";
}

function docToLayoutGraph(doc: CanvasDocument): Graph {
	return {
		nodes: doc.nodes.map(
			(n): LayoutNode => ({ id: n.id, label: n.id, type: "topic" }),
		),
		edges: doc.edges.map((e) => ({
			id: e.id,
			from: e.from,
			to: e.to,
			relation: toLayoutRelation(e.relation),
		})),
	};
}

function gridPos(index: number): { x: number; y: number } {
	const cols = 4;
	return { x: (index % cols) * 300, y: Math.floor(index / cols) * 220 };
}

// ─── app shell: one window, board switcher in a sidebar ──────────────────────

interface BoardEntry {
	id: string;
	title: string;
	kind: string;
	nodeCount: number;
}

// Always-present boards, even before they're written to disk.
const DEFAULT_BOARDS: BoardEntry[] = [
	{
		id: "scratch-pad",
		title: "Scratch Pad",
		kind: "scratch_pad",
		nodeCount: 0,
	},
	{ id: "work", title: "Agent Work", kind: "agent_work", nodeCount: 0 },
];

function CanvasPage() {
	return <CanvasShell />;
}

function CanvasShell() {
	const [project, setProject] = useState(currentProject);
	const [boards, setBoards] = useState<BoardEntry[]>(DEFAULT_BOARDS);

	const refreshBoards = useCallback(async () => {
		try {
			const list = await invoke<
				{
					projectId: string;
					title: string;
					kind: string;
					nodeCount: number;
				}[]
			>("canvas_list_projects");
			const byId = new Map<string, BoardEntry>(
				DEFAULT_BOARDS.map((b) => [b.id, { ...b }]),
			);
			for (const p of list) {
				byId.set(p.projectId, {
					id: p.projectId,
					title: p.title || p.projectId,
					kind: p.kind,
					nodeCount: p.nodeCount,
				});
			}
			// scratch-pad + work pinned first, the rest after.
			const rest = [...byId.values()].filter(
				(b) => b.id !== "scratch-pad" && b.id !== "work",
			);
			const ordered = [
				byId.get("scratch-pad"),
				byId.get("work"),
				...rest,
			].filter((b): b is BoardEntry => !!b);
			setBoards(ordered);
		} catch (e) {
			console.error("[canvas] list projects failed", e);
		}
	}, []);

	useEffect(() => {
		refreshBoards();
		let unlisten: (() => void) | undefined;
		listen("canvas:changed", () => refreshBoards()).then((fn) => {
			unlisten = fn;
		});
		return () => unlisten?.();
	}, [refreshBoards]);

	return (
		<div className="flex h-screen w-screen bg-background text-foreground">
			<aside className="flex w-52 flex-col border-r bg-sidebar">
				<div className="px-4 py-3 text-sm font-semibold tracking-tight">
					Aizuchi
				</div>
				<div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
					Boards
				</div>
				<nav className="flex flex-col gap-0.5 px-2">
					{boards.map((b) => (
						<button
							key={b.id}
							type="button"
							onClick={() => setProject(b.id)}
							className={`flex items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] ${
								b.id === project
									? "bg-accent font-medium text-accent-foreground"
									: "text-foreground/80 hover:bg-accent/50"
							}`}
						>
							<span className="truncate">{b.title}</span>
							{b.nodeCount > 0 ? (
								<span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
									{b.nodeCount}
								</span>
							) : null}
						</button>
					))}
				</nav>
			</aside>
			<main className="relative min-w-0 flex-1">
				{/* Remount the whole canvas per board so layout/pins/state reset cleanly. */}
				<ReactFlowProvider key={project}>
					<CanvasInner project={project} />
				</ReactFlowProvider>
			</main>
		</div>
	);
}

function CanvasInner({ project }: { project: string }) {
	const projectRef = useRef(project);
	projectRef.current = project;
	const rf = useReactFlow<FlowNode, RFEdge>();
	const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>([]);
	const [editingId, setEditingId] = useState<string | null>(null);

	// Canonical doc + bookkeeping refs.
	const docRef = useRef<CanvasDocument | null>(null);
	const knownVersion = useRef(0);
	const draggingRef = useRef<Set<string>>(new Set());
	const geometryDirty = useRef(false);
	const userMovedViewport = useRef(false);
	const didInitialFit = useRef(false);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const undoStack = useRef<CanvasDocument[]>([]);
	const redoStack = useRef<CanvasDocument[]>([]);

	// Layout inputs: `pins` freeze placed nodes; `seedPositions` give new nodes
	// a first position. Rebuilt from the doc on (re)load; `pins` grows as new
	// nodes settle.
	const [layoutGraph, setLayoutGraph] = useState<Graph>({
		nodes: [],
		edges: [],
	});
	const [pins, setPins] = useState<PinMap>(new Map());
	const [seedPositions, setSeedPositions] = useState<PinMap>(new Map());

	const { positions, settledAt } = useForceLayout(
		layoutGraph,
		null,
		pins,
		seedPositions,
	);
	const positionsRef = useRef(positions);
	positionsRef.current = positions;
	// Flips true once every visible card has been measured (xyflow needs
	// measured dims for a correct fit) — the trigger for the instant open-fit.
	const nodesInitialized = useNodesInitialized();

	// ── load / reload ──────────────────────────────────────────────────────
	const reload = useCallback(async () => {
		const doc = await invoke<CanvasDocument>("canvas_get", {
			projectId: projectRef.current,
		});
		docRef.current = doc;
		knownVersion.current = doc.version;
		const saved: PinMap = new Map(
			Object.entries(doc.positions).map(([id, p]) => [id, { x: p.x, y: p.y }]),
		);
		setSeedPositions(saved);
		setPins(saved);
		setLayoutGraph(docToLayoutGraph(doc));
		setNodes(
			doc.nodes.map((n, i): FlowNode => {
				const live = positionsRef.current.get(n.id);
				const pos = live ?? doc.positions[n.id] ?? gridPos(i);
				return {
					id: n.id,
					type: "canvas",
					position: { x: pos.x, y: pos.y },
					data: {
						node: n,
						width: doc.sizes?.[n.id]?.width,
						height: doc.sizes?.[n.id]?.height,
					},
				};
			}),
		);
		setEdges(
			doc.edges.map(
				(e): RFEdge => ({
					id: e.id,
					source: e.from,
					target: e.to,
					type: "floating",
					data: { relation: e.relation },
				}),
			),
		);
	}, [setNodes, setEdges]);

	useEffect(() => {
		reload().catch((e) => console.error("[canvas] load failed", e));
	}, [reload]);

	// Live sync from agents / other windows (ignore the echo of our own writes).
	useEffect(() => {
		let unlisten: (() => void) | undefined;
		listen<{ projectId: string; version: number }>("canvas:changed", (ev) => {
			if (
				ev.payload.projectId === projectRef.current &&
				ev.payload.version > knownVersion.current
			) {
				reload().catch((e) => console.error("[canvas] reload failed", e));
			}
		}).then((fn) => {
			unlisten = fn;
		});
		return () => unlisten?.();
	}, [reload]);

	// ── per-tick position sync (skip nodes the user is dragging) ─────────────
	useEffect(() => {
		setNodes((current) =>
			current.map((n) => {
				if (draggingRef.current.has(n.id)) return n;
				const p = positions.get(n.id);
				if (!p) return n;
				if (n.position.x === p.x && n.position.y === p.y) return n;
				return { ...n, position: { x: p.x, y: p.y } };
			}),
		);
	}, [positions, setNodes]);

	// ── camera: open centered on the content, then animate the zoom-out ──────
	// The force sim takes ~2s to fully settle (alpha decay), and the settle-fit
	// below waits for that — even when every node is pinned at a saved spot and
	// the layout is already final on the first frame. So frame the board the
	// instant its cards are measured (fitView needs measured dims) rather than
	// waiting. We center on the content's bounding-box center first (the same
	// point fitView targets), then animate fitView to it: a smooth zoom-OUT
	// from the middle of the board instead of a hard snap. A fresh board gets
	// re-framed by the settle-fit once the sim spreads its nodes out.
	// biome-ignore lint/correctness/useExhaustiveDependencies: nodesInitialized is the trigger
	useEffect(() => {
		if (!nodesInitialized || didInitialFit.current) return;
		if (userMovedViewport.current) return;
		const ns = rf.getNodes();
		if (ns.length === 0) return;
		didInitialFit.current = true;
		// Content bounding box → its center is where we open the camera.
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const n of ns) {
			const w = n.measured?.width ?? 0;
			const h = n.measured?.height ?? 0;
			minX = Math.min(minX, n.position.x);
			minY = Math.min(minY, n.position.y);
			maxX = Math.max(maxX, n.position.x + w);
			maxY = Math.max(maxY, n.position.y + h);
		}
		// Open looking at the middle of the board at normal zoom...
		rf.setCenter((minX + maxX) / 2, (minY + maxY) / 2, {
			zoom: FIT_MAX_ZOOM,
			duration: 0,
		});
		// ...then (next frame, so the center is committed) animate the pull-back
		// to frame the whole board. A small/single-node board already fits at
		// FIT_MAX_ZOOM, so this is a no-op move; a big board zooms smoothly out.
		requestAnimationFrame(() => {
			if (userMovedViewport.current) return;
			rf.fitView({
				padding: 0.3,
				maxZoom: FIT_MAX_ZOOM,
				minZoom: FIT_MIN_ZOOM,
				duration: 600,
			});
		});
	}, [nodesInitialized]);

	// ── camera: re-fit when the sim settles, until the user takes control ────
	// biome-ignore lint/correctness/useExhaustiveDependencies: settledAt is the trigger
	useEffect(() => {
		if (settledAt === 0 || userMovedViewport.current) return;
		if (rf.getNodes().length === 0) return;
		rf.fitView({
			padding: 0.3,
			maxZoom: FIT_MAX_ZOOM,
			minZoom: FIT_MIN_ZOOM,
			duration: 400,
		});
	}, [settledAt]);

	// ── geometry persistence ─────────────────────────────────────────────────
	const savePositions = useCallback(async () => {
		const base = docRef.current;
		if (!base || !geometryDirty.current) return;
		geometryDirty.current = false;
		const nextPositions: Record<string, { x: number; y: number }> = {};
		for (const [id, p] of positionsRef.current) {
			nextPositions[id] = { x: p.x, y: p.y };
		}
		const nextSizes: Record<string, { width: number; height?: number }> = {};
		for (const n of rf.getNodes()) {
			const w = n.data.width;
			const h = n.data.height;
			// Persist only manually-sized cards (width and/or height set).
			if (w !== undefined || h !== undefined) {
				nextSizes[n.id] = {
					width: w ?? defaultWidth(n.data.node.nodeType),
					...(h !== undefined ? { height: h } : {}),
				};
			}
		}
		const doc: CanvasDocument = {
			...base,
			positions: nextPositions,
			sizes: nextSizes,
			pinned: Array.from(pins.keys()),
			version: knownVersion.current,
		};
		try {
			const saved = await invoke<CanvasDocument>("canvas_put", {
				projectId: projectRef.current,
				doc,
			});
			docRef.current = saved;
			knownVersion.current = saved.version;
		} catch (e) {
			if (String(e).includes("conflict")) await reload();
			else console.error("[canvas] save failed", e);
		}
	}, [pins, reload, rf]);

	const scheduleSave = useCallback(() => {
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => {
			savePositions().catch((e) => console.error(e));
		}, 500);
	}, [savePositions]);

	// When the sim settles, pin newly-placed nodes at their resting spot and
	// persist. Only does real work when something actually moved.
	// biome-ignore lint/correctness/useExhaustiveDependencies: settledAt is the trigger
	useEffect(() => {
		if (settledAt === 0) return;
		const missing: [string, { x: number; y: number }][] = [];
		for (const [id, p] of positionsRef.current) {
			if (!pins.has(id)) missing.push([id, { x: p.x, y: p.y }]);
		}
		if (missing.length > 0) {
			geometryDirty.current = true;
			setPins((prev) => new Map([...prev, ...missing]));
			scheduleSave();
		}
	}, [settledAt]);

	// ── drag → pin ───────────────────────────────────────────────────────────
	const onNodeDragStart = useCallback((_e: unknown, node: FlowNode) => {
		userMovedViewport.current = true;
		draggingRef.current.add(node.id);
	}, []);

	const onNodeDragStop = useCallback(
		(_e: unknown, node: FlowNode) => {
			draggingRef.current.delete(node.id);
			geometryDirty.current = true;
			setPins((prev) => {
				const next = new Map(prev);
				next.set(node.id, { x: node.position.x, y: node.position.y });
				return next;
			});
			scheduleSave();
		},
		[scheduleSave],
	);

	// ── effects helper (records undo for local structural mutations) ─────────
	const applyEffects = useCallback(
		async (effects: CanvasEffect[], recordUndo = true) => {
			if (recordUndo && docRef.current) {
				undoStack.current.push(structuredClone(docRef.current));
				redoStack.current = [];
			}
			await invoke("canvas_apply_effects", {
				projectId: projectRef.current,
				effects,
			});
		},
		[],
	);

	const addNote = useCallback(async () => {
		const id = `note_${Date.now().toString(36)}`;
		await applyEffects([
			{
				op: "add",
				node: {
					id,
					nodeType: "note",
					payload: { title: "New note", markdown: "" },
				},
			},
		]);
		setEditingId(id);
	}, [applyEffects]);

	const onConnect = useCallback(
		(c: Connection) => {
			if (!c.source || !c.target || c.source === c.target) return;
			const id = `e_${c.source}__${c.target}_${Date.now().toString(36)}`;
			applyEffects([
				{
					op: "connect",
					edge: { id, from: c.source, to: c.target, relation: "related_to" },
				},
			]).catch((e) => console.error(e));
		},
		[applyEffects],
	);

	const onNodesDelete = useCallback(
		(deleted: FlowNode[]) => {
			const effects: CanvasEffect[] = deleted.map((n) => ({
				op: "remove",
				id: n.id,
			}));
			if (effects.length > 0)
				applyEffects(effects).catch((e) => console.error(e));
		},
		[applyEffects],
	);

	// Re-run layout from scratch (drop all pins → organic arrangement).
	const tidy = useCallback(() => {
		geometryDirty.current = true;
		userMovedViewport.current = false; // let the camera re-frame the tidy result
		setPins(new Map());
		scheduleSave();
	}, [scheduleSave]);

	// ── undo / redo (best-effort whole-doc restore via CAS) ──────────────────
	const restore = useCallback(
		async (snapshot: CanvasDocument) => {
			try {
				const saved = await invoke<CanvasDocument>("canvas_put", {
					projectId: projectRef.current,
					doc: { ...snapshot, version: knownVersion.current },
				});
				docRef.current = saved;
				knownVersion.current = saved.version;
				await reload();
			} catch (e) {
				if (String(e).includes("conflict")) await reload();
				else console.error("[canvas] restore failed", e);
			}
		},
		[reload],
	);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
			const target = e.target as HTMLElement | null;
			if (
				target?.closest('[contenteditable="true"]') ||
				target?.tagName === "INPUT" ||
				target?.tagName === "TEXTAREA"
			)
				return; // let the editor handle its own undo
			e.preventDefault();
			if (e.shiftKey) {
				const doc = redoStack.current.pop();
				if (doc && docRef.current) {
					undoStack.current.push(structuredClone(docRef.current));
					restore(doc).catch((err) => console.error(err));
				}
			} else {
				const doc = undoStack.current.pop();
				if (doc && docRef.current) {
					redoStack.current.push(structuredClone(docRef.current));
					restore(doc).catch((err) => console.error(err));
				}
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [restore]);

	const updateNote = useCallback(
		(id: string, payload: Record<string, unknown>) => {
			applyEffects([{ op: "update", id, payload }], false).catch((e) =>
				console.error(e),
			);
		},
		[applyEffects],
	);

	const removeNode = useCallback(
		(id: string) => {
			applyEffects([{ op: "remove", id }]).catch((e) => console.error(e));
		},
		[applyEffects],
	);

	// Width is app/user-owned geometry (like position): set it on the live node
	// and persist via the debounced geometry save (whole-doc PUT incl. `sizes`).
	const handleResize = useCallback(
		(id: string, geom: ResizeGeom, phase: ResizePhase) => {
			if (phase === "start") {
				// Skip the per-tick layout sync for this node while resizing so a
				// left/top resize can move its position without the sim fighting it.
				draggingRef.current.add(id);
				return;
			}
			if (phase === "end") {
				draggingRef.current.delete(id);
				const node = rf.getNode(id);
				if (node) {
					setPins((prev) => {
						const next = new Map(prev);
						next.set(id, { x: node.position.x, y: node.position.y });
						return next;
					});
				}
				geometryDirty.current = true;
				scheduleSave();
				return;
			}
			// move
			setNodes((current) =>
				current.map((n) => {
					if (n.id !== id) return n;
					const data = { ...n.data };
					if (geom.width !== undefined) data.width = geom.width;
					if (geom.height !== undefined) data.height = geom.height;
					const position =
						geom.x !== undefined || geom.y !== undefined
							? { x: geom.x ?? n.position.x, y: geom.y ?? n.position.y }
							: n.position;
					return { ...n, position, data };
				}),
			);
		},
		[rf, setNodes, setPins, scheduleSave],
	);

	const setHeight = useCallback(
		(id: string, height: number | null) => {
			setNodes((current) =>
				current.map((n) => {
					if (n.id !== id) return n;
					const data = { ...n.data };
					if (height === null) data.height = undefined;
					else data.height = height;
					return { ...n, data };
				}),
			);
			geometryDirty.current = true;
			scheduleSave();
		},
		[setNodes, scheduleSave],
	);

	const editCtx = useMemo<EditCtxValue>(
		() => ({
			editingId,
			beginEdit: (id) => setEditingId(id),
			endEdit: () => setEditingId(null),
			updateNote,
			removeNode,
			resize: handleResize,
			setHeight,
		}),
		[editingId, updateNote, removeNode, handleResize, setHeight],
	);

	return (
		<EditCtx.Provider value={editCtx}>
			<div className="relative h-full w-full bg-background">
				<ReactFlow
					nodes={nodes}
					edges={edges}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					connectionMode={ConnectionMode.Loose}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					onConnect={onConnect}
					onNodeDragStart={onNodeDragStart}
					onNodeDragStop={onNodeDragStop}
					onNodesDelete={onNodesDelete}
					onNodeDoubleClick={(_e, node) => {
						if (node.data.node.nodeType === "note") setEditingId(node.id);
					}}
					onPaneClick={() => setEditingId(null)}
					onMoveStart={(e) => {
						// Real pan/zoom gestures carry an event; programmatic
						// fitView passes null — only the former takes control.
						if (e) userMovedViewport.current = true;
					}}
					nodesDraggable
					panOnScroll
					zoomOnDoubleClick={false}
					deleteKeyCode={["Backspace", "Delete"]}
					minZoom={0.1}
					maxZoom={2.5}
				>
					<Background variant={BackgroundVariant.Dots} gap={28} size={1.5} />
					<Controls />
				</ReactFlow>
				<div className="absolute left-3 top-3 flex items-center gap-2">
					<button
						type="button"
						onClick={() => addNote().catch((e) => console.error(e))}
						className="rounded-md border bg-card px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-accent"
					>
						+ Note
					</button>
					<button
						type="button"
						onClick={tidy}
						className="rounded-md border bg-card px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-accent"
						title="Re-run the force layout"
					>
						Tidy
					</button>
					<span className="rounded-md border bg-card/80 px-2 py-1 text-[11px] text-muted-foreground">
						<span className="font-medium text-foreground/80">{project}</span> ·{" "}
						{nodes.length} node{nodes.length === 1 ? "" : "s"}
					</span>
				</div>
			</div>
		</EditCtx.Provider>
	);
}
