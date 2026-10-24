# pi-zvec-status

**View and manage your current project's zvec-grep index without leaving Pi.**

`pi-zvec-status` is a Pi extension that shows index readiness in the footer and provides an index status and management menu through `/zvec`.

This is an independent third-party extension, not an official zvec-grep component. It uses existing MCP interfaces, does not parse CLI display output, and does not register additional model-facing tools. Background polling only reads status; index management operations require explicit confirmation in `/zvec`.

## What does it do?

When using zvec-grep for semantic code search, you may want to know whether a project has an index, whether it needs updating, whether a background job is running, and which embedding model it uses. This extension brings that information and common management actions into Pi.

| Feature | Description |
| --- | --- |
| Footer status | Shows readiness and progress alongside the Git branch (or detached HEAD) and worktree name. Long Git labels are shortened to fit the footer. |
| Project status panel | Shows the query directory, full worktree path, branch, Git HEAD, embedding model, index path, and file counts. |
| Index management | Create an index, update it incrementally, rebuild it, or switch to another local embedding model and rebuild. |
| Model cache detection | Distinguishes `Downloaded`, `Not downloaded`, and `Cache unknown`, with downloaded models listed first. |
| Operation confirmation | Index writes require confirmation. Missing or unverifiable local models also require separate download consent. |

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

The `full` toolset exposes index management tools as well as status queries. The extension only calls the status tool in the background and calls the index management tool after user confirmation. Other connected clients may also access those tools. The extension does not depend on or modify Pi's own MCP configuration.

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

- Queries once when an interactive session starts, then **30 seconds after each query completes**. The previous result remains visible while waiting for the next result; a failed refresh replaces it with `unavailable`. Use `/zvec` to request a fresh snapshot.
- `/zvec` opens the current project's status and action menu. The former `/zvec-status` command has been merged into `/zvec` and removed.
- The panel separates **Overview**, **Workspace**, and **Actions**, uses semantic status colors, dims secondary paths, aligns field labels, and wraps content in narrow terminals.
- Supports refreshing status, creating an index, incremental updates, rebuilding, and switching local embedding models with a rebuild.
- Every write operation requires confirmation. Queued/running jobs or unrecognized status formats limit the menu to refresh and close. Status is checked again before submission. An operation is not submitted if the current model cannot be determined.
- Index jobs run in the daemon. Closing the menu or Pi does not cancel an already accepted job.
- Updates the footer only when its final displayed content changes.
- Each request has a **10-second deadline**. Concurrent monitor refreshes share the same request.
- Stops polling and cancels requests when exiting, switching sessions, or reloading.
- Does not start background queries in print, JSON, RPC, or other non-TUI modes.
- Uses `ctx.ui.setStatus()` without replacing Pi's default footer. Third-party custom footers must display extension status themselves.

The query root is exactly Pi's `ctx.cwd`. The extension verifies that the response belongs to that root, resolving existing symlinks/junctions and normalizing paths using the host OS. A different or invalid response root is rejected before showing status or allowing actions. The extension does not search parent directories for a Git repository or index. Starting Pi from a subdirectory queries that subdirectory's status.

### Git branches and worktrees

In Git repositories, the footer identifies both the branch and the worktree directory:

```text
● zvec · main @ app · ready (last check)
◌ zvec · feature/login @ app-login · indexing 4/25
! zvec · detached@a1b2c3d @ app-review · stale
```

Branch and worktree labels are each limited to 20 terminal columns; the panel retains the full branch name and worktree path plus a 12-character Git HEAD. An unborn branch keeps its name and shows `No commit available` for HEAD. Outside Git, or if Git cannot be read, index status still works and the panel shows `Git: Not available`.

Each linked worktree is queried using its own Pi working directory, not the shared Git common directory or the branch name. Two worktrees at the same commit remain distinct. Starting from a subdirectory still queries that subdirectory; the panel's `Project` path is the query directory, while `Worktree` is its Git top-level directory. The extension never silently changes the query root to the Git root.

Git context is read before and after each panel/footer status query with bounded, read-only Git commands, not from the terminal rendering path. No working-tree file scan or `git status` is performed. A branch/HEAD change during a query suppresses readiness (`unknown`) and asks for a refresh. Changes during an operation confirmation invalidate that confirmation. A later refresh displays the new context; no branch switch triggers an automatic index update or rebuild.

**Git HEAD describes the checkout, not the commit stored in the index.** The daemon's snapshot remains the source of index readiness. Changes are detected on refresh, not through an instantaneous Git event subscription; a stable new branch plus a ready daemon response does not prove every file in that branch has been indexed.

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

Background polling only calls `zvec_grep_index_status({ root })`. After confirmation, the menu submits create, incremental update, or rebuild jobs through `zvec_grep_index({ root, wait: false, ... })`. It does not offer index deletion, switching to other projects, changing global model settings, or granting remote embedding authorization.

