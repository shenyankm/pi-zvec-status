import assert from "node:assert/strict";
import { test } from "node:test";
import { formatStatus } from "../lib/display.ts";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

const plain: Parameters<typeof formatStatus>[1] = { fg: (_color, text) => text };

test("footer identifies branch and worktree with bounded, sanitized labels", () => {
  assert.equal(
    formatStatus("zvec: stale", plain, {
      root: join("/workspace", "app-login"),
      branch: "feature/login",
      head: "123456789abcdef",
    }),
    "! zvec · feature/login @ app-login · stale",
  );
  const long = formatStatus("zvec: ready", plain, {
    root: join("/workspace", "树".repeat(80) + "\x1b[2J"),
    branch: "分支".repeat(40),
    head: "123456789abcdef",
  });
  assert.ok(visibleWidth(long) <= 80);
  assert.ok(long.includes("…"));
  assert.doesNotMatch(long, /\x1b(?!\[0m)/);
});

for (const [input, output, color] of [
  ["ready · 957 files", "● zvec · ready (last check)", "success"],
  ["ready", "● zvec · ready (last check)", "success"],
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
    formatStatus(`zvec: ${input}`, {
      fg: (token, text) => {
        calls.push([token, text]);
        return text;
      },
    });
    assert.equal(calls[0][0], color);
    assert.deepEqual(calls[1], ["muted", "zvec"]);
    assert.equal(calls.at(-1)![0], color);
    assert.equal(calls.length, 4);
  });
}
