"""
AIZ-55 token-budget simulation for Apple Foundation Models on iOS 26.

Foundation Models (FM) ship a single shared 4,096-token context window —
instructions + prompts + outputs all consume the same budget
(SystemLanguageModel.contextSize is 4096 per the Apple docs).

This script reconstructs the GraphDiff prompt as Aizuchi builds it today
(SYSTEM_PROMPT_SUBSTANCE + buildUserPrompt with graph JSON + previous
thoughts + recent transcript + new chunk) and reports the token cost for
small / medium / large graph snapshots, telling us what budget is left
for the model's GraphDiff response.

We use tiktoken's cl100k_base as a proxy. Apple has not published the
Foundation Models tokenizer; cl100k_base is the OpenAI BPE used for
GPT-3.5 / GPT-4 and is a defensible same-class English BPE proxy. Apple's
own guidance from `exceededContextWindowSize` is "~3-4 characters per
token in English / Spanish / German" — cl100k_base lands in that band,
so it's a reasonable order-of-magnitude stand-in. Numbers should be read
as ±10-15% rather than exact.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass, field

import tiktoken


ENC = tiktoken.get_encoding("cl100k_base")
FM_CONTEXT_WINDOW = 4096  # Apple Foundation Models, iOS 26 — shared in+out
APPLE_CHAR_PER_TOKEN_LOW = 3.0
APPLE_CHAR_PER_TOKEN_HIGH = 4.0


def toks(s: str) -> int:
    return len(ENC.encode(s))


# ---------------------------------------------------------------------------
# Realistic graph generator — engineering standup vocabulary, 5 / 15 / 30 nodes
# ---------------------------------------------------------------------------

NODE_TYPES = [
    "person", "topic", "work_item", "blocker", "decision", "action_item",
    "question", "context", "risk", "assumption", "constraint", "hypothesis",
    "metric", "artifact", "event", "sentiment",
]
EDGE_RELATIONS = [
    "owns", "depends_on", "blocks", "related_to", "decides", "asks",
    "answers", "mentions", "assigned_to", "causes", "contradicts",
    "supports", "example_of", "alternative_to", "precedes", "resolves",
    "clarifies",
]

# A bank of plausible standup-shaped nodes. The labels and descriptions are
# representative of what Aizuchi actually extracts from engineering meetings.
NODE_BANK: list[dict] = [
    {"id": "travis_chen", "label": "Travis Chen", "type": "person"},
    {"id": "priya_singh", "label": "Priya Singh", "type": "person"},
    {"id": "alex_park", "label": "Alex Park", "type": "person"},
    {"id": "mira_rao", "label": "Mira Rao", "type": "person"},
    {"id": "postgres_migration", "label": "Postgres migration", "type": "work_item",
     "description": "Migrate the primary order-service database from MySQL 5.7 to Postgres 16."},
    {"id": "ios_push_fix", "label": "iOS push notification fix", "type": "work_item",
     "description": "Fix silent-push regression that broke on iOS 26 due to APS payload validation."},
    {"id": "badge_ux", "label": "Badge UX redesign", "type": "work_item",
     "description": "Rework the unread-count badge so it doesn't overflow at >99 events."},
    {"id": "staging_db_outage", "label": "Staging DB outage", "type": "blocker",
     "description": "Connection pool exhaustion on staging is blocking the migration dry-run."},
    {"id": "p95_latency_target", "label": "p95 latency target", "type": "metric",
     "value": "180ms", "target": "200ms", "unit": "ms"},
    {"id": "migration_friday", "label": "Migration cutover Friday", "type": "event",
     "occurredAt": "2026-05-22"},
    {"id": "use_pgbouncer", "label": "Use pgbouncer for pooling", "type": "decision",
     "alternative": "RDS Proxy",
     "description": "Chose pgbouncer over RDS Proxy because of cost and Tahoe compatibility."},
    {"id": "review_pr_421", "label": "Review PR #421", "type": "action_item",
     "dueDate": "end of week",
     "description": "Travis to review the pgbouncer config PR before the Friday cutover."},
    {"id": "rollback_plan_q", "label": "Do we have a rollback plan?", "type": "question",
     "description": "Open question: if cutover fails Friday, what's the rollback window?"},
    {"id": "no_pii_logs", "label": "No PII in logs", "type": "constraint",
     "limit": "no PII in logs",
     "description": "Security policy: no customer PII may appear in service logs."},
    {"id": "data_loss_risk", "label": "Data-loss risk during cutover", "type": "risk",
     "likelihood": "medium", "impact": "high",
     "description": "If replication lag exceeds 30s at cutover, in-flight writes may be lost."},
    {"id": "assume_no_traffic_friday", "label": "Assuming low traffic Friday night", "type": "assumption",
     "description": "We're assuming Friday 10pm-2am has < 5% peak traffic."},
    {"id": "pgbouncer_hypothesis", "label": "pgbouncer cuts conn count 10x", "type": "hypothesis",
     "prediction": "Connection count drops from ~2k to ~200 against the primary."},
    {"id": "runbook_doc", "label": "Cutover runbook (Notion)", "type": "artifact",
     "description": "Notion page with step-by-step cutover plan, owners, and rollback gate."},
    {"id": "frustrated_perf", "label": "Frustration with current perf", "type": "sentiment",
     "tone": "frustrated",
     "description": "Team is fed up with weekly p95 regressions on the order service."},
    {"id": "migration_topic", "label": "Database migration", "type": "topic"},
    {"id": "perf_topic", "label": "Performance", "type": "topic"},
    {"id": "release_topic", "label": "Release planning", "type": "topic"},
    {"id": "ios_topic", "label": "iOS mobile", "type": "topic"},
    {"id": "pgbouncer_artifact", "label": "pgbouncer config", "type": "artifact"},
    {"id": "rds_proxy_alt", "label": "RDS Proxy alternative", "type": "context",
     "description": "AWS-managed option weighed against pgbouncer; rejected on cost."},
    {"id": "shipping_decision", "label": "Ship behind feature flag", "type": "decision",
     "alternative": "Ship dark + canary",
     "description": "Ship the new iOS push path behind FF, ramp 5/25/100 over the week."},
    {"id": "test_coverage_gap", "label": "Push-fix test coverage gap", "type": "blocker",
     "description": "No integration test exists for the silent-push payload path."},
    {"id": "alex_owns_push", "label": "Alex owns the iOS push work", "type": "context"},
    {"id": "q_who_does_badge", "label": "Who owns the badge UX?", "type": "question"},
    {"id": "badge_overflow_event", "label": "Badge overflow reported on Slack", "type": "event",
     "occurredAt": "last Tuesday"},
    {"id": "metric_crash_rate", "label": "iOS crash-free rate", "type": "metric",
     "value": "99.2%", "target": "99.5%"},
]


def _edge_id(frm: str, rel: str, to: str) -> str:
    return f"{frm}-{rel}-{to}"


def build_graph(n_nodes: int, seed: int = 7) -> dict:
    """Pick `n_nodes` from the bank deterministically and wire plausible
    edges between them — roughly 1.5–2 edges per node, mixing strong and
    weak relations like real Aizuchi graphs do."""
    rng = random.Random(seed)
    nodes = NODE_BANK[:n_nodes]
    node_ids = [n["id"] for n in nodes]

    # Hand-picked plausible edges first — only included when both endpoints
    # are in the slice.
    candidate_edges: list[tuple[str, str, str]] = [
        ("travis_chen", "owns", "postgres_migration"),
        ("priya_singh", "owns", "badge_ux"),
        ("alex_park", "owns", "ios_push_fix"),
        ("staging_db_outage", "blocks", "postgres_migration"),
        ("postgres_migration", "depends_on", "use_pgbouncer"),
        ("use_pgbouncer", "decides", "postgres_migration"),
        ("travis_chen", "assigned_to", "review_pr_421"),
        ("review_pr_421", "resolves", "rollback_plan_q"),
        ("data_loss_risk", "causes", "postgres_migration"),
        ("assume_no_traffic_friday", "supports", "migration_friday"),
        ("pgbouncer_hypothesis", "supports", "use_pgbouncer"),
        ("rds_proxy_alt", "alternative_to", "use_pgbouncer"),
        ("runbook_doc", "clarifies", "postgres_migration"),
        ("frustrated_perf", "related_to", "perf_topic"),
        ("p95_latency_target", "related_to", "perf_topic"),
        ("shipping_decision", "decides", "ios_push_fix"),
        ("test_coverage_gap", "blocks", "ios_push_fix"),
        ("badge_overflow_event", "precedes", "badge_ux"),
        ("alex_park", "mentions", "ios_topic"),
        ("travis_chen", "mentions", "migration_topic"),
        ("metric_crash_rate", "related_to", "ios_topic"),
        ("q_who_does_badge", "asks", "badge_ux"),
        ("no_pii_logs", "blocks", "runbook_doc"),
        ("priya_singh", "decides", "shipping_decision"),
        ("mira_rao", "owns", "release_topic"),
    ]

    edges: list[dict] = []
    for frm, rel, to in candidate_edges:
        if frm in node_ids and to in node_ids:
            edges.append({
                "id": _edge_id(frm, rel, to),
                "from": frm,
                "to": to,
                "relation": rel,
            })

    # Top up with random related_to edges until we hit ~1.5 per node.
    target = int(n_nodes * 1.7)
    attempts = 0
    while len(edges) < target and attempts < 200:
        attempts += 1
        a, b = rng.sample(node_ids, 2)
        eid = _edge_id(a, "related_to", b)
        if any(e["id"] == eid for e in edges):
            continue
        edges.append({"id": eid, "from": a, "to": b, "relation": "related_to"})

    return {"nodes": nodes, "edges": edges}


# ---------------------------------------------------------------------------
# Prompt fixtures — mirror src/lib/aizuchi/prompts.ts exactly
# ---------------------------------------------------------------------------

# Pulled verbatim from src/lib/aizuchi/prompts.ts (SYSTEM_PROMPT_ATTRIBUTION).
# Truncated only in this docstring — the on-disk fixture is the full prompt.

with open("system_prompt_attribution.txt", "r", encoding="utf-8") as f:
    SYSTEM_PROMPT_ATTRIBUTION = f.read()

with open("system_prompt_substance.txt", "r", encoding="utf-8") as f:
    SYSTEM_PROMPT_SUBSTANCE = f.read()


# A 30-second engineering-standup transcript chunk, ~80 words.
NEW_CHUNK = """\
Travis: Okay so we hit the staging DB outage again last night, the pool exhausted around 2am.
Priya: That's the third time this week. Are we sure pgbouncer is going to fix this?
Travis: I think so. The hypothesis is connection count drops from two thousand to about two hundred against the primary. I'll merge the config PR today.
Alex: Cool. Unrelated — the iOS silent-push fix is ready for review, I want to ship it behind a feature flag.
Priya: Approved. Let's ramp five, twenty-five, one hundred over the week."""

