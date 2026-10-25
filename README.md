# pi-zvec-status

**View and manage your current project's zvec-grep index without leaving Pi.**

`pi-zvec-status` is a Pi extension that shows index readiness in the footer and provides an index status and management menu through `/zvec`.

This is an independent third-party extension, not an official zvec-grep component. It uses existing MCP interfaces, does not parse CLI display output, and does not register additional model-facing tools. Background polling is read-only by default. Index management requires explicit confirmation in `/zvec`, with an opt-in global switch for automatic local incremental updates.

## What does it do?

When using zvec-grep for semantic code search, you may want to know whether a project has an index, whether it needs updating, whether a background job is running, and which embedding model it uses. This extension brings that information and common management actions into Pi.

| Feature | Description |
| --- | --- |
| Footer status | Shows readiness and progress alongside the Git branch (or detached HEAD) and worktree name. Long Git labels are shortened to fit the footer. |
| Project status panel | Live updates from the same snapshot as the footer, with query/worktree paths, Git changes and operation, model, file counts, activity, and check time. |
| Worktree overview | `/zvec worktrees` lists worktrees read-only, 20 per page, with at most four concurrent status queries and a 10-second page budget. |
| Index management | Create an index, update it incrementally, rebuild it, or switch to another local embedding model and rebuild. |
| Model cache detection | Distinguishes `Downloaded`, `Not downloaded`, and `Cache unknown`, with downloaded models listed first. |
| Operation confirmation | Manual index writes require confirmation. Automatic local updates require explicit global opt-in. Missing or unverifiable local models require separate download consent for manual operations. |

**This is not the search engine itself.** The zvec-grep daemon performs project scanning, model downloads, embedding computation, and index jobs. Search remains available through zvec-grep tools or its CLI. The extension does not automatically start the service, create an index, change the global default model, or offer index deletion.

## Everyday use

After installation and connection to the zvec-grep service:

1. Start Pi from the project directory whose index you want to manage.
2. Check the footer, for example `● zvec · ready (last check)` or `○ zvec · no index`.
3. Enter `/zvec` to open the **Overview**, **Workspace**, and **Actions** panel.
4. Select refresh, create, update, or rebuild. Choose **Switch model and rebuild** to change the embedding model.
5. Review the confirmation prompts before submitting an operation. Jobs run in the background; the footer refreshes periodically. You can also select **Refresh status** in the panel.

The interface is in English. The extension uses Pi's current working directory and does not search parent directories for a project root. Installation, connection settings, and limitations are described below.

## Installation

