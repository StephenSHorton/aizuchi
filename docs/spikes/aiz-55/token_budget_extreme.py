"""Follow-up sweep for AIZ-55: how much can we compress before the budget closes?

token_budget.py shows even the small graph blows the 4K window with the
current Aizuchi system prompt. This script answers two follow-ups:

1. What size system prompt would actually fit a useful graph + output?
2. With a maximally-compressed FM-port system prompt + no schema +
   aggressive eviction, what's the largest in-context graph we can keep
   while leaving ≥1000 output tokens?
"""

from __future__ import annotations

import json

import tiktoken

from token_budget import (
    FM_CONTEXT_WINDOW,
    NEW_CHUNK,
    OUTPUT_BUDGET_FLOOR,
    PREVIOUS_THOUGHTS,
    RECENT_TRANSCRIPT,
    REFERENCE_DIFF,
    build_graph,
    build_user_prompt,
    evict_keep_last_touched,
    toks,
)

ENC = tiktoken.get_encoding("cl100k_base")

# A purpose-built compact system prompt designed for FM iOS 26. Strips
# worked examples (the @Generable macro + schema constraint replaces
# them) and condenses the rubric. This is what an iOS-shipped Aizuchi
# would actually send.
COMPACT_SYSTEM_PROMPT = """\
You maintain a live mind map of a meeting. Each pass: emit a GraphDiff that adds/updates/merges/removes nodes and edges, and updates a running thoughts list.

Inputs: current graph, previous thoughts, recent ~60s transcript, and the new chunk. Be willing to restructure if a prior classification was wrong. Don't drop stable nodes just because the new chunk doesn't mention them — the graph is cumulative.

Node types: person, topic, work_item, blocker, decision, action_item, question, context, risk, assumption, constraint, hypothesis, metric, artifact, event, sentiment. Use snake_case ids derived from labels; reuse ids across passes. Strongest quotes go on decision/risk/assumption/hypothesis/metric/sentiment.

Edge relations: owns, depends_on, blocks, related_to, decides, asks, answers, mentions, assigned_to, causes, contradicts, supports, example_of, alternative_to, precedes, resolves, clarifies. Prefer specific relations over related_to. Action items always get assigned_to a person.

Optional fields: status (active/resolved/parked), confidence (high/medium/low), quote (verbatim, ≤200 chars), tags. Type-specific: likelihood+impact (risk), prediction (hypothesis), value+target+unit (metric), occurredAt (event), limit (constraint), dueDate (action_item), tone (sentiment), alternative (decision).

Thoughts: short observations/questions/patterns the user should see. Stable ids; emit only new or changed thoughts each pass. Reference relevant node ids.

Return no_changes: true only when the new chunk genuinely adds nothing.\
"""


def measure_quick(label: str, graph: dict, system_prompt: str) -> tuple[int, int, int]:
    user_prompt = build_user_prompt(graph)
    total = toks(system_prompt) + toks(user_prompt)
    remaining = FM_CONTEXT_WINDOW - total
    return toks(system_prompt), total, remaining


def main() -> None:
    print("=" * 100)
    print("AIZ-55 follow-up: compression sweep")
    print("=" * 100)
    ref_diff = toks(json.dumps(REFERENCE_DIFF, indent=2))
    print(f"Reference GraphDiff response: {ref_diff} tokens")
    print(f"Floor: {OUTPUT_BUDGET_FLOOR} output tokens")
    print(f"Compact system prompt: {toks(COMPACT_SYSTEM_PROMPT)} tokens "
          f"({len(COMPACT_SYSTEM_PROMPT)} chars)")
    print()

    print("Compact prompt across sizes (no schema injection):")
    print(f"  {'label':<32} {'sys':>5} {'total_in':>9} {'remaining':>10} {'floor≥1000':>11} {'ref-fits':>10}")
    for n in [3, 5, 8, 10, 15, 20]:
        g = build_graph(n)
        sys_t, total_in, remaining = measure_quick(f"{n}-node graph", g, COMPACT_SYSTEM_PROMPT)
        floor = "PASS" if remaining >= OUTPUT_BUDGET_FLOOR else "FAIL"
        ref = "PASS" if remaining >= ref_diff else "FAIL"
        print(f"  {n:>2}-node graph                  {sys_t:>5} {total_in:>9} {remaining:>10} {floor:>11} {ref:>10}")
    print()

    print("Compact prompt + eviction on a 30-node graph (keep_n sweep):")
    print(f"  {'keep_n':<8} {'after_evict':<13} {'graph_tok':>10} {'remaining':>10} {'floor≥1000':>11}")
    big = build_graph(30)
    for keep_n in [3, 5, 8, 10, 15]:
        evicted = evict_keep_last_touched(big, keep_n=keep_n)
        sys_t, total_in, remaining = measure_quick("", evicted, COMPACT_SYSTEM_PROMPT)
        graph_tok = toks(json.dumps(evicted, indent=2))
        floor = "PASS" if remaining >= OUTPUT_BUDGET_FLOOR else "FAIL"
        n_after = len(evicted["nodes"])
        print(f"  {keep_n:<8} {n_after} of 30      {graph_tok:>10} {remaining:>10} {floor:>11}")
    print()

    # The transcript window itself isn't huge; the bottleneck is system + graph.
    # Try a maximally-tight 30s-only mode (drop recent transcript window).
    print("Drop the recent-transcript window (lean on FM session multi-turn instead):")
    print(f"  {'label':<32} {'sys':>5} {'graph':>6} {'recent':>7} {'total_in':>9} {'remaining':>10}")
    for n in [10, 15, 20]:
        g = build_graph(n)
        graph_json = json.dumps(g, indent=2)
        thoughts_json = json.dumps(PREVIOUS_THOUGHTS, indent=2)
        # User prompt minus the "Recent transcript window" block
        user = f"""## Current graph state

```json
{graph_json}
```

## Previous thoughts

```json
{thoughts_json}
```

## New transcript chunk

```
{NEW_CHUNK}
```

Return the GraphDiff."""
        total = toks(COMPACT_SYSTEM_PROMPT) + toks(user)
        rem = FM_CONTEXT_WINDOW - total
        print(f"  {n}-node graph, no recent       {toks(COMPACT_SYSTEM_PROMPT):>5} "
              f"{toks(graph_json):>6} {'0 (drop)':>7} {total:>9} {rem:>10}")


if __name__ == "__main__":
    main()
