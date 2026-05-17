#!/usr/bin/env bun

/**
 * Replays a stored meeting's transcript through the current `mutateGraph`
 * + `finalizeGraph` pipeline, so we can A/B the new prompt against the
 * output that's already saved on disk.
 *
 *   bun run scripts/diag-replay.ts <meeting-json-path> [out-path]
 *
 * Defaults: out-path = sibling file `<meeting-id>.replay.json`.
 *
 * Honors the same env vars as the app:
 *   AIZUCHI_PROVIDER=ollama|anthropic (default ollama)
 *   AIZUCHI_OLLAMA_MODEL=gemma4:latest
 *   AIZUCHI_ANTHROPIC_MODEL=claude-haiku-4-5
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { batchTranscript, formatChunkBatch } from "../src/lib/aizuchi/batcher";
import { finalizeGraph, mutateGraph } from "../src/lib/aizuchi/graph-mutation";
import type { ExtractionMode } from "../src/lib/aizuchi/persistence";
import {
	applyDiff,
	emptyGraph,
	type AIThought,
	type AIThoughtRecord,
	type Graph,
	mergeThoughts,
	type TranscriptChunk,
} from "../src/lib/aizuchi/schemas";

// Match useMeetingSession's import-stream tuning (paragraph-sized batches).
const SIZE_THRESHOLD_WORDS = 60;
const TIME_THRESHOLD_MS = 25_000;
const RECENT_TRANSCRIPT_WINDOW_MS = 60_000;

const [, , inPath, outPathArg] = process.argv;
if (!inPath) {
	console.error("usage: bun run scripts/diag-replay.ts <meeting-json-path> [out]");
	process.exit(1);
}

const raw = JSON.parse(readFileSync(inPath, "utf8")) as {
	id?: string;
	transcript?: TranscriptChunk[];
	extractionMode?: ExtractionMode;
};

const transcript = raw.transcript ?? [];
const mode: ExtractionMode = raw.extractionMode ?? "attribution";
const meetingId = raw.id ?? "unknown";

const outPath = outPathArg
	? resolve(outPathArg)
	: inPath.replace(/\.json$/, ".replay.json");

console.error(
	`replaying meeting ${meetingId}: ${transcript.length} chunks, mode=${mode}`,
);

let graph: Graph = emptyGraph();
let thoughts: AIThoughtRecord[] = [];
const accumulatedChunks: TranscriptChunk[] = [];
const passes: Array<{
	batchIdx: number;
	chunkRange: [number, number];
	latencyMs: number;
	usage: unknown;
	normalize: unknown;
	addedNodes: number;
	addedEdges: number;
	updatedNodes: number;
	mergedNodes: number;
	removedNodes: number;
	thoughtsEmitted: number;
}> = [];

function recentTranscriptText(chunks: TranscriptChunk[]): string {
	if (chunks.length === 0) return "";
	const cutoff = (chunks[chunks.length - 1]?.endMs ?? 0) - RECENT_TRANSCRIPT_WINDOW_MS;
	const recent = chunks.filter((c) => c.endMs >= cutoff);
	return recent.map((c) => `${c.speaker}: ${c.text}`).join("\n");
}

let batchIdx = 0;
const batches = Array.from(
	batchTranscript(transcript, SIZE_THRESHOLD_WORDS, TIME_THRESHOLD_MS),
);
console.error(`  → ${batches.length} batches\n`);

for (const batch of batches) {
	const chunkStart = accumulatedChunks.length;
	const chunkEnd = chunkStart + batch.chunks.length - 1;
	const recent = recentTranscriptText(accumulatedChunks);
	const chunkText = formatChunkBatch(batch);

	console.error(
		`[batch ${batchIdx}] chunks ${chunkStart}..${chunkEnd} (${batch.wordCount} words) — calling mutateGraph...`,
	);

	const result = await mutateGraph(graph, chunkText, {
		extractionMode: mode,
		recentTranscript: recent,
		previousThoughts: thoughts.map(({ createdAt: _c, updatedAt: _u, ...t }) => t as AIThought),
	});

	graph = applyDiff(graph, result.diff);
	thoughts = mergeThoughts(thoughts, result.diff.notes, Date.now());
	accumulatedChunks.push(...batch.chunks);

	passes.push({
		batchIdx,
		chunkRange: [chunkStart, chunkEnd],
		latencyMs: Math.round(result.latencyMs),
		usage: result.usage,
		normalize: result.normalize,
		addedNodes: result.diff.add_nodes.length,
		addedEdges: result.diff.add_edges.length,
		updatedNodes: result.diff.update_nodes.length,
		mergedNodes: result.diff.merge_nodes.length,
		removedNodes: result.diff.remove_nodes.length,
		thoughtsEmitted: result.diff.notes.length,
	});

	console.error(
		`           +${result.diff.add_nodes.length} nodes, +${result.diff.add_edges.length} edges, ${result.diff.update_nodes.length} upd, ${result.diff.merge_nodes.length} merge, ${result.diff.remove_nodes.length} rm | ${Math.round(result.latencyMs)}ms`,
	);
	batchIdx++;
}

console.error("\n[finalize] running end-of-transcript review...");
const finalizeResult = await finalizeGraph(graph, transcript, {
	extractionMode: mode,
	previousThoughts: thoughts.map(({ createdAt: _c, updatedAt: _u, ...t }) => t as AIThought),
});

graph = applyDiff(graph, finalizeResult.diff);
thoughts = mergeThoughts(thoughts, finalizeResult.diff.notes, Date.now());

console.error(
	`[finalize] +${finalizeResult.diff.add_nodes.length} nodes, +${finalizeResult.diff.add_edges.length} edges, ${finalizeResult.diff.update_nodes.length} upd, ${finalizeResult.diff.merge_nodes.length} merge, ${finalizeResult.diff.remove_nodes.length} rm | ${Math.round(finalizeResult.latencyMs)}ms`,
);

const summary = {
	meetingId,
	provider: finalizeResult.providerLabel,
	mode,
	transcriptChunks: transcript.length,
	batches: batches.length,
	passes,
	finalize: {
		latencyMs: Math.round(finalizeResult.latencyMs),
		usage: finalizeResult.usage,
		normalize: finalizeResult.normalize,
		addedNodes: finalizeResult.diff.add_nodes.length,
		addedEdges: finalizeResult.diff.add_edges.length,
		updatedNodes: finalizeResult.diff.update_nodes.length,
		mergedNodes: finalizeResult.diff.merge_nodes.length,
		removedNodes: finalizeResult.diff.remove_nodes.length,
	},
	graph,
	thoughts,
};

writeFileSync(outPath, JSON.stringify(summary, null, 2));

console.error(
	`\n→ ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${thoughts.length} thoughts`,
);
console.error(`→ wrote ${outPath}`);
