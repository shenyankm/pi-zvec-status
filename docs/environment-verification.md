# Environment acceptance and remaining boundaries

This records local experiments for the status plugin and its sibling Node backend, not a claim of universal platform coverage. Host: Darwin arm64, Node v22.23.2, Pi 1.4.0. All writable fixtures use temporary repositories and isolated HOME / agent / zvec directories. The shared installed daemon and real project index jobs are not restarted, cancelled, or reconfigured.

## Implemented behavior

- One coalesced status source publishes to both footer and open panel. Pending, expired, unavailable, and Git-operation frames cannot enable index writes.
- Idle polling is 30 seconds, queued/running polling is two seconds, and outage retries back off to 120 seconds. Explicit refresh, terminal focus, and `SIGCONT` bypass the retry delay. A wall-clock watchdog handles overdue requests after an event-loop pause.
- TTY-only focus observation also works when a fullscreen host consumes focus reports before its public input hooks. It stores only an escape-sequence prefix, never typed text. Timers/listeners are released on session shutdown; non-TTY registration does not open stdin.
- Git changes include untracked files; merge, rebase, cherry-pick, revert, and bisect states are visible. The worktree overview is read-only, paginated, concurrency-limited, and uses a total page deadline.
- The Node cache has budget/age pruning, administration commands, stale-temp cleanup, and per-input cross-process leases. Native indexes retain their own vectors.
- Explicit added/modified/deleted file drift overrides historical job success and matching revision numbers. The panel shows the drift counters rather than treating pending=0 as proof of synchronization.
- Ignore inheritance is shared by full, targeted, and watcher scans. Traversal reopened for one include does not restore sibling generated files or allow a child ignore file to escape its ignored parent.

## 1. Real Git layouts

`test/git.test.ts` uses real Git commands and filesystem entries, not mocked Git output:

- merge, cherry-pick, and rebase conflicts; writes are disabled until abort/resolution;
- submodules, nested repositories, and cone-mode sparse checkouts;
- detached/unborn branches, directory aliases, moved/missing/prunable/recreated worktrees, and bare repositories;
- 23 worktrees across two overview pages, with at most four status calls in flight and no index submissions.

The ignore regression tests compare selection against `git check-ignore` for `/gen/*`, `/gen/`, `gen`, and `gen/**`, including nested negations and explicit includes. A read-only scan using PractiQ's actual saved root configuration confirmed that the offending bundled `THIRD-PARTY.txt` is excluded and no longer eligible for watcher indexing in the fixed build. This does not modify or deploy to the old running daemon. A later read-only status observation found the latest PractiQ job succeeded at 1543/1543, but reported two outstanding deletions; the added regression ensures this is `stale`, not ready. These Git layout tests verify context/status handling, not automatic relocation of a persisted native index.

## 2. Real filesystem / native backend load

`../zvec-grep/test/environments/load.test.mjs` creates:

- 20 actual linked worktrees;
- four independent native Zvec indexes, 256 source files each;
- 10,000 unique dense 1,024-dimensional vectors, reused 200,000 times;
- 40 real HTTP MCP status requests against an isolated `DaemonHttpServer`, with four clients in flight.

The first native index computed 256 inputs; each of the next three reused 256 and computed zero. A representative passing run took 62.78 seconds, held 222,625,922 bytes of disposable vectors, observed 617.5 MiB peak RSS, and 0.2 MiB retained JS heap growth after explicit GC. The script emits actual metrics on every run and also asserts that clearing the cache preserves native-index search.

This is a bounded roughly one-minute trial, not an hours-long soak or a production-model latency benchmark. Dense deterministic inference isolates reuse/storage behavior; no Qwen weights or external provider are used.

## 3. Real process and I/O faults

`../zvec-grep/test/environments/faults.test.mjs` passes on this host:

- actual `SIGKILL` at an injected pre-rename barrier after a real temporary-file write; the previously published record remains intact and dead-writer temporary files are pruned;
- actual `SIGKILL` of an inference owner; a waiting process reclaims the stale lease and completes;
- actual read-only cache permissions (`chmod 0500`); inference still returns valid vectors when publication fails.

