# ThermalBench — AIZ-56 measurement harness

Self-contained iOS 26 app. Drives Foundation Models at Aizuchi's target cadence (1 pass / 10 s) for 30 minutes and logs per-pass thermal, battery, latency, validity, and free memory to a JSONL file you can AirDrop off the device.

## Build

Open this folder as a new Xcode 26+ iOS app target:

1. Xcode -> File -> New -> Project... -> iOS App.
2. Product Name: `ThermalBench`. Interface: SwiftUI. Language: Swift.
3. Save into `docs/spikes/aiz-56/ThermalBench/` (this directory). Replace Xcode's stub `.swift` files with the ones in `ThermalBench/`.
4. Target -> Frameworks: link `FoundationModels.framework` (weak-link is fine).
5. Capabilities: none required. Background modes off (foreground-only is intentional).
6. Deployment target: iOS 26.0.

There is no `.xcodeproj` checked in deliberately — the harness is six Swift files plus an Info.plist, and a hand-rolled `.xcodeproj` adds noise to the diff. If you'd like one committed, run `xcodegen` against an added `project.yml` and we'll merge it.

## Run

On a real iPhone 17 Pro and a real iPhone 15 Pro on iOS 26.x. Three runs per device, in order:

1. **Idle baseline** — 30 min, no LLM, no audio work. Establishes the device's thermal floor.
2. **ASR-only baseline** — 30 min, synthetic 30 s audio chunks at 10 s cadence, no LLM. Isolates the audio-pipeline contribution.
3. **Full Aizuchi cadence** — 30 min, Foundation Models call per 10 s with the realistic GraphDiff prompt.

The app auto-stops on `ProcessInfo.thermalState == .critical` or when `os_proc_available_memory() < 50 MB`.

Between runs:
- Cool the device for **at least 20 minutes** at room temperature (target 21-23 C). Don't refrigerate.
- Re-charge to 90-100% on the wall (not a USB hub).
- Restart the app so the run id is fresh.

## Export

After each run tap **Share JSONL**. Use AirDrop to your Mac. Drop the files into `docs/spikes/aiz-56/data/` and run:

```bash
uv run docs/spikes/aiz-56/analyze.py docs/spikes/aiz-56/data/*.jsonl
```

(or `python3` if you don't have `uv` — see analyze.py for deps.)

## What's measured

See `Metrics.swift` for the full list. Headline: thermal state, battery %, latency, free memory. CPU/GPU/NPU per-component utilization is **not** available from a public API and is not in scope. If we need that we'd add an Instruments os_signpost and capture a `.trace` separately.

## Relationship to AIZ-55

This harness is parallel-built, not extending AIZ-55's, because AIZ-55 had not landed when AIZ-56 started. The `Runner`/`Bench`/`GraphDiff`/`PromptBank` types are deliberately structured so they can be replaced wholesale with AIZ-55's once that ships — only the call site in `Runner.runOnePass` would need to change.
