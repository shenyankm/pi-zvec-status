import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readAutoUpdateSetting, writeAutoUpdateSetting } from "./lib/settings.ts";
import { createMonitor } from "./lib/monitor.ts";
import { formatStatus } from "./lib/display.ts";
import { readSnapshot, type Snapshot, type StatusSource } from "./lib/status.ts";
import { openPanel } from "./lib/panel.ts";
import { showWorktreeOverview } from "./lib/worktrees.ts";
import { createAutoUpdater } from "./lib/auto-update.ts";

export default function (pi: ExtensionAPI) {
  let lifecycle = 0;
  let monitor: ReturnType<typeof createMonitor> | undefined;
  let source: StatusSource | undefined;
  let session: AbortController | undefined;
  let panelSession: AbortController | undefined;
  let unsubscribeInput: (() => void) | undefined;
  let onContinue: (() => void) | undefined;
  let onFocus: ((data: string | Buffer) => void) | undefined;

  async function stop() {
    const generation = ++lifecycle;
    session?.abort();
    session = undefined;
    source = undefined;
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    if (onContinue) process.removeListener("SIGCONT", onContinue);
    onContinue = undefined;
    if (onFocus) process.stdin.removeListener("data", onFocus);
    onFocus = undefined;
    const previous = monitor;
    monitor = undefined;
    await previous?.stop();
    return generation;
  }

  pi.on("session_start", async (_event, ctx) => {
    const generation = await stop();
    if (generation !== lifecycle || ctx.mode !== "tui") return;
    const currentSession = (session = new AbortController());
    const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
    if (currentSession.signal.aborted) return;
    const settingsPath = join(getAgentDir(), "zvec-status.json");
    let autoUpdateFailed = false;
    let settingsFailed = false;
    const autoUpdate = createAutoUpdater(ctx.cwd, async () => {
      autoUpdateFailed = true;
      let saved = true;
      try {
        await writeAutoUpdateSetting(settingsPath, false, AbortSignal.timeout(5000));
      } catch {
        saved = false;
      }
      autoUpdateFailed = !saved;
      if (!currentSession.signal.aborted)
        ctx.ui.notify(
          saved
            ? "Auto-update disabled globally after an error. Refresh /zvec before enabling it again; an index request may already have been accepted."
            : "Auto-update stopped for this session, but the global setting could not be saved. Disable it in other sessions and fix config permissions before restarting; an index request may already have been accepted.",
          "warning",
        );
    });
    let displayed: string | undefined;
    let latest: Snapshot | undefined;
    let view: Snapshot | undefined;
    const listeners = new Set<(snapshot: Snapshot) => void>();
    const render = (text: string) => {
      const base = latest ?? view;
      if (base) {
        view = {
          ...base,
          text,
          details: base.details
            .split("\n")
            .filter((line) => !line.startsWith("Checked: "))
            .map((line) => (line.startsWith("Status: ") ? `Status: ${text.replace(/^zvec: /, "")}` : line))
            .concat(`Checked: ${new Date(base.checkedAt).toISOString()}`)
            .join("\n"),
        };
        for (const listener of listeners) listener(view);
      }
      const formatted = formatStatus(text, ctx.ui.theme, text === "zvec: unavailable" ? undefined : view?.git);
      if (formatted === displayed) return;
      ctx.ui.setStatus("zvec-status", formatted);
      displayed = formatted;
    };
    render("zvec: checking");
    const current = (monitor = createMonitor({
      read: async (signal) => {
        latest = undefined;
        let enabled = false;
        try {
          enabled = await readAutoUpdateSetting(settingsPath, signal);
          settingsFailed = false;
        } catch {
          signal.throwIfAborted();
          if (!settingsFailed)
            ctx.ui.notify(
              "Cannot read global auto-update settings. Automatic updates are disabled until the config is readable and valid.",
              "warning",
            );
          settingsFailed = true;
        }
        enabled &&= !autoUpdateFailed;
        if (enabled !== autoUpdate.enabled) autoUpdate.setEnabled(enabled);
        let snapshot = await readSnapshot(ctx.cwd, signal);
        if (panelSession !== currentSession && (await autoUpdate.update(snapshot, signal)))
          snapshot = await readSnapshot(ctx.cwd, signal);
        signal.throwIfAborted();
        latest = snapshot;
        return snapshot.text;
      },
      render,
    }));
    source = {
      autoUpdate: {
        get enabled() {
          return autoUpdate.enabled;
        },
        setEnabled: async (enabled) => {
          if (!enabled) autoUpdate.setEnabled(false);
          try {
            await writeAutoUpdateSetting(settingsPath, enabled, currentSession.signal);
            currentSession.signal.throwIfAborted();
            autoUpdateFailed = false;
            autoUpdate.setEnabled(enabled);
          } catch {
            autoUpdateFailed = true;
            autoUpdate.setEnabled(false);
            if (!currentSession.signal.aborted)
              ctx.ui.notify(
                "Cannot save global auto-update settings. No automatic updates will run in this session; other sessions may still use the previous saved setting.",
                "warning",
              );
          }
        },
      },
      read: async () => {
        const result = await current.refresh();
        currentSession.signal.throwIfAborted();
        if (!result?.text || !view) throw new Error("Status is unavailable.");
        return view;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    unsubscribeInput = ctx.ui.onTerminalInput?.((data) => {
      if (data === "\x1b[I") void current.refresh();
      else current.wake();
    });
    // Fullscreen hosts can consume focus reports before UI input hooks.
    let focusPrefix = "";
    onFocus = (data) => {
      const text = focusPrefix + data.toString();
      focusPrefix = text.endsWith("\x1b[") ? "\x1b[" : text.endsWith("\x1b") ? "\x1b" : "";
      if (text.includes("\x1b[I")) void current.refresh();
    };
    if (process.stdin.isTTY) process.stdin.on("data", onFocus);
    onContinue = () => {
      void current.refresh();
    };
    process.on("SIGCONT", onContinue);
    void current.refresh();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await stop();
    if (ctx.mode === "tui") ctx.ui.setStatus("zvec-status", undefined);
  });

  pi.registerCommand("zvec", {
    description: "Manage the current index; /zvec worktrees shows a read-only overview",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !session || !monitor || !source) {
        ctx.ui.notify("zvec requires an interactive Pi session.", "info");
        return;
      }
      if (args.trim() && args.trim() !== "worktrees") {
        ctx.ui.notify("Use /zvec or /zvec worktrees.", "info");
        return;
      }
      if (panelSession === session) return;
      const currentSession = session;
      panelSession = currentSession;
      const current = monitor;
      try {
        if (args.trim() === "worktrees") await showWorktreeOverview(ctx, currentSession.signal);
        else await openPanel(ctx, currentSession.signal, source);
        if (monitor === current) await current.refresh();
      } finally {
        if (panelSession === currentSession) panelSession = undefined;
      }
    },
  });
}
