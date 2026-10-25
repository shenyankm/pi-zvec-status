# Manual daemon and TUI verification

Default `npm run check` tests use an isolated model-cache directory and a local mock MCP server. They do not download models or rebuild a real index. The Pi loader smoke test uses the installed host to discover the package and load its TypeScript entry.

The separate, opt-in `npm run test:menus` drives actual Pi menus against the installed daemon and already-downloaded real local models. It covers create, incremental update, rebuild, model switching, global setting propagation between two independent Pi processes, and concurrent automatic updates. It creates and removes only disposable indexes. See [the recorded real-menu acceptance](real-menu-acceptance.md) for prerequisites, reproduction, results, and observed daemon lock retries.

Run the following manual checks before release. Use a disposable workspace, not a real project. A confirmed operation can download model files and consume CPU, memory, and disk space. Use the same cache configuration in Pi and the daemon.

## Prepare

1. Start a compatible local zvec-grep daemon with the `full` MCP toolset. Do not restart a shared daemon without checking its other users.
2. In a terminal, create a temporary workspace and one source file:

   ```bash
   PLUGIN=/absolute/path/to/pi-zvec-status
   WORKSPACE="$(mktemp -d)"
   printf 'export const value = 1;\n' > "$WORKSPACE/sample.ts"
   cd "$WORKSPACE"
   pi -e "$PLUGIN/index.ts"
   ```

   These commands use a POSIX shell. On Windows, create an equivalent temporary folder and source file, then start Pi from that folder with the plugin path.

## Checklist

- [ ] The footer shows `no index`. `/zvec` opens a single English menu.
- [ ] Model choices distinguish downloaded, not-downloaded, and unverifiable caches.
- [ ] Choose a not-downloaded model and reject `Download model?`: no job is submitted.
- [ ] Accept the download prompt but reject the index operation: no job is submitted.
- [ ] If you intentionally want to test downloading, accept both prompts in this disposable workspace. Otherwise choose an already downloaded model and confirm index creation.
- [ ] A submitted job appears as queued/indexing, then `ready (last check)` in the footer; closing Pi does not cancel an accepted daemon job.
- [ ] Between polls ready is labeled `(last check)`; a pending refresh replaces it with checking. A resumed/overdue session immediately expires or refreshes its old snapshot. Open panels update from the same snapshot as the footer.
- [ ] Disconnect/reconnect the disposable daemon while a panel is open, then focus the terminal. Both views recover together; an unresponsive transport cannot leave a green frame past its deadline.
- [ ] With the disposable daemon unavailable, open `/zvec` both before any successful query and after a ready snapshot. The panel must show unavailable, hide index-write actions, and allow disabling the global auto-update setting without confirmation. Reconnecting and refreshing must restore verified status, not an old ready frame.
- [ ] With automatic updates enabled, open `/zvec` or `/zvec worktrees` while a background update is still rechecking status before submission. That pending update must be skipped without disabling the preference; later polls after closing the panel may submit again. An already attempted submission cannot be cancelled.
- [ ] Start Pi through a symlink (or a Windows junction) to the disposable workspace. A canonical response root is accepted; a response for a different workspace must never enable actions.
- [ ] In a disposable Git repo and a linked worktree, the footers show their own branch/worktree names; panels show full worktree/query paths and the checkout's Git HEAD. Index operations still target the query directory, never the shared Git directory.
- [ ] Test an unborn branch, detached HEAD, a subdirectory, long CJK branch/worktree names, and a non-Git directory. Status must remain usable, and long names must wrap in the panel.
- [ ] Switch branch or commit during a status query: the result must not be labeled ready for the new context. Switch during an operation confirmation: submission must be blocked and require a new selection.
- [ ] With auto-update off, change the source file, then test incremental update, rebuild, and (optionally) model switching. Confirm each manual write operation explicitly.
- [ ] `/zvec` shows **Auto-update: off** by default. Declining its enable prompt leaves it off. Enable it with a downloaded local model and an existing index, close the panel, and change a source file: stable stale polls should submit an incremental job without further prompts. Busy jobs, active Git operations, missing/unknown caches, remote models, and absent indexes must not trigger automatic writes.
- [ ] Select **Auto-update: on** to disable it. Session switching, reload, and restart preserve the global setting, including when starting in another workspace. Other running sessions pick up a changed setting on their next refresh. A failed or uncertain automatic submission saves the global setting as off with a warning, with no automatic retry. If the settings file cannot be read or saved, automatic updates must remain stopped locally and the warning must explain the failure. Disabling cannot cancel an accepted daemon job.
- [ ] If a local model cache becomes missing, updating/rebuilding with the existing model requires separate download consent too. In a disposable cache, mutate a file without changing its size: it must become `Cache unknown`, not downloaded. Do not alter your real model cache for this test.
- [ ] Open a menu or confirmation dialog, then switch session or reload. The old dialog must not submit an operation; the new session must remain usable.
- [ ] Test **80×24 and 40×24**, not only narrow widths in a tall terminal. Every selected action must remain visible; ←/→ must reveal all details without moving the selected action. Repeat with extra host widgets and in both regular/fullscreen modes.
- [ ] Try resize, theme switching, arrow-key navigation, Enter, and Esc. A cancelled menu must restore the editor's focus.
- [ ] With invalid MCP credentials or an unavailable daemon, the footer shows unavailable and notifications do not expose credentials or raw server errors.
- [ ] After a submission timeout, refresh status before retrying. A timeout does not prove that the daemon rejected the job.

The reproducible native-daemon load, process-kill, and real Pi PTY results are recorded in [environment verification](environment-verification.md). The regular-file/64 KiB I/O limits and FIFO race tests run in `npm run check`; the FIFO child is force-bounded to avoid stranding the test runner if this protection regresses. Coverage enforces 90% lines, 90% branches, and 85% functions.

Run `npm run test:environments` on a POSIX host with the sibling backend built and installed dependencies. This does not establish Windows/UNC, network filesystem, literal disk-full, or power-loss behavior.

Record Node, Pi, OS, zvec-grep version, and cache configuration with the results. Once Pi has exited, verify the temporary path before cleaning up the disposable workspace/index. Do not remove a shared model cache.
