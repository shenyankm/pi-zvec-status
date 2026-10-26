import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { readAutoUpdateSetting, writeAutoUpdateSetting } from "../lib/settings.ts";
import { createAutoUpdater } from "../lib/auto-update.ts";
import { openPanel } from "../lib/panel.ts";
import { indexActions } from "../lib/menu.ts";
import type { Snapshot } from "../lib/status.ts";
import { deferred, isolateModelCache, mockServer, setEnv } from "./helpers.ts";

const model = "local/potion-code-16m-v2";
const snapshot: Snapshot = {
  text: "zvec: stale",
  details: "Project: /workspace\nStatus: stale\nModel: local/potion-code-16m-v2\nFiles: 1\nIndex path: /index",
  model,
  git: undefined,
  indexed: true,
  busy: false,
  checkedAt: 0,
};
const response = {
  root: "/workspace",
  indexed: true,
  status: "stale",
  persistent: { workspace_index: { embedding: { provider: "local", model: "potion-code-16m-v2" } } },
};

for (const scenario of [
  "success",
  "uncached",
  "cache unknown",
  "state changed",
  "model changed",
  "disabled during read",
  "cancelled during read",
  "rejected",
  "timeout",
] as const) {
  test(`auto-update: ${scenario}`, async (t) => {
    await isolateModelCache(t, scenario === "uncached" ? [] : [model], scenario === "cache unknown");
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const errors: string[] = [];
    const updater = createAutoUpdater("/workspace", () => errors.push("error"));
    const controller = new AbortController();
    const { env, calls } = await mockServer(t, (message) => {
      if (message.params?.name === "zvec_grep_index") {
        if (scenario === "timeout") controller.abort();
        return scenario === "rejected"
          ? { result: { isError: true, content: [] } }
          : { result: { content: [], structuredContent: { state: "queued" } } };
      }
      if (scenario === "disabled during read") updater.setEnabled(false);
      if (scenario === "cancelled during read") controller.abort();
      return {
        result: {
          content: [],
          structuredContent: {
            ...response,
            ...(scenario === "state changed" ? { status: "ready" } : {}),
            ...(scenario === "model changed" ? { persistent: {} } : {}),
          },
        },
      };
    });
    setEnv(t, { ...env, ZVEC_GREP_SERVER_TOKEN_FILE: undefined });
    assert.equal(updater.enabled, false);
    assert.equal(await updater.update(snapshot, controller.signal), false);
    assert.equal(calls.length, 0);
    updater.setEnabled(true);
    assert.equal(await updater.update(snapshot, controller.signal), false);
    now += 4999;
    assert.equal(await updater.update(snapshot, controller.signal), false);
    assert.equal(calls.length, 0, "debounce must not submit immediately");
    now++;
    assert.equal(await updater.update(snapshot, controller.signal), scenario === "success");
    const writes = () => calls.filter((call) => call.message?.params?.name === "zvec_grep_index");
    assert.equal(writes().length, ["success", "rejected", "timeout"].includes(scenario) ? 1 : 0);
    if (writes().length) assert.deepEqual(writes()[0].message?.params?.arguments, { root: "/workspace", wait: false });
    if (scenario === "success") {
      assert.equal(await updater.update(snapshot, controller.signal), false);
      now += 59_999;
      assert.equal(await updater.update(snapshot, controller.signal), false);
      assert.equal(writes().length, 1, "successful submissions have a cooldown");
    }
    if (scenario === "rejected" || scenario === "timeout") {
      assert.equal(updater.enabled, false);
      assert.equal(errors.length, 1);
      now += 120_000;
      assert.equal(await updater.update(snapshot, new AbortController().signal), false);
      assert.equal(writes().length, 1, "uncertain submissions must not retry automatically");
    } else {
      assert.deepEqual(errors, []);
      if (scenario === "cancelled during read")
        assert.equal(updater.enabled, true, "shutdown before submission must not disable the global preference");
    }
  });
}

test("auto-update skips unsafe snapshots and resets debounce on Git changes", async (t) => {
  const updater = createAutoUpdater("/workspace", () => assert.fail("no I/O expected"));
  updater.setEnabled(true);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const signal = AbortSignal.timeout(2000);
  for (const patch of [
    { indexed: false },
    { busy: true },
    { text: "zvec: ready" },
    { text: "zvec: rebuild required" },
    { text: "zvec: unknown" },
    { model: "remote/test" },
    { model: undefined },
    { git: { root: "/workspace", operation: "merge" } },
  ]) {
    assert.equal(await updater.update({ ...snapshot, ...patch }, signal), false);
    now += 10_000;
    assert.equal(await updater.update({ ...snapshot, ...patch }, signal), false);
  }
  const before = { ...snapshot, git: { root: "/workspace", branch: "main" } };
  assert.equal(await updater.update(before, signal), false);
  now += 5000;
  assert.equal(await updater.update({ ...before, git: { ...before.git, branch: "feature" } }, signal), false);
  assert.equal(await updater.update(snapshot, AbortSignal.abort()), false);
});

