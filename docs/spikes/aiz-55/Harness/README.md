# AIZ-55 — Foundation Models GraphDiff harness

A Swift Package that mirrors the Aizuchi `GraphDiff` schema as `@Generable` types and benchmarks `LanguageModelSession.streamResponse(generating: GraphDiff.self, …)` on Apple Foundation Models (iOS 26).

## Scope

This is a measurement harness, not a port. It exists to answer a single question: how close is the current Aizuchi pass to fitting inside the FM 4,096-token shared window, and what would on-device latency / validity look like at the sizes that do fit?

The simulator next to it (`../token_budget.py`) already showed the answer is **negative on the current prompt** and **positive after compression + eviction** — this harness gives the user a place to confirm on a real iPhone 17 Pro.

## What's in here

```
Package.swift                       — iOS 26 / macOS 26 platform pin, two products
Sources/Harness/GraphDiff.swift     — @Generable mirror of src/lib/aizuchi/schemas.ts
Sources/Harness/Prompt.swift        — buildUserPrompt() + two system-prompt variants
Sources/Harness/Runner.swift        — one streamResponse(generating:) call + error mapping
Sources/Harness/Bench.swift         — 50-trial loop, p50/p95/p99 + validity-rate report
Sources/HarnessCLI/main.swift       — entry point that loads fixtures and runs Bench
Fixtures/                           — JSON fixtures emitted by ../emit_fixtures.py
```

## How to run

> **Will not compile or run on this Mac as-is.** The `FoundationModels` framework only exists in the iOS 26 / macOS 26-era Xcode toolchain on Apple-silicon hardware. The package is conditional on `canImport(FoundationModels)` so the file *compiles* cleanly into a stub on older toolchains, but the harness body becomes empty.

### Option A — Mac (macOS Tahoe, M-series, Xcode 26)

```bash
cd docs/spikes/aiz-55/Harness
swift run harness-cli
```

The first run will be slow (model warmup); the 50-trial report applies prewarm + 1s wait per Apple's recommendation.

### Option B — iPhone (iOS 26+, A17 Pro / M-class)

1. Open Xcode 26.
2. File → New → Project → iOS App. Drop the `Harness` directory in as a local Swift Package dependency.
3. Replace the default ContentView body with:
   ```swift
   import Harness

   struct ContentView: View {
       @State var report: String = "Tap to run"
       var body: some View {
           ScrollView {
               Text(report).font(.system(.body, design: .monospaced)).padding()
           }
           .task {
               // Load fixtures from the bundle (drop the Fixtures dir
               // into the app target as a folder reference first).
               let bundle = Bundle.main
               func read(_ n: String, _ ext: String) -> String {
                   guard let url = bundle.url(forResource: n, withExtension: ext) else { return "{}" }
                   return (try? String(contentsOf: url, encoding: .utf8)) ?? "{}"
               }
               let trials = Fixtures.trials(
                   smallGraphJSON: read("graph_small", "json"),
                   mediumGraphJSON: read("graph_medium", "json"),
                   largeGraphJSON: read("graph_large", "json"),
                   evictedGraphJSON: read("graph_evicted", "json"),
                   previousThoughtsJSON: read("previous_thoughts", "json"),
                   recentTranscript: read("recent_transcript", "txt"),
                   newChunk: read("new_chunk", "txt")
               )
               var out = ""
               for t in trials {
                   let r = await Bench.run(trial: t, iterations: 50)
                   out += Bench.format(r) + "\n\n"
               }
               report = out
           }
       }
   }
   ```
4. Enable Apple Intelligence in Settings → Apple Intelligence on the device under test. The model has to be downloaded — first-run check `SystemLanguageModel.default.isAvailable` (the harness does not — adapt if you need a graceful "not yet downloaded" path).
5. Build & run on a wired iPhone 17 Pro for the latency numbers AIZ-55 calls out.

## What to capture for the spike write-up

The benchmark prints, per trial:
- `validity rate` — % of trials whose final `GraphDiff` decoded cleanly and passed the post-decode sanity check. Spike pass-bar is >99%.
- `p50`, `p95`, `p99` total latency in ms. Spike pass-bar is p50 < 3,000 ms on iPhone 17 Pro.
- `avg first-token` — relevant if we plan to render streaming `notes` ahead of the full diff.
- error breakdown — we expect the `large` trial to dominantly throw `exceededContextWindowSize`; that's the binding constraint and the reason eviction matters.

Append the numbers to `../report.md` once you have them — the simulator's predictions are explicit; the on-device run only needs to confirm / contradict.

## Caveats

- The verbatim attribution system prompt in `Prompt.kAttributionSystemPrompt` is a stub. To benchmark the desktop prompt as-is, paste in the full string from `src/lib/aizuchi/prompts.ts` — but the simulator says it overruns the 4K window before any graph is added, so we don't expect anyone to bother.
- `Runner.sanityCheck` validates only the structural invariants the `@Generable` constraint can't enforce (e.g. `no_changes: true` ⇒ all arrays empty). It does NOT validate that edge endpoints reference real nodes — the call site has the prior graph and should re-check there.
- iOS 26's `LanguageModelSession` is rate-limited when invoked from the background. The 50-trial loop here runs foreground; do not background the app mid-bench.
- `prewarm` caches a prompt prefix per Apple's `prewarm(promptPrefix:)` API — we don't pass one yet. If the bench numbers look poor, try passing the static system prompt as the prewarm prefix to exercise the prefix cache TN3193 mentions.
