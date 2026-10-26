import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile, truncate, stat, chmod, readFile, open, utimes } from "node:fs/promises";
import { join } from "node:path";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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

test("single-model checks avoid touching unrelated model caches and still validate mutations", async (t) => {
  const { home, cache } = await fixture(t);
  const { directory, snapshot } = await cachedSnapshot(cache, potion);
  const paths: string[] = [];
  const originalStat = fs.stat;
  t.mock.method(fs, "stat", async (path: Parameters<typeof stat>[0]) => {
    paths.push(String(path));
    return originalStat(path);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const choices = await localModelChoices({}, home, AbortSignal.timeout(2000), potion);
  assert.deepEqual(
    choices.map((choice) => [choice.model, choice.status]),
    [[potion, "Downloaded"]],
  );
  assert.equal(paths.length, 5, "only the global config, two model markers, and two artifact files need path stats");
  await utimes(join(directory, snapshot.files[0][0]), new Date(), new Date(Date.now() + 2000));
  assert.equal((await localModelChoices({}, home, AbortSignal.timeout(2000), potion))[0].status, "Cache unknown");
  assert.deepEqual(await localModelChoices({}, home, AbortSignal.timeout(2000), "local/unknown"), []);
});

test("complete GGUF, Model2Vec, and ModelScope snapshots are downloaded and sorted first", async (t) => {
  const { home, cache } = await fixture(t);
  await cachedSnapshot(cache, qwen);
  await cachedSnapshot(cache, potion);
  await cachedSnapshot(cache, e5, 1);
  const choices = await localModelChoices({}, home);
  assert.deepEqual(
    choices.slice(0, 3).map((choice) => [choice.model, choice.status]),
    [
      [qwen, "Downloaded"],
      [potion, "Downloaded"],
      [e5, "Downloaded"],
    ],
  );
  assert.ok(choices.slice(3).every((choice) => choice.status === "Not downloaded"));
});

test("completion records use backend artifact keys rather than renamed cache paths", async (t) => {
  const { home, cache } = await fixture(t);
  for (const [model, source, expected] of [
    [qwen, 0, ["Qwen3-Embedding-0.6B-Q8_0.gguf"]],
    ["local/embeddinggemma-300m", 0, ["embeddinggemma-300M-Q8_0.gguf"]],
    [potion, 0, ["model.safetensors", "tokenizer.json"]],
    [potion, 1, ["model.safetensors", "tokenizer.json"]],
  ] as const) {
    const { marker, snapshot } = await cachedSnapshot(cache, model, source);
    const data = JSON.parse(await readFile(marker, "utf8"));
    assert.deepEqual(Object.keys(data.files).sort(), [...expected].sort());
    assert.equal((await localModelChoices({}, home)).find((choice) => choice.model === model)?.status, "Downloaded");
    const renamed = snapshot.files.find(([path, , artifact = path]) => path !== artifact)!;
    const [localPath, , artifact] = renamed;
    data.files[localPath] = data.files[artifact!];
    delete data.files[artifact!];
    await writeFile(marker, JSON.stringify(data));
    assert.equal((await localModelChoices({}, home)).find((choice) => choice.model === model)?.status, "Cache unknown");
  }
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
  const corrupt = (await localModelChoices({}, home)).find((choice) => choice.model === potion)!;
  assert.equal(corrupt.status, "Cache unknown");
  await confirmModelDownload(
    {
      confirm: async (_title, message) => {
        assert.match(message, /could not be verified/);
        assert.doesNotMatch(message, /This model is not downloaded/);
        return false;
      },
    },
    corrupt,
    AbortSignal.timeout(2000),
  );
  await writeFile(marker, JSON.stringify({ version: 1, fingerprint: "wrong" }));
  assert.equal((await localModelChoices({}, home)).find((choice) => choice.model === potion)?.status, "Not downloaded");
});

test("same-size mutations invalidate downloaded state and require download consent again", async (t) => {
  const { home, cache } = await fixture(t);
  const { snapshot, directory } = await cachedSnapshot(cache, potion);
  const file = join(directory, snapshot.files[0][0]);
  const handle = await open(file, "r+");
  try {
    await handle.write(Buffer.from([1]), 0, 1, 0);
  } finally {
    await handle.close();
  }
  await utimes(file, new Date(), new Date(Date.now() + 2000));
  assert.equal((await stat(file)).size, snapshot.files[0][1]);
  const choice = (await localModelChoices({}, home)).find((choice) => choice.model === potion)!;
  assert.equal(choice.status, "Cache unknown");
  let prompts = 0;
  assert.equal(
    await confirmModelDownload(
      {
        confirm: async () => {
          prompts++;
          return false;
        },
      },
      choice,
      new AbortController().signal,
    ),
    false,
  );
  assert.equal(prompts, 1);
});

test("missing or malformed per-file completion metadata never qualifies as downloaded", async (t) => {
  const { home, cache } = await fixture(t);
  const { marker, snapshot } = await cachedSnapshot(cache, potion);
  const valid = JSON.parse(await readFile(marker, "utf8"));
  const path = snapshot.files[0][0];
  for (const files of [undefined, null, [], {}, { [path]: { ...valid.files[path], ctimeMs: -1 } }]) {
    await writeFile(marker, JSON.stringify({ ...valid, files }));
    assert.equal(
      (await localModelChoices({}, home)).find((choice) => choice.model === potion)?.status,
      "Cache unknown",
    );
  }
});

test("oversized configuration and marker files are unknown; cancellation propagates", async (t) => {
  const { home, cache } = await fixture(t);
  const { marker } = await cachedSnapshot(cache, potion);
  await writeFile(marker, "x".repeat(65537));
  assert.equal((await localModelChoices({}, home)).find((choice) => choice.model === potion)?.status, "Cache unknown");
  await mkdir(join(home, ".zvec-grep"), { recursive: true });
  await writeFile(join(home, ".zvec-grep", "config.json"), "x".repeat(65537));
  assert.ok((await localModelChoices({}, home)).every((choice) => choice.status === "Cache unknown"));
  await assert.rejects(localModelChoices({}, home, AbortSignal.abort()), { name: "AbortError" });
});

test(
  "permission errors are unknown, not incorrectly labeled as an empty cache",
  {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  },
  async (t) => {
    const { home, cache } = await fixture(t);
    const { marker } = await cachedSnapshot(cache, potion);
    await chmod(marker, 0);
    try {
      assert.equal(
        (await localModelChoices({}, home)).find((choice) => choice.model === potion)?.status,
        "Cache unknown",
      );
    } finally {
      await chmod(marker, 0o600);
    }
  },
);

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
  for (const modelCacheDir of [cache, ` ${cache} `, `${cache}\n`]) {
    await writeFile(join(home, ".zvec-grep", "config.json"), JSON.stringify({ defaults: { modelCacheDir } }));
    const choices = await localModelChoices({ ZVEC_GREP_MODEL_CACHE: join(home, "empty") }, home);
    assert.equal(choices[0].model, e5);
    assert.equal(choices[0].status, "Downloaded");
  }
});