test("global auto-update survives reload/workspace changes and persists external or error disabling", async (t) => {
  const fixture = await isolateModelCache(t, [model]);
  const settingsPath = join(fixture.home, "pi", "zvec-status.json");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let rejectSubmission = false;
  const { calls, env } = await mockServer(t, (message) => ({
    result:
      rejectSubmission && message.params?.name === "zvec_grep_index"
        ? { isError: true, content: [] }
        : {
            content: [],
            structuredContent:
              message.params?.name === "zvec_grep_index"
                ? { state: "queued" }
                : { ...response, root: message.params?.arguments?.root },
          },
  }));
  setEnv(t, { ...env, ZVEC_GREP_SERVER_TOKEN_FILE: undefined });
  const handlers = new Map<string, (event: object, ctx: ExtensionContext) => Promise<void>>();
  let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
  const api = {
    on: (name: string, handler: (event: object, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler),
    registerCommand: (_name: string, value: { handler: typeof command }) => {
      command = value.handler;
    },
  } as unknown as ExtensionAPI;
  extension(api);
  let input!: (data: string) => void;
  let menus = 0;
  let renderedMenu = "";
  const notifications: string[] = [];
  let refreshed = deferred<void>();
  const ctx = {
    mode: "tui",
    cwd: "/workspace",
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      setStatus: (_key: string, value: string) => {
        if (value?.includes("stale")) refreshed.resolve();
      },
      notify: (message: string) => notifications.push(message),
      onTerminalInput: (handler: typeof input) => {
        input = handler;
        return () => {};
      },
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        const component = await factory(
          { requestRender() {}, terminal: { rows: 60 } } as never,
          { fg: (_color: string, value: string) => value, bold: (value: string) => value } as never,
          {} as never,
          () => {},
        );
        renderedMenu = component.render(120).join("\n");
        return menus++ === 0 ? "Auto-update: off" : "Close";
      },
      confirm: async () => true,
    },
  } as unknown as ExtensionContext;
  t.after(() => handlers.get("session_shutdown")!({}, ctx));
  await handlers.get("session_start")!({}, ctx);
  await command("", ctx);
  refreshed = deferred<void>();
  input("\x1b[I");
  await refreshed.promise;
  now += 5000;
  // An open panel pauses automatic submission even after the debounce period.
  await command("", ctx);
  const writes = () => calls.filter((call) => call.message?.params?.name === "zvec_grep_index");
  assert.equal(writes().length, 0, "panel reads must not submit automatically");
  refreshed = deferred<void>();
  input("\x1b[I");
  await refreshed.promise;
  assert.equal(writes().length, 1, "a poll outside the panel submits the debounced update");
  assert.equal(await readAutoUpdateSetting(settingsPath, AbortSignal.timeout(2000)), true);
  await handlers.get("session_shutdown")!({}, ctx);
  extension(api);
  const otherCtx = { ...ctx, cwd: "/another-workspace" };
  await handlers.get("session_start")!({}, otherCtx);
  await command("", otherCtx);
  assert.match(renderedMenu, /Auto-update: on/);
  refreshed = deferred<void>();
  input("\x1b[I");
  await refreshed.promise;
  now += 5000;
  refreshed = deferred<void>();
  input("\x1b[I");
  await refreshed.promise;
  assert.equal(writes().length, 2, "new workspaces inherit the saved global opt-in");
  assert.equal(writes()[1].message?.params?.arguments?.root, "/another-workspace");
  await writeAutoUpdateSetting(settingsPath, false, AbortSignal.timeout(2000));
  for (let poll = 0; poll < 2; poll++) {
    now += 60_000;
    refreshed = deferred<void>();
    input("\x1b[I");
    await refreshed.promise;
  }
  await command("", otherCtx);
  assert.match(renderedMenu, /Auto-update: off/);
  assert.equal(writes().length, 2, "other sessions observe changes to the shared setting on refresh");
  assert.deepEqual(notifications, []);
  await writeAutoUpdateSetting(settingsPath, true, AbortSignal.timeout(2000));
  refreshed = deferred<void>();
  input("\x1b[I");
  await refreshed.promise;
  rejectSubmission = true;
  now += 5000;
  refreshed = deferred<void>();
  input("\x1b[I");
  await refreshed.promise;
  assert.equal(writes().length, 3);
  assert.equal(await readAutoUpdateSetting(settingsPath, AbortSignal.timeout(2000)), false);
  assert.match(notifications[0], /disabled globally/);
  now += 60_000;
  refreshed = deferred<void>();
  input("\x1b[I");
  await refreshed.promise;
  assert.equal(writes().length, 3, "errors must not re-enable auto-update on the next global settings refresh");
  await writeFile(settingsPath, "{broken");
  for (let poll = 0; poll < 2; poll++) {
    now += 60_000;
    refreshed = deferred<void>();
    input("\x1b[I");
    await refreshed.promise;
  }
  assert.equal(writes().length, 3);
  assert.equal(notifications.length, 2, "invalid configuration should warn once, not on every poll");
  assert.match(notifications[1], /Cannot read global/);
  assert.equal(
    await readFile(settingsPath, "utf8"),
    "{broken",
    "invalid configuration must not be silently overwritten",
  );
});

