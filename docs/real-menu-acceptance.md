# Real Pi menu and two-process acceptance

## Result and scope

**Passed on Darwin arm64, 2026-10-25.** The extension under test is the production code at `fdb63a6`. This acceptance adds test drivers and documentation, not changes to extension logic or the backend.

| Component | Version / implementation |
| --- | --- |
| Node | v22.23.2 |
| Pi | installed Pi 1.4.0, actual regular-mode POSIX PTYs |
| zvec-grep | installed CLI/package 0.2.2, unmodified `zg server run` |
| Initial embedding | real cached `local/potion-code-16m-v2`, 256 dimensions |
| Switched embedding | real cached `local/potion-retrieval-32m`, 512 dimensions |

Unlike the existing layout/disconnect fixture, **no `FakeEmbeddingModel`, inference override, fake clock, or fake daemon response is used**. The chat provider is a loopback-only dummy because only slash commands and keyboard menu input are sent; no chat-model inference is requested. Embeddings use the real local Model2Vec implementation and existing model files.

All source fixtures, native indexes, daemon state, and the shared Pi agent directory are inside one disposable directory. The normal daemon is not stopped or reconfigured, and normal project indexes and the user's global auto-update setting are not changed. Model artifact sizes and modification/change timestamps are compared before and after; they remained unchanged. No download prompt is approved.

## What was executed through actual menus

The driver types `/zvec`, moves the real menu selection with arrow keys, selects the model when needed, and confirms the actual Pi **Yes** dialog. It does not submit index jobs through a test API. A transparent loopback proxy labels traffic from Pi A, Pi B, and the read-only observer without changing tool arguments or responses.

| Menu action | Fixture change | Final daemon job state | Stored / scanned / indexed files | Embedding |
| --- | --- | --- | ---: | --- |
| Create index | One `value.ts` file | `succeeded` | 1 / 1 / 1 | potion-code-16m-v2, 256d |
| Update index (incremental) | Modify `value.ts`, add `extra.ts` | `succeeded` | 2 / 2 / 2 | potion-code-16m-v2, 256d |
| Rebuild index | Rebuild the same two-file workspace | `succeeded` | 2 / 2 / 2 | potion-code-16m-v2, 256d |
| Switch model and rebuild | Select potion-retrieval-32m | `succeeded` | 2 / 2 / 2 | potion-retrieval-32m, 512d |

At each accepted final snapshot, pending, failed, added, modified, and deleted counters are zero. The final UI refresh also reaches `ready (last check)`.

The proxy verifies four distinct menu requests with exactly these option shapes, in addition to `root` and `wait: false`:

1. Create: `embedding: local/potion-code-16m-v2`.
2. Incremental update: no rebuild or embedding override.
3. Rebuild: `rebuild: true`.
4. Switch: `rebuild: true`, `embedding: local/potion-retrieval-32m`.

Repeated identical notification text is not the success criterion: the driver checks the recorded MCP submission and the actual daemon's final state. This avoids mistaking notification deduplication or a transient terminal repaint for a failed operation.

## Global setting propagation: independent Pi processes

The recorded run used Pi PIDs **84448** and **87495**, not two extension factories in one Node process. Both used the same temporary `PI_CODING_AGENT_DIR` and workspace.

1. A enables auto-update through its real menu and confirmation dialog. The shared settings file contains `autoUpdate: true`.
2. B starts as a new OS process and its menu shows **Auto-update: on**.
3. B disables the setting through its menu. A observes **Auto-update: off** on its next refresh/menu read.
4. A enables it again. B executes the real `/reload` command, then its menu still shows **Auto-update: on**.
5. After the concurrent-update check, A disables it and B observes off before both processes exit with code 0.

This verifies cross-process startup inheritance, propagation in both directions, and real reload persistence. It is not a claim of instantaneous notification: another process reads the setting on its next refresh.

## Concurrent automatic update: one workspace, two clients

To leave work for the plugin rather than allowing the backend's native watcher to process it first, the driver stops **only the isolated daemon**, adds 80 TypeScript files while it is offline, then restarts it at the same port. Both Pi processes remain running. The normal native watcher remains enabled; no watcher or scheduler implementation is replaced.

Both clients then receive terminal-focus events to refresh, wait at least six real seconds, and refresh again. These are automatic updates outside an open menu, not manually selected incremental operations. Focus events bypass the normal 30-second wait but do not bypass the five-second debounce or change the clock.