# A 60-second recent transcript window (the prior context). ~150 words.
RECENT_TRANSCRIPT = """\
Travis: Quick standup. Migration cutover is still Friday night. Mira, are you blocked?
Mira: No, but I want a rollback plan written down before Friday. If we lose writes we need a path back.
Travis: Yeah, the runbook in Notion covers it, I'll send the link.
Priya: While we're here — the badge UX overflow keeps coming up. Who actually owns that?
Alex: I think nobody right now. I can pick it up after the push fix lands.
Priya: Okay, parked. Travis, what's blocking the migration?
Travis: Honestly the staging pool issues. We can't even get a clean dry-run to complete.
Priya: Right, and that's pgbouncer-shaped, not a real prod risk?
Travis: Correct. We're assuming low traffic Friday night, ten pm to two am window."""

# Three previous AI thoughts — ~80 words of JSON.
PREVIOUS_THOUGHTS = [
    {
        "id": "rollback_uncertainty",
        "text": "Mira flagged the rollback plan but the team hasn't agreed on a hard rollback window yet.",
        "intent": "unresolved",
        "references": ["postgres_migration", "rollback_plan_q"],
    },
    {
        "id": "badge_ownership_gap",
        "text": "Badge UX overflow has been raised twice now with no clear owner — Alex tentatively offered to pick it up.",
        "intent": "pattern",
        "references": ["badge_ux"],
    },
    {
        "id": "staging_pool_recurrence",
        "text": "Connection pool exhaustion on staging is a recurring blocker; pgbouncer is the bet to fix it.",
        "intent": "observation",
        "references": ["staging_db_outage"],
    },
]


