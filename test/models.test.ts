import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile, truncate, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { confirmModelDownload, localModelChoices } from "../lib/models.ts";
import { modelSnapshots } from "../lib/model-cache-data.ts";

import { cacheFixture as fixture, cachedSnapshot } from "./helpers.ts";

const qwen = "local/qwen3-embedding-0.6b";
const potion = "local/potion-code-16m-v2";
const e5 = "local/multilingual-e5-small";

test("missing cache lists every model as not downloaded without creating it", async (t) => {
  const { home, cache } = await fixture(t);
  const choices = await localModelChoices({}, home);
  assert.equal(choices.length, 11);
  await assert.rejects(stat(cache), { code: "ENOENT" });
  assert.ok(choices.every((choice) => choice.status === "Not downloaded"));
  assert.ok(choices.every((choice) => choice.label.endsWith(choice.model)));
});

test("complete GGUF, Model2Vec, and ModelScope snapshots are downloaded and sorted first", async (t) => {
  const { home, cache } = await fixture(t);
  await cachedSnapshot(cache, qwen);
  await cachedSnapshot(cache, potion);
  await cachedSnapshot(cache, e5, 1);
  const choices = await localModelChoices({}, home);
  assert.deepEqual(choices.slice(0, 3).map((choice) => [choice.model, choice.status]),
    [[qwen, "Downloaded"], [potion, "Downloaded"], [e5, "Downloaded"]]);
  assert.ok(choices.slice(3).every((choice) => choice.status === "Not downloaded"));
});

test("empty directories, incomplete files, and malformed completion markers do not count as downloaded", async (t) => {
  const { home, cache } = await fixture(t);
  await mkdir(join(cache, modelSnapshots[potion][0].directory), { recursive: true });
  assert.equal((await localModelChoices({}, home)).find((choice) => choice.model === potion)?.status, "Not downloaded");
  const { snapshot, directory, marker } = await cachedSnapshot(cache, potion);
  await truncate(join(directory, snapshot.files[0][0]), 0);
  assert.equal((await localModelChoices({}, home)).find((choice) => choice.model === potion)?.status, "Not downloaded");
  await cachedSnapshot(cache, potion);
  await writeFile(marker, "{invalid");
  assert.equal((await localModelChoices({}, home)).find((choice) => choice.model === potion)?.status, "Not downloaded");
  await writeFile(marker, JSON.stringify({ version: 1, fingerprint: "wrong" }));
  assert.equal((await localModelChoices({}, home)).find((choice) => choice.model === potion)?.status, "Not downloaded");
});

test("permission errors are unknown, not incorrectly labeled as an empty cache", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (t) => {
  const { home, cache } = await fixture(t);
  const { marker } = await cachedSnapshot(cache, potion);
  await chmod(marker, 0);
  try {
    assert.equal((await localModelChoices({}, home)).find((choice) => choice.model === potion)?.status, "Cache unknown");
  } finally {
    await chmod(marker, 0o600);
  }
});

test("environment cache and home overrides are respected", async (t) => {
  const { home } = await fixture(t);
  const cache = join(home, "custom-models");
  await cachedSnapshot(cache, qwen);
  assert.equal((await localModelChoices({ ZVEC_GREP_MODEL_CACHE: cache }, home))[0].status, "Downloaded");
  const serviceHome = join(home, "custom-service-home");
  await cachedSnapshot(join(serviceHome, "models"), potion);
  assert.equal((await localModelChoices({ ZVEC_GREP_HOME: serviceHome }, home))[0].model, potion);
});

test("global cache configuration takes precedence over the environment, matching zvec-grep", async (t) => {
  const { home } = await fixture(t);
  const cache = join(home, "configured-cache");
  await cachedSnapshot(cache, e5);
  await mkdir(join(home, ".zvec-grep"), { recursive: true });
  await writeFile(join(home, ".zvec-grep", "config.json"), JSON.stringify({ defaults: { modelCacheDir: cache } }));
  const choices = await localModelChoices({ ZVEC_GREP_MODEL_CACHE: join(home, "empty") }, home);
  assert.equal(choices[0].model, e5);
  assert.equal(choices[0].status, "Downloaded");
});

for (const status of ["Not downloaded", "Cache unknown"] as const) {
  for (const accepted of [true, false]) {
    test(`${status} requires explicit download consent (${accepted})`, async () => {
      let prompts = 0;
      const allowed = await confirmModelDownload({ confirm: async (title, message, options) => {
        prompts++;
        assert.equal(title, "Download model?");
        assert.match(message, /Model: local\/qwen3-embedding-0.6b/);
        assert.match(message, /Hugging Face or ModelScope/);
        assert.match(message, /only start after you also confirm the index operation/);
        assert.ok(options?.signal);
        return accepted;
      } }, { model: qwen, status }, new AbortController().signal);
      assert.equal(prompts, 1);
      assert.equal(allowed, accepted);
    });
  }
}

test("downloaded models skip download consent; aborted sessions never proceed", async () => {
  const ui = { confirm: async () => assert.fail("unexpected confirmation") };
  assert.equal(await confirmModelDownload(ui, { model: qwen, status: "Downloaded" }, new AbortController().signal), true);
  assert.equal(await confirmModelDownload(ui, { model: qwen, status: "Not downloaded" }, AbortSignal.abort()), false);
  const controller = new AbortController();
  assert.equal(await confirmModelDownload({ confirm: async () => {
    controller.abort();
    return true;
  } }, { model: qwen, status: "Cache unknown" }, controller.signal), false);
});

test("invalid cache configuration is unknown, not incorrectly labeled as not downloaded", async (t) => {
  const { home } = await fixture(t);
  await mkdir(join(home, ".zvec-grep"), { recursive: true });
  const config = join(home, ".zvec-grep", "config.json");
  for (const value of ["{invalid", "null", JSON.stringify({ defaults: { modelCacheDir: 123 } })]) {
    await writeFile(config, value);
    assert.ok((await localModelChoices({}, home)).every((choice) => choice.status === "Cache unknown"));
  }
});
