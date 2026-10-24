import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createIndexMenu, showIndexMenu } from "../lib/menu.ts";

const snapshot = {
  text: "zvec: ready · 11 files",
  busy: false,
  details: [
    `Project: /workspace/${"项目".repeat(30)}`,
    "Status: ready · 11 files",
    "Model: local/qwen3-embedding-0.6b",
    "Files: 11 · Pending: 0 · Failed: 0",
    `Index path: /workspace/${"nested/".repeat(20)}index.zvec`,
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

test("menu recomputes theme colors after invalidation", () => {
  const calls: [string, string][] = [];
  const colored = { ...theme, fg: (color: string, text: string) => { calls.push([color, text]); return text; } } as Theme;
  const menu = createIndexMenu(snapshot, options, colored, () => {});
  menu.render(100);
  assert.ok(calls.some(([color, text]) => color === "success" && text.includes("ready")));
  assert.ok(calls.some(([color, text]) => color === "dim" && text.includes("/workspace/")));
  calls.length = 0;
  menu.invalidate();
  menu.render(100);
  assert.ok(calls.some(([color, text]) => color === "success" && text.includes("ready")));
});

test("session abort closes a custom menu and pre-aborted sessions do not open it", async () => {
  const controller = new AbortController();
  let opened = 0;
  const ctx = { ui: {
    custom: (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => new Promise((resolve) => {
      opened++;
      void factory({} as Parameters<typeof factory>[0], theme, {} as Parameters<typeof factory>[2], resolve);
      controller.abort();
    }),
  } } as unknown as ExtensionContext;
  assert.equal(await showIndexMenu(ctx, snapshot, options, controller.signal), undefined);
  await showIndexMenu(ctx, snapshot, options, controller.signal);
  assert.equal(opened, 1);
});
