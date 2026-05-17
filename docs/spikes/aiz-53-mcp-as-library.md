# AIZ-53 — Spike: MCP-as-library refactor for mobile

**Status:** Spike — design only, no production code changes.
**Linear:** https://linear.app/aizuchi/issue/AIZ-53/spike-mcp-as-library-refactor-prerequisite-for-mobile
**Author:** Stephen Horton (drafted by Claude)

> **Top-line recommendation:** The ticket's framing is based on an out-of-date
> picture of the codebase. **Stop here, update the ticket, and re-scope before
> any refactor work begins.** The MCP server is not a Rust binary, it is not
> spawned by the Tauri app, and "lift it into a `crates/aizuchi-mcp/`
> workspace crate" does not describe anything that can actually be done with
> today's source tree. The real mobile question is different (and arguably
> simpler), and is sketched in §3 below.

---

## 0. TL;DR

| AIZ-53 assumption                                                | Reality on `main` (commit `0029e2b`)                                                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| MCP server is a Rust sidecar in `src-tauri/binaries/`             | MCP server is **TypeScript/Bun** at `mcp-server/src/index.ts` (1,568 lines). The "binary" in `src-tauri/binaries/` is a Bun-compiled standalone JS bundle, not a Rust crate. |
| Tauri spawns the sidecar via the `shell` plugin / `sidecar()`     | Tauri does **not** spawn it at runtime at all. `tauri-plugin-shell` is not even a dependency in `src-tauri/Cargo.toml`.            |
| Refactor target is a Rust workspace crate                         | There is nothing Rust-shaped to lift — the MCP server is JS/TS and would have to be **rewritten** in Rust, not moved.              |
| In-process transport is `tokio::sync::mpsc` inside Tauri          | Today's "in-process" path between MCP and Tauri is already a localhost HTTP server with a bearer token (`src-tauri/src/cli_server/`). |
| Spawn problem blocks mobile                                       | The spawn problem **does not exist on mobile** the way described, because nothing is spawned today. The actual mobile blocker is "Claude Code cannot reach an MCP server that lives inside a sandboxed iOS app". |

Read on for the evidence.

---

## 1. Current state map

### 1.1 Where the MCP server actually lives

```
mcp-server/
├── package.json            # name: "aizuchi-mcp", deps: @modelcontextprotocol/sdk, zod
├── src/
│   ├── index.ts            # 1,568 LOC — every MCP tool registration + the StdioServerTransport
│   └── index.test.ts
└── tsconfig.json
```

It is a Bun/TypeScript package. Its build script is:

```jsonc
// mcp-server/package.json
"build:binary": "bun build --compile --minify src/index.ts --outfile ../src-tauri/binaries/aizuchi-mcp"
```

`bun build --compile` produces a single ~63 MB self-contained executable. The
compiled artifact at `src-tauri/binaries/aizuchi-mcp-aarch64-apple-darwin` is
the JavaScript runtime plus the bundled JS bundled together by Bun — it is
**not** a Rust binary and there is no Rust source for it.

### 1.2 How (and whether) the Tauri app spawns it

It doesn't. I greped for every plausible signal:

```bash
$ grep -rn 'sidecar\|aizuchi-mcp\|tauri_plugin_shell' src-tauri/
src-tauri/tauri.conf.json:27:      "binaries/aizuchi-mcp"
src-tauri/src/lib.rs:1863:    claude mcp add ... -- ".../Aizuchi.app/.../aizuchi-mcp"
```

`tauri.conf.json` declares it as an `externalBin`, but `externalBin` only
tells the Tauri bundler to **copy the binary into the .app**. It does not
cause Tauri to spawn it. There is no `tauri-plugin-shell` in
`src-tauri/Cargo.toml`, no `shell:allow-execute` capability, no
`Command::new("aizuchi-mcp")`, and no `sidecar()` call anywhere in the Rust
source.

The one literal reference to the binary in `src-tauri/src/lib.rs` is inside a
**Welcome note's markdown body** (line 1863) instructing the user to run:

```
claude mcp add --transport stdio --scope user aizuchi -- \
  "/Applications/Aizuchi.app/Contents/MacOS/aizuchi-mcp"
```

