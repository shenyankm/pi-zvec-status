import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMonitor } from "./lib/monitor.ts";
import { formatStatus } from "./lib/display.ts";
import { readSnapshot, type Snapshot, type StatusSource } from "./lib/status.ts";
import { openPanel } from "./lib/panel.ts";
import { showWorktreeOverview } from "./lib/worktrees.ts";

export default function (pi: ExtensionAPI) {
  let monitor: ReturnType<typeof createMonitor> | undefined;
  let source: StatusSource | undefined;
  let session: AbortController | undefined;
  let panelSession: AbortController | undefined;
  let unsubscribeInput: (() => void) | undefined;
  let onContinue: (() => void) | undefined;
  let onFocus: ((data: string | Buffer) => void) | undefined;

  async function stop() {
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
  }

  pi.on("session_start", async (_event, ctx) => {
    await stop();
    if (ctx.mode !== "tui") return;
    const currentSession = session = new AbortController();
    let displayed: string | undefined;
    let latest: Snapshot | undefined;
    let view: Snapshot | undefined;
    const listeners = new Set<(snapshot: Snapshot) => void>();
    const render = (text: string) => {
      const base = latest ?? view;
      if (base) {
        view = { ...base, text, details: base.details.split("\n")
          .filter((line) => !line.startsWith("Checked: "))
          .map((line) => line.startsWith("Status: ") ? `Status: ${text.replace(/^zvec: /, "")}` : line)
          .concat(`Checked: ${new Date(base.checkedAt).toISOString()}`).join("\n") };
        for (const listener of listeners) listener(view);
      }
      const formatted = formatStatus(text, ctx.ui.theme, text === "zvec: unavailable" ? undefined : view?.git);
      if (formatted === displayed) return;
      ctx.ui.setStatus("zvec-status", formatted);
      displayed = formatted;
    };
    render("zvec: checking");
    const current = monitor = createMonitor({
      read: async (signal) => {
        latest = undefined;
        const snapshot = await readSnapshot(ctx.cwd, signal);
        signal.throwIfAborted();
        latest = snapshot;
        return snapshot.text;
      },
      render,
    });
    source = {
      read: async () => {
        const result = await current.refresh();
        currentSession.signal.throwIfAborted();
        if (!result?.text || !view) throw new Error("Status is unavailable.");
        return view;
      },
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
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
    onContinue = () => { void current.refresh(); };
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
        ctx.ui.notify("Use /zvec or /zvec worktrees.", "info"); return;
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
