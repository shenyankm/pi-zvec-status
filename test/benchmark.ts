import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localModelChoices } from "../lib/models.ts";
import { modelSnapshots } from "../lib/model-cache-data.ts";
import { cachedSnapshot, cacheFixture, mockServer } from "./helpers.ts";
import { readGit } from "../lib/git.ts";
import { readSnapshot, readStatus } from "../lib/status.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createIndexMenu } from "../lib/menu.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const options = ["Refresh status", "Rebuild index", "Close"];
const snapshot = {
  text: "zvec: ready · 11 files",
  busy: false,
  details: [
    `Project: /workspace/${"项目".repeat(30)}`,
    "Status: ready · 11 files",
    "Model: local/qwen3-embedding-0.6b",
    "Files: 11 · Pending: 0 · Failed: 0",
    `Index path: /workspace/${"nested/".repeat(20)}index.zvec`,
  ].join("\n"),
};
const iterations = 2000;
for (const scenario of ["redraw", "navigate", "resize", "invalidate"] as const) {
  const samples: number[] = [];
  for (let round = 0; round < 6; round++) {
    const menu = createIndexMenu(snapshot, options, theme, () => {});
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      if (scenario === "navigate") menu.handleInput("\x1b[B");
      if (scenario === "invalidate") menu.invalidate();
      const lines = menu.render(scenario === "resize" ? (i % 2 ? 80 : 100) : 100);
      assert.ok(lines.length > 0);
    }
    if (round > 0) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(`${scenario}: ${samples[2].toFixed(2)} ms / ${iterations} renders (median of 5, one warmup)`);
}

const imports: number[] = [];
for (let round = 0; round < 6; round++) {
  const result = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `const start = performance.now(); await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)}); console.log(performance.now() - start);`,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (round > 0) imports.push(Number(result.trim()));
}
imports.sort((a, b) => a - b);
console.log(`extension import: ${imports[2].toFixed(2)} ms (fresh process, median of 5, one warmup)`);

const home = await mkdtemp(join(tmpdir(), "zvec-perf-"));
try {
  const cache = join(home, "models");
  for (const model of Object.keys(modelSnapshots)) await cachedSnapshot(cache, model);
  for (const onlyModel of [undefined, "local/potion-code-16m-v2"]) {
    const samples: number[] = [];
    for (let round = 0; round < 6; round++) {
      const start = performance.now();
      for (let iteration = 0; iteration < 50; iteration++) {
        const choices = await localModelChoices(
          { ZVEC_GREP_MODEL_CACHE: cache },
          home,
          AbortSignal.timeout(10_000),
          onlyModel,
        );
        assert.equal(choices.find((choice) => choice.model === "local/potion-code-16m-v2")?.status, "Downloaded");
      }
      if (round > 0) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(
      `model cache ${onlyModel ? "current model" : "catalog"}: ${samples[2].toFixed(2)} ms / 50 checks (median of 5, one warmup)`,
    );
  }
} finally {
  await rm(home, { recursive: true, force: true });
}

await test("status polling benchmark", async (t) => {
  const { home: root } = await cacheFixture(t);
  execFileSync("git", ["init", "--initial-branch=main", root], { stdio: "ignore" });
  const { env, calls } = await mockServer(t, {
    result: { content: [], structuredContent: { root, indexed: true, status: "ready" } },
  });
  for (const scenario of ["git", "status", "snapshot"] as const) {
    const samples: number[] = [];
    const before = calls.filter((call) => call.message?.method === "tools/call").length;
    for (let round = 0; round < 6; round++) {
      const start = performance.now();
      for (let iteration = 0; iteration < 20; iteration++) {
        const signal = AbortSignal.timeout(10_000);
        if (scenario === "git") assert.equal((await readGit(root, signal))?.branch, "main");
        else if (scenario === "status") assert.equal(await readStatus(root, signal, env), "zvec: ready");
        else assert.equal((await readSnapshot(root, signal, env)).text, "zvec: ready");
      }
      if (round > 0) samples.push((performance.now() - start) / 20);
    }
    const queries = calls.filter((call) => call.message?.method === "tools/call").length - before;
    assert.equal(queries, scenario === "git" ? 0 : 120);
    samples.sort((a, b) => a - b);
    console.log(`poll ${scenario}: ${samples[2].toFixed(2)} ms / read (median of 5 × 20 reads, one warmup)`);
  }
  assert.ok(
    calls.every((call) => !call.message?.params?.name || call.message.params.name === "zvec_grep_index_status"),
  );
});
