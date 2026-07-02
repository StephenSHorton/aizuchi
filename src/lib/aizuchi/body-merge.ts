/**
 * AIZ-60 / #119 — incremental editing for node bodies.
 *
 * When Gemma updates an existing rich-type node it can emit a PATCH
 * (`body_patch`) — only the changed/new OpenUI Lang statements — instead of
 * regenerating the whole body. We merge the patch into the node's current
 * body so the body accumulates substance over the meeting.
 *
 * We use OpenUI Lang's own incremental-editing engine: `mergeStatements`
 * from `@openuidev/lang-core` (verified present in the installed
 * `@openuidev/lang-core@0.2.x`, re-exported by `@openuidev/react-lang`).
 * Same-named statements replace, unmentioned statements are kept, and
 * statements no longer reachable from `root` are garbage-collected. We
 * import from `@openuidev/lang-core` directly rather than `react-lang`
 * because `react-lang`'s entry pulls in React (its `<Renderer>`), which
 * makes it unimportable in the headless `bun test` / Node harness contexts;
 * `lang-core` is pure and loads everywhere.
 *
 * Every merged body is re-parsed with the real parser (built from the same
 * `openuiChatLibrary` the canvas renders with) so we catch the failure modes
 * the issue calls out — dangling references ("unknown statement names
 * referenced"), dropped-component prop errors, or an empty/root-less result
 * — BEFORE a corrupt body can reach the canvas. On any failure the caller
 * falls back to the last-known-good body (see normalize.ts).
 */

import {
	createParser,
	mergeStatements,
	type Parser,
} from "@openuidev/lang-core";
import { openuiChatLibrary } from "@openuidev/react-ui";

/** Aizuchi bodies always name their entry point `root = Card(...)`. */
const ROOT_ID = "root";

let cachedParser: Parser | null = null;
function getParser(): Parser {
	if (cachedParser === null) {
		cachedParser = createParser(openuiChatLibrary.toJSONSchema(), ROOT_ID);
	}
	return cachedParser;
}

export interface ValidateResult {
	ok: boolean;
	reason?: string;
}

/**
 * Structural validity check for an OpenUI Lang body source, using the real
 * parser. Rejects bodies that would render broken:
 *   - empty / whitespace
 *   - no resolvable `root` component
 *   - unresolved references (the model patched against a name that isn't
 *     defined — the issue's "unknown statement names referenced")
 *   - component prop-validation errors (missing-required etc.; the parser
 *     drops those components, leaving a hollow render)
 */
export function validateBody(source: string): ValidateResult {
	const trimmed = source.trim();
	if (trimmed.length === 0) return { ok: false, reason: "empty body" };

	let result: ReturnType<Parser["parse"]>;
	try {
		result = getParser().parse(trimmed);
	} catch (err) {
		return { ok: false, reason: `parse threw: ${(err as Error).message}` };
	}

	if (result.root === null) return { ok: false, reason: "no root component" };
	if (result.meta.unresolved.length > 0) {
		return {
			ok: false,
			reason: `unresolved references: ${result.meta.unresolved.join(", ")}`,
		};
	}
	if (result.meta.errors.length > 0) {
		return {
			ok: false,
			reason: `component errors: ${result.meta.errors
				.map((e) => `${e.component}:${e.code}`)
				.join(", ")}`,
		};
	}
	return { ok: true };
}

export type MergeResult =
	| { ok: true; body: string }
	| { ok: false; reason: string };

/**
 * Merge an OpenUI Lang `patch` into `existingBody` via the DSL's own
 * statement-name merge, then validate the result. Returns the merged source
 * on success, or a reason string on failure so the caller can fall back to
 * the last-known-good body instead of shipping something corrupt.
 *
 * Note: a patch that parses to zero statements (pure garbage) is a no-op in
 * `mergeStatements` — it returns `existingBody` unchanged, which still
 * validates, so this returns `{ ok: true }` with the untouched body. That is
 * the safe outcome (the node simply doesn't get richer this pass). A patch
 * that DOES change structure but leaves a dangling reference or an invalid
 * component fails validation and returns `{ ok: false }`.
 */
export function mergeBodyPatch(
	existingBody: string,
	patch: string,
): MergeResult {
	const base = existingBody.trim();
	const delta = patch.trim();
	if (base.length === 0) {
		return { ok: false, reason: "no existing body to patch" };
	}
	if (delta.length === 0) return { ok: false, reason: "empty patch" };

	let merged: string;
	try {
		merged = mergeStatements(base, delta, ROOT_ID);
	} catch (err) {
		return { ok: false, reason: `merge threw: ${(err as Error).message}` };
	}
	if (merged.trim().length === 0) {
		return { ok: false, reason: "merge produced empty body" };
	}

	const valid = validateBody(merged);
	if (!valid.ok) {
		return { ok: false, reason: valid.reason ?? "merged body invalid" };
	}
	return { ok: true, body: merged };
}
