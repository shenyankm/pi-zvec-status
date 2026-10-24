import { mkdir, mkdtemp, open, writeFile, rm } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { modelSnapshots } from "../lib/model-cache-data.ts";

export function setEnv(t: TestContext, env: NodeJS.ProcessEnv) {
  const original = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

export async function cacheFixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "zvec-model-cache-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, cache: join(home, ".zvec-grep", "models") };
}

export async function cachedSnapshot(cache: string, model: string, source = 0) {
  const snapshot = modelSnapshots[model][source];
  const directory = join(cache, snapshot.directory);
  for (const [path, size] of snapshot.files) {
    const file = join(directory, path);
    await mkdir(dirname(file), { recursive: true });
    const handle = await open(file, "w");
    try { await handle.truncate(size); } finally { await handle.close(); }
  }
  const marker = join(directory, `.zvec-grep-artifacts-${snapshot.fingerprint}.complete`);
  await writeFile(marker, JSON.stringify({ version: 1, fingerprint: snapshot.fingerprint }));
  return { snapshot, directory, marker };
}

export async function isolateModelCache(t: TestContext, cached: string[] = [], unknown = false) {
  const fixture = await cacheFixture(t);
  await mkdir(join(fixture.home, ".zvec-grep"), { recursive: true });
  await writeFile(join(fixture.home, ".zvec-grep", "config.json"), unknown ? "{invalid" : JSON.stringify({
    defaults: { modelCacheDir: fixture.cache },
  }));
  setEnv(t, { HOME: fixture.home, USERPROFILE: fixture.home, ZVEC_GREP_HOME: undefined, ZVEC_GREP_MODEL_CACHE: undefined });
  for (const model of cached) await cachedSnapshot(fixture.cache, model);
  return fixture;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function serve(t: TestContext, handler: RequestListener): Promise<NodeJS.ProcessEnv> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  return { ZVEC_GREP_SERVER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, ZVEC_GREP_SERVER_TOKEN: "test-secret" };
}

interface Message {
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

export async function mockServer(t: TestContext, result: Record<string, unknown> | ((message: Message) => Record<string, unknown> | Promise<Record<string, unknown>>)) {
  const calls: { method?: string; authorization?: string; message?: Message }[] = [];
  const env = await serve(t, async (req, res) => {
    calls.push({ method: req.method, authorization: req.headers.authorization });
    if (req.method === "DELETE") { res.writeHead(204).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    calls.at(-1)!.message = message;
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const payload = message.method === "initialize"
      ? { result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } } }
      : typeof result === "function" ? await result(message) : result;
    res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "test-session" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload }));
  });
  return { calls, env };
}
