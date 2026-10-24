# Menu performance verification

## Change

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

## Local results

Environment: Darwin arm64, Node v22.23.2, installed lockfile dependencies. Before/after runs used the same benchmark and machine.

| Scenario | Before (ms / 2,000) | After (ms / 2,000) | Result |
| --- | ---: | ---: | --- |
| Same-width redraw | 417.01 | 11.66 | 97.2% less time, 35.8× faster |
| Keyboard navigation | 412.55 | 10.53 | 97.4% less time, 39.2× faster |
| Alternating widths | 389.33 | 393.38 | +1.0%, effectively unchanged locally |
| Explicit invalidation | 414.63 | 415.72 | +0.3%, effectively unchanged locally |

These are menu-rendering microbenchmarks, not end-to-end Pi speedups. The uncached resize/invalidation paths intentionally retain their existing work.

## Acceptance

- TypeScript check and all 125 tests pass (124 before this change), including the Pi loader smoke test.
- Regression tests verify reuse on repaint/navigation, live selection, output equivalence to a fresh menu after resize (including widths 0 and 1), and theme refresh after invalidation.
- Source coverage: 100% lines, 97.29% branches. Coverage excludes the loader smoke test to avoid counting transpiled copies.
- `npm pack --dry-run` succeeds; tests and benchmark are not included in the published package.
- `git diff --check` passes.

No live-daemon mutation, model download, interactive terminal walkthrough, or cross-platform CI run was performed. Use [the manual checklist](verification.md) for those checks. No project index was created or rebuilt for verification.
