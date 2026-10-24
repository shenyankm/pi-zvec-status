import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { deferred, mockServer, setEnv } from "./helpers.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "UI update timed out");
    await delay(5);
  }
}

test(
  "open panel, footer, focus refresh and disconnect recovery share one live snapshot",
  { timeout: 10000 },
  async (t) => {
    let state = "ready";
    const { env, calls } = await mockServer(t, () => ({
      result:
        state === "offline"
          ? { isError: true, content: [] }
          : {
              content: [],
              structuredContent: {
                root: "/workspace",
                indexed: true,
                status: state,
                runtime: { job_state: state === "indexing" ? "running" : "succeeded" },
              },
            },
    }));
    setEnv(t, { ...env, ZVEC_GREP_SERVER_TOKEN_FILE: undefined });
    const handlers = new Map<string, (event: object, ctx: ExtensionContext) => Promise<void>>();
    let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
    extension({
      on: (name: string, fn: (event: object, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, fn),
      registerCommand: (_name: string, value: { handler: typeof command }) => {
        command = value.handler;
      },
    } as unknown as ExtensionAPI);
    let input!: (data: string) => void;
    let detached = false;
    let footer = "";
    let menu: { render: (width: number) => string[] } | undefined;
    let renders = 0;
    const close = deferred<string | undefined>();
    const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
    const ctx = {
      mode: "tui",
      cwd: "/workspace",
      ui: {
        theme,
        onTerminalInput: (fn: typeof input) => {
          input = fn;
          return () => {
            detached = true;
          };
        },
        setStatus: (_key: string, value: string) => {
          footer = value ?? "";
        },
        notify: () => assert.fail("no dialog errors expected"),
        custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
          menu = await factory(
            {
              requestRender: () => {
                renders++;
              },
              terminal: { rows: 44 },
            } as never,
            theme as never,
            {} as never,
            (value) => {
              assert.ok(value === undefined || typeof value === "string");
              close.resolve(value);
            },
          );
          return close.promise;
        },
      },
    } as unknown as ExtensionContext;
    const continuations = process.listenerCount("SIGCONT");
    const stdinListeners = process.stdin.listenerCount("data");
    t.after(async () => {
      close.resolve("Close");
      await handlers.get("session_shutdown")!({}, ctx);
    });
    await handlers.get("session_start")!({}, ctx);
    const opened = command("", ctx);
    await until(() => !!menu);
    assert.equal(calls.filter((call) => call.message?.params?.name === "zvec_grep_index_status").length, 1);
    assert.match(menu!.render(100).join("\n"), /Checked:/);
    state = "indexing";
    input("\x1b[I");
    await until(() => footer.includes("indexing"));
    assert.match(menu!.render(100).join("\n"), /indexing/);
    assert.doesNotMatch(menu!.render(100).join("\n"), /Rebuild index|Update index/);
    state = "offline";
    input("\x1b[I");
    await until(() => footer.includes("unavailable"));
    assert.match(menu!.render(100).join("\n"), /unavailable/);
    state = "ready";
    process.emit("SIGCONT");
    await until(() => footer.includes("ready"));
    assert.match(menu!.render(100).join("\n"), /Rebuild index/);
    assert.ok(renders >= 4);
    close.resolve("Close");
    await opened;
    assert.equal(calls.filter((call) => call.message?.params?.name === "zvec_grep_index").length, 0);
    await handlers.get("session_shutdown")!({}, ctx);
    assert.equal(detached, true);
    assert.equal(process.listenerCount("SIGCONT"), continuations);
    assert.equal(process.stdin.listenerCount("data"), stdinListeners);
  },
);
