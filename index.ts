import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMonitor } from "./lib/monitor.ts";
import { formatStatus } from "./lib/display.ts";
import { readSnapshot } from "./lib/status.ts";
import type { GitContext } from "./lib/git.ts";
import { openPanel } from "./lib/panel.ts";

export default function (pi: ExtensionAPI) {
  let monitor: ReturnType<typeof createMonitor> | undefined;
  let session: AbortController | undefined;
  let panelSession: AbortController | undefined;

  pi.on("session_start", async (_event, ctx) => {
    session?.abort();
    session = undefined;
    const previous = monitor;
    monitor = undefined;
    await previous?.stop();
    if (ctx.mode !== "tui") return;
    session = new AbortController();
    let displayed: string | undefined;
    let git: GitContext | undefined;
    const render = (text: string) => {
      const formatted = formatStatus(text, ctx.ui.theme, git);
      if (formatted === displayed) return;
      ctx.ui.setStatus("zvec-status", formatted);
      displayed = formatted;
    };
    render("zvec: checking");
    monitor = createMonitor({
      read: async (signal) => {
        git = undefined;
        const snapshot = await readSnapshot(ctx.cwd, signal);
        git = snapshot.git;
        return snapshot.text;
      },
      render,
    });
    void monitor.refresh();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    session?.abort();
    session = undefined;
    const previous = monitor;
    monitor = undefined;
    await previous?.stop();
    if (ctx.mode === "tui") ctx.ui.setStatus("zvec-status", undefined);
  });

  pi.registerCommand("zvec", {
    description: "View index status, create, update, switch models, or rebuild",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !session || !monitor) {
        ctx.ui.notify("zvec requires an interactive Pi session.", "info");
        return;
      }
      if (panelSession === session) return;
      const currentSession = session;
      panelSession = currentSession;
      const current = monitor;
      try {
        await openPanel(ctx, currentSession.signal);
        if (monitor === current) await current.refresh();
      } finally {
        if (panelSession === currentSession) panelSession = undefined;
      }
    },
  });
}