Requires Node.js 22.19+, Pi 1.4.x or a later compatible release in the same 1.x series using `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, and a local zvec-grep HTTP MCP service supporting `zvec_grep_index_status`.

Install directly from GitHub using Pi's package manager:

```bash
pi install git:github.com/shenyankm/pi-zvec-status
```

Run `/reload` in an existing Pi session, or start a new session. Pi installs runtime dependencies for Git packages and provides the host packages itself.

For local development:

```bash
git clone https://github.com/shenyankm/pi-zvec-status.git
cd pi-zvec-status
npm ci --omit=peer
pi install .
```

To try a local checkout without installing it:

```bash
pi -e /absolute/path/to/pi-zvec-status/index.ts
```

Replace the example path with your checkout's location. Local packages are loaded in place; install their dependencies yourself.

### zvec-grep service

The extension **does not start, stop, or reconfigure the service**. The status tool belongs to the `full` toolset. If the service is not running, start it yourself:

```bash
zg --server on --mcp-toolset full
```

If an existing service only exposes the `agent` toolset, stop it at an appropriate time and restart it with `full`. Restarting affects other clients sharing that daemon; the extension never does this for you.

The `full` toolset exposes index management tools as well as status queries. By default, the extension only calls the status tool in the background. Index management requires user confirmation, either for each manual operation or to enable automatic local incremental updates globally. Other connected clients may also access those tools. The extension does not depend on or modify Pi's own MCP configuration.

## Status and behavior

Example footer states:

```text
● zvec · ready (last check)
◌ zvec · indexing 40/128
! zvec · stale
○ zvec · no index
! zvec · unavailable
```

Icons and state descriptions use semantic colors from Pi's active theme: green for ready, accent for checking and indexing, warning for warnings, and error for failures. The name uses a muted color. Every state includes an English description after the name; ready is shown as `ready (last check)` without file counts. This is the last successful snapshot, not a live guarantee. The panel retains the full status text.

The server reports running create, update, and rebuild jobs as `indexing`. Overall completed/total counts are shown when available.

### State reference

| State | Meaning |
| --- | --- |
| `ready (last check)` | The most recent snapshot reported the index ready. It may have changed since that check. |
| `checking` | Querying index status. |
| `queued` | An index job is queued. |
| `indexing` | Creating, updating, or rebuilding the index; may include overall progress. |
| `no index` | No index exists for the current working directory. |
| `stale` | The index needs updating; file changes may not have been processed yet. |
| `rebuild required` | The index must be rebuilt. |
| `failed` | An index job or some files failed processing. |
| `cancelled` | The index job was cancelled. |
| `disabled` | Indexing is disabled. |
| `unavailable` | The service cannot be reached or its status cannot be read. |
| `unknown` | The response format or state is not recognized; it is not treated as ready. |

### Refresh and interaction

- Queries at startup, then **30 seconds after completion while idle**, or **2 seconds while queued/indexing**. Outages back off from 30 to at most 120 seconds; manual/focus/resume refreshes do not wait for the retry timer.
- Refreshing replaces the previous result with `checking`; failed or timed-out reads show `unavailable`. A wall-clock watchdog expires overdue snapshots after an event-loop pause. Terminal focus and `SIGCONT` trigger refresh; all listeners and timers are removed on session shutdown.
- The panel and footer share the same coalesced request and update together, including while the menu is open. The `Checked` field records snapshot time. Unverified or expired frames cannot enable writes.
- `/zvec` opens the current project's status and action menu. The former `/zvec-status` command has been merged into `/zvec` and removed.
- The panel separates **Overview**, **Workspace**, and **Actions** in a height-bounded overlay. **←/→** scroll details, **↑/↓** select actions, Enter selects, and Esc closes. The action list stays visible on short terminals, including 80×24 and 40×24; long details use Pi's native `ScrollView` independently from selection.
- Supports refreshing status, creating an index, incremental updates, rebuilding, and switching local embedding models with a rebuild.
- Manual writes require confirmation. Queued/running jobs, active Git operations, expired or unrecognized snapshots disable manual index writes; refresh, read-only overview, the auto-update setting, and close remain available. Status is checked again before submission. An operation is not submitted if the current model cannot be determined.
- Index jobs run in the daemon. Closing the menu or Pi does not cancel an already accepted job.
- Updates the footer only when its final displayed content changes.
- Each request has a **10-second deadline**. Concurrent monitor refreshes share the same request.
- Stops polling and cancels requests when exiting, switching sessions, or reloading.
- Does not start background queries in print, JSON, RPC, or other non-TUI modes.
- Uses `ctx.ui.setStatus()` without replacing Pi's default footer. Third-party custom footers must display extension status themselves.

The query root is exactly Pi's `ctx.cwd`. The extension verifies that the response belongs to that root, resolving existing symlinks/junctions and normalizing paths using the host OS. A different or invalid response root is rejected before showing status or allowing actions. The extension does not search parent directories for a Git repository or index. Starting Pi from a subdirectory queries that subdirectory's status.

### Automatic incremental updates

Open `/zvec`, select **Auto-update: off**, and confirm to enable it. Select **Auto-update: on** to disable it immediately. It is **off by default** and saved globally in **`~/.pi/agent/zvec-status.json`**, or `zvec-status.json` under `PI_CODING_AGENT_DIR` when overridden. It survives session switches, reloads, and restarts. Each session only updates its own current working directory; enabling this does not scan every project on disk. Other running sessions pick up changes on their next status refresh.

```json
{ "autoUpdate": true }
```

The plugin uses a private, atomically replaced settings file rather than modifying Pi `settings.json` or the zvec-grep global configuration. A missing file means off; unreadable or malformed settings disable automatic updates without being overwritten.

When enabled:

- Only an existing index reported as `stale`, using a verified downloaded **local** model, is eligible. There is no automatic creation, rebuild, model switch, download consent, or remote embedding.
- Two eligible status samples with the same model and Git context must be at least **5 seconds apart**. This reuses the existing polls, so enabling the switch or observing a new Git context usually takes **30–60 seconds** to reach submission, not five-second file watching.
- Before submission, the plugin rechecks the local model cache and current daemon/Git status. Unknown or missing cache data, running jobs, active Git operations, and non-stale states skip automatic submission.
- A successful submission has a **60-second cooldown**. Automatic submission pauses while the `/zvec` panel or worktree overview is open; manually requested actions still require confirmation.
- An automatic-update error, including an uncertain submission timeout, saves the global switch as off and warns you. If saving fails, that session stays stopped and the warning explains that other sessions or restarts may still use the old setting. Refresh status before enabling it again to avoid duplicate submissions.

Updates use local CPU, memory, and disk. Pi and the daemon must share model-cache settings; a daemon-only cache override and filesystem changes after validation cannot be detected atomically. Turning the switch off or exiting Pi cancels pending client requests, but cannot cancel a job already accepted by the daemon.

### Git branches and worktrees

In Git repositories, the footer identifies both the branch and the worktree directory:

```text
● zvec · main @ app · ready (last check)
◌ zvec · feature/login @ app-login · indexing 4/25
! zvec · detached@a1b2c3d @ app-review · stale
```

A `*` after the branch marks tracked or untracked changes. Merge, rebase, cherry-pick, revert, and bisect states are shown explicitly and disable index writes until resolved. Branch and worktree labels are each limited to 20 terminal columns; the panel retains the full branch name and worktree path plus a 12-character Git HEAD. An unborn branch keeps its name and shows `No commit available` for HEAD. Outside Git, or if Git cannot be read, index status still works and the panel shows `Git: Not available`.

Each linked worktree is queried using its own Pi working directory, not the shared Git common directory or the branch name. Two worktrees at the same commit remain distinct. Starting from a subdirectory still queries that subdirectory; the panel's `Project` path is the query directory, while `Worktree` is its Git top-level directory. The extension never silently changes the query root to the Git root.

Git context is read before and after each shared status query using bounded, read-only Git commands, including porcelain-v2 status with untracked-file detection. These commands never run in the rendering path or take optional Git write locks; very large/slow status output safely degrades to `Git: Not available`. A branch/HEAD change during a query suppresses readiness (`unknown`) and asks for a refresh. Changes during an operation confirmation invalidate that confirmation. A later refresh displays the new context. A branch switch alone never triggers a rebuild; if global auto-update is enabled, a stable new context with an eligible stale index can receive a debounced incremental update.

`/zvec worktrees` never changes Pi's working directory or submits index jobs. Missing/prunable and bare worktrees are distinguished; rows not reached before the page deadline remain `not checked`, while timed-out reads show `unavailable`, never ready. New, moved, or removed worktrees are re-listed on refresh.

**Git HEAD describes the checkout, not the commit stored in the index.** The panel labels index HEAD as `Not attested by daemon`. Git metadata checks do not prove that an already-dirty file's bytes stayed unchanged throughout a query. The daemon's snapshot remains the source of index readiness. Changes are detected on refresh, not through an instantaneous Git event subscription; a stable new branch plus a ready daemon response does not prove every file in that branch has been indexed.

### Connection and authentication

Reuses zvec-grep environment variables; no extension configuration file is needed:

| Variable | Default / meaning |
| --- | --- |
| `ZVEC_GREP_SERVER_URL` | `http://127.0.0.1:7999/mcp` |
| `ZVEC_GREP_SERVER_TOKEN` | Optional Bearer token; takes precedence over the token file. |
| `ZVEC_GREP_SERVER_TOKEN_FILE` | Optional token file path; leading and trailing whitespace is trimmed. |

