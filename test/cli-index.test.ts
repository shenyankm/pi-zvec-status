import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runCliIndex } from "../lib/cli-index.ts";
import { isolateModelCache } from "./helpers.ts";

for (const scenario of [
  "success",
  "selection cancelled",
  "download declined",
  "operation declined",
  "aborted",
  "failure",
  "missing CLI",
] as const) {
  test(`CLI indexing: ${scenario}`, async (t) => {
    const { home } = await isolateModelCache(t);
    const controller = new AbortController();
    const calls: unknown[][] = [];
    const confirmations: string[] = [];
    const notices: string[] = [];
    const ctx = {
      cwd: home,
      ui: {
        select: async (_title: string, labels: string[]) =>
          scenario === "selection cancelled"
            ? undefined
            : labels.find((label) => label.endsWith("local/potion-code-16m-v2")),
        confirm: async (title: string) => {
          confirmations.push(title);
          if (scenario === "aborted") controller.abort();
          return (
            !(scenario === "download declined" && title === "Download model?") &&
            !(scenario === "operation declined" && title === "Run zg index?")
          );
        },
        notify: (message: string) => notices.push(message),
      },
    } as unknown as ExtensionContext;
    const pi = {
      exec: async (...args: unknown[]) => {
        calls.push(args);
        if (scenario === "missing CLI") throw new Error("ENOENT");
        return {
          code: scenario === "failure" ? 1 : 0,
          killed: false,
          stdout: "",
          stderr: "\x1b[31mmodel failed\x1b[0m",
        };
      },
    } as unknown as Pick<ExtensionAPI, "exec">;
    await runCliIndex(pi, ctx, controller.signal);
    if (["selection cancelled", "download declined", "operation declined", "aborted"].includes(scenario)) {
      assert.equal(calls.length, 0);
      return;
    }
    assert.deepEqual(confirmations, ["Download model?", "Run zg index?"]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      "zg",
      ["index", home, "--mode", "auto", "--embedding", "local/potion-code-16m-v2"],
      { cwd: home, signal: controller.signal },
    ]);
    assert.match(notices.at(-1)!, scenario === "success" ? /completed/ : /before retrying/);
    assert.ok(!notices.at(-1)!.includes("\x1b"));
  });
}

test("CLI indexing never prompts or spawns after session shutdown", async () => {
  const controller = new AbortController();
  controller.abort();
  await runCliIndex({} as Pick<ExtensionAPI, "exec">, {} as ExtensionContext, controller.signal);
});
