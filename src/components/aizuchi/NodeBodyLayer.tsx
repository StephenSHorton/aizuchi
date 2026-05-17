import type { Node as AzNode, Graph } from "@/lib/aizuchi/schemas";
import { NodeBody } from "./NodeBody";

interface NodeBodyLayerProps {
	graph: Graph;
	/**
	 * Forwarded from the route — selection state is owned upstream. Same
	 * shape as MeetingCanvas's `onNodeClick` so the route's existing focus-
	 * mode handler keeps working when the click originates in the DOM card
	 * layer instead of the canvas hit-test.
	 */
	onNodeClick?: (node: AzNode) => void;
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
export function NodeBodyLayer({ graph, onNodeClick }: NodeBodyLayerProps) {
	return (
		<div className="pointer-events-none absolute inset-0 z-10">
			{graph.nodes
				.filter((n) => typeof n.body === "string" && n.body.length > 0)
				.map((n) => (
					<NodeBody
						key={n.id}
						nodeId={n.id}
						body={n.body as string}
						onClick={onNodeClick ? () => onNodeClick(n) : undefined}
					/>
				))}
		</div>
	);
}