def build_user_prompt(graph: dict) -> str:
    """Mirror buildUserPrompt() from prompts.ts."""
    graph_json = json.dumps(graph, indent=2)
    thoughts_json = json.dumps(PREVIOUS_THOUGHTS, indent=2)
    return f"""## Current graph state

```json
{graph_json}
```

## Previous thoughts

```json
{thoughts_json}
```

## Recent transcript window (last ~60s, for context)

```
{RECENT_TRANSCRIPT}
```

## New transcript chunk (the freshest utterances)

```
{NEW_CHUNK}
```

Return the GraphDiff. Update the graph and your thoughts based on the new chunk, using the recent transcript and previous thoughts for context. Be willing to restructure — `remove_nodes` and `remove_edges` are available when something needs reclassification. Only return `no_changes: true` if the new chunk and surrounding context genuinely add nothing."""


# ---------------------------------------------------------------------------
# Schema injection cost
# ---------------------------------------------------------------------------
# Foundation Models defaults `includeSchemaInPrompt: true`. We can't run the
# Swift macro, but we can estimate the schema cost by re-serializing the
# GraphDiff Zod shape as a JSON-schema-ish blob. This is conservative — the
# real FM-injected schema is tighter (it's the @Generable-emitted shape, not
# full JSON Schema). Treat this as the upper bound; we also report a tight
# lower bound assuming Apple's schema injection is ~30% smaller.

