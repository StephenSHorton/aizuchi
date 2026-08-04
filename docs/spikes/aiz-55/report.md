# AIZ-55 — Foundation Models + @Generable GraphDiff fit-check

**Verdict: yellow.** On-device Foundation Models can host Aizuchi's GraphDiff loop, but not with the prompt we ship today. The binding constraint is the 4,096-token shared input + output window: our current 12 KB system prompt alone consumes ~74% of it. A purpose-built compact system prompt (340 tokens, 1/9th of today's) plus an aggressive eviction strategy (keep last-touched 8 nodes + 1-hop neighbors) clears the spike's pass-bar of a 15-node / 25-edge graph with ≥1 K tokens of output budget remaining.

Latency, validity rate, and prefix-cache effectiveness still need to be measured on real iPhone hardware via the Swift harness in [`Harness/`](./Harness/). This spike doesn't have access to a device; that's the user's next step.

## Current GraphDiff shape

Source of truth: [`src/lib/aizuchi/schemas.ts`](../../../src/lib/aizuchi/schemas.ts).

- `NodeType` — 16 cases: `person`, `topic`, `work_item`, `blocker`, `decision`, `action_item`, `question`, `context`, `risk`, `assumption`, `constraint`, `hypothesis`, `metric`, `artifact`, `event`, `sentiment` ([schemas.ts:3-21](../../../src/lib/aizuchi/schemas.ts#L3-L21)).
- `EdgeRelation` — 17 cases including `owns`, `depends_on`, `blocks`, `related_to`, `decides`, `asks`, `answers`, `mentions`, `assigned_to`, plus the AIZ-12 additions ([schemas.ts:24-43](../../../src/lib/aizuchi/schemas.ts#L24-L43)).
- `Node` — required `id`, `label`, `type`; optional `description`, `speaker`, `status`, `confidence`, `quote`, `tags`, plus 11 type-specific fields (`likelihood`, `impact`, `prediction`, `value`, `target`, `unit`, `occurredAt`, `limit`, `dueDate`, `tone`, `alternative`). All optional; the model fills them when the node type warrants ([schemas.ts:55-153](../../../src/lib/aizuchi/schemas.ts#L55-L153)).
- `Edge` — `id`, `from`, `to`, `relation`, optional `description` ([schemas.ts:156-165](../../../src/lib/aizuchi/schemas.ts#L156-L165)).
- `NodeUpdate` — id plus every Node field optional ([schemas.ts:173-194](../../../src/lib/aizuchi/schemas.ts#L173-L194)).
- `NodeMerge` — `keep` id, `absorb` array of ids ([schemas.ts:196-204](../../../src/lib/aizuchi/schemas.ts#L196-L204)).
- `AIThought` — `id`, `text`, `intent` enum (5 cases), optional `references` array of node ids ([schemas.ts:215-234](../../../src/lib/aizuchi/schemas.ts#L215-L234)).
- `GraphDiff` — `no_changes` boolean plus seven arrays: `add_nodes`, `add_edges`, `update_nodes`, `merge_nodes`, `remove_nodes`, `remove_edges`, `notes` ([schemas.ts:263-289](../../../src/lib/aizuchi/schemas.ts#L263-L289)).

Prompt-construction site: [`src/lib/aizuchi/prompts.ts`](../../../src/lib/aizuchi/prompts.ts) — `buildUserPrompt()` ([prompts.ts:458-490](../../../src/lib/aizuchi/prompts.ts#L458-L490)) emits the current graph JSON + previous thoughts + recent transcript + new chunk into four markdown sections. The system prompts (`SYSTEM_PROMPT_ATTRIBUTION` 12,020 chars / `SYSTEM_PROMPT_SUBSTANCE` 10,871 chars) include extensive rubric *plus* a worked example per mode.

## Swift `@Generable` mirror

Full source: [`Harness/Sources/Harness/GraphDiff.swift`](./Harness/Sources/Harness/GraphDiff.swift). Highlights:

- Each enum is `@Generable enum X: String, CaseIterable`. The case set provides the constrained-decoding grammar; per the docs surfaced via Context7, enum cases don't accept per-case `@Guide(description:)` the way struct fields do — keep cases minimal and lean on the struct-field guides for context.
- `@Guide(description: "...")` annotates every field carrying domain meaning. Constants like `id`, `label`, `type` get descriptions; the type-specific fields (`likelihood`, `prediction`, etc.) get descriptions that point at the node type they apply to.
- Dynamic-length arrays use `.maximumCount(N)`. Per-array bounds: `add_nodes` 12, `add_edges` 16, `update_nodes` 10, `merge_nodes` 4, `remove_nodes` / `remove_edges` 8, `notes` 6, `tags` 8, `absorb` 6, `references` 8. These are the upper bounds Aizuchi sees in practice; they fail-fast if the model spirals and reduce the constrained-decoding grammar size.
- `@Generable`-decorated types auto-derive `PartiallyGenerated` siblings with every property optional; this is what `streamResponse(generating: GraphDiff.self)` yields per snapshot. `Runner.swift` captures both partials (for streaming `notes` early into the UI — the spike's open question) and the realized terminal value.

## Token budget — the binding constraint

Detailed write-up: [`token-budget.md`](./token-budget.md). Raw run output: [`token_budget_output.txt`](./token_budget_output.txt) and [`token_budget_extreme_output.txt`](./token_budget_extreme_output.txt). Headline numbers (cl100k_base proxy):

| Configuration | Total input | Remaining (of 4,096) | Floor ≥1K |
|---|---:|---:|:---:|
| Desktop prompt + schema, 5-node graph | 4,841 | **−745** | FAIL |
| Desktop prompt, no schema, 5-node graph | 4,220 | **−124** | FAIL |
| Compact FM prompt, 15-node graph | 2,891 | **1,205** | **PASS** |
| Compact FM prompt + evict to 17 of 30 nodes | 2,783 | **1,313** | **PASS** |
| Compact FM prompt, 20-node graph | 3,577 | 519 | FAIL |

The compact prompt at 340 tokens fits a 15-node / 25-edge graph with ~1,200 output tokens free. The evicted-30-node configuration fits 17 contextually-relevant nodes with ~1,300 output tokens free. Both meet the AIZ-55 spike's `≥15-node, ≥25-edge graph with room for a meaningful diff` bar.

## Eviction strategy

Recommended: **last-touched-N + 1-hop expansion + edge filter**.

1. Maintain a per-node `lastTouchedPassId` (already implicit in `applyDiff` ordering; surfaceable as an explicit field with minimal change).
2. At pass-prep time, take the most recent `N=8` nodes by `lastTouchedPassId`.
3. Expand by 1 hop: add every node directly connected to any of the seed-8.
4. Keep only edges whose both endpoints are in the kept set.
5. Pass the trimmed graph to the model. Stash the evicted-node ids in a side cache.
6. When the model's diff `add_nodes` produces an id collision with the side cache, prefer "un-evict" over "create-duplicate": re-inject the prior node, treat the diff's version as a `NodeUpdate`.

Why it works: a meeting's conversational locality is high. Three minutes into discussing the migration cluster, the unrelated `badge_ux` cluster contributes nothing to the next diff — and pays 200+ tokens to sit in context. Eviction recovers those tokens for output.

What's lost: cross-cluster `related_to` edges, occasional duplicate-node misclassifications when speakers switch back to an evicted cluster. The de-dup pass at the call site catches the second class. The first class is acceptable — `related_to` is the soft relation by design.

## Three open questions, answered

1. **Does prefix caching help?** Apple's [`prewarm(promptPrefix:)`](https://developer.apple.com/documentation/foundationmodels/languagemodelsession/prewarm%28promptprefix%3A%29) is exactly this. The compact system prompt is static across all passes in a meeting; prewarm it once on meeting start. The harness wires this up but can't measure the actual TTFT delta until on-device. **Expected impact:** meaningful — the system prompt is 340/4,096 ≈ 8% of the window and cached prefix means we skip re-tokenization on every pass.

2. **Streaming `notes` separately?** Possible but not needed. `streamResponse(generating: GraphDiff.self)` yields a `GraphDiff.PartiallyGenerated` whose every field is optional and arrives as the model emits it. If `notes` happens to be ordered last in our struct definition, the UI gets the graph diff first and the notes after — which is the desired sequencing for perceived latency. We control the order via field declaration in `GraphDiff.swift`; `notes` is intentionally last there.

3. **Right eviction strategy?** Node recency wins over distance-from-current-topic. Recency requires zero extra inference (timestamps from `applyDiff` order); topic-distance requires either an embedding or a heuristic that the model itself has to maintain across passes. Recency is cheap and good enough; revisit if validity rate drops on long-tail topic-switching transcripts.

## Out of budget

- Real-device latency. Can't measure here. Harness is ready.
- Actual `@Generable` output validity rate. Same.
- Whether `prewarm(promptPrefix:)` materially affects p50. Same.
- Behavior of `LanguageModelSession.GenerationError.exceededContextWindowSize` in practice — does it fail-fast, or does the model produce partial output that we can still apply? The harness logs both; user will see this on first 30-node run.
- The finalize pass (`FINALIZE_SYSTEM_PROMPT`) is even larger and was not measured. It's almost certainly cloud-only on iOS — flag for follow-up.

## Recommendation

**Conditional green-light for iOS-first with Foundation Models for the streaming GraphDiff loop, subject to on-device latency confirmation.**

Required follow-ups before committing the architecture:
1. Run the harness on iPhone 17 Pro. p50 < 3,000 ms is the spike pass-bar.
2. Confirm validity rate >99% — this is the @Generable promise, so it should be easy, but TTFT-driven UX changes if the model frequently bumps `decodingFailure`.
3. Decide finalize-pass policy: cloud-only, multi-pass on-device, or skip on mobile for v0.

If latency on device matches the streaming numbers Apple cites for similar guided-generation workloads, the iOS-first wedge is real. If it doesn't, fall back to a thin local-extraction loop (notes only, no graph) + cloud GraphDiff — but that's a different product, not the same one shipped on a smaller screen.

## Files

- [`token_budget.py`](./token_budget.py), [`token_budget_extreme.py`](./token_budget_extreme.py) — simulation
- [`emit_fixtures.py`](./emit_fixtures.py), [`extract_prompts.py`](./extract_prompts.py) — fixture generators
- [`token-budget.md`](./token-budget.md) — full numeric write-up
- [`Harness/`](./Harness/) — Swift harness skeleton (will not compile without iOS 26 toolchain)
