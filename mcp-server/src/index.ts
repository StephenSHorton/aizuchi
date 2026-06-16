#!/usr/bin/env node
/**
 * Aizuchi MCP server.
 *
 * Phase 4 of AIZ-13 (AIZ-23): the CRUD path now goes through the shared
 * `AizuchiClient` from `src/lib/cli-core/`. Every "create / read /
 * update / delete" tool is a thin wrapper over the IPC server running
 * inside the Tauri app — there is no more direct `notes.json` access on
 * the CRUD path.
 *
 * Behaviour change vs. pre-AIZ-23: the MCP server now requires the
 * Tauri app to be running. CRUD calls without the app surface as a
 * friendly "app isn't running" message instead of silently writing to
 * ~/.aizuchi/notes.json.
 *
 * What still touches the filesystem directly (residual / explicitly
 * out of scope for this PR — folded in by a follow-up):
 *
 *   - `note_organize`               .organize signal file
 *   - `note_create` (scope != local) .share-{id} signal file
 *   - `note_clear`                  .retract-{id} signal files
 *   - `peer_discover`, `peer_list`  peers.json + remote-notes.json
 *   - `pad_subscribe`               subscriptions.json
 *   - `room_host`, `room_join`,
 *     `peer_disconnect`             .host-room / .join-room / etc.
 *   - `log_open`, `log_close`       .show-logs / .close-logs signals
 *   - `log_tail`, `log_search`      reads aizuchi.log
 *   - `note_highlight`,
 *     `note_unhighlight`            highlights.json
 *
 * The IPC layer doesn't expose endpoints for these yet (signal-file
 * channel) so they stay direct-FS until a future ticket extends the
 * contract.
 *
 * ## Cross-package import note
 *
 * `mcp-server/` is a sibling Bun package — its `package.json` has no
 * dependency on the parent repo. We pull in `AizuchiClient` via a
 * relative path that crosses the package boundary
 * (`../../src/lib/cli-core`). At runtime this works because
 * `bun build --compile --minify` (the `build:binary` script) bundles
 * every reachable module into the standalone sidecar binary, so the
 * cross-package path is purely a build-time concern. Future cleanup:
 * convert `cli-core` into a proper workspace package
 * (`@aizuchi/cli-core`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
	AizuchiClient,
	AppNotRunningError,
	AuthError,
	type CanvasDocument,
	type CanvasEffect,
	ConflictError,
	EdgeRelationSchema,
	IpcClientError,
	type MeetingMeta,
	type MeetingSnapshot,
	NodeKindSchema,
	NotFoundError,
} from "../../src/lib/cli-core";

// ---------------------------------------------------------------------------
// Types — for direct-FS reads that aren't on the IPC contract yet.
// ---------------------------------------------------------------------------

interface NoteEnvelope {
	id: string;
	sender: string;
	senderId: string;
	scope: string;
	intent: string;
	title: string | null;
	body: string;
	color: string;
	timestamp: number;
	ttl: number;
}

interface PeerInfo {
	nodeId: string;
	name: string;
	addr: string;
	connectedAt: string;
	lastSeen: string;
}

type HighlightValue = string | { type: "blocks"; blocks: number[] };

// ---------------------------------------------------------------------------
// Filesystem helpers (residual — see file-level comment).
// ---------------------------------------------------------------------------

function notesDir(): string {
	return path.join(os.homedir(), ".aizuchi");
}

function ensureNotesDir(): void {
	const dir = notesDir();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function readRemoteNotes(): NoteEnvelope[] {
	const file = path.join(notesDir(), "remote-notes.json");
	if (!fs.existsSync(file)) return [];
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return [];
	}
}

function readPeers(): PeerInfo[] {
	const file = path.join(notesDir(), "peers.json");
	if (!fs.existsSync(file)) return [];
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return [];
	}
}

function writeSignalFile(name: string, data?: object): void {
	ensureNotesDir();
	const file = path.join(notesDir(), name);
	fs.writeFileSync(file, data ? JSON.stringify(data) : "", "utf-8");
}

function readHighlights(): Record<string, HighlightValue> {
	const file = path.join(notesDir(), "highlights.json");
	if (!fs.existsSync(file)) return {};
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return {};
	}
}

function writeHighlights(highlights: Record<string, HighlightValue>): void {
	ensureNotesDir();
	const file = path.join(notesDir(), "highlights.json");
	fs.writeFileSync(file, `${JSON.stringify(highlights, null, 2)}\n`, "utf-8");
}

function log(msg: string): void {
	const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
	const line = `[${timestamp}] [mcp] ${msg}\n`;
	try {
		fs.appendFileSync(path.join(notesDir(), "aizuchi.log"), line);
	} catch {}
}

// ---------------------------------------------------------------------------
// IPC client — lazily constructed, cached.
//
// Discovery touches the disk and verifies token perms, so we only do it
// once. If the app restarts mid-session the bound port may change and
// the cached client will surface stale-discovery errors; users can
// reconnect from Claude Code by restarting the MCP session.
// ---------------------------------------------------------------------------

let cachedClient: AizuchiClient | null = null;

async function getClient(rediscover = false): Promise<AizuchiClient> {
	if (rediscover) cachedClient = null;
	if (cachedClient) return cachedClient;
	cachedClient = await AizuchiClient.create();
	return cachedClient;
}

interface ToolError {
	content: { type: "text"; text: string }[];
	isError?: true;
}

/**
 * Errors that mean "the cached connection is stale" — the app likely
 * restarted on a NEW ephemeral port, so the cached client points at a dead
 * (or different) port. The fix for the long-standing "MCP sporadically
 * breaks until you restart the session" bug: re-discover + retry once.
 *
 *  - AppNotRunningError → missing discovery files / ECONNREFUSED (dead port)
 *  - network_error      → connect failed in a way that didn't normalize to
 *                         AppNotRunningError (e.g. a new process on the old port)
 *  - AuthError          → connected, but the token no longer matches (the app
 *                         restarted and rotated nothing but the port; another
 *                         instance grabbed the old port)
 */
function isReconnectable(err: unknown): boolean {
	if (err instanceof AppNotRunningError) return true;
	if (err instanceof AuthError) return true;
	if (err instanceof IpcClientError && err.code === "network_error")
		return true;
	return false;
}