SCHEMA_BLOB = json.dumps({
    "GraphDiff": {
        "no_changes": "bool",
        "add_nodes": ["Node"],
        "add_edges": ["Edge"],
        "update_nodes": ["NodeUpdate"],
        "merge_nodes": [{"keep": "string", "absorb": ["string"]}],
        "remove_nodes": ["string"],
        "remove_edges": ["string"],
        "notes": ["AIThought"],
    },
    "Node": {
        "id": "string", "label": "string", "type": NODE_TYPES,
        "description?": "string", "speaker?": "string",
        "status?": ["active", "resolved", "parked"],
        "confidence?": ["high", "medium", "low"],
        "quote?": "string (<=200 chars)",
        "tags?": ["string"],
        "likelihood?": ["low", "medium", "high"],
        "impact?": ["low", "medium", "high"],
        "prediction?": "string", "value?": "string", "target?": "string",
        "unit?": "string", "occurredAt?": "string", "limit?": "string",
        "dueDate?": "string", "tone?": "string", "alternative?": "string",
    },
    "Edge": {
        "id": "string", "from": "string", "to": "string",
        "relation": EDGE_RELATIONS,
        "description?": "string",
    },
    "NodeUpdate": "Same as Node minus required fields; all optional",
    "AIThought": {
        "id": "string", "text": "string",
        "intent": ["question", "observation", "unresolved", "pattern", "fyi"],
        "references?": ["string"],
    },
}, indent=2)


# ---------------------------------------------------------------------------
# Output-budget model for a GraphDiff response
# ---------------------------------------------------------------------------
# A "useful" GraphDiff in a streaming pass typically emits:
# - 2-5 new nodes (each ~30-50 tokens once labels/desc/quote are filled)
# - 2-5 new edges (~15-20 tokens each)
# - 0-2 update_nodes (~20 tokens each)
# - 1-3 notes (~30-50 tokens each)
# That puts a "meaningful" diff response at roughly 350-600 tokens with
# brace/key overhead. We target 1,000 tokens of output budget as the soft
# floor (gives headroom for richer passes and a small safety margin).

OUTPUT_BUDGET_FLOOR = 1000  # tokens reserved for the GraphDiff response

