import assert from "node:assert/strict";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openPanel } from "../lib/panel.ts";
import { readSnapshot, readStatus } from "../lib/status.ts";
import { cacheFixture, mockServer, setEnv } from "./helpers.ts";

for (const read of [readStatus, readSnapshot]) {
  for (const root of ["/different-project", "relative/project", "", undefined, 42, "/workspace\0"]) {
    test(`${read.name} rejects response root ${JSON.stringify(root)}`, async (t) => {
      const { env, calls } = await mockServer(t, { result: { content: [], structuredContent: {
        root, indexed: true, status: "ready",
      } } });
      await assert.rejects(read("/workspace", AbortSignal.timeout(3000), env), /root|different workspace|null bytes/);
      assert.ok(calls.some((call) => call.method === "DELETE"), "rejected responses still clean up the MCP session");
    });
  }

  test(`${read.name} accepts normalized roots even when no directory exists`, async (t) => {
    const { home } = await cacheFixture(t);
    const root = join(home, "not-created");
    const { env } = await mockServer(t, { result: { content: [], structuredContent: {
      root: root + "/../not-created/", indexed: false,
    } } });
    const result = await read(root, AbortSignal.timeout(3000), env);
    assert.equal(typeof result === "string" ? result : result.text, "zvec: no index");
  });

  test(`${read.name} accepts a symlink or Windows junction to the requested root`, async (t) => {
    const { home } = await cacheFixture(t);
    const target = join(home, "workspace");
    const alias = join(home, "alias");
    await mkdir(target);
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    const { env } = await mockServer(t, { result: { content: [], structuredContent: {
      root: await realpath(target), indexed: true, status: "ready",
    } } });
    const result = await read(alias, AbortSignal.timeout(3000), env);
    assert.equal(typeof result === "string" ? result : result.text, "zvec: ready");
  });

  test(`${read.name} accepts Windows path casing`, { skip: process.platform !== "win32" }, async (t) => {
    const { home } = await cacheFixture(t);
    const { env } = await mockServer(t, { result: { content: [], structuredContent: {
      root: home.toUpperCase(), indexed: true, status: "ready",
    } } });
    const result = await read(home, AbortSignal.timeout(3000), env);
    assert.equal(typeof result === "string" ? result : result.text, "zvec: ready");
  });
}

test("a mismatched workspace cannot open the action menu or submit an index job", async (t) => {
  const { env, calls } = await mockServer(t, { result: { content: [], structuredContent: {
    root: "/different-project", indexed: true, status: "ready",
  } } });
  setEnv(t, { ...env, ZVEC_GREP_SERVER_TOKEN_FILE: undefined });
  const notifications: string[] = [];
  await openPanel({ cwd: "/workspace", ui: {
    custom: () => assert.fail("must reject the response before opening actions"),
    notify: (message: string) => notifications.push(message),
  } } as unknown as ExtensionContext, AbortSignal.timeout(3000));
  assert.equal(notifications.length, 1);
  assert.equal(calls.filter((call) => call.message?.params?.name === "zvec_grep_index").length, 0);
});
