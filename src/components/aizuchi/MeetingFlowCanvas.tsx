import "@xyflow/react/dist/style.css";

import { Renderer } from "@openuidev/react-lang";
import { openuiChatLibrary, ThemeProvider } from "@openuidev/react-ui";
import {
	Background,
	BackgroundVariant,
	type EdgeProps,
	getBezierPath,
	Handle,
	type InternalNode,
	type NodeProps,
	Position,
	ReactFlow,
	ReactFlowProvider,
	type Edge as RFEdge,
	type Node as RFNode,
	useEdgesState,
	useNodesState,
	useReactFlow,
	useStore,
} from "@xyflow/react";
import { useTheme } from "next-themes";
import {
	memo,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
} from "react";
import type { PositionMap } from "@/hooks/useForceLayout";
import type {
	Node as AzNode,
	EdgeRelation,
	Graph,
} from "@/lib/aizuchi/schemas";
import { cn } from "@/lib/utils";

// ─── relation styles ─────────────────────────────────────────────────────────
// Ported verbatim from MeetingCanvas — same colours, same dash treatment, so
// the visual language of the graph doesn't shift in the migration.

interface EdgeStyle {
	color: string;
	width: number;
	dashed?: boolean;
}

const RELATION_STYLE: Record<EdgeRelation, EdgeStyle> = {
	causes: { color: "rgb(249, 115, 22)", width: 1.5 },
	resolves: { color: "rgb(16, 185, 129)", width: 1.5 },
	blocks: { color: "rgb(239, 68, 68)", width: 1.5 },
	contradicts: { color: "rgb(244, 63, 94)", width: 1.25, dashed: true },
	supports: { color: "rgb(20, 184, 166)", width: 1.25 },
	depends_on: { color: "rgb(6, 182, 212)", width: 1.25 },
	owns: { color: "rgb(99, 102, 241)", width: 1.25 },
	decides: { color: "rgb(139, 92, 246)", width: 1.25 },
	assigned_to: { color: "rgb(34, 197, 94)", width: 1 },
	asks: { color: "rgb(245, 158, 11)", width: 1 },
	answers: { color: "rgb(16, 185, 129)", width: 1 },
	clarifies: { color: "rgb(14, 165, 233)", width: 1 },
	related_to: { color: "rgb(120, 120, 130)", width: 0.9 },
	mentions: { color: "rgb(160, 160, 170)", width: 0.7 },
	example_of: { color: "rgb(120, 113, 108)", width: 0.9 },
	alternative_to: { color: "rgb(249, 115, 22)", width: 0.9, dashed: true },
	precedes: { color: "rgb(100, 116, 139)", width: 1 },
};

// ─── geometry ────────────────────────────────────────────────────────────────
// Render width matches AIZ-52's NodeBody (280px) so OpenUI Cards have the
// expected presentation. The cap on rendered height keeps cards from growing
// taller than their force-layout footprint (~340px collision in
// useForceLayout.ts) — anything past the cap scrolls inside the card.
const NODE_WIDTH = 280;
const NODE_MAX_HEIGHT = 300;

// Camera framing — same constants the canvas used so the AI-follow and
// focus-enter motions feel identical.
const FIT_PADDING_FOCUS = 0.4;
const FIT_PADDING_AI = 0.6;
const FIT_PADDING_ALL = 0.3;
const FIT_DURATION_INTERACTIVE = 700;
const FIT_DURATION_FIRST = 600;

// ─── node / edge data shapes ─────────────────────────────────────────────────

interface ObservationNodeData extends Record<string, unknown> {
	node: AzNode;
	body: string;
	dimmed: boolean;
	focused: boolean;
	aiTouched: boolean;
	inNeighborhood: boolean;
}

type ObservationFlowNode = RFNode<ObservationNodeData, "observation">;

interface ObservationEdgeData extends Record<string, unknown> {
	relation: EdgeRelation;
	description?: string;
	dimmed: boolean;
	inNeighborhood: boolean;
}

