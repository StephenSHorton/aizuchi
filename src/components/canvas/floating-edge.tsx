/**
 * Floating bezier edge for the node canvas. Each endpoint attaches to the
 * face of its node nearest the other node (recomputed live as nodes move),
 * so edges never cross the card and we don't need per-handle bookkeeping.
 *
 * The intersection math is ported from `MeetingFlowCanvas`'s `ObservationEdge`
 * (the xyflow floating-edge recipe) and generalized: relation styling covers
 * the full canvas edge vocabulary, and node geometry is read via
 * `useInternalNode` so any custom node size works.
 */

import {
	type EdgeProps,
	getBezierPath,
	type InternalNode,
	Position,
	useInternalNode,
} from "@xyflow/react";

interface EdgeStyle {
	color: string;
	width: number;
	dashed?: boolean;
}

// Values cover the canvas EdgeRelation vocabulary (a superset of the meeting
// canvas's relations). Colors mirror MeetingFlowCanvas's RELATION_STYLE so the
// visual language is consistent across both canvases.
const RELATION_STYLE: Record<string, EdgeStyle> = {
	owns: { color: "rgb(99, 102, 241)", width: 1.25 },
	depends_on: { color: "rgb(6, 182, 212)", width: 1.25 },
	blocks: { color: "rgb(239, 68, 68)", width: 1.5 },
	related_to: { color: "rgb(120, 120, 130)", width: 0.9 },
	decides: { color: "rgb(139, 92, 246)", width: 1.25 },
	assigned_to: { color: "rgb(34, 197, 94)", width: 1 },
	causes: { color: "rgb(249, 115, 22)", width: 1.5 },
	contradicts: { color: "rgb(244, 63, 94)", width: 1.25, dashed: true },
	supports: { color: "rgb(20, 184, 166)", width: 1.25 },
	example_of: { color: "rgb(120, 113, 108)", width: 0.9 },
	alternative_to: { color: "rgb(249, 115, 22)", width: 0.9, dashed: true },
	precedes: { color: "rgb(100, 116, 139)", width: 1 },
	resolves: { color: "rgb(16, 185, 129)", width: 1.5 },
	clarifies: { color: "rgb(14, 165, 233)", width: 1 },
	part_of: { color: "rgb(148, 163, 184)", width: 1, dashed: true },
	produces: { color: "rgb(13, 148, 136)", width: 1.25 },
};

function getNodeRect(node: InternalNode) {
	const w = node.measured?.width ?? 240;
	const h = node.measured?.height ?? 120;
	const x = node.internals.positionAbsolute.x;
	const y = node.internals.positionAbsolute.y;
	return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

function getNodeIntersection(node: InternalNode, other: InternalNode) {
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
	node: InternalNode,
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

export function FloatingEdge({
	id,
	source,
	target,
	data,
	selected,
}: EdgeProps) {
	const sourceNode = useInternalNode(source);
	const targetNode = useInternalNode(target);
	if (!sourceNode || !targetNode) return null;

	const s = getNodeIntersection(sourceNode, targetNode);
	const t = getNodeIntersection(targetNode, sourceNode);
	const [path, labelX, labelY] = getBezierPath({
		sourceX: s.x,
		sourceY: s.y,
		sourcePosition: getEdgePosition(sourceNode, s),
		targetX: t.x,
		targetY: t.y,
		targetPosition: getEdgePosition(targetNode, t),
	});

	const relation = (data?.relation as string | undefined) ?? "related_to";
	const style = RELATION_STYLE[relation] ?? {
		color: "rgb(148,163,184)",
		width: 1,
	};
	const strokeWidth = selected ? style.width + 1 : style.width;

	return (
		<g>
			<path
				id={id}
				d={path}
				stroke={style.color}
				strokeWidth={strokeWidth}
				strokeOpacity={selected ? 1 : 0.7}
				strokeDasharray={style.dashed ? "6 5" : undefined}
				fill="none"
				className="react-flow__edge-path"
			/>
			<text
				x={labelX}
				y={labelY}
				textAnchor="middle"
				dominantBaseline="central"
				fill={style.color}
				fillOpacity={selected ? 1 : 0.75}
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
				{relation.replace(/_/g, " ")}
			</text>
		</g>
	);
}
