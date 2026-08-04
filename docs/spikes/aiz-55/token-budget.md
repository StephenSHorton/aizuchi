# AIZ-55 — Token budget analysis

Simulation of the Aizuchi GraphDiff prompt against Apple Foundation Models' 4,096-token shared input + output window. Code: [`token_budget.py`](./token_budget.py) and [`token_budget_extreme.py`](./token_budget_extreme.py). Raw output: [`token_budget_output.txt`](./token_budget_output.txt) and [`token_budget_extreme_output.txt`](./token_budget_extreme_output.txt).

## Setup

- **Context window:** 4,096 tokens, shared input + output. Source: `SystemLanguageModel.contextSize` documents this exact value; `LanguageModelSession.GenerationError.exceededContextWindowSize` enforces it. (Both confirmed via Context7 docs lookup, May 2026.)
- **Tokenizer proxy:** `tiktoken` `cl100k_base`. Apple has not published the Foundation Models tokenizer, but their docs cite *"~3-4 characters per token in English, Spanish, German"* — which is the cl100k regime. Numbers here are ±10-15% rather than exact.
- **Output budget floor:** 1,000 tokens reserved for the GraphDiff response. A "meaningful" diff in production (2-5 new nodes, 2-5 new edges, 1-2 updates, 1-3 notes) hand-written in the simulator is **444 tokens**; the 1K floor leaves headroom for richer passes and the finalize-pass diff, which is larger.
- **Schema injection:** FM's default is `includeSchemaInPrompt: true`. The `@Generable` macro provides constrained decoding even when the schema isn't echoed in-prompt, so the harness sets it to `false`. We report both rows for completeness.

## Fixed component costs (cl100k tokens)

| Component | Tokens | Chars |
|---|---:|---:|
| `SYSTEM_PROMPT_ATTRIBUTION` (current desktop) | **3,038** | 12,020 |
| `SYSTEM_PROMPT_SUBSTANCE` (current desktop) | 2,681 | 10,871 |
| Schema blob estimate (if echoed) | 621 | — |
| `PREVIOUS_THOUGHTS` (3 thoughts) | 191 | — |
| `RECENT_TRANSCRIPT` (60s window) | 184 | — |
| `NEW_CHUNK` (30s window) | 124 | — |
| `Compact FM-port system prompt` (this spike) | **340** | 1,541 |

The attribution system prompt **alone** consumes **74%** of the 4K window. The substance prompt is barely better at **65%**.

## Three graph sizes against the current prompt

Scenario A — `SYSTEM_PROMPT_ATTRIBUTION` + schema echoed (FM default):

| Graph | Nodes | Edges | Graph tok | Total in | Remaining | Floor ≥1K |
|---|---:|---:|---:|---:|---:|:---:|
| Small | 5 | 8 | 563 | 4,841 | **−745** | FAIL |
| Medium | 15 | 25 | 1,932 | 6,210 | **−2,114** | FAIL |
| Large | 30 | 51 | 3,760 | 8,038 | **−3,942** | FAIL |

Scenario B — same prompt, `includeSchemaInPrompt: false`:

| Graph | Total in | Remaining | Floor ≥1K |
|---|---:|---:|:---:|
| Small | 4,220 | **−124** | FAIL |
| Medium | 5,589 | −1,493 | FAIL |
| Large | 7,417 | −3,321 | FAIL |

Scenario C — desktop prompt with worked examples removed, no schema echo:

| Graph | Total in | Remaining | Floor ≥1K | Ref-diff fits |
|---|---:|---:|:---:|:---:|
| Small | 3,605 | 491 | FAIL | PASS |
| Medium | 4,974 | −878 | FAIL | FAIL |
| Large | 6,802 | −2,706 | FAIL | FAIL |

**Verdict for the existing desktop prompt: it doesn't fit at any meaningful graph size.** Even with the worked examples stripped and schema injection off, only the 5-node graph leaves any room — and that room (491 tokens) is too small for our 1,000-token output floor.

## Compact FM-port system prompt

Scenario for [`token_budget_extreme.py`](./token_budget_extreme.py): a 340-token system prompt written specifically for the FM port. The `@Generable` macro removes the need to spell out the schema or include worked examples; we keep the rubric (node types, edge relations, type-specific fields) compressed:

