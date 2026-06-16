# Auto-populating the Agent-Work Graph from Claude Code

Aizuchi's **Work Graph** (Open Work Graph window, or any `/canvas?project=work`
board) visualizes work across agents as a live node graph. You can populate it
two ways:

1. **Agent-authored** — an agent calls the `work_*` MCP tools (`work_start`,
   `work_status`, `work_done`, `work_link`, `work_blocked_by`, `work_produced`,
   `work_list`). Explicit and expressive.
2. **Auto-derived** — Claude Code **hooks** pipe real activity into the graph
   with zero agent effort. This page wires that up.

## What gets ingested

`bin/aizuchi-work-hook.ts` translates Claude Code hook events into `work`-board
canvas effects:

| Hook event | Becomes |
| --- | --- |
| `SessionStart` | an **agent** node (labelled by the repo dir), status `in_progress` |
| `PostToolUse` matching `TodoWrite` | one **task** node per todo (status `pending`/`in_progress`/`done`), an `owns` edge from the agent, and a prune of that session's tasks that fell off the list |
| `Stop` | the agent node marked `idle` |

Tasks are keyed by `task_<session>_<hash(content)>`, so re-running `TodoWrite`
updates the same nodes instead of duplicating them, and multiple agents (each a
different session) show up as separate `agent` nodes on one graph.

## Wiring it up

The hook script discovers the running app through `~/.aizuchi/cli.port` +
`~/.aizuchi/cli-token` (same as the CLI), so the only thing to configure is the
command. Add this to your Claude Code settings (`~/.claude/settings.json`, or a
project `.claude/settings.json`), replacing `ABS_PATH` with the absolute path to
this repo:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "bun ABS_PATH/bin/aizuchi-work-hook.ts" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "bun ABS_PATH/bin/aizuchi-work-hook.ts" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "TodoWrite",
        "hooks": [
          { "type": "command", "command": "bun ABS_PATH/bin/aizuchi-work-hook.ts" }
        ]
      }
    ]
  }
}
```

> On this machine `ABS_PATH` is `/Users/stephenhorton/projects/aizuchi-canvas`
> (the worktree). Use wherever the app actually lives once merged.

The script never fails the hook — if Aizuchi isn't running, or anything errors,
it logs to stderr and exits 0, so Claude Code is unaffected.

### Try it

1. Run Aizuchi (`bun tauri dev`) and open the Work Graph window
   (app menu → **Open Work Graph**).
2. In a Claude Code session with the hooks wired, ask the agent to plan
   something so it calls `TodoWrite`.
3. Watch tasks appear under an agent node, statuses flip as the agent works,
   and completed todos turn green.

## v2 ideas (not yet wired)

- A `PostToolUse` matcher on `Bash(git commit*|gh pr create*)` to mint
  `artifact` nodes + `produces` edges automatically.
- `depends_on` / `blocks` inference between tasks.
- Per-worktree (branch) agent grouping instead of per-session.