function errText(text: string): ToolError {
	return { content: [{ type: "text" as const, text }], isError: true };
}

function toToolError(err: unknown): ToolError {
	if (err instanceof AppNotRunningError) {
		return errText(
			"Aizuchi app isn't running. Start it (open -a 'Aizuchi' or " +
				"`bun tauri dev`) and retry.",
		);
	}
	if (err instanceof ConflictError) {
		// Per "surface, don't fix": tell the agent to re-read and retry rather
		// than clobbering another agent's concurrent edit.
		return errText(
			`The board changed under you (${err.message}). Re-read it ` +
				"(canvas_list / work_list) and retry.",
		);
	}
	if (err instanceof NotFoundError) {
		return errText(err.message || "Not found.");
	}
	if (err instanceof IpcClientError) {
		return errText(`IPC error (${err.code}): ${err.message}`);
	}
	const message = err instanceof Error ? err.message : String(err);
	return errText(`Error: ${message}`);
}

/**
 * Run an IPC-backed tool body. On a reconnectable failure (a restarted app on
 * a new port), transparently re-discover and retry ONCE before surfacing the
 * error — so the agent never has to restart its MCP session.
 */
async function withClient<
	T extends { content: { type: "text"; text: string }[] },
>(fn: (client: AizuchiClient) => Promise<T>): Promise<T | ToolError> {
	try {
		return await fn(await getClient());
	} catch (err) {
		if (isReconnectable(err)) {
			try {
				return await fn(await getClient(true));
			} catch (err2) {
				return toToolError(err2);
			}
		}
		return toToolError(err);
	}
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
	name: "aizuchi",
	version: "1.0.0",
});

// =============================================================================
// Multiplayer / peer tools — direct FS for now (signal files + state
// files outside the IPC contract). See file-level comment.
// =============================================================================

server.tool(
	"peer_discover",
	"List currently connected peers. Use room_host and room_join to connect with peers manually via room codes.",
	{},
	async () => {
		log("peer_discover");
		const peers = readPeers();
		if (peers.length === 0) {
			return {
				content: [
					{
						type: "text" as const,
						text: "No peers discovered on the network. Make sure other Aizuchi instances are running on the same LAN.",
					},
				],
			};
		}
		let text = `## Discovered Peers (${peers.length})\n\n`;
		for (const peer of peers) {
			text += `- **${peer.name}** (${peer.addr})\n`;
			text += `  Connected: ${peer.connectedAt} | Last seen: ${peer.lastSeen}\n`;
		}
		return { content: [{ type: "text" as const, text }] };
	},
);

server.tool(
	"peer_list",
	"List currently connected peers with their status and shared note counts.",
	{},
	async () => {
		log("peer_list");
		const peers = readPeers();
		const remoteNotes = readRemoteNotes();
		if (peers.length === 0) {
			return {
				content: [
					{ type: "text" as const, text: "No peers currently connected." },
				],
			};
		}
		let text = `## Connected Peers (${peers.length})\n\n`;
		for (const peer of peers) {
			const noteCount = remoteNotes.filter(
				(n) => n.senderId === peer.nodeId,
			).length;
			text += `- **${peer.name}** — ${noteCount} shared note${
				noteCount !== 1 ? "s" : ""
			}\n`;
			text += `  Last seen: ${peer.lastSeen}\n`;
		}
		return { content: [{ type: "text" as const, text }] };
	},
);

server.tool(
	"pad_subscribe",
	"Subscribe to notes from a specific scope. Controls which network notes you receive.",
	{
		scope: z
			.string()
			.optional()
			.describe(
				"Scope to subscribe to: 'team' or a named group (e.g., 'frontend', 'backend'). Omit to subscribe to all.",
			),
	},
	async ({ scope }) => {
		log(`pad_subscribe: ${scope || "all"}`);
		ensureNotesDir();
		const subsFile = path.join(notesDir(), "subscriptions.json");
		let subs: string[] = [];
		if (fs.existsSync(subsFile)) {
			try {
				subs = JSON.parse(fs.readFileSync(subsFile, "utf-8"));
			} catch {
				subs = [];
			}
		}
		if (scope) {
			if (!subs.includes(scope)) subs.push(scope);
			fs.writeFileSync(subsFile, `${JSON.stringify(subs, null, 2)}\n`, "utf-8");
			return {
				content: [
					{
						type: "text" as const,
						text: `Subscribed to scope: "${scope}". Current subscriptions: ${subs.join(", ")}`,
					},
				],
			};
		}
		// No scope = subscribe to all (delete subs file).
		if (fs.existsSync(subsFile)) fs.unlinkSync(subsFile);
		return {
			content: [
				{
					type: "text" as const,
					text: "Subscribed to all scopes (no filtering).",
				},
			],
		};
	},
);

server.tool(
	"room_host",
	"Host a multiplayer room and get a room code to share with a teammate. The code encodes your local IP and port — share it out-of-band (verbally, chat, etc.).",
	{},
	async () => {
		log("room_host");
		const resultFile = path.join(notesDir(), "room-code.json");
		if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
		writeSignalFile(".host-room");

		const maxWait = 5000;
		const pollInterval = 200;
		let waited = 0;
		while (waited < maxWait) {
			await new Promise((r) => setTimeout(r, pollInterval));
			waited += pollInterval;
			if (fs.existsSync(resultFile)) {
				try {
					const result = JSON.parse(fs.readFileSync(resultFile, "utf-8"));
					fs.unlinkSync(resultFile);
					return {
						content: [
							{
								type: "text" as const,
								text: `Room hosted! Share this code with your teammate:\n\n**${result.code}**\n\nListening on ${result.ip}:${result.port}`,
							},
						],
					};
				} catch {
					break;
				}
			}
		}
		return {
			content: [
				{
					type: "text" as const,
					text: "Failed to host room — Aizuchi app may not be running.",
				},
			],
			isError: true,
		};
	},
);

