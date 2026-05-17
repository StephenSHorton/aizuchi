"""Emit the JSON / text fixtures that the Swift harness loads at runtime.
Kept in lockstep with token_budget.py so the on-device numbers can be
compared apples-to-apples with the simulator output."""

from __future__ import annotations

import json
import os

from token_budget import (
    NEW_CHUNK,
    PREVIOUS_THOUGHTS,
    RECENT_TRANSCRIPT,
    build_graph,
    evict_keep_last_touched,
)

OUT = os.path.join(os.path.dirname(__file__), "Harness", "Fixtures")
os.makedirs(OUT, exist_ok=True)


def w(name: str, content: str) -> None:
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        f.write(content)
    print(f"  wrote {name} ({len(content)} chars)")


print(f"Emitting fixtures into {OUT}/")
w("graph_small.json", json.dumps(build_graph(5), indent=2))
w("graph_medium.json", json.dumps(build_graph(15), indent=2))
w("graph_large.json", json.dumps(build_graph(30), indent=2))
w("graph_evicted.json", json.dumps(evict_keep_last_touched(build_graph(30), keep_n=8), indent=2))
w("previous_thoughts.json", json.dumps(PREVIOUS_THOUGHTS, indent=2))
w("recent_transcript.txt", RECENT_TRANSCRIPT)
w("new_chunk.txt", NEW_CHUNK)
