import { Renderer } from "@openuidev/react-lang";
import { openuiChatLibrary, ThemeProvider } from "@openuidev/react-ui";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";
import { useMeetingTransform } from "./MeetingTransformContext";

interface NodeBodyProps {
	nodeId: string;
	body: string;
}

const BODY_WIDTH = 280;
const BODY_MAX_HEIGHT = 220;

/**
 * AIZ-52 — DOM render of a single node's OpenUI Lang body, docked at the
 * node's force-layout position and following pan/zoom imperatively via
 * MeetingTransformContext. Subscribes to per-RAF-frame notifications so
 * the position updates happen in the same draw loop as the canvas itself —
 * no React re-render on every frame.
 *
 * Centered on the node's geometric center (not anchored to a side) since
 * the body REPLACES the pill rather than overlaying it.
 *
 * Theme is forwarded to OpenUI's ThemeProvider from next-themes so the
 * cards follow the app's light/dark mode instead of OpenUI's built-in
 * default. Height is capped so the force-layout collision rect (~220 in
 * useForceLayout.ts) keeps approximately matching the rendered DOM size.
 */
export function NodeBody({ nodeId, body }: NodeBodyProps) {
	const api = useMeetingTransform();
	const ref = useRef<HTMLDivElement>(null);
	const { resolvedTheme } = useTheme();
	const mode = resolvedTheme === "dark" ? "dark" : "light";

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
			className="absolute top-0 left-0 overflow-y-auto will-change-transform"
			style={{
				width: BODY_WIDTH,
				maxHeight: BODY_MAX_HEIGHT,
				opacity: 0,
				pointerEvents: "none",
			}}
		>
			<ThemeProvider mode={mode}>
				<Renderer library={openuiChatLibrary} response={body} />
			</ThemeProvider>
		</div>
	);
}
