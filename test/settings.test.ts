import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { readAutoUpdateSetting, writeAutoUpdateSetting } from "../lib/settings.ts";
import { cacheFixture } from "./helpers.ts";

const signal = () => AbortSignal.timeout(2000);

test("global auto-update defaults off without creating a config, and persists both switch values", async (t) => {
  const { home } = await cacheFixture(t);
  const path = join(home, "agent", "zvec-status.json");
  assert.equal(await readAutoUpdateSetting(path, signal()), false);
  assert.deepEqual(await readdir(home), []);
  for (const enabled of [true, false]) {
    await writeAutoUpdateSetting(path, enabled, signal());
    assert.equal(await readAutoUpdateSetting(path, signal()), enabled);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { autoUpdate: enabled });
    assert.deepEqual(await readdir(join(home, "agent")), ["zvec-status.json"]);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

for (const content of ["{invalid", "null", "[]", "{}", '{"autoUpdate":"true"}', " ".repeat(65537)]) {
  test(`invalid global settings never authorize automatic writes (${content.slice(0, 30).trim() || "oversized"})`, async (t) => {
    const { home } = await cacheFixture(t);
    const path = join(home, "zvec-status.json");
    await writeFile(path, content);
    await assert.rejects(readAutoUpdateSetting(path, signal()));
    assert.equal(await readFile(path, "utf8"), content);
  });
}

test("cancelled saves preserve the existing global setting and failed renames clean up temporary files", async (t) => {
  const { home } = await cacheFixture(t);
  const path = join(home, "zvec-status.json");
  await writeAutoUpdateSetting(path, true, signal());
  await assert.rejects(writeAutoUpdateSetting(path, false, AbortSignal.abort()), { name: "AbortError" });
  await assert.rejects(readAutoUpdateSetting(path, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(await readAutoUpdateSetting(path, signal()), true);
  const directory = join(home, "directory");
  await mkdir(directory);
  await assert.rejects(writeAutoUpdateSetting(directory, false, signal()));
  assert.deepEqual((await readdir(home)).sort(), ["directory", "zvec-status.json"]);
});