test(
  "opening a panel during automatic revalidation pauses submission without disabling the preference",
  { timeout: 5000 },
  async (t) => {
    const fixture = await isolateModelCache(t, [model]);
    const settingsPath = join(fixture.home, "pi", "zvec-status.json");
    await writeAutoUpdateSetting(settingsPath, true, AbortSignal.timeout(2000));
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const revalidating = deferred<void>();
    const release = deferred<void>();
    let reads = 0;
    const { env, calls } = await mockServer(t, async (message) => {
      if (message.params?.name === "zvec_grep_index")
        return { result: { content: [], structuredContent: { state: "queued" } } };
      if (++reads === 3) {
        revalidating.resolve();
        await release.promise;
      }
      return { result: { content: [], structuredContent: { ...response, root: fixture.home } } };
    });
    setEnv(t, { ...env, ZVEC_GREP_SERVER_TOKEN_FILE: undefined });
    const handlers = new Map<string, (event: object, ctx: ExtensionContext) => Promise<void>>();
    let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
    extension({
      on: (name: string, handler: (event: object, ctx: ExtensionContext) => Promise<void>) =>
        handlers.set(name, handler),
      registerCommand: (_name: string, value: { handler: typeof command }) => {
        command = value.handler;
      },
    } as unknown as ExtensionAPI);
    let input!: (data: string) => void;
    let refreshed = deferred<void>();
    const ctx = {
      mode: "tui",
      cwd: fixture.home,
      ui: {
        theme: { fg: (_color: string, value: string) => value },
        setStatus: (_key: string, value: string) => {
          if (value?.includes("stale")) refreshed.resolve();
        },
        onTerminalInput: (handler: typeof input) => {
          input = handler;
          return () => {};
        },
        custom: async () => "Close",
        notify: () => assert.fail("pausing must not disable auto-update or show errors"),
      },
    } as unknown as ExtensionContext;
    t.after(async () => {
      release.resolve();
      await handlers.get("session_shutdown")!({}, ctx);
    });
    await handlers.get("session_start")!({}, ctx);
    await refreshed.promise;
    now += 5000;
    input("\x1b[I");
    await revalidating.promise;
    const opening = command("", ctx);
    release.resolve();
    await opening;
    const writes = () => calls.filter((call) => call.message?.params?.name === "zvec_grep_index");
    assert.equal(writes().length, 0, "opening during revalidation must block the pending automatic submission");
    assert.equal(await readAutoUpdateSetting(settingsPath, AbortSignal.timeout(2000)), true);
    for (let poll = 0; poll < 2; poll++) {
      now += 5000;
      refreshed = deferred<void>();
      input("\x1b[I");
      await refreshed.promise;
    }
    assert.equal(writes().length, 1, "polls after closing the panel can automatically update again");
  },
);

