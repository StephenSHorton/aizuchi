/**
 * Public barrel for the Aizuchi IPC core client.
 *
 * Consumers (the base CLI in `bin/`, the extended CLI in AIZ-22, the
 * MCP refactor in AIZ-23, and any future TS tooling) should import
 * from `@/lib/cli-core` only — never reach into individual modules.
 */

export type {
	AddNodeInput,
	CanvasDocument,
	CanvasEdge,
	CanvasEffect,
	CanvasNode,
	EdgeRelation,
	EffectsAck,
	NodeKind,
	ProjectMeta,
	WorkStatus,
} from "./canvas-schema";
export {
	AddNodeInputSchema,
	CanvasDocumentSchema,
	CanvasEffectSchema,
	EdgeRelationSchema,
	NodeKindSchema,
	WorkStatusSchema,
} from "./canvas-schema";
export type { AizuchiClientOptions } from "./client";
export { AizuchiClient } from "./client";
export { defaultBaseDir, loadIpcConfig } from "./discovery";
export {
	AppNotRunningError,
	AuthError,
	ConflictError,
	errorFromServer,
	IpcClientError,
	NotFoundError,
	TokenPermsError,
	ValidationError,
} from "./errors";
export type {
	AppStatus,
	CreatePadInput,
	ImportAudioMeetingInput,
	ImportMeetingInput,
	ImportMeetingResponse,
	IpcConfig,
	ListPadsOptions,
	MeetingMeta,
	MeetingMode,
	MeetingSnapshot,
	Note,
	NoteColor,
	PadPatch,
	Position,
	RenameMeetingInput,
	ResumeMeetingResponse,
	RunStats,
	Size,
	StartMeetingResponse,
} from "./types";

/** Convenience factory — equivalent to `AizuchiClient.create(opts)`. */
import { AizuchiClient, type AizuchiClientOptions } from "./client";
export function createClient(
	opts?: AizuchiClientOptions,
): Promise<AizuchiClient> {
	return AizuchiClient.create(opts);
}
