import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readWorktrees } from "./git.ts";
import { readSnapshot, readStatus } from "./status.ts";

export async function showWorktreeOverview(ctx: ExtensionContext, signal: AbortSignal) {
  try {
    let page = 0;
    while (!signal.aborted) {
      const worktrees = await readWorktrees(ctx.cwd, signal);
      page = Math.min(page, Math.max(0, Math.ceil(worktrees.length / 20) - 1));
      const visible = worktrees.slice(page * 20, (page + 1) * 20);
      const label = (index: number, status: string) => {
        const tree = visible[index];
        return `${page * 20 + index + 1}. [${status}] ${tree.branch ?? `detached@${tree.head?.slice(0, 7) ?? "?"}`} — ${tree.root}`.replace(
          /[\x00-\x1f\x7f-\x9f]/g,
          "",
        );
      };
      const labels = visible.map((_tree, index) => label(index, "not checked"));
      const pageSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, visible.length) }, async () => {
          while (next < visible.length && !pageSignal.aborted) {
            const index = next++;
            const tree = visible[index];
            let status = tree.bare ? "bare (no checkout)" : tree.prunable ? "missing / prunable" : "unavailable";
            if (!tree.bare && !tree.prunable) {
              try {
                status = (await readStatus(tree.root, pageSignal)).replace(/^zvec: /, "");
              } catch {
                signal.throwIfAborted();
              }
            }
            labels[index] = label(index, status);
          }
        }),
      );
      signal.throwIfAborted();
      while (!signal.aborted) {
        const selected = await ctx.ui.select(
          `Worktrees ${page * 20 + 1}–${page * 20 + visible.length} / ${worktrees.length} (read-only snapshot)`,
          [
            ...labels,
            ...(page > 0 ? ["Previous page"] : []),
            ...((page + 1) * 20 < worktrees.length ? ["Next page"] : []),
            "Refresh overview",
            "Close",
          ],
          { signal },
        );
        if (!selected || selected === "Close") return;
        if (selected === "Next page") {
          page++;
          break;
        }
        if (selected === "Previous page") {
          page--;
          break;
        }
        const index = labels.indexOf(selected);
        if (index < 0) break;
        const tree = visible[index];
        if (tree.bare || tree.prunable) {
          ctx.ui.notify(selected, "info");
          continue;
        }
        const snapshot = await readSnapshot(tree.root, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
        await ctx.ui.select(`Read-only worktree\n${snapshot.details}`, ["Back"], { signal });
      }
    }
  } catch {
    if (!signal.aborted)
      ctx.ui.notify(
        "Cannot read the worktree overview. Check Git, the worktree paths, and the local daemon.",
        "warning",
      );
  }
}