# A reference "meaningful" GraphDiff for the new chunk above, hand-written.
REFERENCE_DIFF = {
    "no_changes": False,
    "add_nodes": [
        {"id": "feature_flag_ramp", "label": "Feature-flag ramp 5/25/100",
         "type": "decision", "speaker": "Priya",
         "quote": "Let's ramp five, twenty-five, one hundred over the week.",
         "alternative": "Ship dark + canary"},
        {"id": "merge_pgbouncer_pr_today", "label": "Merge pgbouncer config PR today",
         "type": "action_item", "speaker": "Travis",
         "dueDate": "today",
         "quote": "I'll merge the config PR today."},
    ],
    "add_edges": [
        {"id": "travis_chen-assigned_to-merge_pgbouncer_pr_today",
         "from": "travis_chen", "to": "merge_pgbouncer_pr_today", "relation": "assigned_to"},
        {"id": "feature_flag_ramp-decides-ios_push_fix",
         "from": "feature_flag_ramp", "to": "ios_push_fix", "relation": "decides"},
        {"id": "merge_pgbouncer_pr_today-resolves-staging_db_outage",
         "from": "merge_pgbouncer_pr_today", "to": "staging_db_outage", "relation": "resolves"},
    ],
    "update_nodes": [
        {"id": "shipping_decision", "status": "resolved"},
    ],
    "merge_nodes": [],
    "remove_nodes": [],
    "remove_edges": [],
    "notes": [
        {"id": "third_staging_outage",
         "text": "Staging DB pool exhaustion has happened three times this week — pgbouncer merge is the bet.",
         "intent": "pattern",
         "references": ["staging_db_outage", "use_pgbouncer"]},
    ],
}


# ---------------------------------------------------------------------------
# Eviction strategy
# ---------------------------------------------------------------------------

def evict_keep_last_touched(graph: dict, keep_n: int) -> dict:
    """Aggressive eviction: keep the N most-recently-touched nodes plus their
    one-hop neighbors and the edges connecting them. In a real pass, "most
    recently touched" comes from a per-node last-mutation timestamp; for the
    simulation we just take the last `keep_n` by bank order, then expand by
    1 hop through the edge set.

    Why this strategy: GraphDiff prompts care most about the part of the
    graph the model is about to edit. Older clusters that haven't been
    touched in many passes contribute little to the next diff but pay full
    token cost. Last-touched + 1-hop covers the conversational locality
    that real meetings exhibit (people talk about one topic-cluster for a
    while, then transition)."""
    nodes = graph["nodes"]
    edges = graph["edges"]
    seeds = {n["id"] for n in nodes[-keep_n:]}
    keep_ids = set(seeds)
    for e in edges:
        if e["from"] in seeds:
            keep_ids.add(e["to"])
        if e["to"] in seeds:
            keep_ids.add(e["from"])
    kept_nodes = [n for n in nodes if n["id"] in keep_ids]
    kept_edges = [e for e in edges if e["from"] in keep_ids and e["to"] in keep_ids]
    return {"nodes": kept_nodes, "edges": kept_edges}


# ---------------------------------------------------------------------------
# Main report
# ---------------------------------------------------------------------------


@dataclass
class Row:
    label: str
    n_nodes: int
    system_tokens: int
    schema_tokens: int
    graph_tokens: int
    thoughts_tokens: int
    transcript_tokens: int
    chunk_tokens: int
    scaffolding_tokens: int  # user-prompt boilerplate outside the variable blocks
    total_input: int
    remaining: int
    fits_with_floor: bool
    fits_strict: bool
    extras: dict = field(default_factory=dict)