These variables must be inherited by the **Pi process**. Variables set only in Pi's MCP configuration are not passed to this extension.

Only HTTP(S) loopback addresses are accepted: `127.0.0.1`, `localhost`, and `[::1]`. URLs containing a username, password, query, or fragment are rejected to avoid sending the working directory to a remote host or exposing credentials in URLs.

Each poll creates a short-lived MCP session, then terminates and closes it. Connection errors, authentication failures, and incompatible interfaces display `unavailable`. The next poll retries without repeated popups or exposing raw server errors or credentials.

## Safety boundaries and limitations

Background polling calls `zvec_grep_index_status({ root })`. With auto-update disabled (the default), it never submits index jobs. After confirmation, the menu submits create, incremental update, or rebuild jobs through `zvec_grep_index({ root, wait: false, ... })`. Enabling the global auto-update switch additionally authorizes eligible local incremental jobs with `{ root, wait: false }`, without per-job prompts. It does not offer index deletion, switching to other projects, changing global model settings, or granting remote embedding authorization.

Switching the index means switching the current project's embedding model and rebuilding, not changing Pi's working directory. Model selection lists local models supported by zvec-grep 0.2.2. Downloaded models appear first. Unreadable configuration or cache data is labeled `Cache unknown`, not incorrectly treated as missing.

