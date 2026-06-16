#!/usr/bin/env bun
/**
 * Claude Code hook → Aizuchi agent-work graph ingester.
 *
 * Wire this as a Claude Code hook (see `docs/work-graph-hooks.md`). Claude
 * pipes the hook event JSON on stdin; this script translates it into canvas
 * effects on the `work` board so an agent's real activity auto-populates the
 * Work Graph window — no agent effort required.
 *
 * Translated events:
 *   - SessionStart        → upsert an `agent` node (status in_progress)
 *   - Stop                → mark that agent `idle`
 *   - PostToolUse(TodoWrite) → one `task` node per todo (status mapped),
 *                             `owns` edges from the agent, and a prune of the
 *                             session's tasks that dropped off the list
 *
 * It discovers the running app via `~/.aizuchi/cli.port` + `cli-token` (same
 * as the CLI) and NEVER fails the hook — any error is logged to stderr and we
 * exit 0 so Claude Code is unaffected.
 */

import { AizuchiClient, type CanvasEffect } from "../src/lib/cli-core";

const WORK = "work";

// biome-ignore lint/suspicious/noExplicitAny: the Claude hook payload is untyped
type HookPayload = any;

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function hash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
	return h.toString(36);
}

function slug(s: string, n = 12): string {
	return (
		s
			.replace(/[^a-z0-9]/gi, "")
			.toLowerCase()
			.slice(0, n) || "x"
	);
}

function basename(p: string | undefined): string {
	if (!p) return "agent";
	const parts = p.replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || "agent";
}

const STATUS_MAP: Record<string, string> = {
	pending: "pending",
	in_progress: "in_progress",
	completed: "done",
};

async function buildEffects(
	hook: HookPayload,
	client: AizuchiClient,
): Promise<CanvasEffect[]> {
	const event = hook.hook_event_name ?? hook.hookEventName;
	const session = String(hook.session_id ?? hook.sessionId ?? "unknown");
	const sShort = slug(session);
	const agentNodeId = `agent_${sShort}`;
	const cwd: string | undefined = hook.cwd ?? hook.workspace?.cwd;
	const label = basename(cwd);

	if (event === "SessionStart") {
		return [
			{
				op: "add",
				node: {
					id: agentNodeId,
					nodeType: "agent",
					payload: { label, cwd, status: "in_progress" },
				},
			},
		];
	}

	if (event === "Stop") {
		return [{ op: "update", id: agentNodeId, payload: { status: "idle" } }];
	}

	const toolName = hook.tool_name ?? hook.toolName;
	if (event === "PostToolUse" && toolName === "TodoWrite") {
		const todos: HookPayload[] =
			hook.tool_input?.todos ?? hook.toolInput?.todos ?? [];
		const effects: CanvasEffect[] = [
			{
				op: "add",
				node: {
					id: agentNodeId,
					nodeType: "agent",
					payload: { label, cwd, status: "in_progress" },
				},
			},
		];
		const keep = new Set<string>();
		for (const todo of todos) {
			const content = String(todo.content ?? todo.activeForm ?? "").trim();
			if (!content) continue;
			const taskId = `task_${sShort}_${hash(content)}`;
			keep.add(taskId);
			const status = STATUS_MAP[String(todo.status)] ?? "pending";
			effects.push({
				op: "add",
				node: {
					id: taskId,
					nodeType: "task",
					payload: { title: content, status },
				},
			});
			effects.push({
				op: "connect",
				edge: {
					id: `${agentNodeId}__owns__${taskId}`,
					from: agentNodeId,
					to: taskId,
					relation: "owns",
				},
			});
		}
		// Prune this session's tasks that dropped off the list.
		try {
			const doc = await client.getCanvas(WORK);
			for (const n of doc.nodes) {
				if (
					n.nodeType === "task" &&
					n.id.startsWith(`task_${sShort}_`) &&
					!keep.has(n.id)
				) {
					effects.push({ op: "remove", id: n.id });
				}
			}
		} catch {
			// best effort — if we can't read the board, just upsert what we have
		}
		return effects;
	}

	return [];
}

async function main() {
	const raw = await readStdin();
	if (!raw.trim()) return;
	let hook: HookPayload;
	try {
		hook = JSON.parse(raw);
	} catch {
		return;
	}
	const client = await AizuchiClient.create();
	const effects = await buildEffects(hook, client);
	if (effects.length > 0) await client.applyEffects(WORK, effects);
}

main()
	.catch((e: unknown) => {
		console.error(
			"[aizuchi-work-hook]",
			e instanceof Error ? e.message : String(e),
		);
	})
	.finally(() => process.exit(0));