server.tool(
	"room_join",
	"Join a multiplayer room using a room code from a teammate. Connects to their Aizuchi instance for real-time note sharing.",
	{
		code: z
			.string()
			.describe("The room code from the host (e.g., XXXX-XXXX-XX)"),
	},
	async ({ code }) => {
		log(`room_join: ${code}`);
		const resultFile = path.join(notesDir(), "room-result.json");
		if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
		writeSignalFile(".join-room", { code });

		const maxWait = 15000;
		const pollInterval = 300;
		let waited = 0;
		while (waited < maxWait) {
			await new Promise((r) => setTimeout(r, pollInterval));
			waited += pollInterval;
			if (fs.existsSync(resultFile)) {
				try {
					const result = JSON.parse(fs.readFileSync(resultFile, "utf-8"));
					fs.unlinkSync(resultFile);
					if (result.success) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Connected to **${result.peer_name}** (${result.peer_id}). You can now share notes with scope "team".`,
								},
							],
						};
					}
					return {
						content: [
							{
								type: "text" as const,
								text: `Failed to join room: ${result.error}`,
							},
						],
						isError: true,
					};
				} catch {
					break;
				}
			}
		}
		return {
			content: [
				{
					type: "text" as const,
					text: "Join timed out — check that the host is running Aizuchi and the code is correct.",
				},
			],
			isError: true,
		};
	},
);

server.tool(
	"peer_disconnect",
	"Disconnect from a specific peer.",
	{
		node_id: z
			.string()
			.describe(
				"The node ID of the peer to disconnect (from peer_discover or peer_list)",
			),
	},
	async ({ node_id }) => {
		log(`peer_disconnect: ${node_id}`);
		writeSignalFile(".disconnect-peer", { nodeId: node_id });
		return {
			content: [
				{ type: "text" as const, text: `Disconnecting from peer ${node_id}.` },
			],
		};
	},
);

// =============================================================================
// Log viewer + log search — direct FS for now.
// =============================================================================

server.tool(
	"log_open",
	"Open the live log viewer as a floating sticky note. Optionally pass a filter to only show matching entries.",
	{
		filter: z
			.string()
			.optional()
			.describe(
				"Only show log lines containing this text (e.g., 'network', 'mcp', 'error')",
			),
	},
	async ({ filter }) => {
		log(`log_open: ${filter || "unfiltered"}`);
		writeSignalFile(".show-logs", filter ? { filter } : undefined);
		return {
			content: [
				{
					type: "text" as const,
					text: `Log viewer opened${filter ? ` with filter: "${filter}"` : ""}.`,
				},
			],
		};
	},
);

server.tool("log_close", "Close the live log viewer window.", {}, async () => {
	log("log_close");
	writeSignalFile(".close-logs");
	return {
		content: [{ type: "text" as const, text: "Log viewer closed." }],
	};
});

function readLogFile(): string {
	const file = path.join(notesDir(), "aizuchi.log");
	if (!fs.existsSync(file)) return "";
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return "";
	}
}

server.tool(
	"log_tail",
	"Read the most recent log entries from Aizuchi. Useful for debugging network, MCP, and app events.",
	{
		lines: z
			.number()
			.optional()
			.describe("Number of lines to return (default 50, max 500)"),
		filter: z
			.string()
			.optional()
			.describe(
				"Optional filter — only return lines containing this string (e.g., 'network', 'mcp', 'error')",
			),
	},
	async ({ lines, filter }) => {
		const maxLines = Math.min(lines ?? 50, 500);
		const content = readLogFile();
		let allLines = content.split("\n").filter((l) => l.trim());
		if (filter) {
			const lowerFilter = filter.toLowerCase();
			allLines = allLines.filter((l) => l.toLowerCase().includes(lowerFilter));
		}
		const start = Math.max(0, allLines.length - maxLines);
		const result = allLines.slice(start).join("\n");
		return {
			content: [
				{ type: "text" as const, text: result || "No log entries found." },
			],
		};
	},
);

server.tool(
	"log_search",
	"Search Aizuchi logs by keyword, time range, or category. Returns matching entries with context.",
	{
		query: z.string().describe("Search term to find in log entries"),
		category: z
			.enum(["mcp", "network", "all"])
			.optional()
			.describe("Filter by log category (default: all)"),
		last_minutes: z
			.number()
			.optional()
			.describe(
				"Only search entries from the last N minutes (default: no time limit)",
			),
	},
	async ({ query, category, last_minutes }) => {
		const content = readLogFile();
		let allLines = content.split("\n").filter((l) => l.trim());
		if (category && category !== "all") {
			allLines = allLines.filter((l) => l.includes(`[${category}]`));
		}
		if (last_minutes) {
			const cutoff = Date.now() - last_minutes * 60 * 1000;
			allLines = allLines.filter((l) => {
				const match = l.match(
					/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/,
				);
				if (!match) return false;
				const ts = new Date(`${match[1].replace(" ", "T")}Z`).getTime();
				return ts >= cutoff;
			});
		}
		const lowerQuery = query.toLowerCase();
		const matches = allLines.filter((l) =>
			l.toLowerCase().includes(lowerQuery),
		);
		if (matches.length === 0) {
			return {
				content: [
					{
						type: "text" as const,
						text: `No log entries matching "${query}"${category ? ` in [${category}]` : ""}${last_minutes ? ` from last ${last_minutes}m` : ""}.`,
					},
				],
			};
		}
		const capped = matches.slice(-200);
		let text = `## Log Search: "${query}" (${matches.length} matches)\n\n`;
		text += capped.join("\n");
		if (matches.length > 200) {
			text += `\n\n... (showing last 200 of ${matches.length} matches)`;
		}
		return { content: [{ type: "text" as const, text }] };
	},
);

// =============================================================================
// Highlights — direct FS (highlights.json), no IPC contract yet.
// =============================================================================

server.tool(
	"note_highlight",
	"Highlight matching content in a scratch pad and dim everything else. Draws the user's attention to specific information. The user can click the note to clear the highlight.",
	{
		id: z.string().describe("Note ID to highlight"),
		pattern: z
			.string()
			.describe(
				"Text pattern to highlight — matching lines stay bright, others are dimmed",
			),
	},
	async ({ id, pattern }) => {
		log(`note_highlight: ${id} pattern="${pattern}"`);
		const highlights = readHighlights();
		highlights[id] = pattern;
		writeHighlights(highlights);
		return {
			content: [
				{
					type: "text" as const,
					text: `Highlighting "${pattern}" in note ${id}. User can click the note to clear.`,
				},
			],
		};
	},
);

server.tool(
	"note_unhighlight",
	"Remove highlight/emphasis from a scratch pad, restoring normal display.",
	{
		id: z.string().describe("Note ID to unhighlight"),
	},
	async ({ id }) => {
		log(`note_unhighlight: ${id}`);
		const highlights = readHighlights();
		delete highlights[id];
		writeHighlights(highlights);
		return {
			content: [
				{ type: "text" as const, text: `Highlight removed from note ${id}.` },
			],
		};
	},
);

// =============================================================================
// Block tools — body-level edits go through the IPC PATCH endpoint, the
// markdown parsing/serialising stays in JS.
// =============================================================================

interface Block {
	index: number;
	type: "heading" | "paragraph" | "list" | "code" | "blank";
	text: string;
	raw: string;
}

function parseBlocks(body: string): Block[] {
	const lines = body.split("\n");
	const blocks: Block[] = [];
	let i = 0;
	let index = 0;

	const isHeading = (line: string) => /^#{1,6}\s+/.test(line);
	const isListItem = (line: string) => /^\s*([-*+]\s+|\d+\.\s+)/.test(line);
	const isFence = (line: string) => /^\s*```/.test(line);
	const isBlank = (line: string) => line.trim() === "";

	while (i < lines.length) {
		const line = lines[i];

		if (isBlank(line)) {
			blocks.push({ index: index++, type: "blank", text: "", raw: line });
			i++;
			continue;
		}

		if (isFence(line)) {
			const collected: string[] = [line];
			i++;
			while (i < lines.length && !isFence(lines[i])) {
				collected.push(lines[i]);
				i++;
			}
			if (i < lines.length && isFence(lines[i])) {
				collected.push(lines[i]);
				i++;
			}
			const raw = collected.join("\n");
			const text = collected
				.slice(
					1,
					collected[collected.length - 1] &&
						isFence(collected[collected.length - 1])
						? -1
						: undefined,
				)
				.join("\n");
			blocks.push({ index: index++, type: "code", text, raw });
			continue;
		}

		if (isHeading(line)) {
			const text = line.replace(/^#{1,6}\s+/, "");
			blocks.push({ index: index++, type: "heading", text, raw: line });
			i++;
			continue;
		}

		if (isListItem(line)) {
			const collected: string[] = [];
			while (i < lines.length && isListItem(lines[i])) {
				collected.push(lines[i]);
				i++;
			}
			const raw = collected.join("\n");
			const text = collected
				.map((l) => l.replace(/^\s*([-*+]\s+|\d+\.\s+)/, ""))
				.join("\n");
			blocks.push({ index: index++, type: "list", text, raw });
			continue;
		}

		const collected: string[] = [];
		while (
			i < lines.length &&
			!isBlank(lines[i]) &&
			!isHeading(lines[i]) &&
			!isListItem(lines[i]) &&
			!isFence(lines[i])
		) {
			collected.push(lines[i]);
			i++;
		}
		const raw = collected.join("\n");
		blocks.push({ index: index++, type: "paragraph", text: raw, raw });
	}

	return blocks;
}

function blocksToMarkdown(blocks: Block[]): string {
	return blocks.map((b) => b.raw).join("\n");
}

server.tool(
	"block_list",
	"List all blocks in a scratch pad with their index, type, and content. Use this to find blocks before targeting them with block_highlight, block_update, etc.",
	{
		id: z.string().describe("Note ID"),
	},
	async ({ id }) =>
		withClient(async (client) => {
			log(`block_list: ${id}`);
			const note = await client.getPad(id);
			const blocks = parseBlocks(note.body);
			if (blocks.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Note ${id} has no blocks (empty body).`,
						},
					],
				};
			}
			const lines = blocks.map((b) => {
				const preview = b.raw.replace(/\n/g, "\\n");
				return `${b.index} [${b.type}] ${preview}`;
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `${blocks.length} block(s) in note ${id}:\n\n${lines.join("\n")}`,
					},
				],
			};
		}),
);

