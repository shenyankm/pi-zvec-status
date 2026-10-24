import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, open, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { MAX_METADATA_BYTES, readMetadata } from "../lib/metadata.ts";
import { modelSnapshots } from "../lib/model-cache-data.ts";
import { cacheFixture } from "./helpers.ts";

const exec = promisify(execFile);

test("metadata reads regular UTF-8 files and existing symlinks", async (t) => {
  const { home } = await cacheFixture(t);
  const file = join(home, "metadata");
  await writeFile(file, "中文 token\n");
  assert.equal(await readMetadata(file, AbortSignal.timeout(2000)), "中文 token\n");
  if (process.platform !== "win32") {
    const alias = join(home, "alias");
    await symlink(file, alias);
    assert.equal(await readMetadata(alias, AbortSignal.timeout(2000)), "中文 token\n");
  }
});

test("metadata accepts the byte limit and rejects oversized sparse files", async (t) => {
  const { home } = await cacheFixture(t);
  const file = join(home, "metadata");
  await writeFile(file, "x".repeat(MAX_METADATA_BYTES));
  assert.equal((await readMetadata(file, AbortSignal.timeout(2000))).length, MAX_METADATA_BYTES);
  const handle = await open(file, "r+");
  try {
    await handle.truncate(MAX_METADATA_BYTES * 1024);
  } finally {
    await handle.close();
  }
  await assert.rejects(readMetadata(file, AbortSignal.timeout(2000)), /64 KiB limit/);
  assert.equal((await stat(file)).size, MAX_METADATA_BYTES * 1024);
});

test("metadata rejects directories, preserves missing-file errors, and honors cancellation", async (t) => {
  const { home } = await cacheFixture(t);
  await assert.rejects(readMetadata(home, AbortSignal.timeout(2000)), /regular file/);
  await assert.rejects(readMetadata(join(home, "missing"), AbortSignal.timeout(2000)), { code: "ENOENT" });
  await assert.rejects(readMetadata(home, AbortSignal.abort()), { name: "AbortError" });
  const file = join(home, "metadata");
  await writeFile(file, "data");
  const controller = new AbortController();
  const pending = readMetadata(file, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test(
  "FIFO token/config/markers cannot occupy the I/O pool or prevent child exit",
  {
    skip: process.platform === "win32",
    timeout: 10000,
  },
  async (t) => {
    const { home } = await cacheFixture(t);
    const token = join(home, "token");
    const configHome = join(home, "blocked-config");
    const config = join(configHome, ".zvec-grep", "config.json");
    const cache = join(home, "models");
    const model = "local/potion-code-16m-v2";
    const snapshot = modelSnapshots[model][0];
    const markerDirectory = join(cache, snapshot.directory);
    await mkdir(join(configHome, ".zvec-grep"), { recursive: true });
    await mkdir(markerDirectory, { recursive: true });
    const marker = join(markerDirectory, `.zvec-grep-artifacts-${snapshot.fingerprint}.complete`);
    const race = join(home, "replaced-token");
    const replacement = join(home, "replacement-fifo");
    await writeFile(race, "regular token");
    await exec("mkfifo", [token, config, marker, replacement]);
    const code = `
    import assert from 'node:assert/strict';
    import fs, {stat} from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    import {readMetadata} from ${JSON.stringify(new URL("../lib/metadata.ts", import.meta.url).href)};
    import {readStatus} from ${JSON.stringify(new URL("../lib/status.ts", import.meta.url).href)};
    import {localModelChoices} from ${JSON.stringify(new URL("../lib/models.ts", import.meta.url).href)};
    await Promise.all(Array.from({length: 4}, () => assert.rejects(readStatus('/workspace', AbortSignal.timeout(1000), {
      ZVEC_GREP_SERVER_URL: 'http://127.0.0.1:9/mcp', ZVEC_GREP_SERVER_TOKEN_FILE: ${JSON.stringify(token)}
    }), /regular file/)));
    const originalStat = fs.stat;
    let swapped = false;
    fs.stat = async (...args) => {
      const info = await originalStat(...args);
      if (args[0] === ${JSON.stringify(race)} && !swapped) {
        swapped = true;
        await fs.rename(${JSON.stringify(replacement)}, ${JSON.stringify(race)});
      }
      return info;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(readMetadata(${JSON.stringify(race)}, AbortSignal.timeout(1000)), /regular file/);
      assert.equal(swapped, true);
    } finally { fs.stat = originalStat; syncBuiltinESMExports(); }
    const config = await localModelChoices({}, ${JSON.stringify(configHome)});
    assert.ok(config.every(choice => choice.status === 'Cache unknown'));
    const markers = await localModelChoices({ZVEC_GREP_MODEL_CACHE: ${JSON.stringify(cache)}}, ${JSON.stringify(home)});
    assert.equal(markers.find(choice => choice.model === ${JSON.stringify(model)}).status, 'Cache unknown');
    assert.ok((await stat(process.execPath)).isFile());
    console.log('I/O pool usable; no blocked reader remains');
  `;
    const result = await exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], {
      timeout: 5000,
      killSignal: "SIGKILL",
      env: { ...process.env, UV_THREADPOOL_SIZE: "4" },
    });
    assert.match(result.stdout, /I\/O pool usable/);
  },
);