def measure(label: str, graph: dict, system_prompt: str, *, include_schema: bool) -> Row:
    user_prompt = build_user_prompt(graph)
    graph_json = json.dumps(graph, indent=2)
    thoughts_json = json.dumps(PREVIOUS_THOUGHTS, indent=2)

    system_tokens = toks(system_prompt)
    schema_tokens = toks(SCHEMA_BLOB) if include_schema else 0
    graph_tokens = toks(graph_json)
    thoughts_tokens = toks(thoughts_json)
    transcript_tokens = toks(RECENT_TRANSCRIPT)
    chunk_tokens = toks(NEW_CHUNK)
    total_user = toks(user_prompt)
    scaffolding_tokens = total_user - (graph_tokens + thoughts_tokens + transcript_tokens + chunk_tokens)

    total_input = system_tokens + schema_tokens + total_user
    remaining = FM_CONTEXT_WINDOW - total_input
    return Row(
        label=label,
        n_nodes=len(graph["nodes"]),
        system_tokens=system_tokens,
        schema_tokens=schema_tokens,
        graph_tokens=graph_tokens,
        thoughts_tokens=thoughts_tokens,
        transcript_tokens=transcript_tokens,
        chunk_tokens=chunk_tokens,
        scaffolding_tokens=scaffolding_tokens,
        total_input=total_input,
        remaining=remaining,
        fits_with_floor=remaining >= OUTPUT_BUDGET_FLOOR,
        fits_strict=remaining >= toks(json.dumps(REFERENCE_DIFF, indent=2)),
        extras={"n_edges": len(graph["edges"])},
    )


def fmt_row(r: Row) -> str:
    floor_mark = "PASS" if r.fits_with_floor else "FAIL"
    strict_mark = "PASS" if r.fits_strict else "FAIL"
    return (
        f"{r.label:<32} nodes={r.n_nodes:<3} edges={r.extras['n_edges']:<3} "
        f"sys={r.system_tokens:<5} schema={r.schema_tokens:<4} "
        f"graph={r.graph_tokens:<5} thoughts={r.thoughts_tokens:<4} "
        f"recent={r.transcript_tokens:<4} chunk={r.chunk_tokens:<4} "
        f"scaffold={r.scaffolding_tokens:<4} "
        f"TOTAL_IN={r.total_input:<5} REM={r.remaining:<5} "
        f"floor≥{OUTPUT_BUDGET_FLOOR}:{floor_mark} ref-diff-fits:{strict_mark}"
    )


