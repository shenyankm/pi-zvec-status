import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { GitContext } from "./git.ts";

export function formatStatus(text: string, theme: Pick<Theme, "fg">, git?: GitContext) {
  const state = text.replace(/^zvec: /, "");
  let icon = "○";
  let color: ThemeColor = "muted";
  let detail = state;

  if (state === "ready" || state.startsWith("ready · ")) {
    icon = "●";
    color = "success";
    detail = "ready (last check)";
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
  const compact = (value: string) => truncateToWidth(value.replace(/[\x00-\x1f\x7f-\x9f]/g, ""), 20, "…");
  const context = git
    ? theme.fg("dim", " · ") + theme.fg("muted",
      `${compact(git.branch ?? `detached@${git.head?.slice(0, 7)}`)} @ ${compact(basename(git.root))}`)
    : "";
  return label + context + theme.fg("dim", " · ") + theme.fg(color, detail);
}
