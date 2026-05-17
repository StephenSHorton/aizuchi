import type { Graph } from "@/lib/aizuchi/schemas";
import { NodeBody } from "./NodeBody";

interface NodeBodyLayerProps {
	graph: Graph;
}

/**
 * AIZ-52 — sibling DOM layer placed inside MeetingCanvas's children
 * (and therefore inside MeetingTransformContext). Renders one
 * {@link NodeBody} per graph node whose extraction produced an OpenUI
 * Lang `body`. Nodes without a body remain as the canvas-drawn pill.
 *
 * Wrapper is `pointer-events: none` so the underlying canvas still
 * receives pan/zoom gestures everywhere except inside an actual body.
 */
export function NodeBodyLayer({ graph }: NodeBodyLayerProps) {
	return (
		<div className="pointer-events-none absolute inset-0 z-10">
			{graph.nodes
				.filter((n) => typeof n.body === "string" && n.body.length > 0)
				.map((n) => (
					<NodeBody key={n.id} nodeId={n.id} body={n.body as string} />
				))}
		</div>
	);
}
