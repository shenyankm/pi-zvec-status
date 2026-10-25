import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, ScrollView, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Snapshot as FullSnapshot, StatusSource } from "./status.ts";

type Snapshot = Pick<FullSnapshot, "text" | "details" | "busy"> & Partial<Pick<FullSnapshot, "indexed" | "git">>;

export function indexActions(snapshot: Snapshot, autoUpdate?: boolean) {
  const actions =
    snapshot.busy ||
    snapshot.git?.operation ||
    ["zvec: unknown", "zvec: checking", "zvec: status expired", "zvec: unavailable"].includes(snapshot.text)
      ? ["Refresh status", "Worktree overview", "Close"]
      : snapshot.indexed
        ? [
            "Refresh status",
            "Worktree overview",
            "Update index (incremental)",
            "Switch model and rebuild",
            "Rebuild index",
            "Close",
          ]
        : ["Refresh status", "Worktree overview", "Create index", "Close"];
  if (autoUpdate !== undefined) actions.splice(-1, 0, `Auto-update: ${autoUpdate ? "on" : "off"}`);
  return actions;
}

export function createIndexMenu(
  snapshot: Snapshot,
  options: string[],
  theme: Theme,
  done: (value: string | undefined) => void,
  maxHeight = () => Infinity,
) {
  let visible = options.length;
  function makeList(values: string[]) {
    const list = new SelectList(
      values.map((value) => ({ value, label: value })),
      visible,
      {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    );
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);
    return list;
  }
  let list = makeList(options);
  let selected: string | undefined;

  let layout: { width: number; header: string[]; actions: string; footer: string[] } | undefined;
  const details = new ScrollView({
    render: () => layout?.header ?? [],
    invalidate: () => {
      layout = undefined;
    },
  });

  function renderLayout(width: number, inner: number) {
    const [project, , model, files, path, ...git] = snapshot.details.split("\n");
    const status = snapshot.text.replace(/^zvec: /, "");
    const color = status.startsWith("ready")
      ? "success"
      : status === "failed"
        ? "error"
        : snapshot.busy
          ? "accent"
          : "warning";
    const row = (line: string, secondary = false) => {
      const split = line.indexOf(": ");
      return (
        theme.fg("muted", line.slice(0, split + 1).padEnd(12)) +
        theme.fg(secondary ? "dim" : "text", line.slice(split + 2))
      );
    };
    const text = [
      theme.bold(theme.fg("accent", "zvec")) + theme.fg("muted", "  Index Manager"),
      theme.fg("dim", "─".repeat(inner)),
      "",
      theme.fg("muted", theme.bold("Overview")),
      theme.fg(color, `${status.startsWith("ready") ? "●" : "○"} ${status}`),
      theme.fg("muted", files),
      "",
      theme.fg("muted", theme.bold("Workspace")),
      row(project, true),
      row(model),
      row(path, true),
      ...git.map((line) => row(line, line.startsWith("Worktree: "))),
    ].flatMap((line) => (line ? new Text(line, 0, 0).render(inner) : [""]));
    const fit = (line: string) => truncateToWidth(` ${line}`, Math.max(0, width));
    return {
      width,
      header: text.map(fit),
      actions: fit(theme.fg("muted", theme.bold("Actions"))),
      footer: ["", ...new Text(theme.fg("dim", "←→ details · ↑↓ actions · enter · esc"), 0, 0).render(inner)].map(fit),
    };
  }

  return {
    render(width: number) {
      const inner = Math.max(1, Math.min(width - 2, 100));
      if (!layout || layout.width !== width) layout = renderLayout(width, inner);
      const height = Math.max(1, Math.floor(maxHeight()));
      const count = Math.max(1, Math.min(options.length, height - layout.footer.length - 2));
      if (visible !== count) {
        const current = list.getSelectedItem()?.value;
        visible = count;
        list = makeList(options);
        list.setSelectedIndex(Math.max(0, options.indexOf(current ?? "")));
      }
      const items = list.render(inner).map((line) => truncateToWidth(` ${line}`, Math.max(0, width)));
      const actions = [layout.actions, ...items, ...layout.footer];
      const tail = actions.length <= height ? actions : items.slice(0, height);
      const viewport = Math.max(0, height - tail.length);
      details.updateLayout(layout.header.length, viewport, () => {});
      return [...details.render(width).slice(details.scrollTop, details.scrollTop + viewport), ...tail];
    },
    update(next: Snapshot, values: string[]) {
      snapshot = next;
      layout = undefined;
      if (values.join("\0") !== options.join("\0")) {
        selected ??= list.getSelectedItem()?.value;
        options = values;
        list = makeList(values);
        list.setSelectedIndex(Math.max(0, values.indexOf(selected ?? "")));
      }
    },
    invalidate() {
      details.invalidate();
      list.invalidate();
    },
    handleInput(data: string) {
      const page = Math.max(1, details.viewportHeight - 1);
      if (matchesKey(data, Key.left)) details.scrollBy(-page);
      else if (matchesKey(data, Key.right)) details.scrollBy(page);
      else {
        list.handleInput(data);
        selected = list.getSelectedItem()?.value;
      }
    },
  };
}

export async function showIndexMenu(
  ctx: ExtensionContext,
  snapshot: Snapshot,
  options: string[],
  signal: AbortSignal,
  source?: StatusSource,
) {
  if (signal.aborted) return;
  let onAbort: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    return await ctx.ui.custom<string | undefined>(
      (tui, theme, _keys, done) => {
        const menu = createIndexMenu(snapshot, options, theme, done, () => Math.max(1, (tui.terminal?.rows ?? 24) - 8));
        unsubscribe = source?.subscribe((next) => {
          menu.update(next, indexActions(next, source?.autoUpdate?.enabled));
          tui.requestRender();
        });
        onAbort = () => done(undefined);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        return {
          ...menu,
          handleInput(data: string) {
            menu.handleInput(data);
            tui.requestRender();
          },
        };
      },
      { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } },
    );
  } finally {
    unsubscribe?.();
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