Switching the index means switching the current project's embedding model and rebuilding, not changing Pi's working directory. Model selection lists local models supported by zvec-grep 0.2.2. Downloaded models appear first. Unreadable configuration or cache data is labeled `Cache unknown`, not incorrectly treated as missing.

All writes that may use a local model share the same download-consent check: creation, model switching, incremental updates, and rebuilding with the existing model. A `Not downloaded` or `Cache unknown` model requires a separate **Download model?** confirmation before confirming the index operation. Cancelling either step prevents submission. Downloaded models skip download consent but still require operation confirmation. If the cache disappears during confirmation, the pre-submission check blocks that operation; select the action again to review download consent.

Opening the model list only checks local completion markers and expected file sizes. It does not load models, connect to a model provider, download files, or rehash large model weights. Both Hugging Face and ModelScope caches are supported.

Cache directories are resolved in zvec-grep's order: `defaults.modelCacheDir` in `~/.zvec-grep/config.json`, then `ZVEC_GREP_MODEL_CACHE`, then `$ZVEC_GREP_HOME/models`, or the default `~/.zvec-grep/models`. Pi and the daemon must use the same cache settings. A daemon-only `--model-cache` argument cannot be discovered through the current status interface. Cache detection matches the 0.2.2 model snapshots and directory layout; it must be updated if later versions change them.

An uncached model may download on first use. Existing remote models can be reused for updates or rebuilds only with existing user authorization; the extension does not grant authorization. Search may be temporarily unavailable during model switching or rebuilding.

A submission timeout does not mean the daemon rejected the job. Refresh status before retrying. The daemon ultimately handles submission races between clients.

Even background status queries are not necessarily side-effect-free on the server: they may scan local files or activate a workspace runtime or file watcher. Polling costs for large workspaces or multiple Pi sessions depend on zvec-grep's implementation.

Status comes from the server's existing snapshot; the extension does not perform an additional workspace scan or validate search quality. Ready requires `indexed: true` and either an explicit ready state or complete stored/pending/failed file counters with no pending or failed files. Index existence or a successful historical job alone is insufficient. Unknown compatibility states and incomplete revision pairs are not shown as ready; an older daemon returning insufficient evidence now shows `unknown`. Progress is only displayed when the server provides overall completion, never by treating a single phase's count as overall progress.

## Development and verification

```bash
npm ci --omit=peer
npm run check
npm run coverage
npm run benchmark
npm pack --dry-run
```

For the reproducible menu-rendering benchmark, before/after measurements, and acceptance results, see [performance verification](docs/performance.md).

Source and tests use TypeScript with strict type checking. Pi loads `index.ts` directly, so no build is required. Tests use Node's built-in TypeScript stripping and test runner. `npm run check` runs type checking before the tests.

The official MCP SDK is loaded on the first query, not in non-TUI modes. The custom menu loads only when opened and uses Pi's native pi-tui components without another UI framework. TypeScript, Node types, and the Pi/pi-tui packages used for development are `devDependencies`. Pi and pi-tui are also declared as host `peerDependencies` with `"*"` ranges and are not bundled, following the [official Pi package guidelines](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#declare-dependencies). Development dependency versions remain constrained for type checking and CI; wildcard host peers do not imply compatibility with every Pi release.

Tests also create temporary Git repositories and linked worktrees to cover branch changes, detached HEAD, unborn branches, subdirectories, Git environment overrides, unavailable Git, query-time branch changes, and confirmation invalidation.

Tests cover state mapping, real HTTP MCP protocol exchanges with local mock servers, authentication, read-only calls, connection cleanup, refresh coalescing, footer deduplication and theme changes, menus, confirmations and cancellations, submission arguments, error recovery, and non-interactive modes.

Tests use temporary caches and do not depend on models downloaded by the user. Regression cases include denied downloads, cache changes, malformed states never reporting ready, session switching/reloading, duplicate menus, HTTP 401/403, redirect rejection, token-file failures, submission-result validation, and accepted submissions whose responses time out without automatic retries.

`npm run check` includes a real Pi loader smoke test for package discovery and TypeScript loading. `npm run coverage` counts only extension source and filters out that smoke test by name to prevent jiti-transpiled copies from distorting original source line coverage. The full smoke test still runs in `check`.

GitHub Actions covers Linux, macOS, Windows, Node 22.19 and 24, and the locked Pi 1.4.0 host plus the latest compatible 1.x host. The workflow runs after pushing to GitHub. CI does not download models or operate on real indexes. For isolated live-daemon and terminal checks, see the [manual verification checklist](docs/verification.md). The package uses an explicit `pi.extensions` manifest for discovery, a TypeScript default factory for registration, session-scoped startup/cleanup, and Pi's native UI APIs, as described in the [official extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

## Uninstall

```bash
pi remove git:github.com/shenyankm/pi-zvec-status
```

For a local installation, pass the same local path used during installation to `pi remove` instead. Then run `/reload`. Uninstalling does not stop a shared zvec-grep daemon or delete any index.

## License

[MIT](LICENSE) © 2026 shenyankm. Third-party dependencies retain their own licenses.
