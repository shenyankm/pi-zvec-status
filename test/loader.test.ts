import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { cacheFixture } from "./helpers.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

test("Pi loader smoke: discovers the manifest and loads TypeScript without registering tools", async (t) => {
  const { home } = await cacheFixture(t);
  const loaded = await discoverAndLoadExtensions([root], home, home);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings ?? [], []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.commands.keys()], ["zvec"]);
  assert.equal(extension.tools.size, 0);
  assert.ok(extension.handlers.has("session_start"));
  assert.ok(extension.handlers.has("session_shutdown"));
});