All manual writes that may use a local model share the same download-consent check: creation, model switching, incremental updates, and rebuilding with the existing model. A `Not downloaded` or `Cache unknown` model requires a separate **Download model?** confirmation before confirming the index operation. Cancelling either step prevents submission. Downloaded models skip download consent but manual operations still require confirmation. Automatic updates skip models whose cache cannot be verified and never show a download prompt. If the cache disappears during confirmation, the pre-submission check blocks that operation; select the action again to review download consent.

Opening the model list checks local completion markers, expected file sizes, and each file's recorded `mtimeMs`/`ctimeMs`. Missing or stale per-file metadata is `Cache unknown`, so same-size mutations cannot skip download consent. It does not load models, connect to a model provider, download files, or rehash large model weights. Both Hugging Face and ModelScope caches are supported.

Token files, the global configuration, and completion-marker JSON must resolve to ordinary files no larger than **64 KiB**. Reads are byte-bounded and cancellable; FIFOs/devices are rejected, including a POSIX file-to-FIFO replacement race. Invalid cache metadata never qualifies as downloaded. Existing symlinks to regular files still work. A blocked kernel `stat`/`open` on a broken network mount is outside these local-I/O guarantees.

Cache directories are resolved in zvec-grep's order: `defaults.modelCacheDir` in `~/.zvec-grep/config.json`, then `ZVEC_GREP_MODEL_CACHE`, then `$ZVEC_GREP_HOME/models`, or the default `~/.zvec-grep/models`. Pi and the daemon must use the same cache settings. A daemon-only `--model-cache` argument cannot be discovered through the current status interface. Cache detection matches the 0.2.2 model snapshots and directory layout; it must be updated if later versions change them.

An uncached model may download on first use. Existing remote models can be reused for updates or rebuilds only with existing user authorization; the extension does not grant authorization. Search may be temporarily unavailable during model switching or rebuilding.

A submission timeout does not mean the daemon rejected the job. Refresh status before retrying. The daemon ultimately handles submission races between clients.

Even background status queries are not necessarily side-effect-free on the server: they may scan local files or activate a workspace runtime or file watcher. Polling costs for large workspaces or multiple Pi sessions depend on zvec-grep's implementation.

Status comes from the server's existing snapshot; the extension does not perform an additional workspace scan or validate search quality. Ready requires `indexed: true` and either an explicit ready state or complete stored/pending/failed file counters with no pending or failed files. Index existence or a successful historical job alone is insufficient. Reported additions, modifications, or deletions force `stale` even when the last job succeeded and revisions match; the panel's `Index drift` row uses `+added ~modified -deleted`. Unknown compatibility states and incomplete revision pairs are not shown as ready; an older daemon returning insufficient evidence now shows `unknown`. Progress is only displayed when the server provides overall completion, never by treating a single phase's count as overall progress.

