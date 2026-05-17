import { Renderer } from "@openuidev/react-lang";
import { openuiChatLibrary } from "@openuidev/react-ui";
import { useEffect, useRef } from "react";
import { useMeetingTransform } from "./MeetingTransformContext";

interface NodeBodyProps {
	nodeId: string;
	body: string;
}

const BODY_WIDTH = 280;

/**
 * AIZ-52 — DOM render of a single node's OpenUI Lang body, docked at the
 * node's force-layout position and following pan/zoom imperatively via
 * MeetingTransformContext. Subscribes to per-RAF-frame notifications so
 * the position updates happen in the same draw loop as the canvas itself —
 * no React re-render on every frame.
 *
 * Centered on the node's geometric center (not anchored to a side) since
 * the body REPLACES the pill rather than overlaying it.
 */
export function NodeBody({ nodeId, body }: NodeBodyProps) {
	const api = useMeetingTransform();
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;

		const update = () => {
			const rect = api.getNodeWorldRect(nodeId);
			if (!rect) {
				el.style.opacity = "0";
				el.style.pointerEvents = "none";
				return;
			}
			const transform = api.getTransform();
			const cx = rect.x + rect.w / 2;
			const cy = rect.y + rect.h / 2;
			const sx = transform.x + cx * transform.k;
			const sy = transform.y + cy * transform.k;
			el.style.transform = `translate3d(${sx}px, ${sy}px, 0) translate(-50%, -50%)`;
			el.style.opacity = "1";
			el.style.pointerEvents = "auto";
		};

		update();
		return api.subscribe(update);
	}, [api, nodeId]);

	return (
		<div
			ref={ref}
			data-node-body={nodeId}
			className="absolute top-0 left-0 will-change-transform"
			style={{
				width: BODY_WIDTH,
				opacity: 0,
				pointerEvents: "none",
			}}
		>
			<Renderer library={openuiChatLibrary} response={body} />
		</div>
	);
}