type ObservationFlowEdge = RFEdge<ObservationEdgeData, "observation">;

// ─── ObservationNode ─────────────────────────────────────────────────────────

const ObservationNode = memo(function ObservationNode({
	data,
}: NodeProps<ObservationFlowNode>) {
	const { resolvedTheme } = useTheme();
	const mode = resolvedTheme === "dark" ? "dark" : "light";

	const ring = data.aiTouched
		? "ring-2 ring-emerald-500/90"
		: data.focused
			? "ring-2 ring-indigo-500/90"
			: data.inNeighborhood
				? "ring-1 ring-indigo-500/50"
				: "";

	return (
		<div
			data-node-id={data.node.id}
			className={cn(
				"rounded-xl transition-opacity",
				ring,
				data.dimmed && "opacity-30",
			)}
			style={{ width: NODE_WIDTH, maxHeight: NODE_MAX_HEIGHT }}
		>
			<Handle
				type="target"
				position={Position.Top}
				style={{ opacity: 0, pointerEvents: "none" }}
			/>
			<Handle
				type="source"
				position={Position.Bottom}
				style={{ opacity: 0, pointerEvents: "none" }}
			/>
			<div
				className="overflow-y-auto rounded-xl"
				style={{ maxHeight: NODE_MAX_HEIGHT }}
			>
				<ThemeProvider mode={mode}>
					<Renderer library={openuiChatLibrary} response={data.body} />
				</ThemeProvider>
			</div>
		</div>
	);
});

// ─── ObservationEdge (floating bezier between nearest faces) ─────────────────
// Floating-edges recipe (xyflow docs): instead of routing from fixed handles,
// each end of the path attaches to the boundary of its node nearest the other
// node. Matches what MeetingCanvas's bezierControls() did on canvas — edges
// look like they leave each card from its closest face.