`test/protocol.test.ts` additionally uses real loopback HTTP servers that stall initialization/session cleanup. Deadlines reject the read rather than publishing green status after expiry. Corrupt/missing records and malformed model output are covered by backend regression tests.

**Not reproduced:** literal disk exhaustion, hardware power loss, network-filesystem rename semantics, or a hostile multi-user machine. No attempt is made to fill the developer's disk. Atomic publication and permission checks are protections, not substitutes for those experiments.

## 4. Real Pi terminal process

`test/environments/terminal-check.py` starts installed Pi in an actual POSIX PTY, loading this extension against the isolated real backend:

| Mode | Theme | Keyboard/overview | Resize | Disconnect/reconnect | Actual 31s SIGSTOP/SIGCONT | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| regular | dark | pass; detail scrolling | 80×24 → 40×24 → 80×24 | pass, panel/footer update together | pass | 0 |
| fullscreen | light | pass; detail scrolling | 80×24 → 40×24 → 80×24 | pass, panel/footer update together | not separately repeated | 0 |

Both runs include eight extra host-widget rows. They assert that update actions remain visible at 24 rows and that left/right detail scrolling reveals `Checked` without changing action selection. The overlay is independent of the host's editor/widget height allocation.

The tests use a loopback-only dummy chat provider and send only slash commands; no external model request or download is required. Raw terminal logs and result JSON are saved under `/tmp/pi-zvec-gap-evidence` by default. Keyboard input is drained between escape sequences to avoid confusing asynchronous native selectors with Alt-key sequences.

This is not a manual visual review in every terminal emulator. Two initial themes are tested; live theme invalidation is a unit test, not a claimed manual theme-switch walkthrough. Third-party replacement footers remain responsible for drawing extension statuses.

## 5. Real menu writes and independent Pi processes

The opt-in `npm run test:menus` acceptance now runs installed Pi 1.4.0 against the **unmodified installed zvec-grep 0.2.2 daemon**, with real cached Model2Vec models rather than `FakeEmbeddingModel`. See [the complete run record](real-menu-acceptance.md) for reproduction and evidence.

- Actual menus create a one-file 256-dimensional index, incrementally update it to two files, rebuild it, then switch from `local/potion-code-16m-v2` to `local/potion-retrieval-32m`, producing a two-file 512-dimensional index. All four jobs finish `succeeded`, with no pending, failed, or drift counters.
- Two separate Pi OS processes share only the disposable workspace, agent directory, and isolated daemon. Menu changes propagate on refresh; the second process inherits on at startup and preserves it through real `/reload`.
- After 80 files are added while only the isolated daemon is offline, both Pi processes submit automatic incremental requests. Both responses have the same job ID; the second has `reused: true`. The final index has 82 stored/scanned/indexed files, both footers show ready, and the shared setting remains on.
- The daemon reports one `ZVEC_GREP.ENGINE.LOCK.BUSY` retry with a 250 ms delay; the same job succeeds on attempt 2. This is an observed bounded retry, not a claim that no contention occurred.
- Both Pi processes exit 0, disposable indexes are removed, and model artifact size/mtime/ctime comparisons remain unchanged. No model download is approved and normal user settings/daemon state are not changed.

This does not close the remaining offline-settings or cache-validation-window improvement items, nor does it validate other operating systems or remote providers.

## Full-check evidence

| Check | Result |
| --- | --- |
| Plugin `npm run check` | 225 tests: 223 pass, two platform-specific skips |
| Plugin coverage | 96.82% lines, 95.26% branches, 93.50% functions; gates: 90/90/85 |
| Backend ordinary tests, aggregated across isolated phases | 809 tests: 808 pass, one Windows-specific skip |
| Backend merged coverage | 90.71% lines, 85.88% branches, 95.51% functions; all four global gates exceed 80% |
| Backend real environment fixtures | Four pass; zero skipped |
| Plugin environment subset | 32 pass, plus both real Pi PTY runs at 24 rows |
| Opt-in real menu / two-process acceptance | Four real menu writes, shared-setting propagation/reload, two auto requests coalesced to one successful job; both Pi exits 0 |
| Plugin dependency audit | Zero known vulnerabilities in the full locked dependency graph |
| Static/package checks | Typechecks, backend lint/format, plugin dry-run pack and backend installed-package test pass |