So the model is: **Claude Code (the user's installed CLI) spawns the MCP
binary as its own subprocess; the Aizuchi app never sees or owns that
process.**

### 1.3 How the MCP server talks to the Tauri app

Not over stdio JSON-RPC into Tauri — Tauri is not on the other end of stdio.
Instead, the MCP server is an **HTTP client** of the Aizuchi IPC server that
the Tauri app already runs (this is the AIZ-13/AIZ-20/AIZ-23 line, completed
~April).

Concretely:

1. The Tauri app starts up and calls `cli_server::start_ipc_server(app)`
   (`src-tauri/src/cli_server/mod.rs:61`). This binds an ephemeral
   `127.0.0.1` port via `tokio::net::TcpListener`, generates a 256-bit
   bearer token in `~/.aizuchi/cli-token` (mode 0600), writes the port to
   `~/.aizuchi/cli.port`, and serves the `/v1/...` REST surface defined in
   `src-tauri/src/cli_server/routes.rs`.
2. The MCP server boots (because Claude Code launched it), discovers the
   port + token via `src/lib/cli-core/discovery.ts`, and lazily constructs
   an `AizuchiClient` (`src/lib/cli-core/client.ts`) that does typed
   `fetch()` calls into the Tauri-hosted HTTP API.
3. Every MCP tool (e.g. `note_create`, `meeting_get`) is a thin wrapper
   around an `AizuchiClient` method, with `withClient(...)` mapping
   `AppNotRunningError` to a friendly "the app isn't running" reply.

```
  Claude Code (user's machine)
       │  stdin / stdout (MCP protocol)
       ▼
  aizuchi-mcp  (Bun binary, separate process)
       │  HTTP fetch() to 127.0.0.1:<ephemeral>
       │  Authorization: Bearer <token from ~/.aizuchi/cli-token>
       ▼
  Aizuchi.app  (Tauri, running)  ──> serves /v1/... via hyper
```

The MCP server **also** still touches the filesystem directly for a handful
of features that aren't on the IPC contract yet — see the header comment at
`mcp-server/src/index.ts:16-34` (organize signal, share/retract signals,
peer/remote-note reads, subscriptions, room host/join, log open/tail,
highlights). These are real cross-cutting reads; any future refactor has to
account for them.

### 1.4 Public surface

There are two layers of "public surface", and they are not the same thing:

1. **The MCP tool surface** — registered with `server.tool(...)` in
   `mcp-server/src/index.ts`. I counted **34** tool registrations
   (`grep -c '^server.tool('` returns 34 hits in lines 255–1542). These are
   what an LLM sees.
2. **The IPC HTTP surface** — defined in `src-tauri/src/cli_server/routes.rs`.
   Today this is ~20 endpoints across `/v1/app/...`, `/v1/pads/...`,
   `/v1/meetings/...`. This is what the MCP server consumes and what
   `bin/aizuchi.ts` (the CLI) also consumes. It is **frozen** by the v1
   contract per the comment at the top of `cli_server/mod.rs`.

> **Implication:** the existing IPC surface is the "thin desktop-only
> wrapper" that AIZ-53 was looking for. It already exists, it is already in
> Rust, it is already in-process inside Tauri, and it already speaks HTTP
> over a random localhost port that uses a bearer token. The refactor the
> ticket asks for is, in some sense, already done — for the IPC client side
> of the boundary. The MCP server side is where the disconnect is.

---

## 2. What the ticket should probably say instead

The actual mobile-blocking question is **not** "how do we link the MCP
server's Rust code in-process". It's:

> On iOS/Android, where does `aizuchi-mcp` (the MCP protocol server, the
> thing Claude Code talks to) physically run, given that:
>
> (a) the iOS sandbox cannot host the Bun runtime nor spawn other
> processes, and
>
> (b) Claude Code is a **desktop** Anthropic CLI — it isn't going to be
> running on the user's phone connecting to an in-app MCP server anyway.

There are three plausible answers, all of which are bigger rethinks than the
ticket implies:

### Option A: "MCP on mobile is a non-goal, ship desktop-only MCP."
The iOS app would simply not expose MCP. Users use Aizuchi mobile as a UI
client and use Aizuchi desktop (with MCP) as the Claude-Code-facing
integration. The two would sync via the existing P2P / cloud path (whatever
that becomes). The refactor is then **zero work for AIZ-53** because there
is no in-process MCP server to build; AIZ-53 closes as "won't fix /
non-goal".

This is, frankly, the option I'd recommend. The current MCP server exists to
let a developer-on-a-laptop drive their desktop scratch pads from their
terminal. That use case doesn't translate to a phone.

### Option B: "Mobile app speaks the IPC contract directly to itself."
If the goal is "the mobile UI can drive the same pads/meetings the desktop
UI drives", you don't need an MCP server inside the iOS app. You need the
**IPC server** (`cli_server`) running in-process inside the mobile build. The
mobile UI talks to it over a Tauri command bridge or in-process Rust calls.
This is genuinely tractable:

- `cli_server` is already a tokio-based hyper server. It already runs
  in-process on desktop and binds `127.0.0.1`. On iOS it would bind on the
  loopback interface inside the app's sandbox.
- We'd need to cfg-gate the bits that touch the OS in
  desktop-incompatible ways (`mdns-sd`, `cpal`, `whisper-rs`, `notify`,
  `objc2-app-kit`) — these are listed in `src-tauri/Cargo.toml` and most
  are already macOS-only via the `[target.'cfg(target_os = "macos")']`
  block.
- Capabilities aside, this is a sane refactor. It's also out of scope for
  AIZ-53 as written — it's a different ticket.

### Option C: "Re-host the MCP server in Rust, in-process, in Tauri."
This is what AIZ-53 literally asks for, rewritten honestly:

- Port `mcp-server/src/index.ts` (1,568 LOC of TS) to a new Rust crate.
- Use a Rust MCP SDK (the official one is
  [modelcontextprotocol/rust-sdk](https://github.com/modelcontextprotocol/rust-sdk),
  pre-1.0 as of writing — would need a context7 check before committing).
- Link it as a module inside `src-tauri`; on desktop, also expose a TCP
  port so external Claude Code can still connect.
- This is a **rewrite**, not a lift-and-shift. Effort is multiples larger
  than the ticket's 3-point estimate.

Even if we pick option C, the user-facing problem remains: **Claude Code
doesn't run on iOS**. Inside iOS, who is the MCP client? If the answer is
"nobody, this is just to keep the architecture clean," we should say so and
defer to a desktop-only refactor.

---

## 3. If we proceed with Option C anyway — the design AIZ-53 asked for

Per the ticket. This is what the deliverable would look like if we accept
the rewrite cost.

### 3.1 Cargo workspace shape

```toml
# Cargo.toml (new, at repo root)
[workspace]
resolver = "2"
members = ["src-tauri", "crates/aizuchi-mcp"]

# src-tauri/Cargo.toml
[dependencies]
aizuchi-mcp = { path = "../crates/aizuchi-mcp" }
# ...everything currently here

# crates/aizuchi-mcp/Cargo.toml
[package]
name = "aizuchi-mcp"
version = "0.1.0"
edition = "2021"

[dependencies]
tokio = { version = "1", features = ["sync", "rt", "macros", "io-util"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
# MCP SDK — TBD; the official rust-sdk is pre-1.0. Likely
# `rust-mcp-sdk` or rolling our own JSON-RPC over a Transport trait.

[features]
# Desktop builds need the local TCP listener so external Claude Code
# can still attach. Mobile turns it off.
external-tcp = ["dep:hyper", "dep:hyper-util"]
default = []
```

### 3.2 Module layout

```
crates/aizuchi-mcp/
├── Cargo.toml
├── src/
│   ├── lib.rs              # pub: spawn_in_process(app_handle), spawn_tcp(addr)
│   ├── transport/
│   │   ├── mod.rs          # trait Transport: send / recv JSON-RPC messages
│   │   ├── in_process.rs   # tokio::sync::mpsc-based Transport
│   │   └── tcp.rs          # cfg(feature = "external-tcp") — hyper-based MCP-over-HTTP/SSE
│   ├── tools/
│   │   ├── mod.rs          # registry + dispatch
│   │   ├── pads.rs         # 14 pad tools
│   │   ├── meetings.rs     # 8 meeting tools
│   │   ├── peers.rs        # 6 peer/room tools
│   │   └── logs.rs         # 6 log tools
│   └── client.rs           # rusty equivalent of AizuchiClient — talks to cli_server in-process
└── tests/
```

### 3.3 The desktop wrapper binary

The current `mcp-server/` Bun package goes away. Replaced by:

```rust
// src-tauri/src/bin/aizuchi-mcp.rs  (new, thin)
//
// Stdio entry point that desktop Claude Code launches. Same UX as today.
fn main() -> anyhow::Result<()> {
    // Discover the running Tauri app's IPC port/token (same as today,
    // just from Rust instead of TS).
    let config = aizuchi_mcp::client::discover()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(aizuchi_mcp::serve_stdio(config))
}
```

And a `[[bin]]` entry in `src-tauri/Cargo.toml`. Tauri's `externalBin`
keeps pointing at the same path so the bundling story doesn't change.

### 3.4 The mobile entry point (literally as asked)

```rust
// src-tauri/src/lib.rs  (sketch — DO NOT COMMIT as part of this spike)

#[tauri::command]
async fn start_in_process_mcp(app: tauri::AppHandle) -> Result<(), String> {
    aizuchi_mcp::spawn_in_process(app)
        .await
        .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        // ... existing plugins, commands ...
        .setup(|app| {
            let app_handle = app.handle().clone();

            #[cfg(mobile)]
            {
                // On iOS/Android, the MCP server runs in-process. The mobile
                // UI dispatches MCP calls over the Tauri command bridge
                // (see start_in_process_mcp above). No TCP, no stdio.
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = aizuchi_mcp::spawn_in_process(app_handle).await {
                        eprintln!("[mcp] in-process server failed: {e}");
                    }
                });
            }

            #[cfg(desktop)]
            {
                // On desktop, we *don't* start an in-process MCP server
                // by default — the desktop sidecar (`aizuchi-mcp` binary)
                // is what Claude Code connects to. We do still run the
                // optional TCP transport for in-app testing.
                if std::env::var("AIZUCHI_MCP_TCP").is_ok() {
                    tauri::async_runtime::spawn(async move {
                        let _ = aizuchi_mcp::spawn_tcp(app_handle, "127.0.0.1:0").await;
                    });
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 3.5 In-process transport choice

The ticket asks `tokio::sync::mpsc` vs a localhost `TcpListener`. My take:

**Use `tokio::sync::mpsc` for the in-process path. Keep TCP as an optional
desktop-only `--feature external-tcp`.**

Reasoning:

- **mpsc is cheaper and avoids a sandbox surprise.** iOS's
  `App Sandbox` permits loopback TCP from within an app to itself, but
  every loopback `bind()` is a syscall we don't need. mpsc is a couple of
  atomic ops.
- **TCP-on-mobile invites every "why is this app opening a socket"
  conversation later** — App Review questions, MDM policies, the App
  Privacy report. Avoid by construction.
- **There is no external client on mobile.** TCP only helps you when
  another process needs to connect. On iOS there is no other process to
  connect.
- **One transport trait, two implementations** is cheap to maintain. The
  framing on both sides is the same JSON-RPC message envelope.

Counter-argument: a localhost TCP listener has the upside that the *same*
transport code is used on both targets, which makes the iOS-simulator-vs-
desktop testing matrix smaller. I think that's outweighed by the points
above, but it's a real trade.

---

## 4. Risks and unknowns

Ranked by severity.

### 4.1 **Tokio-runtime ownership** (high)
`tauri::async_runtime` is a thin wrapper that today defaults to a global
tokio runtime. The IPC server (`cli_server`) already runs on it; adding the
MCP server on the same runtime is fine *if* MCP doesn't block. It does
block today on `cli_server.importAudioMeeting()` (whisper + tinydiarize
runs synchronously on tens-of-seconds-long audio). If we run MCP on the
same multi-threaded runtime as the audio decoder, a long import will starve
MCP request handling unless we spawn whisper work on a `spawn_blocking`
pool. **Pre-refactor: audit `meetings::import_audio` to confirm it uses
`spawn_blocking`.** I did not trace this end-to-end in this spike.

### 4.2 **Rust MCP SDK maturity** (medium)
The Rust MCP SDK is pre-1.0. Last time I checked the official
`modelcontextprotocol/rust-sdk` repo it had < 1k stars and shape changed
in the last few months. We may end up:
- Vendoring + patching, or
- Writing our own JSON-RPC dispatch loop (it's ~200 LOC, not terrible).
Either way, this is a real risk to the effort estimate. **Action: run
`context7 resolve-library-id` + `query-docs` on the rust-sdk before
committing to Option C.**

### 4.3 **The MCP server still touches the filesystem directly for ~10 tools** (medium)
The header comment at `mcp-server/src/index.ts:16-34` lists the tools that
still read/write `~/.aizuchi/` directly because the IPC contract doesn't
cover them yet. On mobile, `~/.aizuchi/` is in the app's sandbox container
(fine, but the path is different — `NSHomeDirectory()` does not give you
`/Users/…`, it gives you the per-app container). Any refactor needs to
either:
- Push those tools onto the IPC contract first (preferable, cleaner), or
- Carry the FS code into the new crate and cfg-gate the paths.

### 4.4 **Compile target leakage** (medium)
`src-tauri/Cargo.toml` pulls in `cpal`, `whisper-rs`, `hound`, `notify`,
`mdns-sd`, `cpal`, several `objc2-*` macOS-only crates, and `symphonia`.
None of these are needed by the MCP layer per se, but they are siblings
inside the same crate. Building for `aarch64-apple-ios` will require
cfg-gating most of these — the `[target.'cfg(target_os = "macos")']`
block already gates `objc2-*` and `block2`, but `cpal`, `whisper-rs`,
`notify`, and `mdns-sd` are unconditional. **Mobile build won't compile
today; this is true regardless of the MCP refactor.** The MCP refactor is
*one* prerequisite, but not the only one.

### 4.5 **`async-trait` boundaries** (low)
The MCP SDK exposes `async fn`s on traits; on Rust 2021 with stable Rust
this still wants the `async-trait` crate. Object-safety holes are
plausible if we expose a `dyn Transport`. Workable — just call out the
likely `Box<dyn Transport + Send>` shape in the trait design.

### 4.6 **External Claude Code still expects stdio** (low)
On desktop the contract is "Claude Code spawns the binary; talks stdio".
The Rust port must keep that exact wire shape — same JSON-RPC framing,
same protocol version handshake. Tested by the same end-to-end test we
have today (claude mcp add … && call note_create from a separate Claude
Code session).

### 4.7 **The `cli-core` cross-package import** (low — orthogonal)
The MCP server imports from `../../src/lib/cli-core/` (TS-side). If we
port MCP to Rust, this import goes away, but the **CLI** (`bin/aizuchi.ts`)
still uses it. That's fine — `cli-core` stays where it is. Just noting
that it isn't part of the MCP scope.

---

## 5. Effort estimate

Assuming **Option C** (the literal AIZ-53 plan), broken into commits/PRs:

| # | Title                                                              | Estimate | Risk |
|---|---|---|---|
| 1 | Decision PR — pick MCP SDK / hand-rolled JSON-RPC. Spike a minimal `note_list` over stdio in Rust. | 1 day    | High (SDK maturity) |
| 2 | New `crates/aizuchi-mcp/` skeleton — Cargo workspace, Transport trait, mpsc impl, stdio impl, empty tool registry. | 1 day | Low |
| 3 | Port the 14 pad tools. Reuse the `cli_server` HTTP API as the back end (Rust client equivalent of `AizuchiClient`). | 1.5 days | Low |
| 4 | Port the 8 meeting tools. | 1 day    | Low |
| 5 | Port the 6 peer/room tools + 6 log tools. Most touch the FS directly today; need either to push them onto the IPC contract first, or to lift the FS code into the new crate. | 2 days   | Medium |
| 6 | Replace `mcp-server/` Bun build with the new `aizuchi-mcp` Rust bin in `src-tauri/Cargo.toml`. Update `release.yml` to build via cargo instead of `bun build --compile` on all four platforms. | 1 day    | Medium (release CI surface) |
| 7 | Wire the in-process spawn under `#[cfg(mobile)]` in `src-tauri/src/lib.rs`. Behind an `AIZUCHI_MCP_TCP` env var on desktop for parity testing. | 0.5 days | Low |
| 8 | Acceptance: `cargo tauri dev` keeps working, `cargo tauri build` on macOS still bundles the binary, `cargo build --target aarch64-apple-ios` compiles past MCP code. | 1 day    | Medium (cfg-gating compile surface) |

**Total: ~9 working days (~1.8 weeks for one person, end-to-end).** This is
~3× the ticket's 3-point estimate. The ticket's 3 points are probably right
for the *Rust* refactor it imagines (move files, add a workspace member),
but wrong for what the work actually is (port 1,568 lines of TS to Rust
and replace a Bun build pipeline).

If we pick **Option A** (mobile-doesn't-need-MCP), the effort is **zero**
and we close AIZ-53.

If we pick **Option B** (mobile uses the IPC contract directly,
no in-process MCP), the effort is probably **2–3 days** to cfg-gate the
non-mobile crates in `src-tauri/Cargo.toml` and put the IPC server behind a
Tauri command on mobile. That work is a different ticket.

---

## 6. Open questions for the user

These need answers before any code moves. The first one is by far the most
important.

1. **Is there actually an MCP-on-mobile use case?** Who is the MCP client
   on iOS? Claude Code doesn't run on phones. If the answer is "we want
   the Aizuchi UI on the phone to use MCP tools internally", that's a
   different architecture (and arguably not MCP — it's just app-internal
   commands).

2. **If yes to (1): is a 9-day Rust rewrite acceptable**, vs. closing the
   ticket as won't-fix and revisiting once Option A's UX gaps become
   visible? I'd argue no — but it's your call.

3. **If yes to (2): are we OK depending on a pre-1.0 Rust MCP SDK**, or
   should we roll our own JSON-RPC dispatch? Rolling our own is more code
   but escapes the "SDK changed under us" risk.

4. **Out-of-band: when do you want to update the AIZ-53 ticket itself?**
   The Linear description references a Rust sidecar that does not exist.
   It should be rewritten before the next person picks it up.

5. **Smaller, but real: the FS-side tools (`organize`, `share`, `retract`,
   `peers`, `logs`, `highlights`).** Are these in scope for the
   mobile port at all? Some are tied to multi-window desktop UX (open log
   window, focus pad) that doesn't translate to a single-window mobile
   app. If they're out of scope on mobile, we can `#[cfg(desktop)]` the
   entire tool registration and save ourselves ~30% of the porting work.

---

## Appendix A: Repo evidence cited above

| Claim                                                  | File / lines                                                    |
|---|---|
| MCP server is TS/Bun                                  | `mcp-server/package.json:7-13`, `mcp-server/src/index.ts:46-65` |
| 1,568 LOC                                             | `wc -l mcp-server/src/index.ts`                                 |
| Compiled binary is `bun build --compile` output       | `mcp-server/package.json:12`                                    |
| No `tauri-plugin-shell` dep                           | `src-tauri/Cargo.toml:21-69`                                    |
| No `Command::new("aizuchi-mcp")`                      | `grep -rn 'aizuchi-mcp' src-tauri/` (only `tauri.conf.json` + welcome note string)|
| `externalBin` only triggers bundling                  | `src-tauri/tauri.conf.json:26-28`                               |
| Welcome note tells the user to run `claude mcp add`   | `src-tauri/src/lib.rs:1862-1867`                                |
| IPC server already exists, hyper-on-tokio-on-127.0.0.1| `src-tauri/src/cli_server/mod.rs:61-120`                        |
| MCP server is an HTTP client of the IPC server        | `mcp-server/src/index.ts:56-65`, `src/lib/cli-core/client.ts`   |
| Per-platform MCP build in release CI                  | `.github/workflows/release.yml:43-127`                          |
| Tools still touching FS directly                      | `mcp-server/src/index.ts:16-34`                                 |

## Appendix B: Things I did not verify in this spike

These would each kill the effort estimate if they turned out badly. Listing
them so they don't get missed by whoever picks this up.

- **Does `meetings::import_audio` already use `spawn_blocking`?** If not,
  it'll starve the in-process MCP server on a multi-minute audio import.
- **Does the Rust MCP SDK exist in a usable state today?** I did not run
  context7 / cargo search; AIZ-53's reviewer should.
- **Is `127.0.0.1` TCP loopback actually permitted on iOS at runtime
  without an entitlement?** I believe yes (the App Sandbox blocks
  *server* sockets on real hardware in some configurations, but I have
  not confirmed with current iOS docs). The spike recommendation
  (`tokio::sync::mpsc`, not TCP, on mobile) dodges this anyway.
- **Does the iOS Tauri target build at all today on this repo's
  `Cargo.toml`?** Almost certainly not — `cpal`, `whisper-rs`, `notify`,
  and `mdns-sd` are unconditional and don't claim iOS support. The MCP
  refactor is a prerequisite but is not by itself sufficient to compile
  for iOS.
