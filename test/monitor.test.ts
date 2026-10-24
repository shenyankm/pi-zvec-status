import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { createMonitor } from "../lib/monitor.ts";
import { formatStatus } from "../lib/display.ts";
import { setTimeout as delay } from "node:timers/promises";

function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("coalesces concurrent refreshes and discards late results on shutdown", async () => {
  const wait = deferred();
  const rendered: string[] = [];
  let calls = 0;
  let signal!: AbortSignal;
  const monitor = createMonitor({
    read: (s) => {
      calls++;
      signal = s;
      return wait.promise;
    },
    render: (text) => rendered.push(text),
  });
  const first = monitor.refresh();
  assert.equal(monitor.refresh(), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  const stopped = monitor.stop();
  assert.equal(signal.aborted, true);
  wait.resolve("zvec: ready");
  await stopped;
  assert.deepEqual(rendered, ["zvec: checking"]);
  await monitor.refresh();
  assert.equal(calls, 1);
});

test("recovers from synchronous and asynchronous errors without leaking details", async () => {
  const rendered: string[] = [];
  let calls = 0;
  const monitor = createMonitor({
    read: () => {
      calls++;
      if (calls === 1) throw new Error("secret-token");
      if (calls === 2) return Promise.reject(new Error("private-path"));
      return Promise.resolve("zvec: ready");
    },
    render: (text) => rendered.push(text),
  });
  const result = await monitor.refresh();
  assert.ok(result?.error);
  assert.match(result.error, /--mcp-toolset full/);
  await monitor.refresh();
  await monitor.refresh();
  assert.deepEqual(rendered, [
    "zvec: checking",
    "zvec: unavailable",
    "zvec: checking",
    "zvec: unavailable",
    "zvec: checking",
    "zvec: ready",
  ]);
  await monitor.stop();
});

test("polls after completion, and clears polling on stop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const monitor = createMonitor({
    read: async () => {
      calls++;
      return "ready";
    },
    render: () => {},
  });
  await monitor.refresh();
  t.mock.timers.tick(29_999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await monitor.refresh();
  assert.equal(calls, 2);
  await monitor.stop();
  t.mock.timers.tick(30_000);
  assert.equal(calls, 2);
});

test("refreshing replaces cached ready and failures remove it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  const rendered: string[] = [];
  let calls = 0;
  const monitor = createMonitor({
    read: () => {
      calls++;
      if (calls === 1) return Promise.resolve("zvec: ready");
      if (calls === 2) return pending.promise;
      throw new Error("daemon unavailable");
    },
    render: (text) => rendered.push(formatStatus(text, { fg: (_color, value) => value })),
  });
  t.after(() => monitor.stop());
  await monitor.refresh();
  t.mock.timers.tick(29_999);
  assert.equal(calls, 1);
  assert.equal(rendered.at(-1), "● zvec · ready (last check)");
  t.mock.timers.tick(1);
  const refreshing = monitor.refresh();
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(rendered.at(-1), "◌ zvec · checking");
  pending.resolve("zvec: stale");
  await refreshing;
  assert.equal(rendered.at(-1), "! zvec · stale");
  await monitor.refresh();
  assert.equal(rendered.at(-1), "! zvec · unavailable");
});

test("wall-clock expiry clears ready and recovers after an event-loop pause", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const pending = deferred();
  const rendered: string[] = [];
  let calls = 0;
  const monitor = createMonitor({
    read: async () => (++calls === 1 ? "zvec: ready" : pending.promise),
    render: (value) => rendered.push(value),
  });
  t.after(() => monitor.stop());
  await monitor.refresh();
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.ok(rendered.includes("zvec: status expired"));
  assert.equal(rendered.at(-1), "zvec: checking");
  pending.resolve("zvec: stale");
  await monitor.refresh();
  assert.equal(rendered.at(-1), "zvec: stale");
});

test("a reader ignoring cancellation cannot retain green status or block shutdown", async () => {
  const frames: string[] = [];
  const monitor = createMonitor({
    read: () => new Promise(() => {}),
    render: (text) => frames.push(text),
    timeoutMs: 15,
  });
  const [result] = await Promise.all([monitor.refresh(), delay(40)]);
  assert.ok(result?.error);
  assert.equal(frames.at(-1), "zvec: unavailable");
  await monitor.stop();
});

test("running jobs poll faster, then return to idle polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const monitor = createMonitor({
    read: async () => (++calls === 1 ? "zvec: indexing 1/2" : "zvec: ready"),
    render() {},
  });
  t.after(() => monitor.stop());
  await monitor.refresh();
  t.mock.timers.tick(1999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await monitor.refresh();
  assert.equal(calls, 2);
  t.mock.timers.tick(29_999);
  assert.equal(calls, 2);
  t.mock.timers.tick(1);
  await monitor.refresh();
  assert.equal(calls, 3);
});

test("outages back off retries and successful manual refresh resets the interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let offline = true;
  const monitor = createMonitor({
    read: async () => {
      calls++;
      if (offline) throw new Error("offline");
      return "zvec: ready";
    },
    render() {},
  });
  t.after(() => monitor.stop());
  await monitor.refresh();
  t.mock.timers.tick(30_000);
  await monitor.refresh();
  assert.equal(calls, 2);
  t.mock.timers.tick(30_000);
  assert.equal(calls, 2);
  t.mock.timers.tick(30_000);
  await monitor.refresh();
  assert.equal(calls, 3);
  offline = false;
  await monitor.refresh();
  t.mock.timers.tick(30_000);
  await monitor.refresh();
  assert.equal(calls, 5);
});

test("passes a deadline signal to the reader", async () => {
  let signal!: AbortSignal;
  const monitor = createMonitor({
    read: async (s) => {
      signal = s;
      return "ready";
    },
    render: () => {},
  });
  await monitor.refresh();
  assert.ok(signal instanceof AbortSignal);
  await monitor.stop();
  assert.equal(signal.aborted, true);
});

test("extension registration and non-TUI sessions have no background activity", async () => {
  const handlers = new Map();
  const commands = new Map();
  extension({
    on: (name: string, handler: unknown) => {
      handlers.set(name, handler);
      return () => {};
    },
    registerCommand: (name: string, command: unknown) => {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI);
  const notifications: string[] = [];
  const ctx = {
    mode: "print",
    ui: {
      setStatus: () => assert.fail("no status in print mode"),
      notify: (text: string) => notifications.push(text),
    },
  } as unknown as ExtensionContext;
  await handlers.get("session_start")({}, ctx);
  await commands.get("zvec").handler("", ctx);
  await handlers.get("session_shutdown")({}, ctx);
  assert.deepEqual(notifications, ["zvec requires an interactive Pi session."]);
});