| Graph | Total in | Remaining | Floor ≥1K |
|---|---:|---:|:---:|
| 3 nodes | 1,307 | **2,789** | PASS |
| 5 nodes | 1,522 | **2,574** | PASS |
| 8 nodes | 1,913 | **2,183** | PASS |
| 10 nodes | 2,197 | **1,899** | PASS |
| 15 nodes | 2,891 | **1,205** | PASS |
| 20 nodes | 3,577 | 519 | FAIL |

The compact prompt clears the bar up through **15 nodes / 25 edges** with 1,205 output tokens remaining — exactly matching the AIZ-55 spike's pass criterion ("≥15-node, ≥25-edge graph with room for a meaningful diff").

## Eviction — keeping a large graph relevant

A real Aizuchi meeting accrues many more than 15 nodes over a 30-minute session (current finalize-pass snapshots from import runs land in the 40-80 node range). The compact prompt only helps if we can *evict* aggressively per pass while keeping the conversationally-active subgraph.

Strategy: **keep the last-touched N nodes plus their 1-hop neighbors and the edges that connect them.** "Last touched" comes from a per-node `updatedAt` we already maintain in `applyDiff` ordering; 1-hop expansion captures the immediate cluster the speakers are currently in. Older clusters that haven't been mutated for many passes pay nothing.

Sweep on a 30-node graph, compact prompt:

| `keep_n` seed | After 1-hop expansion | Graph tok | Remaining | Floor ≥1K |
|---:|---:|---:|---:|:---:|
| 3 | 6 of 30 | 475 | 2,662 | PASS |
| 5 | 12 of 30 | 1,253 | 1,884 | PASS |
| 8 | 17 of 30 | 1,824 | 1,313 | PASS |
| 10 | 23 of 30 | 2,804 | 333 | FAIL |
| 15 | 28 of 30 | 3,435 | −298 | FAIL |

**Sweet spot: `keep_n = 8` retains 17 of 30 nodes (≈57%) and leaves 1,313 output tokens.** Going to `keep_n = 10` over-shoots once 1-hop expansion is applied. The model loses visibility into the ~13 nodes outside this window; the call site has to detect when the model emits an `add_nodes` collision with an evicted id and route an "undo eviction for this id" hint into the next pass.

## What gets evicted, and what's lost

Nodes most likely to be evicted by last-touched-8: stable participants (`person` nodes set up at meeting start), early topic nodes that have stopped being mentioned, and resolved blockers. Loss surface:

- **Risk of duplicate-node creation** when an older node falls out of context and the model re-introduces it under a slightly different id. Mitigation: keep a per-pass server-side de-duper that maps near-duplicate ids back to the evicted canonical id, and emit a `merge_nodes` on the *next* pass when the model surfaces the same concept twice.
- **Loss of cross-cluster `related_to` edges.** The 1-hop expansion already preserves immediate neighbors; weaker edges between non-current clusters are dropped. This is acceptable — `related_to` is the soft relation and not load-bearing for layout.
- **Finalize pass cannot use this strategy.** End-of-meeting finalize needs the full graph for cross-batch misses and merges. That pass has to go to the cloud (or chunk + multi-pass on-device, which adds latency).

## Skipping the recent-transcript window

Sanity check: what if we drop the 60s recent transcript window entirely and lean on FM's multi-turn session context to carry it implicitly?

| Graph | Total in (no recent) | Remaining |
|---|---:|---:|
| 10 nodes | 1,926 | 2,170 |
| 15 nodes | 2,620 | 1,476 |
| 20 nodes | 3,306 | 790 |

184 tokens saved per pass. Useful but not transformative — and it costs coreference quality. Recommendation: **keep the recent transcript window; cut tokens from the graph via eviction instead.**

## Bottom line for the spike

The binding constraint is the **system prompt size**, not the graph or the transcript. The desktop prompt has to be rewritten for the FM port — at 340 tokens (≈1/9th of today's), the 4K window comfortably hosts a 15-node graph with room for a meaningful diff. With eviction, on-device passes can keep up with meeting-shaped (30-80 node) graphs without overflow.

Latency, validity, and per-iPhone p50/p95 still need confirmation on a real device — that's what the Swift harness in `Harness/` is for.