for (const status of ["Not downloaded", "Cache unknown"] as const) {
  for (const accepted of [true, false]) {
    test(`${status} requires explicit download consent (${accepted})`, async () => {
      let prompts = 0;
      const allowed = await confirmModelDownload(
        {
          confirm: async (title, message, options) => {
            prompts++;
            assert.equal(title, "Download model?");
            assert.match(message, /Model: local\/qwen3-embedding-0.6b/);
            assert.match(message, /Hugging Face or ModelScope/);
            assert.match(message, /only start after you also confirm the index operation/);
            assert.ok(options?.signal);
            return accepted;
          },
        },
        { model: qwen, status },
        new AbortController().signal,
      );
      assert.equal(prompts, 1);
      assert.equal(allowed, accepted);
    });
  }
}

test("downloaded models skip download consent; aborted sessions never proceed", async () => {
  const ui = { confirm: async () => assert.fail("unexpected confirmation") };
  assert.equal(
    await confirmModelDownload(ui, { model: qwen, status: "Downloaded" }, new AbortController().signal),
    true,
  );
  assert.equal(await confirmModelDownload(ui, { model: qwen, status: "Not downloaded" }, AbortSignal.abort()), false);
  const controller = new AbortController();
  assert.equal(
    await confirmModelDownload(
      {
        confirm: async () => {
          controller.abort();
          return true;
        },
      },
      { model: qwen, status: "Cache unknown" },
      controller.signal,
    ),
    false,
  );
});

test("invalid cache configuration is unknown, not incorrectly labeled as not downloaded", async (t) => {
  const { home, cache } = await fixture(t);
  await cachedSnapshot(cache, potion);
  const config = join(home, ".zvec-grep", "config.json");
  for (const value of [
    "{invalid",
    "null",
    "[]",
    JSON.stringify({ defaults: { modelCacheDir: 123 } }),
    JSON.stringify({ defaults: { modelCacheDir: " \n" } }),
    ...[null, [], "invalid"].map((defaults) => JSON.stringify({ defaults })),
  ]) {
    await writeFile(config, value);
    assert.ok((await localModelChoices({}, home)).every((choice) => choice.status === "Cache unknown"));
  }
});
