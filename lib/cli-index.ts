import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { readGit, sameGit } from "./git.ts";
import { confirmModelDownload, localModelChoices } from "./models.ts";

export async function runCliIndex(pi: Pick<ExtensionAPI, "exec">, ctx: ExtensionContext, signal: AbortSignal) {
  const deadline = () => AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  try {
    signal.throwIfAborted();
    const git = await readGit(ctx.cwd, deadline());
    if (git?.operation) {
      ctx.ui.notify(git.unavailable ? "Cannot verify Git state. Retry when Git is available." : "Finish the active Git operation before indexing.", "warning");
      return;
    }
    const choices = await localModelChoices(process.env, undefined, deadline());
    const selected = await ctx.ui.select(
      "zg index: choose a local embedding model",
      choices.map((choice) => choice.label),
      { signal },
    );
    const choice = choices.find((choice) => choice.label === selected);
    if (!choice || signal.aborted) return;
    if (!(await confirmModelDownload(ctx.ui, choice, signal))) return;
    if (
      !(await ctx.ui.confirm(
        "Run zg index?",
        [
          `Project: ${ctx.cwd.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}`,
          `Model: ${choice.model}`,
          "Create or incrementally update this project's index using zg index --mode auto.",
          "The CLI uses the daemon when available, otherwise direct local indexing. It does not start the service.",
          "An existing index must use the selected model; this command never rebuilds or deletes an index.",
          "This may download model files and use significant memory, CPU and disk. Project source files are not modified.",
        ].join("\n"),
        { signal },
      )) ||
      signal.aborted
    )
      return;
    const latestGit = await readGit(ctx.cwd, deadline());
    if (!sameGit(git, latestGit)) {
      ctx.ui.notify("Git state has changed. Run /zvec index again to review the operation.", "warning");
      return;
    }
    if (choice.status === "Downloaded") {
      const latest = (await localModelChoices(process.env, undefined, deadline(), choice.model))[0];
      if (latest?.status !== "Downloaded") {
        ctx.ui.notify("Model cache has changed. Run /zvec index again to review download consent.", "warning");
        return;
      }
    }
    signal.throwIfAborted();
    ctx.ui.notify("Running zg index. This may take several minutes; session shutdown stops the CLI.", "info");
    const result = await pi.exec("zg", ["index", ctx.cwd, "--mode", "auto", "--embedding", choice.model], {
      cwd: ctx.cwd,
      signal,
    });
    if (signal.aborted) return;
    if (result.killed || result.code !== 0) {
      const detail = stripVTControlCharacters(result.stderr)
        .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
        .trim()
        .slice(-1500);
      ctx.ui.notify(
        `zg index did not complete successfully (exit ${result.code}). ${detail || "Check that zg is installed and available on PATH."} Check index status before retrying; a daemon job may still be running.`,
        "warning",
      );
    } else {
      ctx.ui.notify(
        "zg index completed. The footer will refresh; status polling still requires the MCP service.",
        "info",
      );
    }
  } catch {
    if (!signal.aborted)
      ctx.ui.notify(
        "Cannot run zg index. Check the CLI installation and local configuration. Check index status before retrying; a daemon job may still be running.",
        "warning",
      );
  }
}
