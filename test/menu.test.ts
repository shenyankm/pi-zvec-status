import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createIndexMenu, showIndexMenu, indexActions } from "../lib/menu.ts";

const snapshot = {
  text: "zvec: ready · 11 files",
  busy: false,
  details: [
    `Project: /workspace/${"项目".repeat(30)}`,
    "Status: ready · 11 files",
    "Model: local/qwen3-embedding-0.6b",
    "Files: 11 · Pending: 0 · Failed: 0",
    `Index path: /workspace/${"nested/".repeat(20)}index.zvec`,
    "Branch: feature/login",
    "HEAD: 123456789abc",
    `Worktree: /workspace/${"工作树".repeat(30)}`,
  ].join("\n"),
};
const options = ["Refresh status", "Rebuild index", "Close"];
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

test("menu separates status, workspace details, and actions without overflowing", () => {
  const menu = createIndexMenu(snapshot, options, theme, () => {});
  const lines = menu.render(100);
  const output = lines.join("\n");
  assert.match(output, /zvec  Index Manager/);
  assert.match(output, /Overview *\n.*● ready · 11 files/);
  assert.ok(output.indexOf("Overview") < output.indexOf("Workspace"));
  assert.ok(output.indexOf("Workspace") < output.indexOf("Actions"));
  assert.match(output, /Model: {6}local\/qwen3-embedding-0.6b/);
  assert.match(output, /Branch: *feature\/login/);
  assert.match(output, /HEAD: *123456789abc/);
  assert.match(output, /Worktree:/);
  for (const width of [0, 1, 2, 12, 40, 80, 120]) {
    for (const line of menu.render(width)) assert.ok(visibleWidth(line) <= width, `overflow at width ${width}`);
  }
});

test("menu preserves selection, keyboard navigation, and escape cancellation", () => {
  const selected: (string | undefined)[] = [];
  const menu = createIndexMenu(snapshot, options, theme, (value) => selected.push(value));
  menu.handleInput("\x1b[B");
  menu.invalidate();
  menu.render(40);
  menu.handleInput("\r");
  menu.handleInput("\x1b");
  assert.deepEqual(selected, ["Rebuild index", undefined]);
});

test("menu reuses static layout while keeping selection live and rebuilding on resize", () => {
  let colors = 0;
  const counted = {
    ...theme,
    fg: (_color: string, text: string) => {
      colors++;
      return text;
    },
  } as Theme;
  const menu = createIndexMenu(snapshot, options, counted, () => {});
  const first = menu.render(100);
  colors = 0;
  assert.deepEqual(menu.render(100), first);
  const redrawColors = colors;
  menu.handleInput("\x1b[B");
  colors = 0;
  const selected = menu.render(100);
  assert.notDeepEqual(selected, first);
  assert.equal(colors, redrawColors, "navigation must not recolor static layout");

  for (const width of [100, 40, 40, 0, 1, 120, 100]) {
    const fresh = createIndexMenu(snapshot, options, theme, () => {});
    fresh.handleInput("\x1b[B");
    const expected = fresh.render(width);
    assert.deepEqual(menu.render(width), expected);
    assert.deepEqual(menu.render(width), expected);
  }
});

test("menu recomputes theme colors after invalidation", () => {
  const calls: [string, string][] = [];
  let prefix = "";
  const colored = {
    ...theme,
    fg: (color: string, text: string) => {
      calls.push([color, text]);
      return prefix + text;
    },
  } as Theme;
  const menu = createIndexMenu(snapshot, options, colored, () => {});
  const before = menu.render(100);
  assert.ok(calls.some(([color, text]) => color === "success" && text.includes("ready")));
  assert.ok(calls.some(([color, text]) => color === "dim" && text.includes("/workspace/")));
  calls.length = 0;
  prefix = "new-theme:";
  menu.invalidate();
  assert.notDeepEqual(menu.render(100), before);
  assert.ok(calls.some(([color, text]) => color === "success" && text.includes("ready")));
});

test("24-row terminals retain every selected action while long details scroll separately", () => {
  const full = { ...snapshot, indexed: true, details: snapshot.details + "\nChecked: 2026-10-25T00:00:00.000Z" };
  const actions = indexActions(full);
  for (const width of [40, 80]) {
    let selected: string | undefined;
    const menu = createIndexMenu(
      full,
      actions,
      theme,
      (value) => {
        selected = value;
      },
      () => 16,
    );
    for (let index = 0; index < actions.length; index++) {
      const lines = menu.render(width);
      assert.ok(lines.length <= 16);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(
        lines.some((line) => line.includes(`→ ${actions[index]}`)),
        `hidden selection: ${actions[index]}`,
      );
      if (index < actions.length - 1) menu.handleInput("\x1b[B");
    }
    menu.handleInput("\r");
    assert.equal(selected, "Close");
    for (let page = 0; page < 50; page++) menu.handleInput("\x1b[C");
    const bottom = menu.render(width).join("\n");
    assert.match(bottom, /Checked:/);
    assert.ok(bottom.includes("→ Close"));
    menu.handleInput("\x1b[D");
    assert.notEqual(menu.render(width).join("\n"), bottom);
  }
});

test("height changes and temporary read-only frames preserve the selected action", () => {
  const full = { ...snapshot, indexed: true };
  const actions = indexActions(full);
  let height = 16;
  const menu = createIndexMenu(
    full,
    actions,
    theme,
    () => {},
    () => height,
  );
  for (let step = 0; step < 4; step++) menu.handleInput("\x1b[B");
  for (const rows of [16, 6, 1, 16]) {
    height = rows;
    const lines = menu.render(40);
    assert.ok(lines.length <= rows);
    assert.ok(lines.some((line) => line.includes("→ Rebuild index")));
  }
  const busy = { ...full, busy: true, text: "zvec: indexing" };
  menu.update(busy, indexActions(busy));
  assert.doesNotMatch(menu.render(40).join("\n"), /Rebuild index/);
  menu.update(full, actions);
  assert.match(menu.render(40).join("\n"), /→ Rebuild index/);
});

test("session abort closes a custom menu and pre-aborted sessions do not open it", async () => {
  const controller = new AbortController();
  let opened = 0;
  const ctx = {
    ui: {
      custom: (
        factory: Parameters<ExtensionContext["ui"]["custom"]>[0],
        options: Parameters<ExtensionContext["ui"]["custom"]>[1],
      ) =>
        new Promise((resolve) => {
          opened++;
          assert.equal(options?.overlay, true);
          void factory({} as Parameters<typeof factory>[0], theme, {} as Parameters<typeof factory>[2], resolve);
          controller.abort();
        }),
    },
  } as unknown as ExtensionContext;
  assert.equal(await showIndexMenu(ctx, snapshot, options, controller.signal), undefined);
  await showIndexMenu(ctx, snapshot, options, controller.signal);
  assert.equal(opened, 1);
});
