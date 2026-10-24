import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { indexWorkspace, readStatus } from "../lib/status.ts";
import { cacheFixture, mockServer, serve } from "./helpers.ts";

for (const status of [401, 403]) {
  test(`HTTP ${status} rejects the request without retrying or reporting ready`, async (t) => {
    let posts = 0;
    const env = await serve(t, (req, res) => {
      if (req.method === "POST") posts++;
      res.writeHead(status, { "Content-Type": "text/plain" }).end("private error details");
    });
    await assert.rejects(readStatus("/workspace", AbortSignal.timeout(3000), env));
    assert.equal(posts, 1);
  });
}

test("HTTP redirects are refused and credentials never reach the target", async (t) => {
  let targetRequests = 0;
  const target = await serve(t, (_req, res) => { targetRequests++; res.writeHead(500).end(); });
  const env = await serve(t, (_req, res) => {
    res.writeHead(302, { Location: target.ZVEC_GREP_SERVER_URL! }).end();
  });
  await assert.rejects(readStatus("/workspace", AbortSignal.timeout(3000), env));
  assert.equal(targetRequests, 0);
});

test("an unreadable token file fails before connecting", async (t) => {
  const { home } = await cacheFixture(t);
  const { calls, env } = await mockServer(t, { result: { content: [], structuredContent: { root: "/workspace", indexed: true } } });
  await assert.rejects(readStatus("/workspace", AbortSignal.timeout(3000), {
    ...env, ZVEC_GREP_SERVER_TOKEN: undefined, ZVEC_GREP_SERVER_TOKEN_FILE: join(home, "missing-token"),
  }), { code: "ENOENT" });
  assert.equal(calls.length, 0);
});

for (const state of ["queued", "running", "succeeded"]) {
  test(`index submission accepts confirmed ${state} results`, async (t) => {
    const { calls, env } = await mockServer(t, { result: { content: [], structuredContent: { state } } });
    assert.equal(await indexWorkspace("/workspace", { rebuild: true }, AbortSignal.timeout(3000), env), state);
    assert.equal(calls.filter((call) => call.message?.params?.name === "zvec_grep_index").length, 1);
  });
}

for (const data of [{}, { state: null }, { state: "failed" }, { state: "future_state" }, { state: 42 }]) {
  test(`index submission rejects an unconfirmed result: ${JSON.stringify(data)}`, async (t) => {
    const { calls, env } = await mockServer(t, { result: { content: [], structuredContent: data } });
    await assert.rejects(indexWorkspace("/workspace", {}, AbortSignal.timeout(3000), env), /not confirmed/);
    assert.equal(calls.filter((call) => call.message?.params?.name === "zvec_grep_index").length, 1);
  });
}

for (const text of ["", "not json", "null", "[]"]) {
  test(`invalid text fallback never becomes ready: ${JSON.stringify(text)}`, async (t) => {
    const { env } = await mockServer(t, { result: { content: [{ type: "text", text }] } });
    await assert.rejects(readStatus("/workspace", AbortSignal.timeout(3000), env));
  });
}

test("unsupported session termination does not discard a valid status result", async (t) => {
  let deletes = 0;
  const env = await serve(t, async (req, res) => {
    if (req.method === "DELETE") { deletes++; res.writeHead(405).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
      : { content: [], structuredContent: { root: "/workspace", indexed: true, status: "ready" } };
    res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "test-session" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  assert.equal(await readStatus("/workspace", AbortSignal.timeout(3000), env), "zvec: ready");
  assert.equal(deletes, 1);
});
