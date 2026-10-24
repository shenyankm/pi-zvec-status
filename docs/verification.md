# Manual daemon and TUI verification

Automated tests use an isolated model-cache directory and a local mock MCP server. They do not download models or rebuild a real index. The Pi loader smoke test uses the installed host to discover the package and load its TypeScript entry.

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
- [ ] Start Pi through a symlink (or a Windows junction) to the disposable workspace. A canonical response root is accepted; a response for a different workspace must never enable actions.
- [ ] In a disposable Git repo and a linked worktree, the footers show their own branch/worktree names; panels show full worktree/query paths and the checkout's Git HEAD. Index operations still target the query directory, never the shared Git directory.
- [ ] Test an unborn branch, detached HEAD, a subdirectory, long CJK branch/worktree names, and a non-Git directory. Status must remain usable, and long names must wrap in the panel.
- [ ] Switch branch or commit during a status query: the result must not be labeled ready for the new context. Switch during an operation confirmation: submission must be blocked and require a new selection.
- [ ] Change the source file, then test incremental update, rebuild, and (optionally) model switching. Confirm each write operation explicitly.
- [ ] If a local model cache becomes missing, updating/rebuilding with the existing model requires separate download consent too. Do not delete your real model cache just for this test; use a disposable daemon/cache if testing this case live.
- [ ] Open a menu or confirmation dialog, then switch session or reload. The old dialog must not submit an operation; the new session must remain usable.
- [ ] Try narrow/wide terminal widths, resize, theme switching, arrow-key navigation, Enter, and Esc. Test both regular and fullscreen terminal modes if used.
- [ ] With invalid MCP credentials or an unavailable daemon, the footer shows unavailable and notifications do not expose credentials or raw server errors.
- [ ] After a submission timeout, refresh status before retrying. A timeout does not prove that the daemon rejected the job.

The reproducible native-daemon load, process-kill, and real Pi PTY results are recorded in [environment verification](environment-verification.md). Run `npm run test:environments` on a POSIX host with the sibling backend built and installed dependencies. This does not establish Windows/UNC, network filesystem, literal disk-full, or power-loss behavior.

Record Node, Pi, OS, zvec-grep version, and cache configuration with the results. Once Pi has exited, verify the temporary path before cleaning up the disposable workspace/index. Do not remove a shared model cache.
