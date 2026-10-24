import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export function formatStatus(text: string, theme: Pick<Theme, "fg">) {
  const state = text.replace(/^zvec: /, "");
  let icon = "○";
  let color: ThemeColor = "muted";
  let detail = state;

  if (state === "ready" || state.startsWith("ready · ")) {
    icon = "●";
    color = "success";
    detail = "ready";
  } else if (/^(checking|indexing|queued)( |$)/.test(state)) {
    icon = "◌";
    color = "accent";
  } else if (state === "failed") {
    icon = "✕";
    color = "error";
  } else if (["stale", "rebuild required", "unavailable", "cancelled"].includes(state)) {
    icon = "!";
    color = "warning";
  }

  const label = theme.fg(color, icon) + " " + theme.fg("muted", "zvec");
  return label + theme.fg("dim", " · ") + theme.fg(color, detail);
}