Recorded result:

| Observation | Result |
| --- | --- |
| Automatic index requests | 2, one from each Pi process |
| First response | `reused: false`, `state: running` |
| Second response | `reused: true`, `state: running` |
| Job ID in both responses | `02f50eac-3ba2-4728-a247-f10906b781e8` |
| Distinct automatic jobs | **1** |
| Final job state | `succeeded` |
| Final stored / scanned / indexed / unchanged files | **82 / 82 / 82 / 82** |
| Final pending / failed / added / modified / deleted | **0 / 0 / 0 / 0 / 0** |
| Final entity count | 82 |
| Final model | potion-retrieval-32m, 512d |
| Both Pi footers | `ready (last check)` |
| Global setting after concurrent submissions | Still on; no false error disable |
| Observed interval including debounce/status checks | 13.17 seconds |

**An internal lock retry occurred and is not hidden as a first-attempt success.** With both Pi clients and the observer querying status, the daemon logged `ZVEC_GREP.ENGINE.LOCK.BUSY`, scheduled a 250 ms retry, and finished the same job on attempt 2. Job execution including the retry took 3,451 ms. It did not create a second job or disable the plugin setting.

The same two-request/one-job behavior was also observed in the preceding successful isolated runs. This is bounded acceptance, not a multi-hour concurrency soak or a promise that the plugin itself provides cross-process locking; the daemon performs the job coalescing.

## Reproduce

Prerequisites: POSIX, Python 3, Git, installed `pi` and `zg` on `PATH`, this checkout's npm dependencies, and both named models already downloaded. The test fails preflight rather than approving a download. It does not require the sibling backend checkout.

```sh
npm ci --omit=peer
ZG_ACCEPTANCE_MODEL_CACHE=/absolute/path/to/downloaded/models \
PI_TEST_EVIDENCE=/tmp/pi-zvec-real-menu-acceptance \
npm run test:menus
```

`ZG_ACCEPTANCE_MODEL_CACHE` is mandatory and points to an existing model cache. The script isolates `HOME`, `USERPROFILE`, `PI_CODING_AGENT_DIR`, and `ZVEC_GREP_HOME`, clears inherited daemon authentication/URL and Git repository overrides, selects a private loopback daemon port, and cleans up its child processes and temporary workspace in `finally` blocks.

This test intentionally stays out of `npm run check` and CI defaults: it needs installed tools and real cached models, consumes local compute, and performs real index writes in a disposable workspace. Do not point its working directory or settings at a real project.

## Evidence and ordinary regressions

The recorded run saved evidence in `/tmp/pi-zvec-real-menu-acceptance`:

- `results.json`: operation schemas/counts, PIDs, propagation assertions, concurrent job IDs, artifact comparison, retries, and child exit codes.
- `mcp.ndjson`: actual requests/responses labelled `a`, `b`, and `probe`.
- `status-create.json`, `status-incremental.json`, `status-rebuild.json`, `status-switch.json`, and `status-concurrent-auto.json`: complete final daemon snapshots.
- `pi-a-84448.log` and `pi-b-87495.log`: raw actual PTY transcripts.
- `daemon-events.ndjson`, `daemon-console.log`, `observer-errors.log`: daemon jobs/model activity and proxy diagnostics.

Temporary source files and indexes were removed after copying the evidence; model files were not removed. `/tmp` evidence is machine-local and can be purged by the OS. A new run should use a different `PI_TEST_EVIDENCE` directory if earlier logs must be retained.

Ordinary verification was also rerun: `npm run check` passed 223 tests with two platform-specific skips; coverage remained 96.82% lines, 95.26% branches, and 93.50% functions.

## Remaining boundaries

- This run does not validate Windows/Linux terminals, every local model/backend version, remote embedding providers, or network download consent. Only the two real cached models above are accepted here.
- The automatic-cache validation window and inability to open the settings menu while the backend is unavailable are not fixed by this acceptance. They remain separate improvement items, not claimed passes.
- No claim is made about clean-machine installation/uninstallation, multi-hour load, power loss, or network filesystems.
- The documented service command is corrected to `zg server on --mcp-toolset full`; the old `zg --server on ...` form is rejected by the installed 0.2.2 CLI.