def main() -> None:
    ref_diff_tokens = toks(json.dumps(REFERENCE_DIFF, indent=2))

    print("=" * 100)
    print("AIZ-55 — Foundation Models GraphDiff token budget")
    print("=" * 100)
    print(f"Context window (FM iOS 26):   {FM_CONTEXT_WINDOW} tokens (shared input + output)")
    print(f"Output budget floor:          {OUTPUT_BUDGET_FLOOR} tokens reserved for GraphDiff response")
    print(f"Reference GraphDiff response: {ref_diff_tokens} tokens (2 add_nodes, 3 add_edges,")
    print(f"                              1 update_nodes, 1 note — a 'meaningful' streaming pass)")
    print(f"Tokenizer proxy:              tiktoken cl100k_base (Apple FM uses an unpublished BPE;")
    print(f"                              docs cite ~3-4 chars/token for EN, which matches cl100k)")
    print()

    print("Fixed prompt-component costs (sanity check):")
    print(f"  SYSTEM_PROMPT_ATTRIBUTION: {toks(SYSTEM_PROMPT_ATTRIBUTION)} tokens "
          f"({len(SYSTEM_PROMPT_ATTRIBUTION)} chars)")
    print(f"  SYSTEM_PROMPT_SUBSTANCE:   {toks(SYSTEM_PROMPT_SUBSTANCE)} tokens "
          f"({len(SYSTEM_PROMPT_SUBSTANCE)} chars)")
    print(f"  SCHEMA_BLOB (estimate):    {toks(SCHEMA_BLOB)} tokens")
    print(f"  PREVIOUS_THOUGHTS (3):     {toks(json.dumps(PREVIOUS_THOUGHTS, indent=2))} tokens")
    print(f"  RECENT_TRANSCRIPT (60s):   {toks(RECENT_TRANSCRIPT)} tokens")
    print(f"  NEW_CHUNK (30s):           {toks(NEW_CHUNK)} tokens")
    print()

    # The attribution prompt is the larger of the two — use it as the worst
    # case for the fit-check.
    print("-" * 100)
    print("Scenario A: SYSTEM_PROMPT_ATTRIBUTION + schema injected (FM default)")
    print("-" * 100)
    rows_a: list[Row] = []
    for label, n in [("Small (5 nodes)", 5), ("Medium (15 nodes)", 15), ("Large (30 nodes)", 30)]:
        g = build_graph(n)
        rows_a.append(measure(label, g, SYSTEM_PROMPT_ATTRIBUTION, include_schema=True))
    for r in rows_a:
        print(fmt_row(r))
    print()

    print("-" * 100)
    print("Scenario B: SYSTEM_PROMPT_ATTRIBUTION + schema NOT injected (includeSchemaInPrompt: false)")
    print("           — assumes the @Generable macro provides constrained decoding without echoing schema")
    print("-" * 100)
    rows_b: list[Row] = []
    for label, n in [("Small (5 nodes)", 5), ("Medium (15 nodes)", 15), ("Large (30 nodes)", 30)]:
        g = build_graph(n)
        rows_b.append(measure(label, g, SYSTEM_PROMPT_ATTRIBUTION, include_schema=False))
    for r in rows_b:
        print(fmt_row(r))
    print()

    print("-" * 100)
    print("Scenario C: trimmed system prompt (worked examples removed) + schema NOT injected")
    print("           — what an FM-port-specific system prompt would look like")
    print("-" * 100)
    # Cut the worked-example block. Heuristic: the worked example starts at
    # the "## Worked example" header; chop it.
    trimmed_attr = SYSTEM_PROMPT_ATTRIBUTION.split("## Worked example")[0].rstrip()
    trimmed_subst = SYSTEM_PROMPT_SUBSTANCE.split("## Worked example")[0].rstrip()
    print(f"  Trimmed attribution: {toks(trimmed_attr)} tokens "
          f"(was {toks(SYSTEM_PROMPT_ATTRIBUTION)})")
    print(f"  Trimmed substance:   {toks(trimmed_subst)} tokens "
          f"(was {toks(SYSTEM_PROMPT_SUBSTANCE)})")
    rows_c: list[Row] = []
    for label, n in [("Small (5 nodes)", 5), ("Medium (15 nodes)", 15), ("Large (30 nodes)", 30)]:
        g = build_graph(n)
        rows_c.append(measure(label, g, trimmed_attr, include_schema=False))
    for r in rows_c:
        print(fmt_row(r))
    print()

    print("-" * 100)
    print("Scenario D: aggressive eviction — keep last-touched 8 nodes + 1-hop neighbors")
    print("           on the LARGE (30-node) graph, with trimmed system prompt + no schema")
    print("-" * 100)
    big = build_graph(30)
    evicted = evict_keep_last_touched(big, keep_n=8)
    r = measure(f"Evicted ({len(evicted['nodes'])} of 30)", evicted, trimmed_attr, include_schema=False)
    print(fmt_row(r))
    print()

    # Bottom line.
    print("=" * 100)
    print("Bottom line")
    print("=" * 100)
    # Find the largest graph size that fits with the floor in the realistic
    # scenario (B: full attribution prompt, no schema injection — FM's
    # @Generable handles the structure).
    fits_b = [r for r in rows_b if r.fits_with_floor]
    if fits_b:
        biggest = max(fits_b, key=lambda r: r.n_nodes)
        print(f"With the current attribution system prompt (no schema injection), the largest")
        print(f"  graph that leaves ≥{OUTPUT_BUDGET_FLOOR} output tokens is: {biggest.label} "
              f"({biggest.n_nodes} nodes, {biggest.extras['n_edges']} edges).")
        print(f"  Remaining output budget: {biggest.remaining} tokens.")
    else:
        print(f"Even the small (5-node) graph does not leave ≥{OUTPUT_BUDGET_FLOOR} output tokens")
        print(f"  with the current system prompt as-is.")

    fits_c = [r for r in rows_c if r.fits_with_floor]
    if fits_c:
        biggest = max(fits_c, key=lambda r: r.n_nodes)
        print(f"With the TRIMMED system prompt, the largest fit is: {biggest.label} "
              f"({biggest.n_nodes} nodes, {biggest.extras['n_edges']} edges).")
        print(f"  Remaining output budget: {biggest.remaining} tokens.")


if __name__ == "__main__":
    main()