server.tool(
	"block_highlight",
	"Highlight specific blocks in a scratch pad by index and dim everything else. More precise than note_highlight (which uses pattern matching). Use block_list first to see available blocks.",
	{
		id: z.string().describe("Note ID"),
		blocks: z
			.array(z.number())
			.describe("Array of block indices to highlight (e.g., [0, 1, 2])"),
	},
	async ({ id, blocks }) =>
		withClient(async (client) => {
			log(`block_highlight: ${id} blocks=[${blocks.join(",")}]`);
			// Existence check via IPC.
			await client.getPad(id);
			const highlights = readHighlights();
			highlights[id] = { type: "blocks", blocks };
			writeHighlights(highlights);
			return {
				content: [
					{
						type: "text" as const,
						text: `Highlighting blocks [${blocks.join(", ")}] in note ${id}. User can click the note to clear.`,
					},
				],
			};
		}),
);

server.tool(
	"block_insert",
	"Insert a new block into a scratch pad after the specified index (use -1 to insert at the beginning).",
	{
		id: z.string().describe("Note ID"),
		after_index: z
			.number()
			.describe("Insert after this block index (-1 for beginning)"),
		content: z
			.string()
			.describe(
				"Markdown content for the new block (e.g., '## My Heading' or '- list item' or 'plain paragraph')",
			),
	},
	async ({ id, after_index, content }) =>
		withClient(async (client) => {
			log(`block_insert: ${id} after=${after_index}`);
			const note = await client.getPad(id);
			const blocks = parseBlocks(note.body);
			const newBlocks = parseBlocks(content);
			if (newBlocks.length === 0) {
				return {
					content: [
						{ type: "text" as const, text: "Cannot insert empty content." },
					],
				};
			}

			let insertAt: number;
			if (after_index < 0) insertAt = 0;
			else if (after_index >= blocks.length) insertAt = blocks.length;
			else insertAt = after_index + 1;

			const toInsert: Block[] = [];
			if (
				insertAt > 0 &&
				blocks[insertAt - 1] &&
				blocks[insertAt - 1].type !== "blank"
			) {
				toInsert.push({ index: 0, type: "blank", text: "", raw: "" });
			}
			toInsert.push(...newBlocks);
			if (insertAt < blocks.length && blocks[insertAt].type !== "blank") {
				toInsert.push({ index: 0, type: "blank", text: "", raw: "" });
			}

			blocks.splice(insertAt, 0, ...toInsert);
			blocks.forEach((b, idx) => {
				b.index = idx;
			});

			const updatedBody = blocksToMarkdown(blocks);
			await client.updatePad(id, { body: updatedBody });
			return {
				content: [
					{
						type: "text" as const,
						text: `Inserted block(s) into note ${id} after index ${after_index}.`,
					},
				],
			};
		}),
);