The backend figures are retained from the earlier acceptance run; the follow-up audit fixes only changed the plugin. Its lint/format/check/coverage, dependency audit, dry-run pack and real Pi PTY runs were repeated.

One monolithic backend `npm run check` attempt failed with actual host `ENOSPC` during unit tests and coverage writes. Its root phase had passed all 456 tests. The failed run is not recorded as passing: remaining unit files, integration, end-to-end and installed-package checks were rerun with per-file disposable HOME directories; two further cleanup-boundary tests were added and passed. Coverage for the unchanged backend build was merged from these phases using installed Istanbul tooling, with all four 80% gates asserted. Generated raw coverage files were compacted/removed, not project indexes or model caches. Logs remain in `/tmp/zg-gaps-*.log` and `/tmp/pi-gaps-*.log`.

The unplanned `ENOSPC` event is not a controlled disk-full recovery acceptance test. Free disk space was about 3–4 GiB after that earlier backend verification; avoid another high-volume monolithic run without sufficient headroom.

## Follow-up audit regression coverage

- `test/models.test.ts` and `test/status.test.ts` use realistic `marker.files` records. Same-size changes, absent/malformed file records, and changes during confirmation cannot bypass download consent or reach index submission. Tests independently assert GGUF and Model2Vec artifact-key aliases rather than assuming local cache filenames are marker keys. A read-only check of the existing Qwen cache correctly reported `Downloaded` without reading weights or fetching files.
- `test/metadata.test.ts` uses actual FIFOs and an isolated four-thread child process to verify prompt rejection, ordinary-I/O recovery and normal process exit. It also swaps a regular file to a FIFO between path inspection and open, exercising `O_NONBLOCK` and descriptor revalidation. Token/config/marker paths share a cancellable, hard 64 KiB reader; symlinks to ordinary files remain supported.
- `test/menu.test.ts` verifies selection visibility at 40/80 columns and 16 available rows, shrinking to six/one row, restoring selection across read-only frames, and independent detail scrolling. The real PTY tests now exercise 24 terminal rows rather than only narrow columns in a 44-row terminal.
- TypeScript's unused-code/fallthrough checks, Prettier and coverage thresholds are part of the existing CI path. The locked development host's exact Undici 8.10.2 dependency is overridden to 8.12.2, retaining Node 22.19 support and the Pi 1.4.0 API. This does not upgrade or patch global host installations.

Kernel `stat`/`open` calls on a broken network filesystem cannot be interrupted by JavaScript cancellation; those mounts still require separate validation/process isolation. No test here claims otherwise.

## Reproduce

With both checkouts and their dependencies present:

```sh
cd ../zvec-grep
npm run build
npm run test:environments
cd ../pi-zvec-status
npm run check
npm run test:environments
```

The backend environment script needs the sibling plugin's MCP client dependency. The layout/disconnect PTY script requires POSIX, Python 3, Git, installed Pi, and the built sibling backend; `ZG_TEST_BACKEND_ROOT` can select another backend checkout. `PI_TEST_EVIDENCE` selects the transcript output directory. For full backend checks, use a disposable HOME to avoid inheriting a developer's default model setting.

## Explicit boundaries

- Windows/UNC/ACL behavior, long-path combinations, network mounts, and literal power/disk failures are not validated on this Mac. Windows-specific tests remain in CI where applicable.
- The cache limit is a pruning budget, not a hard filesystem quota; active concurrent or cancelled jobs can temporarily exceed it. Cross-process lock failures or a 30-second wait timeout can fall back to redundant inference rather than stall indexing.
- Git metadata and daemon snapshots do not attest to the exact bytes of an already-dirty checkout. `Index HEAD: Not attested by daemon` is deliberate; no green status claims commit provenance.
- Mutable remote models, multi-root cache reuse, separate-clone reuse, and Rust cache support are still deliberately outside this Node-only implementation. These are bypassed, not presented as supported or tested.
- New source builds are not automatically installed into the shared global daemon. Deployment and interruption of its existing jobs require a separate decision.