for (const previouslyReady of [false, true]) {
  test(
    `an unavailable daemon still allows disabling global auto-update (previously ready: ${previouslyReady})`,
    { timeout: 5000 },
    async (t) => {
      const fixture = await isolateModelCache(t);
      const settingsPath = join(fixture.home, "pi", "zvec-status.json");
      await writeAutoUpdateSetting(settingsPath, true, AbortSignal.timeout(2000));
      let unavailable = !previouslyReady;
      const { env, calls } = await mockServer(t, () =>
        unavailable
          ? { result: { isError: true, content: [] } }
          : { result: { content: [], structuredContent: { ...response, root: fixture.home, status: "ready" } } },
      );
      setEnv(t, { ...env, ZVEC_GREP_SERVER_TOKEN_FILE: undefined });
      const handlers = new Map<string, (event: object, ctx: ExtensionContext) => Promise<void>>();
      let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
      extension({
        on: (name: string, handler: (event: object, ctx: ExtensionContext) => Promise<void>) =>
          handlers.set(name, handler),
        registerCommand: (_name: string, value: { handler: typeof command }) => {
          command = value.handler;
        },
      } as unknown as ExtensionAPI);
      const ready = deferred<void>();
      const panels: string[] = [];
      const ctx = {
        mode: "tui",
        cwd: fixture.home,
        ui: {
          theme: { fg: (_color: string, value: string) => value },
          setStatus: (_key: string, value: string) => {
            if (value?.includes("ready")) ready.resolve();
          },
          custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
            const component = await factory(
              { requestRender() {}, terminal: { rows: 60 } } as never,
              { fg: (_color: string, value: string) => value, bold: (value: string) => value } as never,
              {} as never,
              () => {},
            );
            panels.push(component.render(120).join("\n"));
            if (panels.length === 1) return "Auto-update: on";
            if (panels.length === 2) {
              unavailable = false;
              return "Refresh status";
            }
            return "Close";
          },
          confirm: () => assert.fail("disabling must not require confirmation"),
          notify: () => assert.fail("an unavailable snapshot must remain usable"),
        },
      } as unknown as ExtensionContext;
      t.after(() => handlers.get("session_shutdown")!({}, ctx));
      await handlers.get("session_start")!({}, ctx);
      if (previouslyReady) {
        await ready.promise;
        unavailable = true;
      }
      await command("", ctx);
      assert.equal(panels.length, 3);
      for (const panel of panels.slice(0, 2)) {
        assert.match(panel, /unavailable/);
        assert.match(panel, /Refresh status/);
        assert.match(panel, /Worktree overview/);
        assert.doesNotMatch(panel, /● ready|Create index|Update index|Switch model|Rebuild index/);
      }
      assert.match(panels[0], /Auto-update: on/);
      assert.match(panels[1], /Auto-update: off/);
      assert.match(panels[2], /● ready/);
      assert.match(panels[2], /Auto-update: off/);
      assert.match(panels[2], /Update index \(incremental\)/);
      assert.equal(await readAutoUpdateSetting(settingsPath, AbortSignal.timeout(2000)), false);
      assert.equal(calls.filter((call) => call.message?.params?.name === "zvec_grep_index").length, 0);
    },
  );
}

for (const displayed of [false, true]) {
  test(`auto-update selection follows the displayed label despite a concurrent setting change (${displayed})`, async () => {
    let enabled = displayed;
    let confirmations = 0;
    let menus = 0;
    await openPanel({
      cwd: "/workspace",
      ui: {
        custom: async () => {
          if (menus++) return "Close";
          enabled = !displayed;
          return `Auto-update: ${displayed ? "on" : "off"}`;
        },
        confirm: async () => { confirmations++; return true; },
        notify: () => assert.fail("no index operation expected"),
      },
    } as unknown as ExtensionContext, AbortSignal.timeout(2000), {
      autoUpdate: {
        get enabled() { return enabled; },
        setEnabled(value) { enabled = value; },
      },
      read: async () => snapshot,
      subscribe: () => () => {},
    });
    assert.equal(enabled, !displayed);
    assert.equal(confirmations, displayed ? 0 : 1);
  });
}

for (const mode of ["enable", "decline", "disable", "abort"] as const) {
  test(`panel auto-update setting: ${mode}`, async () => {
    let enabled = mode === "disable";
    let menus = 0;
    let confirmations = 0;
    const controller = new AbortController();
    const setting = {
      get enabled() {
        return enabled;
      },
      setEnabled(value: boolean) {
        enabled = value;
      },
    };
    const ctx = {
      cwd: "/workspace",
      ui: {
        custom: async () => (menus++ === 0 ? `Auto-update: ${enabled ? "on" : "off"}` : "Close"),
        confirm: async () => {
          confirmations++;
          if (mode === "abort") controller.abort();
          return mode !== "decline";
        },
        notify: () => assert.fail("no index operation expected"),
      },
    } as unknown as ExtensionContext;
    await openPanel(ctx, controller.signal, {
      autoUpdate: setting,
      read: async () => snapshot,
      subscribe: () => () => {},
    });
    assert.equal(enabled, mode === "enable");
    assert.equal(confirmations, mode === "disable" ? 0 : 1);
    for (const busy of [true, false]) {
      assert.ok(indexActions({ ...snapshot, busy }, enabled).includes(`Auto-update: ${enabled ? "on" : "off"}`));
    }
  });
}