server.tool(
	"block_update",
	"Replace the content of a specific block by index.",
	{
		id: z.string().describe("Note ID"),
		block_index: z.number().describe("Block index to replace"),
		content: z.string().describe("New markdown content for the block"),
	},
	async ({ id, block_index, content }) =>
		withClient(async (client) => {
			log(`block_update: ${id} block=${block_index}`);
			const note = await client.getPad(id);
			const blocks = parseBlocks(note.body);
			if (block_index < 0 || block_index >= blocks.length) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Block index ${block_index} out of range (note has ${blocks.length} block(s)).`,
						},
					],
				};
			}
			const replacementBlocks = parseBlocks(content);
			blocks.splice(block_index, 1, ...replacementBlocks);
			blocks.forEach((b, idx) => {
				b.index = idx;
			});
			const updatedBody = blocksToMarkdown(blocks);
			await client.updatePad(id, { body: updatedBody });
			return {
				content: [
					{
						type: "text" as const,
						text: `Updated block ${block_index} in note ${id}.`,
					},
				],
			};
		}),
);

server.tool(
	"block_delete",
	"Delete a specific block from a scratch pad by index.",
	{
		id: z.string().describe("Note ID"),
		block_index: z.number().describe("Block index to delete"),
	},
	async ({ id, block_index }) =>
		withClient(async (client) => {
			log(`block_delete: ${id} block=${block_index}`);
			const note = await client.getPad(id);
			const blocks = parseBlocks(note.body);
			if (block_index < 0 || block_index >= blocks.length) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Block index ${block_index} out of range (note has ${blocks.length} block(s)).`,
						},
					],
				};
			}
			blocks.splice(block_index, 1);
			blocks.forEach((b, idx) => {
				b.index = idx;
			});
			const updatedBody = blocksToMarkdown(blocks);
			await client.updatePad(id, { body: updatedBody });
			return {
				content: [
					{
						type: "text" as const,
						text: `Deleted block ${block_index} from note ${id}.`,
					},
				],
			};
		}),
);

// =============================================================================
// Aizuchi meeting tools — all routed through the IPC server.
//
// Time fields below: `startedAt` / `endedAt` come straight from
// `MeetingMeta` and are i64 epoch milliseconds (NOT RFC3339). `Note.createdAt`
// from the pad tools is RFC3339.
// =============================================================================

function formatMeetingMeta(m: MeetingMeta): string {
	const started = new Date(m.startedAt).toLocaleString();
	const ended =
		m.endedAt && m.endedAt > 0
			? new Date(m.endedAt).toLocaleString()
			: "running";
	const duration =
		m.endedAt && m.endedAt > 0
			? formatDurationMs(m.endedAt - m.startedAt)
			: formatDurationMs(Date.now() - m.startedAt);
	const name = m.name
		? ` "${m.name}"${m.nameLockedByUser ? " (locked)" : ""}`
		: "";
	const parts = [`## ${m.id}${name} [${m.mode}]`];
	parts.push(`Started: ${started}`);
	parts.push(`Ended: ${ended}`);
	parts.push(`Duration: ${duration}`);
	parts.push(
		`Nodes: ${m.nodeCount} | Edges: ${m.edgeCount} | Thoughts: ${m.thoughtCount}`,
	);
	if (m.transcriptDurationMs > 0) {
		parts.push(`Transcript: ${formatDurationMs(m.transcriptDurationMs)}`);
	}
	return parts.join("\n");
}

function formatDurationMs(ms: number): string {
	if (ms <= 0) return "0s";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const remSec = sec % 60;
	if (min < 60) return remSec === 0 ? `${min}m` : `${min}m${remSec}s`;
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return remMin === 0 ? `${hr}h` : `${hr}h${remMin}m`;
}

server.tool(
	"meeting_start",
	"Start a new Aizuchi meeting. Opens the meeting window and kicks off live ASR (mode='live') or the demo transcript (mode='demo'). Returns the meeting id and whether the window was opened.",
	{
		mode: z
			.enum(["demo", "live"])
			.describe(
				"'live' captures system + microphone audio with ASR. 'demo' replays the bundled fixture transcript — useful for testing without audio.",
			),
	},
	async ({ mode }) =>
		withClient(async (client) => {
			log(`meeting_start: ${mode}`);
			const result = await client.startMeeting(mode);
			return {
				content: [
					{
						type: "text" as const,
						text: `Started meeting ${result.id} (${mode})${
							result.openedWindow ? " — window opened" : ""
						}.`,
					},
				],
			};
		}),
);

server.tool(
	"meeting_stop",
	"Stop the running live meeting. Waits up to ~3s for the React side to finish saving the snapshot, then returns the post-stop MeetingMeta. Time fields (startedAt, endedAt) are epoch milliseconds.",
	{
		id: z.string().describe("Meeting id (e.g., 'meeting-<uuid>')"),
	},
	async ({ id }) =>
		withClient(async (client) => {
			log(`meeting_stop: ${id}`);
			const meta = await client.stopMeeting(id);
			return {
				content: [
					{
						type: "text" as const,
						text: `Stopped meeting ${meta.id}.\n\n${formatMeetingMeta(meta)}`,
					},
				],
			};
		}),
);

