import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { indexWorkspace, readSnapshot, type StatusSource } from "./status.ts";
import { confirmModelDownload, localModelChoices } from "./models.ts";
import { sameGit } from "./git.ts";
import { showWorktreeOverview } from "./worktrees.ts";

export async function openPanel(ctx: ExtensionContext, signal: AbortSignal, source?: StatusSource) {
  const deadline = () => AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const read = () => (source ? source.read() : readSnapshot(ctx.cwd, deadline()));
  try {
    while (!signal.aborted) {
      let snapshot = await read();
      const { showIndexMenu, indexActions } = await import("./menu.ts");
      const action = await showIndexMenu(
        ctx,
        snapshot,
        indexActions(snapshot, source?.autoUpdate?.enabled),
        signal,
        source,
      );
      if (!action || action === "Close" || signal.aborted) return;
      if (action === "Refresh status") continue;
      if (action.startsWith("Auto-update: ") && source?.autoUpdate) {
        const setting = source.autoUpdate;
        if (action === "Auto-update: on") await setting.setEnabled(false);
        else if (
          await ctx.ui.confirm(
            "Enable automatic index updates?",
            "Enable automatic updates globally for all Pi workspaces, including future sessions and restarts. Each session only updates its own existing stale index using downloaded local models. This uses CPU, memory and disk. No automatic creation, rebuild, model download or remote embedding. Errors disable auto-update globally to avoid duplicate submissions.",
            { signal },
          )
        ) {
          if (!signal.aborted) await setting.setEnabled(true);
        }
        continue;
      }
      if (action === "Worktree overview") {
        await showWorktreeOverview(ctx, signal);
        continue;
      }
      if (source) snapshot = await read();
      if (!indexActions(snapshot).includes(action)) continue;
      let embedding: string | undefined;
      if (
        action === "Create index" ||
        action === "Switch model and rebuild" ||
        (action === "Rebuild index" && snapshot.text === "zvec: rebuild required" && !snapshot.model)
      ) {
        const choices = await localModelChoices(process.env, undefined, deadline());
        if (signal.aborted) return;
        const selected = await ctx.ui.select(
          "Local embedding models (uncached models download on use)",
          choices.map((choice) => choice.label),
          { signal },
        );
        const choice = choices.find((choice) => choice.label === selected);
        if (!choice || signal.aborted) continue;
        embedding = choice.model;
      }
      const rebuild = action === "Rebuild index" || action === "Switch model and rebuild";
      const model = embedding ?? snapshot.model;
      if (!model) {
        ctx.ui.notify("Cannot determine the embedding model. Refresh status before retrying.", "warning");
        continue;
      }
      let downloadAllowed = false;
      if (model.startsWith("local/")) {
        const choices = await localModelChoices(process.env, undefined, deadline(), model);
        const choice = choices.find((choice) => choice.model === model) ?? { model, status: "Cache unknown" as const };
        if (!(await confirmModelDownload(ctx.ui, choice, signal))) continue;
        downloadAllowed = choice.status !== "Downloaded";
      }
      const confirmed = await ctx.ui.confirm(
        action,
        [
          snapshot.details,
          `Model: ${model}`,
          rebuild
            ? "Rebuild this project's index. Search may be unavailable during rebuilding. Project source files will not be modified."
            : "Scan this project and create or update its index in the background.",
          !model.startsWith("local/")
            ? "Warning: remote models send project content to the provider. Existing remote embedding authorization is required; this plugin will not grant it."
            : "Local models may use significant memory and compute resources.",
        ].join("\n"),
        { signal },
      );
      if (!confirmed || signal.aborted) continue;
      // Another client may have started a job while the confirmation was open.
      const latest = await read();
      if (
        !indexActions(latest).includes(action) ||
        latest.model !== snapshot.model ||
        latest.indexed !== snapshot.indexed ||
        !sameGit(snapshot.git, latest.git)
      ) {
        ctx.ui.notify("Index or Git state has changed. Refresh and select the operation again.", "warning");
        continue;
      }
      if (model.startsWith("local/") && !downloadAllowed) {
        const choice = (await localModelChoices(process.env, undefined, deadline(), model)).find(
          (choice) => choice.model === model,
        );
        if (choice?.status !== "Downloaded") {
          ctx.ui.notify("Model cache has changed. Select the operation again to review download consent.", "warning");
          continue;
        }
      }
      signal.throwIfAborted();
      const state = await indexWorkspace(
        ctx.cwd,
        {
          ...(rebuild ? { rebuild: true } : {}),
          ...(embedding ? { embedding } : {}),
        },
        deadline(),
      );
      if (!signal.aborted)
        ctx.ui.notify(`Index request submitted: ${state}. Use /zvec to check the latest status.`, "info");
      return;
    }
  } catch {
    if (!signal.aborted)
      ctx.ui.notify(
        "Cannot read status or submit the index operation. Check the daemon, MCP URL/token, and --mcp-toolset full. If you just submitted an operation, refresh status before retrying to avoid duplicate submissions.",
        "warning",
      );
  }
}
