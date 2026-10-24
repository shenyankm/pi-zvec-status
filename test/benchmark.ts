import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
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
