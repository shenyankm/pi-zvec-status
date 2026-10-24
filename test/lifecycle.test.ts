import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { deferred, isolateModelCache, mockServer, setEnv } from "./helpers.ts";

type Handler = (event: Record<string, never>, ctx: ExtensionContext) => Promise<void>;

function harness() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  extension({
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => {};
    },
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI);
  return {
    start: (ctx: ExtensionContext) => handlers.get("session_start")!({}, ctx),
    stop: (ctx: ExtensionContext) => handlers.get("session_shutdown")!({}, ctx),
    open: (ctx: ExtensionContext) => commands.get("zvec")!.handler("", ctx),
  };
}

const snapshot = {
  root: "/workspace",
  indexed: true,
  status: "ready",
  persistent: { workspace_index: { embedding: { provider: "local", model: "qwen3-embedding-0.6b" } } },
};
const plainUI = { theme: { fg: (_color: string, text: string) => text }, setStatus() {}, notify() {} };

for (const mode of ["session switch", "reload"] as const) {
  test(
    `${mode}: a late model selection cannot submit or unlock the new session's menu`,
    { timeout: 5000 },
    async (t) => {
      await isolateModelCache(t);
      const { calls, env } = await mockServer(t, { result: { content: [], structuredContent: snapshot } });
      setEnv(t, { ...env, ZVEC_GREP_SERVER_TOKEN_FILE: undefined });
      const old = harness();
      const current = mode === "reload" ? harness() : old;
      const selecting = deferred<void>();
      const oldSelection = deferred<string | undefined>();
      const currentMenu = deferred<string | undefined>();
      const currentOpened = deferred<void>();
      let staleLabel: string | undefined;
      let currentMenus = 0;
      let staleConfirmations = 0;
      const oldCtx = {
        mode: "tui",
        cwd: "/workspace",
        ui: {
          ...plainUI,
          custom: async () => "Switch model and rebuild",
          select: async (_title: string, labels: string[]) => {
            staleLabel = labels.find((label) => label.endsWith("local/potion-code-16m-v2"));
            selecting.resolve();
            return oldSelection.promise;
          },
          confirm: async () => {
            staleConfirmations++;
            return true;
          },
        },
      } as unknown as ExtensionContext;
      const currentCtx = {
        mode: "tui",
        cwd: "/workspace",
        ui: {
          ...plainUI,
          custom: async () => {
            currentMenus++;
            currentOpened.resolve();
            return currentMenu.promise;
          },
        },
      } as unknown as ExtensionContext;
      t.after(async () => {
        oldSelection.resolve(undefined);
        currentMenu.resolve(undefined);
        await old.stop(oldCtx);
        if (current !== old) await current.stop(currentCtx);
      });
      await old.start(oldCtx);
      const staleCommand = old.open(oldCtx);
      await selecting.promise;
      await old.stop(oldCtx);
      await current.start(currentCtx);
      const activeCommand = current.open(currentCtx);
      await currentOpened.promise;
      oldSelection.resolve(staleLabel);
      await staleCommand;
      await current.open(currentCtx);
      assert.equal(currentMenus, 1, "old completion must not clear the new session's menu guard");
      assert.equal(staleConfirmations, 0);
      assert.equal(calls.filter((call) => call.message?.params?.name === "zvec_grep_index").length, 0);
      currentMenu.resolve("Close");
      await activeCommand;
    },
  );
}

test("repeated commands open only one menu per session", { timeout: 5000 }, async (t) => {
  const { env } = await mockServer(t, { result: { content: [], structuredContent: snapshot } });
  setEnv(t, { ...env, ZVEC_GREP_SERVER_TOKEN_FILE: undefined });
  const app = harness();
  const entered = deferred<void>();
  const close = deferred<string | undefined>();
  let menus = 0;
  const ctx = {
    mode: "tui",
    cwd: "/workspace",
    ui: {
      ...plainUI,
      custom: async () => {
        menus++;
        entered.resolve();
        return close.promise;
      },
    },
  } as unknown as ExtensionContext;
  t.after(async () => {
    close.resolve(undefined);
    await app.stop(ctx);
  });
  await app.start(ctx);
  const first = app.open(ctx);
  await entered.promise;
  await Promise.all([app.open(ctx), app.open(ctx)]);
  assert.equal(menus, 1);
  close.resolve("Close");
  await first;
});