server.tool(
	"meeting_resume",
	"Resume / append to a previously stopped meeting. Re-opens the meeting window and re-attaches live capture; new transcript chunks append to the existing snapshot.",
	{
		id: z.string().describe("Meeting id to resume"),
	},
	async ({ id }) =>
		withClient(async (client) => {
			log(`meeting_resume: ${id}`);
			const result = await client.resumeMeeting(id);
			return {
				content: [
					{
						type: "text" as const,
						text: `Resumed meeting ${id}${
							result.windowOpened ? " — window opened" : ""
						}.`,
					},
				],
			};
		}),
);

server.tool(
	"meeting_list",
	"List every saved Aizuchi meeting with its id, name, mode, duration, and node/edge/thought counts. Time fields are epoch milliseconds.",
	{},
	async () =>
		withClient(async (client) => {
			log("meeting_list");
			const meetings = await client.listMeetings();
			if (meetings.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No saved meetings." }],
				};
			}
			// Newest first.
			const sorted = [...meetings].sort((a, b) => b.startedAt - a.startedAt);
			const text = `${meetings.length} meeting(s):\n\n${sorted
				.map(formatMeetingMeta)
				.join("\n\n---\n\n")}`;
			return { content: [{ type: "text" as const, text }] };
		}),
);

server.tool(
	"meeting_open",
	"Open the read-only meeting window for an existing meeting. Does not resume capture — use meeting_resume for that.",
	{
		id: z.string().describe("Meeting id to open"),
	},
	async ({ id }) =>
		withClient(async (client) => {
			log(`meeting_open: ${id}`);
			await client.openMeeting(id);
			return {
				content: [
					{ type: "text" as const, text: `Opened meeting window for ${id}.` },
				],
			};
		}),
);

server.tool(
	"meeting_rename",
	"Rename a meeting. The user-initiated rename always sets nameLockedByUser=true so the AI naming pass won't overwrite it.",
	{
		id: z.string().describe("Meeting id to rename"),
		name: z.string().describe("New display name for the meeting"),
	},
	async ({ id, name }) =>
		withClient(async (client) => {
			log(`meeting_rename: ${id} -> "${name}"`);
			const meta = await client.renameMeeting(id, name, true);
			return {
				content: [
					{
						type: "text" as const,
						text: `Renamed meeting ${id} to "${meta.name ?? name}" (locked).`,
					},
				],
			};
		}),
);

server.tool(
	"meeting_delete",
	"Permanently delete a saved meeting snapshot.",
	{
		id: z.string().describe("Meeting id to delete"),
	},
	async ({ id }) =>
		withClient(async (client) => {
			log(`meeting_delete: ${id}`);
			await client.deleteMeeting(id);
			return {
				content: [{ type: "text" as const, text: `Deleted meeting ${id}.` }],
			};
		}),
);

server.tool(
	"meeting_get",
	"Fetch the full snapshot of a meeting — graph, transcript, AI thoughts, passes, and stats. Returns JSON. Time fields (startedAt, endedAt, transcript chunks) are epoch milliseconds.",
	{
		id: z.string().describe("Meeting id to fetch"),
	},
	async ({ id }) =>
		withClient(async (client) => {
			log(`meeting_get: ${id}`);
			const snap: MeetingSnapshot = await client.getMeeting(id);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(snap, null, 2),
					},
				],
			};
		}),
);

// =============================================================================
// Canvas — node-graph boards (scratch pad + agent-work) on one in-app canvas.
//
// These route through the IPC effect API (`POST /v1/canvas/:id/effects`). The
// agent emits TOPOLOGY ONLY (nodes/edges) — node positions are owned by the
// app's force layout and the user's drags, never by the agent. A node `id` is
// an agent-chosen stable slug: reuse it to update, and two agents collaborate
// on the same node by reusing the same id (no out-of-band handle needed).
// The default board is `scratch-pad`; pass projectId `work` for the
// agent-work graph (or any slug for a new board).
// =============================================================================

const DEFAULT_PROJECT = "scratch-pad";

