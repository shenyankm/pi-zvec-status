# Performance and audit verification

## Original render-cache change

`lib/menu.ts` caches the static header and help text for the most recent terminal width. Repaints and selection changes reuse the parsed, themed, wrapped, and truncated lines. The action list still renders on every call, so keyboard selection remains live.

Width changes rebuild the layout; `invalidate()` clears it for theme changes. Each menu holds only one layout, which is released with the menu. No new dependencies, status-response caches, persistent connections, or polling changes were introduced. Index submission and download-consent checks are unchanged.

## Reproduce

```sh
npm run check
npm run coverage
npm run benchmark
npm pack --dry-run
```

`test/benchmark.ts` measures 2,000 renders per sample, discards one warmup sample, and reports the median of five samples. It uses long CJK project names and nested index paths with a plain theme. Scenarios cover repeated rendering, down-arrow navigation, alternating widths, and explicit invalidation before every render. Timing is informational, not a flaky CI threshold.

For a baseline, run the same benchmark script against `lib/menu.ts` from commit `10d222b` in a separate checkout with dependencies installed. Do not compare total test-suite time as a performance metric.

## Original local results

Environment: Darwin arm64, Node v22.23.2, installed lockfile dependencies. Before/after runs used the same benchmark and machine.

| Scenario | Before (ms / 2,000) | After (ms / 2,000) | Result |
| --- | ---: | ---: | --- |
| Same-width redraw | 417.01 | 11.66 | 97.2% less time, 35.8× faster |
| Keyboard navigation | 412.55 | 10.53 | 97.4% less time, 39.2× faster |
| Alternating widths | 389.33 | 393.38 | +1.0%, effectively unchanged locally |
| Explicit invalidation | 414.63 | 415.72 | +0.3%, effectively unchanged locally |

These are menu-rendering microbenchmarks, not end-to-end Pi speedups. The uncached resize/invalidation paths intentionally retain their existing work.

## Original acceptance

- TypeScript check and all 125 tests pass (124 before this change), including the Pi loader smoke test.
- Regression tests verify reuse on repaint/navigation, live selection, output equivalence to a fresh menu after resize (including widths 0 and 1), and theme refresh after invalidation.
- Source coverage: 100% lines, 97.29% branches. Coverage excludes the loader smoke test to avoid counting transpiled copies.
- `npm pack --dry-run` succeeds; tests and benchmark are not included in the published package.
- `git diff --check` passes.

That original render-cache acceptance did not perform a live-daemon mutation, model download, interactive terminal walkthrough, or cross-platform CI run. Use [the manual checklist](verification.md) for those checks. No project index was created or rebuilt for that original verification.

## Height-bounded menu follow-up

The audit follow-up keeps the cached header/help layout and uses a native `ScrollView` for details, while actions have their own height-bounded viewport. Left/right scrolling does not change the selected action. The real Pi tests cover 80×24 and 40×24 with eight additional host-widget rows in regular and fullscreen modes.

One repeat on the same Darwin/Node setup measured 10.55 ms redraw, 10.18 ms navigation, 375.54 ms resize, and 401.41 ms invalidation per 2,000 renders. These are informational observations, not a performance gate; the static-layout caching benefit remains. The current functional/coverage results and limits are in [environment verification](environment-verification.md).

## Global auto-update audit and performance follow-up

Scope: all extension source modules, manifest/TypeScript/CI configuration, dependency audit, and the main status, model-cache, settings, confirmation, lifecycle, and automatic-update test paths. Expected load is an interactive Pi user with one or several sessions/worktrees sharing the local daemon, not a public multi-tenant service. No backend implementation or real project index was modified.

Two correctness defects were reproduced and fixed:

- Cancelling the read-only revalidation phase during shutdown could invoke the auto-update error handler and persist the global switch as off, even though no index submission was attempted. Cancellation before submission now preserves the preference; cancellation after an attempted submission remains uncertain and still disables automatic updates.
- A session shutdown racing the initial asynchronous cleanup could complete before the old startup resumed, allowing it to create a late monitor. Startup now checks a lifecycle generation; superseded starts cannot install timers or input/signal listeners. The lazy host import also checks session cancellation before proceeding.

Two bounded performance changes preserve safety checks:

- `getAgentDir()` and its Pi host module are loaded only after a TUI session starts. Registering the extension or using a non-TUI mode no longer eagerly imports the complete Pi host.
- Operations with an existing model check only that model's snapshots. The model chooser still checks the full catalog. Every check rereads completion metadata and artifact timestamps; there is no persistent downloaded-state cache that could bypass consent after a mutation.

### Reproducible local measurements

Environment: Darwin arm64, Node v22.23.2, locked dependencies. Baseline is `9662e24`; the same expanded `test/benchmark.ts` was run before and after the changes. One warmup is discarded and five measured samples are reported by their median.

| Scenario | Before | After | Observation |
| --- | ---: | ---: | --- |
| Extension import, fresh Node process | 310.57 ms | 80.52 ms | 74.1% less time, 3.86× faster |
| Current model cache, 50 checks | 29.95 ms | 5.83 ms | 80.5% less time, 5.14× faster |
| Full catalog cache, 50 checks | 35.61 ms | 34.12 ms | Essentially unchanged; chooser behavior retained |
| Menu redraw, 2,000 renders | 12.87 ms | 12.36 ms | Essentially unchanged |
| Menu navigation, 2,000 renders | 11.28 ms | 11.54 ms | Essentially unchanged |
| Menu resize, 2,000 renders | 409.26 ms | 411.72 ms | Essentially unchanged |
| Menu invalidation, 2,000 renders | 434.05 ms | 435.09 ms | Essentially unchanged |

The cache benchmark creates isolated sparse artifact fixtures for all eleven models without downloading or reading model weights, checks them sequentially, and removes the temporary directory. The current-model path test also verifies that only five path `stat` calls are made: the global config, two source markers, and two Model2Vec artifacts. Unrelated model caches are not inspected.

These are import/cache/menu microbenchmarks, not end-to-end Pi startup, daemon indexing, embedding throughput, or cold-disk guarantees. Pi may already have loaded its own host module; that case cannot realize the entire fresh-process import saving. Timings are informational and are not CI gates.

### Acceptance and limits

- `npm run check`: 225 tests, 223 passed and two platform-specific tests skipped.
- `npm run coverage`: 96.82% source lines, 95.26% branches, 93.50% functions. The original coverage gates remain unchanged.
- `npm audit`: zero reported vulnerabilities in the locked dependency graph at audit time; this does not audit a separately installed Pi host.
- Added regressions cover cancellation before submission, cancellation after submission, startup/shutdown overlap, selective cache I/O, and cache mutation after a selective check.
- No new dependencies, reduced validation, longer polling intervals, persistent MCP connections, or cached readiness claims.

The audit does not prove atomicity between daemon status checks and other clients' submissions; the daemon still arbitrates competing jobs. Broken network-mount kernel I/O, power loss, and real Windows/Linux host behavior were not reproduced on this Darwin machine. No real index update or model download was requested.
