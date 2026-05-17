#!/usr/bin/env python3
"""Analyze ThermalBench JSONL output and produce a decision-quality verdict.

Inputs: one or more .jsonl files written by the ThermalBench iOS app.
Outputs:
  - PNG charts saved next to each input: <name>.throughput.png, <name>.thermal.png,
    <name>.battery.png
  - A printed verdict (GREEN / YELLOW / RED) per AIZ-56's decision criteria.

The criteria, restated from the Linear issue:

  GREEN  : thermal stays <= .fair for 30 min, throughput degrades < 20% (p50
           between minute 0-5 vs minute 25-30), battery drain < 10%/hr.
           -> Pure on-device synthesis is back on the table.

  YELLOW : thermal hits .serious past 15 min, throughput degrades 30-50%,
           battery 10-15%/hr.
           -> Companion-first / cloud-fallback. Adaptive cadence becomes
              mandatory.

  RED    : thermal hits .critical (or auto-stop fires), throughput collapses,
           battery > 15%/hr.
           -> Drop on-device synthesis from v1; phone is always capture-only.

Dependencies: matplotlib, numpy. Run with uv:
  uv run --with matplotlib --with numpy docs/spikes/aiz-56/analyze.py FILE...

Or:
  python3 -m pip install matplotlib numpy
  python3 docs/spikes/aiz-56/analyze.py FILE...
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


THERMAL_RANK = {"nominal": 0, "fair": 1, "serious": 2, "critical": 3, "unknown": -1}
THERMAL_COLORS = {
    "nominal": "#3a9d57",
    "fair": "#cfa838",
    "serious": "#d2691e",
    "critical": "#c0382b",
    "unknown": "#888888",
}


@dataclass
class Verdict:
    color: str
    rationale: list[str]


def load(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(f"  warn: skipping bad line: {e}", file=sys.stderr)
    return rows


def bucket_latency(rows: list[dict], bucket_sec: float = 300.0) -> list[tuple[float, float, float, int]]:
    """Return [(bucket_center_min, p50_ms, p95_ms, n)]."""
    out: list[tuple[float, float, float, int]] = []
    pairs = [(r["elapsedSec"], r["latencyMs"]) for r in rows if r.get("latencyMs") is not None]
    if not pairs:
        return out
    pairs.sort()
    max_t = pairs[-1][0]
    n_buckets = int(max_t // bucket_sec) + 1
    for b in range(n_buckets):
        lo, hi = b * bucket_sec, (b + 1) * bucket_sec
        vals = [lat for (t, lat) in pairs if lo <= t < hi]
        if not vals:
            continue
        a = np.array(vals)
        out.append(((lo + hi) / 2 / 60.0, float(np.percentile(a, 50)), float(np.percentile(a, 95)), len(a)))
    return out


def battery_drain_rate(rows: list[dict]) -> tuple[float, float]:
    """Return (slope %/hr via least-squares, total drop %)."""
    pts = [(r["elapsedSec"], r["batteryLevel"]) for r in rows if r.get("batteryLevel", -1) >= 0]
    if len(pts) < 3:
        return (0.0, 0.0)
    t = np.array([p[0] for p in pts]) / 3600.0  # hours
    y = np.array([p[1] for p in pts]) * 100.0   # percent
    A = np.vstack([t, np.ones_like(t)]).T
    slope, _ = np.linalg.lstsq(A, y, rcond=None)[0]
    drop = y[0] - y[-1]
    return (float(-slope), float(drop))  # positive = drain


def thermal_timeline(rows: list[dict]) -> list[tuple[float, str]]:
    return [(r["elapsedSec"] / 60.0, r["thermalState"]) for r in rows]


def first_time_at(rows: list[dict], state: str) -> float | None:
    target = THERMAL_RANK.get(state, 99)
    for r in rows:
        if THERMAL_RANK.get(r["thermalState"], -1) >= target:
            return r["elapsedSec"] / 60.0
    return None


def throughput_degradation(buckets: list[tuple[float, float, float, int]]) -> float | None:
    """p50 (last bucket) / p50 (first bucket) - 1. Positive = got slower."""
    if len(buckets) < 2:
        return None
    return buckets[-1][1] / buckets[0][1] - 1.0


def color_verdict(rows: list[dict]) -> Verdict:
    kind = rows[0].get("runKind") if rows else None
    if kind != "full_llm":
        return Verdict("INFO", [f"Baseline run ({kind}); no verdict applies."])

    rationale: list[str] = []
    buckets = bucket_latency(rows)
    deg = throughput_degradation(buckets)
    drain_per_hr, drop_pct = battery_drain_rate(rows)
    serious_at = first_time_at(rows, "serious")
    critical_at = first_time_at(rows, "critical")
    max_state = max((r["thermalState"] for r in rows), key=lambda s: THERMAL_RANK.get(s, -1))

    rationale.append(f"Max thermal state: {max_state}")
    rationale.append(f"Time-to-serious: {f'{serious_at:.1f} min' if serious_at is not None else 'never'}")
    rationale.append(f"Time-to-critical: {f'{critical_at:.1f} min' if critical_at is not None else 'never'}")
    rationale.append(f"Latency degradation p50 (last vs first 5-min bucket): {deg * 100:+.1f}%" if deg is not None else "Latency degradation: n/a")
    rationale.append(f"Battery drain: {drain_per_hr:.1f} %/hr (total drop {drop_pct:.1f}%)")

    # RED
    if critical_at is not None or drain_per_hr > 15:
        return Verdict("RED", rationale + ["RED: thermal critical or battery > 15%/hr -> phone is capture-only."])
    if deg is not None and deg > 0.5:
        return Verdict("RED", rationale + ["RED: throughput collapsed (>50% slower)."])

    # YELLOW
    yellow_thermal = serious_at is not None and serious_at > 15
    yellow_thermal_early = serious_at is not None and serious_at <= 15
    yellow_deg = deg is not None and 0.3 <= deg <= 0.5
    yellow_battery = 10 <= drain_per_hr <= 15
    if yellow_thermal or yellow_deg or yellow_battery:
        rationale.append("YELLOW: companion-first + cloud fallback. Adaptive cadence required.")
        return Verdict("YELLOW", rationale)
    if yellow_thermal_early:
        # serious before 15 min is worse than yellow; treat as RED-leaning yellow.
        rationale.append("YELLOW (leaning red): serious thermal before 15 min.")
        return Verdict("YELLOW", rationale)

    # GREEN: thermal <= fair, deg < 20%, drain < 10%/hr
    green_thermal = THERMAL_RANK.get(max_state, 99) <= 1
    green_deg = deg is None or deg < 0.2
    green_battery = drain_per_hr < 10
    if green_thermal and green_deg and green_battery:
        rationale.append("GREEN: pure on-device synthesis is viable for v1.")
        return Verdict("GREEN", rationale)

    rationale.append("YELLOW (default): some criteria not met cleanly.")
    return Verdict("YELLOW", rationale)


def plot_throughput(rows: list[dict], out: Path) -> None:
    buckets = bucket_latency(rows)
    if not buckets:
        return
    xs = [b[0] for b in buckets]
    p50 = [b[1] for b in buckets]
    p95 = [b[2] for b in buckets]
    fig, ax = plt.subplots(figsize=(8, 4))
    ax.plot(xs, p50, marker="o", label="p50")
    ax.plot(xs, p95, marker="s", label="p95")
    ax.set_xlabel("Minutes")
    ax.set_ylabel("Latency (ms)")
    ax.set_title(f"Latency over time — {rows[0]['runKind']} ({rows[0]['runId']})")
    ax.grid(True, alpha=0.3)
    ax.legend()
    fig.tight_layout()
    fig.savefig(out, dpi=130)
    plt.close(fig)


def plot_thermal(rows: list[dict], out: Path) -> None:
    timeline = thermal_timeline(rows)
    if not timeline:
        return
    fig, ax = plt.subplots(figsize=(8, 2.4))
    for i, (t, s) in enumerate(timeline):
        x0 = t
        x1 = timeline[i + 1][0] if i + 1 < len(timeline) else t + 0.2
        ax.axvspan(x0, x1, color=THERMAL_COLORS.get(s, "#888"), alpha=0.85)
    ax.set_yticks([])
    ax.set_xlabel("Minutes")
    ax.set_title(f"Thermal state — {rows[0]['runKind']}")
    handles = [plt.Rectangle((0, 0), 1, 1, color=c) for c in ["#3a9d57", "#cfa838", "#d2691e", "#c0382b"]]
    ax.legend(handles, ["nominal", "fair", "serious", "critical"], loc="upper right", fontsize=8)
    fig.tight_layout()
    fig.savefig(out, dpi=130)
    plt.close(fig)


def plot_battery(rows: list[dict], out: Path) -> None:
    pts = [(r["elapsedSec"] / 60.0, r["batteryLevel"] * 100.0) for r in rows if r.get("batteryLevel", -1) >= 0]
    if len(pts) < 2:
        return
    fig, ax = plt.subplots(figsize=(8, 3.4))
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    ax.plot(xs, ys, marker=".", linestyle="-")
    slope, drop = battery_drain_rate(rows)
    ax.set_xlabel("Minutes")
    ax.set_ylabel("Battery (%)")
    ax.set_title(f"Battery drain — {rows[0]['runKind']} ({slope:.2f} %/hr fit, drop {drop:.1f}%)")
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(out, dpi=130)
    plt.close(fig)


def crossref_thermal_vs_latency(rows: list[dict]) -> dict[str, dict[str, float]]:
    """Per thermal state, return p50 and p95 latency. Helps answer: at what
    state does latency start to climb?"""
    by_state: dict[str, list[float]] = {}
    for r in rows:
        lat = r.get("latencyMs")
        if lat is None:
            continue
        by_state.setdefault(r["thermalState"], []).append(lat)
    out: dict[str, dict[str, float]] = {}
    for state, vals in by_state.items():
        a = np.array(vals)
        out[state] = {
            "n": int(len(a)),
            "p50": float(np.percentile(a, 50)),
            "p95": float(np.percentile(a, 95)),
        }
    return out


def analyze_file(path: Path) -> None:
    rows = load(path)
    if not rows:
        print(f"{path.name}: empty, skipping")
        return
    print(f"\n=== {path.name} ===")
    print(f"  run kind   : {rows[0]['runKind']}")
    print(f"  run id     : {rows[0]['runId']}")
    print(f"  passes     : {len(rows)}")
    print(f"  duration   : {rows[-1]['elapsedSec'] / 60:.1f} min")

    xr = crossref_thermal_vs_latency(rows)
    if xr:
        print("  latency by thermal state:")
        for state in ("nominal", "fair", "serious", "critical"):
            if state in xr:
                d = xr[state]
                print(f"    {state:9} n={d['n']:4} p50={d['p50']:7.0f} ms  p95={d['p95']:7.0f} ms")

    plot_throughput(rows, path.with_suffix(".throughput.png"))
    plot_thermal(rows, path.with_suffix(".thermal.png"))
    plot_battery(rows, path.with_suffix(".battery.png"))

    v = color_verdict(rows)
    print(f"\n  VERDICT: {v.color}")
    for r in v.rationale:
        print(f"    - {r}")


def main(argv: Iterable[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("files", nargs="+", type=Path)
    args = ap.parse_args(list(argv))
    for f in args.files:
        if not f.exists():
            print(f"{f}: not found", file=sys.stderr)
            continue
        analyze_file(f)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