function txt(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function formatCanvas(doc: CanvasDocument): string {
	if (doc.nodes.length === 0 && doc.edges.length === 0) {
		return `Canvas "${doc.projectId}" is empty (v${doc.version}).`;
	}
	const nodeLines = doc.nodes.map((n) => {
		const p = n.payload as Record<string, unknown>;
		const label =
			(p.title as string) ?? (p.label as string) ?? (p.text as string) ?? "";
		const status = p.status ? ` (${p.status})` : "";
		return `- [${n.nodeType}] ${n.id}${label ? `: ${label}` : ""}${status}`;
	});
	const edgeLines = doc.edges.map(
		(e) => `- ${e.from} --${e.relation}--> ${e.to}`,
	);
	let out = `Canvas "${doc.projectId}" (v${doc.version}) — ${doc.nodes.length} node(s), ${doc.edges.length} edge(s)\n\n## Nodes\n${nodeLines.join("\n")}`;
	if (edgeLines.length > 0) out += `\n\n## Edges\n${edgeLines.join("\n")}`;
	return out;
}

server.tool(
	"canvas_add_node",
	"Add (or update, by reusing the id) a node on the shared in-app canvas. Use a stable snake_case slug id you can reuse later and share with other agents. The `kind` selects the node shape; fill `payload` with the fields for that kind: note → {title?, markdown}; topic → {label}; list → {title?, items[]}; task → {title, status: pending|in_progress|blocked|done|failed, detail?}; agent → {label, agentId?, cwd?, gitBranch?}; artifact → {label, artifactType: file|pr|diff|commit|output|url, ref?}; finding → {text, severity?}; blocker → {label, reason?}; milestone → {label, status?}; decision → {label, detail?, alternative?}. Do NOT set positions — the canvas lays nodes out automatically.",
	{
		projectId: z
			.string()
			.optional()
			.describe(
				"Board to write to. Default 'scratch-pad' (collaborative notes); use 'work' for the agent-work graph.",
			),
		id: z
			.string()
			.regex(/^[a-z0-9][a-z0-9_-]*$/)
			.describe(
				"Stable slug id (e.g. 'auth_design'). Reuse to update; share across agents to collaborate.",
			),
		kind: NodeKindSchema.describe(
			"Node kind — see the per-kind payload fields in the tool description.",
		),
		payload: z
			.record(z.string(), z.any())
			.describe("Per-kind content fields (see the tool description)."),
	},
	async ({ projectId, id, kind, payload }) =>
		withClient(async (client) => {
			const project = projectId ?? DEFAULT_PROJECT;
			log(`canvas_add_node: ${project}/${id} [${kind}]`);
			const effects: CanvasEffect[] = [
				{ op: "add", node: { id, nodeType: kind, payload: payload ?? {} } },
			];
			const ack = await client.applyEffects(project, effects);
			return txt(
				`Added ${kind} node "${id}" to ${project} (canvas now at v${ack.version}).`,
			);
		}),
);

server.tool(
	"canvas_connect",
	"Draw a directed, typed edge between two existing canvas nodes (reference them by their slug ids). Use this to express structure: depends_on / blocks / part_of / supports / causes / owns (agent→task) / assigned_to / produces (agent→artifact) / relates_to, etc.",
	{
		projectId: z.string().optional().describe("Board (default 'scratch-pad')."),
		id: z
			.string()
			.describe("Stable slug id for this edge (reuse to re-style/retarget)."),
		from: z.string().describe("Source node id."),
		to: z.string().describe("Target node id."),
		relation: EdgeRelationSchema.describe(
			"Edge relation — drives color + layout clustering.",
		),
		label: z
			.string()
			.optional()
			.describe("Optional override label for the edge."),
		animated: z
			.boolean()
			.optional()
			.describe("Animate the edge (a moving dot)."),
	},
	async ({ projectId, id, from, to, relation, label, animated }) =>
		withClient(async (client) => {
			const project = projectId ?? DEFAULT_PROJECT;
			log(`canvas_connect: ${project}/${from} --${relation}--> ${to}`);
			const effects: CanvasEffect[] = [
				{ op: "connect", edge: { id, from, to, relation, label, animated } },
			];
			const ack = await client.applyEffects(project, effects);
			return txt(
				`Connected ${from} --${relation}--> ${to} (canvas now at v${ack.version}).`,
			);
		}),
);

server.tool(
	"canvas_update_node",
	"Merge new fields into an existing node's payload (e.g. mark a task done with {status:'done'}, or rewrite a note's {markdown}). Only the keys you pass are changed.",
	{
		projectId: z.string().optional().describe("Board (default 'scratch-pad')."),
		id: z.string().describe("Id of the node to update."),
		payload: z
			.record(z.string(), z.any())
			.describe("Fields to merge into the node's payload."),
	},
	async ({ projectId, id, payload }) =>
		withClient(async (client) => {
			const project = projectId ?? DEFAULT_PROJECT;
			log(`canvas_update_node: ${project}/${id}`);
			const effects: CanvasEffect[] = [
				{ op: "update", id, payload: payload ?? {} },
			];
			const ack = await client.applyEffects(project, effects);
			return txt(`Updated node "${id}" (canvas now at v${ack.version}).`);
		}),
);

server.tool(
	"canvas_remove_node",
	"Remove a node from the canvas. Any edges touching it are removed too.",
	{
		projectId: z.string().optional().describe("Board (default 'scratch-pad')."),
		id: z.string().describe("Id of the node to remove."),
	},
	async ({ projectId, id }) =>
		withClient(async (client) => {
			const project = projectId ?? DEFAULT_PROJECT;
			log(`canvas_remove_node: ${project}/${id}`);
			const effects: CanvasEffect[] = [{ op: "remove", id }];
			const ack = await client.applyEffects(project, effects);
			return txt(`Removed node "${id}" (canvas now at v${ack.version}).`);
		}),
);

server.tool(
	"canvas_list",
	"Read back the current canvas — every node (id, kind, title/label, status) and edge. Call this before adding nodes so you reuse existing ids instead of duplicating, and to see what other agents have added.",
	{
		projectId: z
			.string()
			.optional()
			.describe("Board to read (default 'scratch-pad')."),
	},
	async ({ projectId }) =>
		withClient(async (client) => {
			const project = projectId ?? DEFAULT_PROJECT;
			log(`canvas_list: ${project}`);
			const doc = await client.getCanvas(project);
			return txt(formatCanvas(doc));
		}),
);

server.tool(
	"canvas_clear",
	"Remove ALL nodes and edges from a canvas board. Destructive and irreversible — the board id is REQUIRED (no default) so you never clear the wrong board by omission.",
	{
		projectId: z
			.string()
			.describe("Board to clear — required, e.g. 'scratch-pad' or 'work'."),
	},
	async ({ projectId }) =>
		withClient(async (client) => {
			log(`canvas_clear: ${projectId}`);
			const ack = await client.applyEffects(projectId, [{ op: "clear" }]);
			return txt(`Cleared canvas "${projectId}" (now at v${ack.version}).`);
		}),
);

server.tool(
	"canvas_observe",
	"Wait (long-poll, up to ~25s) until a board changes past a version you pass — react to other agents' edits without busy-polling. Pass the `version` from canvas_list/work_list; on changed:true, re-list to see what's new, then observe again with the new version to keep watching.",
	{
		projectId: z
			.string()
			.optional()
			.describe(
				"Board to watch (default 'scratch-pad'; use 'work' for the agent-work graph).",
			),
		since: z
			.number()
			.int()
			.describe("The version you last saw (from canvas_list / work_list)."),
	},
	async ({ projectId, since }) =>
		withClient(async (client) => {
			const project = projectId ?? DEFAULT_PROJECT;
			log(`canvas_observe: ${project} since v${since}`);
			const res = await client.changesSince(project, since);
			return txt(
				res.changed
					? `Board "${project}" changed — now at v${res.version}. Re-read it to see what's new.`
					: `No change to "${project}" (still v${res.version}). Observe again to keep watching.`,
			);
		}),
);

// =============================================================================
// Agent-work graph — convenience tools over the `work` canvas board. These let
// an agent narrate its work as a live node graph ("I'm starting X", "X is
// done", "agent A owns X", "X is blocked by Y") that the user watches in the
// Work Graph window. Multiple agents collaborate on one graph by reusing ids.
// =============================================================================

const WORK_PROJECT = "work";

function agentId(name: string): string {
	return `agent_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

server.tool(
	"work_start",
	"Declare that work on a task has started — adds (or updates) a task node on the agent-work graph with status in_progress. Reuse the same id later to update or complete it. Optionally name the agent doing the work to draw an 'owns' link.",
	{
		id: z
			.string()
			.regex(/^[a-z0-9][a-z0-9_-]*$/)
			.describe("Stable slug for this task (reuse to update/complete)."),
		title: z.string().describe("Short task title."),
		detail: z.string().optional().describe("Optional longer description."),
		agent: z
			.string()
			.optional()
			.describe("Name of the agent doing the work (draws an 'owns' edge)."),
	},
	async ({ id, title, detail, agent }) =>
		withClient(async (client) => {
			log(`work_start: ${id} (${title})`);
			const effects: CanvasEffect[] = [
				{
					op: "add",
					node: {
						id,
						nodeType: "task",
						payload: {
							title,
							status: "in_progress",
							...(detail ? { detail } : {}),
						},
					},
				},
			];
			if (agent) {
				const aid = agentId(agent);
				effects.push({
					op: "add",
					node: { id: aid, nodeType: "agent", payload: { label: agent } },
				});
				effects.push({
					op: "connect",
					edge: {
						id: `${aid}__owns__${id}`,
						from: aid,
						to: id,
						relation: "owns",
					},
				});
			}
			const ack = await client.applyEffects(WORK_PROJECT, effects);
			return txt(`Started task "${id}" (work graph v${ack.version}).`);
		}),
);

server.tool(
	"work_status",
	"Update a task's status on the agent-work graph (todo→in_progress→blocked→done, or failed).",
	{
		id: z.string().describe("Task id."),
		status: z
			.enum(["pending", "in_progress", "blocked", "done", "failed"])
			.describe("New status."),
	},
	async ({ id, status }) =>
		withClient(async (client) => {
			log(`work_status: ${id} -> ${status}`);
			const ack = await client.applyEffects(WORK_PROJECT, [
				{ op: "update", id, payload: { status } },
			]);
			return txt(`Task "${id}" → ${status} (work graph v${ack.version}).`);
		}),
);

server.tool(
	"work_done",
	"Mark a task complete on the agent-work graph (status done).",
	{ id: z.string().describe("Task id.") },
	async ({ id }) =>
		withClient(async (client) => {
			log(`work_done: ${id}`);
			const ack = await client.applyEffects(WORK_PROJECT, [
				{ op: "update", id, payload: { status: "done" } },
			]);
			return txt(`Task "${id}" done (work graph v${ack.version}).`);
		}),
);

server.tool(
	"work_link",
	"Draw a typed dependency between two work items on the agent-work graph: depends_on, blocks, part_of, precedes, or related_to.",
	{
		from: z.string().describe("Source task/item id."),
		to: z.string().describe("Target task/item id."),
		relation: z
			.enum(["depends_on", "blocks", "part_of", "precedes", "related_to"])
			.describe("Relationship from → to."),
	},
	async ({ from, to, relation }) =>
		withClient(async (client) => {
			log(`work_link: ${from} --${relation}--> ${to}`);
			const ack = await client.applyEffects(WORK_PROJECT, [
				{
					op: "connect",
					edge: { id: `${from}__${relation}__${to}`, from, to, relation },
				},
			]);
			return txt(
				`${from} --${relation}--> ${to} (work graph v${ack.version}).`,
			);
		}),
);

server.tool(
	"work_blocked_by",
	"Record that a task is blocked — adds a blocker node, a 'blocks' edge to the task, and sets the task status to blocked.",
	{
		taskId: z.string().describe("The blocked task's id."),
		blockerId: z
			.string()
			.regex(/^[a-z0-9][a-z0-9_-]*$/)
			.describe("Stable slug for the blocker."),
		reason: z.string().describe("What's blocking it."),
	},
	async ({ taskId, blockerId, reason }) =>
		withClient(async (client) => {
			log(`work_blocked_by: ${taskId} <- ${blockerId}`);
			const ack = await client.applyEffects(WORK_PROJECT, [
				{
					op: "add",
					node: {
						id: blockerId,
						nodeType: "blocker",
						payload: { label: reason, reason },
					},
				},
				{
					op: "connect",
					edge: {
						id: `${blockerId}__blocks__${taskId}`,
						from: blockerId,
						to: taskId,
						relation: "blocks",
					},
				},
				{ op: "update", id: taskId, payload: { status: "blocked" } },
			]);
			return txt(
				`Task "${taskId}" blocked by "${blockerId}" (work graph v${ack.version}).`,
			);
		}),
);

server.tool(
	"work_produced",
	"Record an artifact an agent/task produced (a file, PR, diff, commit, or output) and link it with a 'produces' edge.",
	{
		fromId: z.string().describe("The agent or task id that produced it."),
		artifactId: z
			.string()
			.regex(/^[a-z0-9][a-z0-9_-]*$/)
			.describe("Stable slug for the artifact."),
		label: z.string().describe("Artifact label (e.g. PR title, filename)."),
		artifactType: z
			.enum(["file", "pr", "diff", "commit", "output", "url"])
			.describe("Artifact kind."),
		ref: z.string().optional().describe("Path / URL / sha."),
	},
	async ({ fromId, artifactId, label, artifactType, ref }) =>
		withClient(async (client) => {
			log(`work_produced: ${fromId} -> ${artifactId}`);
			const ack = await client.applyEffects(WORK_PROJECT, [
				{
					op: "add",
					node: {
						id: artifactId,
						nodeType: "artifact",
						payload: { label, artifactType, ...(ref ? { ref } : {}) },
					},
				},
				{
					op: "connect",
					edge: {
						id: `${fromId}__produces__${artifactId}`,
						from: fromId,
						to: artifactId,
						relation: "produces",
					},
				},
			]);
			return txt(
				`Recorded artifact "${artifactId}" (work graph v${ack.version}).`,
			);
		}),
);

server.tool(
	"work_list",
	"Read back the agent-work graph — every task (with status), agent, artifact, blocker, and the links between them. Call before adding so you reuse ids.",
	{},
	async () =>
		withClient(async (client) => {
			log("work_list");
			const doc = await client.getCanvas(WORK_PROJECT);
			return txt(formatCanvas(doc));
		}),
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
