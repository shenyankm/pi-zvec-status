import assert from "node:assert/strict";
import { test } from "node:test";
import { formatStatus } from "../lib/display.ts";

const plain: Parameters<typeof formatStatus>[1] = { fg: (_color, text) => text };

for (const [input, output, color] of [
  ["ready · 957 files", "● zvec · ready", "success"],
  ["ready", "● zvec · ready", "success"],
  ["indexing 40/128", "◌ zvec · indexing 40/128", "accent"],
  ["checking", "◌ zvec · checking", "accent"],
  ["queued", "◌ zvec · queued", "accent"],
  ["stale", "! zvec · stale", "warning"],
  ["rebuild required", "! zvec · rebuild required", "warning"],
  ["unavailable", "! zvec · unavailable", "warning"],
  ["cancelled", "! zvec · cancelled", "warning"],
  ["failed", "✕ zvec · failed", "error"],
  ["no index", "○ zvec · no index", "muted"],
  ["disabled", "○ zvec · disabled", "muted"],
  ["unknown", "○ zvec · unknown", "muted"],
]) {
  test(`footer: ${input}`, () => {
    assert.equal(formatStatus(`zvec: ${input}`, plain), output);
    const calls: [string, string][] = [];
    formatStatus(`zvec: ${input}`, { fg: (token, text) => { calls.push([token, text]); return text; } });
    assert.equal(calls[0][0], color);
    assert.deepEqual(calls[1], ["muted", "zvec"]);
    assert.equal(calls.at(-1)![0], color);
    assert.equal(calls.length, 4);
  });
}
