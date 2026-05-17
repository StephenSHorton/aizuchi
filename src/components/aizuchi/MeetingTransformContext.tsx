import { type ZoomTransform, zoomIdentity } from "d3-zoom";
import { createContext, useContext } from "react";

export interface NodeWorldRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface MeetingTransformAPI {
	getTransform(): ZoomTransform;
	getContainer(): HTMLDivElement | null;
	getNodeWorldRect(nodeId: string): NodeWorldRect | null;
	subscribe(cb: () => void): () => void;
	/**
	 * Increments on every pan/zoom interaction start and ticks during the
	 * gesture; consumers can debounce their own work against this if they
	 * want to skip layout during continuous motion. Currently unused by the
	 * overlay layer — kept here so future perf passes can read gesture
	 * state without re-instrumenting MeetingCanvas.
	 */
	getGestureState(): "idle" | "active";
}

const NULL_API: MeetingTransformAPI = {
	getTransform: () => zoomIdentity,
	getContainer: () => null,
	getNodeWorldRect: () => null,
	subscribe: () => () => {},
	getGestureState: () => "idle",
};

export const MeetingTransformContext =
	createContext<MeetingTransformAPI>(NULL_API);

export function useMeetingTransform(): MeetingTransformAPI {
	return useContext(MeetingTransformContext);
}