## Development and verification

```bash
npm ci --omit=peer
npm run check
npm run coverage
npm run benchmark
npm pack --dry-run
```

For the reproducible menu-rendering benchmark, before/after measurements, and acceptance results, see [performance verification](docs/performance.md).

Source and tests use strict TypeScript with unused-local, unused-parameter, and switch-fallthrough checks. Pi loads `index.ts` directly, so no build is required. Tests use Node's built-in TypeScript stripping and test runner. `npm run check` runs compiler-based lint, Prettier verification, and the tests; `npm run format` applies code/config formatting. Git normalizes source files to LF on every OS. The pinned model snapshot table and npm-generated lockfile retain their producer's formatting.

`npm run coverage` fails below **90% lines, 90% branches, or 85% functions**; the Linux Node 24 CI job enforces these gates. The locked development Pi 1.4.0 pins a vulnerable Undici version, so this checkout narrowly overrides `undici@8.10.2` to `8.12.2` without downgrading or replacing the host. This repository-level test dependency override does not patch an independently installed global Pi.

The official MCP SDK is loaded on the first query, not in non-TUI modes. The custom menu loads only when opened and uses Pi's native pi-tui components without another UI framework. TypeScript, Node types, and the Pi/pi-tui packages used for development are `devDependencies`. Pi and pi-tui are also declared as host `peerDependencies` with `"*"` ranges and are not bundled, following the [official Pi package guidelines](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#declare-dependencies). Development dependency versions remain constrained for type checking and CI; wildcard host peers do not imply compatibility with every Pi release.

Tests also create real temporary Git repositories for branch/operation changes, submodules, nested repositories, sparse checkouts, moved/missing/recreated worktrees, bare repositories, paginated request concurrency, detached HEAD, and confirmation invalidation. For native-daemon load, process-kill, and actual Pi PTY results, see [environment verification](docs/environment-verification.md).

Tests cover state mapping, real HTTP MCP protocol exchanges with local mock servers, authentication, read-only calls, connection cleanup, refresh coalescing, footer deduplication and theme changes, menus, confirmations and cancellations, submission arguments, error recovery, and non-interactive modes.

Tests use temporary caches and do not depend on models downloaded by the user. Regression cases include denied downloads, same-size cache mutations, realistic per-file completion metadata, bounded token/config/marker reads, FIFO replacement and I/O-pool recovery, short-terminal selection and detail scrolling, malformed states never reporting ready, session switching/reloading, duplicate menus, HTTP 401/403, redirect rejection, token-file failures, submission-result validation, and accepted submissions whose responses time out without automatic retries.

`npm run check` includes a real Pi loader smoke test for package discovery and TypeScript loading. `npm run coverage` counts only extension source and filters out that smoke test by name to prevent jiti-transpiled copies from distorting original source line coverage. The full smoke test still runs in `check`.

GitHub Actions covers Linux, macOS, Windows, Node 22.19 and 24, and the locked Pi 1.4.0 host plus the latest compatible 1.x host. The workflow runs after pushing to GitHub. CI does not download models or operate on real indexes. For isolated live-daemon and terminal checks, see the [manual verification checklist](docs/verification.md). The package uses an explicit `pi.extensions` manifest for discovery, a TypeScript default factory for registration, session-scoped startup/cleanup, and Pi's native UI APIs, as described in the [official extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

## Uninstall

```bash
pi remove git:github.com/shenyankm/pi-zvec-status
```

For a local installation, pass the same local path used during installation to `pi remove` instead. Then run `/reload`. Uninstalling does not stop a shared zvec-grep daemon or delete any index.

## License

[MIT](LICENSE) © 2026 shenyankm. Third-party dependencies retain their own licenses.