function getNodeRect(node: InternalNode<ObservationFlowNode>) {
	const w = node.measured?.width ?? NODE_WIDTH;
	const h = node.measured?.height ?? NODE_MAX_HEIGHT;
	const x = node.internals.positionAbsolute.x;
	const y = node.internals.positionAbsolute.y;
	return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

function getNodeIntersection(
	node: InternalNode<ObservationFlowNode>,
	other: InternalNode<ObservationFlowNode>,
) {
	const n = getNodeRect(node);
	const o = getNodeRect(other);
	const w2 = n.w / 2;
	const h2 = n.h / 2;
	const dx = o.cx - n.cx;
	const dy = o.cy - n.cy;
	if (dx === 0 && dy === 0) return { x: n.cx, y: n.cy };
	const k = 1 / Math.max(Math.abs(dx) / w2, Math.abs(dy) / h2);
	return { x: n.cx + dx * k, y: n.cy + dy * k };
}

function getEdgePosition(
	node: InternalNode<ObservationFlowNode>,
	intersection: { x: number; y: number },
): Position {
	const n = getNodeRect(node);
	const px = Math.round(intersection.x);
	const py = Math.round(intersection.y);
	if (px <= Math.round(n.x) + 1) return Position.Left;
	if (px >= Math.round(n.x + n.w) - 1) return Position.Right;
	if (py <= Math.round(n.y) + 1) return Position.Top;
	return Position.Bottom;
}

function getEdgeParams(
	source: InternalNode<ObservationFlowNode>,
	target: InternalNode<ObservationFlowNode>,
) {
	const s = getNodeIntersection(source, target);
	const t = getNodeIntersection(target, source);
	return {
		sx: s.x,
		sy: s.y,
		tx: t.x,
		ty: t.y,
		sourcePos: getEdgePosition(source, s),
		targetPos: getEdgePosition(target, t),
	};
}

function ObservationEdge({
	id,
	source,
	target,
	data,
}: EdgeProps<ObservationFlowEdge>) {
	const sourceNode = useStore(
		useCallback((s) => s.nodeLookup.get(source), [source]),
	) as InternalNode<ObservationFlowNode> | undefined;
	const targetNode = useStore(
		useCallback((s) => s.nodeLookup.get(target), [target]),
	) as InternalNode<ObservationFlowNode> | undefined;
	if (!sourceNode || !targetNode || !data) return null;

	const params = getEdgeParams(sourceNode, targetNode);
	const [path, labelX, labelY] = getBezierPath({
		sourceX: params.sx,
		sourceY: params.sy,
		sourcePosition: params.sourcePos,
		targetX: params.tx,
		targetY: params.ty,
		targetPosition: params.targetPos,
	});

	const style = RELATION_STYLE[data.relation];
	const dimmed = data.dimmed;
	const inN = data.inNeighborhood;
	const strokeWidth = dimmed
		? style.width
		: inN
			? Math.max(2, style.width + 0.75)
			: style.width;
	const opacity = dimmed ? 0.15 : inN ? 1 : 0.65;

	return (
		<g>
			<path
				id={id}
				d={path}
				stroke={style.color}
				strokeWidth={strokeWidth}
				strokeOpacity={opacity}
				strokeDasharray={style.dashed ? "6 5" : undefined}
				fill="none"
				className="react-flow__edge-path"
			>
				{data.description ? <title>{data.description}</title> : null}
			</path>
			{!dimmed ? (
				<text
					x={labelX}
					y={labelY}
					textAnchor="middle"
					dominantBaseline="central"
					fill={style.color}
					fillOpacity={opacity}
					className="pointer-events-none select-none [paint-order:stroke] stroke-background"
					style={{
						fontSize: 10,
						fontFamily:
							"ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
						fontWeight: 500,
						strokeWidth: 4,
						strokeLinejoin: "round",
					}}
				>
					{data.relation.replaceAll("_", " ")}
					{data.description ? <title>{data.description}</title> : null}
				</text>
			) : null}
		</g>
	);
}

const nodeTypes = { observation: ObservationNode };
const edgeTypes = { observation: ObservationEdge };

// ─── exported component ──────────────────────────────────────────────────────

export interface MeetingFlowCanvasProps {
	graph: Graph;
	positions: PositionMap;
	highlightIds: ReadonlySet<string>;
	selectedId: string | null;
	/**
	 * Timestamp of the most recent d3-force settle. Drives the camera-framing
	 * effect — we only animate fitView when nodes have stopped moving so the
	 * camera doesn't chase mid-flight positions.
	 */
	settledAt: number;
	onNodeClick?: (node: AzNode) => void;
	onPaneClick?: () => void;
	onNodeHover?: (node: AzNode | null) => void;
	/** Floating overlay panels (status, transcript) rendered above the graph. */
	children?: ReactNode;
}

export function MeetingFlowCanvas(props: MeetingFlowCanvasProps) {
	return (
		<ReactFlowProvider>
			<MeetingFlowInner {...props} />
		</ReactFlowProvider>
	);
}

function MeetingFlowInner({
	graph,
	positions,
	highlightIds,
	selectedId,
	settledAt,
	onNodeClick,
	onPaneClick,
	onNodeHover,
	children,
}: MeetingFlowCanvasProps) {
	const rf = useReactFlow<ObservationFlowNode, ObservationFlowEdge>();
	const [nodes, , onNodesChange] = useNodesState<ObservationFlowNode>([]);
	const [edges, , onEdgesChange] = useEdgesState<ObservationFlowEdge>([]);

	const neighborhood = useMemo(() => {
		if (!selectedId) return null;
		const nodeIds = new Set<string>([selectedId]);
		const edgeIds = new Set<string>();
		for (const e of graph.edges) {
			if (e.from === selectedId) {
				nodeIds.add(e.to);
				edgeIds.add(e.id);
			} else if (e.to === selectedId) {
				nodeIds.add(e.from);
				edgeIds.add(e.id);
			}
		}
		return { nodeIds, edgeIds };
	}, [graph.edges, selectedId]);

	// Sync graph identity + visual state into ReactFlow's controlled `nodes`.
	// Positions for nodes that already existed are preserved; new nodes seed
	// from the force-layout map. Per-node `data` is a fresh object only when
	// the node actually appeared / its visual state changed — but to keep
	// this readable we recreate it on every relevant input, relying on
	// React.memo + identity-stable inner content (body string) for the
	// Renderer to dedupe.
	//
	// `positions` is intentionally excluded from the deps — first-paint seed
	// reads from it, but ongoing position updates flow through the dedicated
	// position-sync effect below. Including `positions` here would re-derive
	// the entire nodes array (and drop preserved per-node positions) on every
	// 60Hz sim tick.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see comment
	useEffect(() => {
		rf.setNodes((current) => {
			const posLookup = new Map(current.map((n) => [n.id, n.position]));
			return graph.nodes.map((n): ObservationFlowNode => {
				const inN = neighborhood?.nodeIds.has(n.id) ?? false;
				const dimmed = !!neighborhood && !inN;
				const focused = n.id === selectedId;
				const aiTouched = highlightIds.has(n.id);
				const body = n.body ?? "";
				const seed = positions.get(n.id);
				return {
					id: n.id,
					type: "observation",
					position:
						posLookup.get(n.id) ??
						(seed ? { x: seed.x, y: seed.y } : { x: 0, y: 0 }),
					data: {
						node: n,
						body,
						dimmed,
						focused,
						aiTouched,
						inNeighborhood: inN,
					},
					draggable: false,
					selectable: false,
				};
			});
		});
	}, [graph, neighborhood, selectedId, highlightIds, rf]);

	useEffect(() => {
		rf.setEdges(
			graph.edges.map(
				(e): ObservationFlowEdge => ({
					id: e.id,
					source: e.from,
					target: e.to,
					type: "observation",
					data: {
						relation: e.relation,
						description: e.description,
						dimmed: !!neighborhood && !neighborhood.edgeIds.has(e.id),
						inNeighborhood: neighborhood?.edgeIds.has(e.id) ?? false,
					},
					selectable: false,
				}),
			),
		);
	}, [graph.edges, neighborhood, rf]);

	// Per-tick position sync from the d3-force simulation. Skip nodes whose
	// position didn't change so React.memo on ObservationNode bails as much as
	// possible during a settle.
	useEffect(() => {
		rf.setNodes((current) =>
			current.map((n) => {
				const p = positions.get(n.id);
				if (!p) return n;
				if (n.position.x === p.x && n.position.y === p.y) return n;
				return { ...n, position: { x: p.x, y: p.y } };
			}),
		);
	}, [positions, rf]);

	// Click + hover wiring — translates ReactFlow's RFNode events back into
	// the route's AzNode-shaped callbacks.
	const handleNodeClick = useCallback(
		(_e: ReactMouseEvent, node: ObservationFlowNode) => {
			onNodeClick?.(node.data.node);
		},
		[onNodeClick],
	);
	const handlePaneClick = useCallback(() => {
		onPaneClick?.();
	}, [onPaneClick]);
	const handleNodeEnter = useCallback(
		(_e: ReactMouseEvent, node: ObservationFlowNode) => {
			onNodeHover?.(node.data.node);
		},
		[onNodeHover],
	);
	const handleNodeLeave = useCallback(() => {
		onNodeHover?.(null);
	}, [onNodeHover]);

	// ─── camera framing ───────────────────────────────────────────────────────
	// Same priority order as MeetingCanvas: focus enter > AI-touched > first
	// paint. User intent outranks AI work outranks the overview.

	const previousHighlightsRef = useRef<ReadonlySet<string>>(new Set());
	const pendingFitRef = useRef<string[] | null>(null);
	const firstFitDoneRef = useRef(false);
	const previousSelectedRef = useRef<string | null>(null);
	const pendingFocusFitRef = useRef<string | null>(null);

	useEffect(() => {
		const previous = previousHighlightsRef.current;
		const newlyTouched: string[] = [];
		for (const id of highlightIds) {
			if (!previous.has(id)) newlyTouched.push(id);
		}
		previousHighlightsRef.current = highlightIds;
		if (newlyTouched.length > 0) pendingFitRef.current = newlyTouched;
	}, [highlightIds]);

	useEffect(() => {
		if (selectedId !== previousSelectedRef.current) {
			if (selectedId) pendingFocusFitRef.current = selectedId;
			previousSelectedRef.current = selectedId;
		}
	}, [selectedId]);

	// `graph.nodes.length` listed only as a trigger; we read fresh state from
	// refs/the latest graph closure.
	// biome-ignore lint/correctness/useExhaustiveDependencies: triggers, not refs
	useEffect(() => {
		if (settledAt === 0) return;
		if (graph.nodes.length === 0) return;

		const pendingFocus = pendingFocusFitRef.current;
		pendingFocusFitRef.current = null;
		if (pendingFocus) {
			firstFitDoneRef.current = true;
			const ids = neighborhoodIdsFor(graph, pendingFocus);
			rf.fitView({
				nodes: ids.map((id) => ({ id })),
				padding: FIT_PADDING_FOCUS,
				maxZoom: 1.1,
				duration: FIT_DURATION_INTERACTIVE,
			});
			return;
		}
		const pending = pendingFitRef.current;
		pendingFitRef.current = null;
		if (pending && pending.length > 0) {
			firstFitDoneRef.current = true;
			rf.fitView({
				nodes: pending.map((id) => ({ id })),
				padding: FIT_PADDING_AI,
				maxZoom: 0.8,
				duration: FIT_DURATION_INTERACTIVE,
			});
			return;
		}
		if (!firstFitDoneRef.current) {
			firstFitDoneRef.current = true;
			rf.fitView({
				padding: FIT_PADDING_ALL,
				maxZoom: 0.8,
				duration: FIT_DURATION_FIRST,
			});
		}
	}, [settledAt, graph.nodes.length, rf]);

	return (
		<div className="relative h-full w-full bg-sidebar">
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onNodeClick={handleNodeClick}
				onPaneClick={handlePaneClick}
				onNodeMouseEnter={handleNodeEnter}
				onNodeMouseLeave={handleNodeLeave}
				nodesDraggable={false}
				nodesConnectable={false}
				elementsSelectable={false}
				panOnScroll
				zoomOnDoubleClick={false}
				minZoom={0.1}
				maxZoom={4}
				defaultViewport={{ x: 0, y: 0, zoom: 0.4 }}
			>
				<Background
					variant={BackgroundVariant.Dots}
					gap={32}
					size={1.5}
					color="rgba(120, 120, 130, 0.35)"
				/>
			</ReactFlow>
			{children}

			{/* Screen-reader mirror of the graph — the canvas was opaque to AT
			    and MeetingCanvas owned this aria block; ReactFlow's DOM is also
			    not semantically meaningful, so we keep mirroring here. */}
			<section aria-label="Meeting graph" className="sr-only">
				<ul>
					{graph.nodes.map((n) => (
						<li key={n.id}>
							{formatTypeForAria(n.type)}: {n.label}
							{n.description ? `. ${n.description}` : ""}
						</li>
					))}
				</ul>
			</section>
		</div>
	);
}

function neighborhoodIdsFor(graph: Graph, focused: string): string[] {
	const ids = new Set<string>([focused]);
	for (const e of graph.edges) {
		if (e.from === focused) ids.add(e.to);
		else if (e.to === focused) ids.add(e.from);
	}
	return Array.from(ids);
}

function formatTypeForAria(type: string): string {
	return type.replace(/_/g, " ");
}
