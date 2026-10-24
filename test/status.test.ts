import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";
import { describeStatus, indexWorkspace, readStatus, readSnapshot, serverUrl } from "../lib/status.ts";
import { openPanel } from "../lib/panel.ts";
import { isolateModelCache, mockServer, setEnv } from "./helpers.ts";

const base = { root: "/workspace", indexed: true, index_policy: "enabled", status: "ready" };

type MenuFactory = Parameters<ExtensionContext["ui"]["custom"]>[0];

async function renderMenu(factory: MenuFactory) {
  const component = await factory(
    { requestRender() {} } as Parameters<MenuFactory>[0],
    { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Parameters<MenuFactory>[1],
    {} as Parameters<MenuFactory>[2],
    () => {},
  );
  return component.render(120).join("\n");
}

for (const [name, patch, expected] of [
  ["Node ready", { status: undefined, persistent: { files: { stored: 42, pending: 0, failed: 0 } } }, "ready · 42 files"],
  ["Rust ready", { status: "ready" }, "ready"],
  ["missing", { indexed: false }, "no index"],
  ["disabled", { indexed: false, index_policy: "disabled" }, "disabled"],
  ["rebuild", { indexed: false, compatibility: { status: "rebuild_required" } }, "rebuild required"],
  ["queued", { runtime: { job_state: "queued" } }, "queued"],
  ["running", { runtime: { job_state: "running", completion: { completed: 3, total: 10 } } }, "indexing 3/10"],
  ["clamps progress", { runtime: { job_state: "running", completion: { completed: 12, total: 10 } } }, "indexing 10/10"],
  ["no NaN progress", { runtime: { job_state: "running", completion: { completed: -1, total: 0 } } }, "indexing"],
  ["failed job", { runtime: { job_state: "failed" } }, "failed"],
  ["failed files", { persistent: { files: { failed: 1 } } }, "failed"],
  ["cancelled", { runtime: { job_state: "cancelled" } }, "cancelled"],
  ["Rust stale", { status: "stale" }, "stale"],
  ["runtime overrides ready", { status: "ready", runtime: { index_status: { status: "stale" } } }, "stale"],
  ["Node dirty", { runtime: { dirty_revision: 2, indexed_revision: 1 } }, "stale"],
  ["pending files", { persistent: { files: { pending: 1 } } }, "stale"],
  ["unknown state", { status: "future_state" }, "unknown"],
  ["malformed nested state", { runtime: { index_status: 42 } }, "unknown"],
  ["missing nested state", { runtime: { index_status: {} } }, "unknown"],
  ["unknown job", { runtime: { job_state: "future_status" } }, "unknown"],
  ["null job", { runtime: { job_state: null } }, "unknown"],
  ["empty state", { status: "" }, "unknown"],
  ["non-string state", { status: false }, "unknown"],
  ["malformed file counts", { persistent: { files: [] } }, "unknown"],
  ["invalid pending count", { persistent: { files: { pending: "2" } } }, "unknown"],
  ["malformed compatibility", { compatibility: 42 }, "unknown"],
  ["malformed completion", { runtime: { completion: "3/10" } }, "unknown"],
  ["unknown policy", { index_policy: "future_policy" }, "unknown"],
  ["invalid policy", { index_policy: false }, "unknown"],
  ["undecided policy without index", { index_policy: "undecided", indexed: false }, "no index"],
  ["minimal response has no readiness evidence", { status: undefined }, "unknown"],
  ["successful job alone is not readiness evidence", { status: undefined, runtime: { job_state: "succeeded" } }, "unknown"],
  ["unknown compatibility never ready", { compatibility: { status: "future_incompatible" } }, "unknown"],
  ["empty compatibility never ready", { compatibility: { status: "" } }, "unknown"],
  ["known compatible index", { compatibility: { status: "compatible" } }, "ready"],
  ["partial file counters", { status: undefined, persistent: { files: { stored: 42 } } }, "unknown"],
  ["partial revisions", { runtime: { dirty_revision: 9 } }, "unknown"],
  ["missing dirty revision", { runtime: { indexed_revision: 9 } }, "unknown"],
  ["Node empty index", { status: undefined, persistent: { files: { stored: 0, pending: 0, failed: 0 } } }, "ready · 0 files"],
] satisfies [string, Record<string, unknown>, string][]) {
  test(name, () => assert.equal(describeStatus({ ...base, ...patch }), `zvec: ${expected}`));
}

test("rejects invalid envelopes without rendering server text", () => {
  for (const data of [null, [], {}, { indexed: true }, { ...base, runtime: [] }]) {
    assert.throws(() => describeStatus(data), /Unsupported/);
  }
  assert.equal(describeStatus({ ...base, status: "\x1b[2J" }), "zvec: unknown");
});

test("only accepts loopback URLs and refuses credential-bearing URLs", () => {
  for (const url of [undefined, "http://localhost:7999/mcp", "http://[::1]:7999/mcp"]) {
    assert.ok(serverUrl(url));
  }
  for (const url of ["https://example.com/mcp", "file:///etc/passwd", "http://user:pass@localhost/mcp", "http://localhost/mcp?token=secret", "http://localhost/mcp#secret"]) {
    assert.throws(() => serverUrl(url));
  }
});


test("real HTTP MCP handshake, read-only call, auth, and session cleanup", async (t) => {
  const { calls, env } = await mockServer(t, { result: { content: [], structuredContent: base } });
  assert.equal(await readStatus("/workspace", AbortSignal.timeout(2000), env), "zvec: ready");
  const tools = calls.filter((call) => call.message?.method === "tools/call");
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0].message!.params, { name: "zvec_grep_index_status", arguments: { root: "/workspace" } });
  assert.equal(tools[0].authorization, "Bearer test-secret");
  assert.ok(calls.some((call) => call.method === "DELETE"));
});

test("supports JSON text fallback", async (t) => {
  const { env } = await mockServer(t, { result: { content: [{ type: "text", text: JSON.stringify(base) }] } });
  assert.equal(await readStatus("/workspace", AbortSignal.timeout(2000), env), "zvec: ready");
});

test("full toolset missing is actionable", async (t) => {
  const { env } = await mockServer(t, { error: { code: -32601, message: "Unknown tool" } });
  await assert.rejects(readStatus("/workspace", AbortSignal.timeout(2000), env), /--mcp-toolset full/);
});

test("tool failures are not mistaken for index readiness", async (t) => {
  const { env } = await mockServer(t, { result: { isError: true, content: [{ type: "text", text: "secret server error" }] } });
  await assert.rejects(readStatus("/workspace", AbortSignal.timeout(2000), env), /Index status rejected/);
});

test("token files are trimmed and direct tokens take precedence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-zvec-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "token");
  await writeFile(file, " file-secret\n");
  const { env, calls } = await mockServer(t, { result: { content: [], structuredContent: base } });
  delete env.ZVEC_GREP_SERVER_TOKEN;
  env.ZVEC_GREP_SERVER_TOKEN_FILE = file;
  await readStatus("/workspace", AbortSignal.timeout(2000), env);
  assert.equal(calls.find((call) => call.message?.method === "tools/call")!.authorization, "Bearer file-secret");
  env.ZVEC_GREP_SERVER_TOKEN = "direct-secret";
  env.ZVEC_GREP_SERVER_TOKEN_FILE = join(directory, "does-not-exist");
  await readStatus("/workspace", AbortSignal.timeout(2000), env);
  assert.equal(calls.filter((call) => call.message?.method === "tools/call").at(-1)!.authorization, "Bearer direct-secret");
});

test("a stalled HTTP initialization is cancelled at the deadline", async (t) => {
  const server = createServer(() => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  await assert.rejects(readStatus("/workspace", AbortSignal.timeout(50), {
    ZVEC_GREP_SERVER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
  }));
});

test("single zvec command opens the panel and skips unchanged footer output", async (t) => {
  const response = { ...base, persistent: { files: { stored: 1 } } };
  const { env } = await mockServer(t, { result: { content: [], structuredContent: response } });
  const names = ["ZVEC_GREP_SERVER_URL", "ZVEC_GREP_SERVER_TOKEN", "ZVEC_GREP_SERVER_TOKEN_FILE"];
  const original = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of names) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  Object.assign(process.env, env);
  const handlers = new Map();
  const commands = new Map();
  const statuses: [string, string | undefined][] = [];
  const notifications: string[] = [];
  const panels: string[] = [];
  extension({
    on: (name: string, handler: unknown) => { handlers.set(name, handler); return () => {}; },
    registerCommand: (name: string, command: unknown) => { commands.set(name, command); },
  } as unknown as ExtensionAPI);
  const ctx = { mode: "tui", cwd: "/workspace", ui: {
    theme: { fg: (_color: string, text: string) => text },
    setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
    notify: (text: string) => notifications.push(text),
    custom: async (factory: MenuFactory) => { panels.push(await renderMenu(factory)); return "Close"; },
  } } as unknown as ExtensionContext;
  t.after(() => handlers.get("session_shutdown")({}, ctx));
  await handlers.get("session_start")({}, ctx);
  assert.deepEqual([...commands.keys()], ["zvec"]);
  await commands.get("zvec").handler("", ctx);
  assert.deepEqual(statuses, [["zvec-status", "◌ zvec · checking"], ["zvec-status", "● zvec · ready (last check)"]]);
  assert.match(panels[0], /Project:\s+\/workspace/);
  await commands.get("zvec").handler("", ctx);
  response.persistent.files.stored = 2;
  await commands.get("zvec").handler("", ctx);
  assert.equal(statuses.length, 2);
  assert.match(panels.at(-1)!, /ready · 2 files/);
  assert.deepEqual(notifications, []);
  ctx.ui.theme.fg = (_color, text) => `[${text}]`;
  await commands.get("zvec").handler("", ctx);
  assert.deepEqual(statuses.at(-1), ["zvec-status", "[●] [zvec][ · ][ready (last check)]"]);
  response.indexed = false;
  await commands.get("zvec").handler("", ctx);
  assert.deepEqual(statuses.at(-1), ["zvec-status", "[○] [zvec][ · ][no index]"]);
  await handlers.get("session_shutdown")({}, ctx);
  assert.deepEqual(statuses.at(-1), ["zvec-status", undefined]);
});

test("aborted requests do not connect", async (t) => {
  const { env, calls } = await mockServer(t, { result: { content: [], structuredContent: base } });
  await assert.rejects(readStatus("/workspace", AbortSignal.abort(), env), { name: "AbortError" });
  assert.equal(calls.length, 0);
});

test("snapshot includes model and file counts without terminal control characters", async (t) => {
  const { env } = await mockServer(t, { result: { content: [], structuredContent: {
    ...base, persistent: {
      index_path: "/workspace/.zvec-grep/\u001b[2J",
      workspace_index: { embedding: { provider: "local", model: "qwen3-embedding-0.6b" } },
      files: { stored: 4, pending: 2, failed: 1 },
    },
  } } });
  const snapshot = await readSnapshot("/workspace", AbortSignal.timeout(2000), env);
  assert.equal(snapshot.model, "local/qwen3-embedding-0.6b");
  assert.match(snapshot.details, /Files: 4 · Pending: 2 · Failed: 1/);
  assert.ok(!snapshot.details.includes("\u001b"));
});

interface PanelCase {
  name: string;
  choices: (string | undefined)[];
  indexed?: boolean;
  busy?: boolean;
  confirm?: boolean;
  downloadConfirm?: boolean;
  cache?: "Downloaded" | "Not downloaded" | "Cache unknown";
  abortDownload?: boolean;
  abort?: boolean;
  changed?: boolean;
  failure?: boolean;
  submissionTimeout?: boolean;
  cacheRemoved?: boolean;
  missingModel?: boolean;
  invalidStatus?: boolean;
  expected?: Record<string, unknown>;
}

for (const scenario of [
  { name: "view only", choices: ["Close"] },
  { name: "escape", choices: [] },
  { name: "refresh", choices: ["Refresh status", "Close"] },
  { name: "busy job", choices: ["Close"], busy: true },
  { name: "cancel confirmation", choices: ["Rebuild index", "Close"], confirm: false },
  { name: "cancel model", choices: ["Switch model and rebuild", undefined, "Close"] },
  { name: "abort confirmation", choices: ["Rebuild index"], abort: true },
  { name: "job started during confirmation", choices: ["Rebuild index", "Close"], changed: true },
  { name: "incremental update", choices: ["Update index (incremental)"], expected: {} },
  { name: "rebuild", choices: ["Rebuild index"], expected: { rebuild: true } },
  { name: "switch model", choices: ["Switch model and rebuild", "local/potion-code-16m-v2"],
    expected: { rebuild: true, embedding: "local/potion-code-16m-v2" } },
  { name: "create", choices: ["Create index", "local/qwen3-embedding-0.6b"], indexed: false,
    expected: { embedding: "local/qwen3-embedding-0.6b" } },
  { name: "rejected submission", choices: ["Rebuild index"], expected: { rebuild: true }, failure: true },
  { name: "cached switch skips download consent", choices: ["Switch model and rebuild", "local/potion-code-16m-v2"],
    cache: "Downloaded", expected: { rebuild: true, embedding: "local/potion-code-16m-v2" } },
  { name: "decline download for create", choices: ["Create index", "local/qwen3-embedding-0.6b", "Close"],
    indexed: false, downloadConfirm: false },
  { name: "allow download but decline create", choices: ["Create index", "local/qwen3-embedding-0.6b", "Close"],
    indexed: false, confirm: false },
  { name: "decline download for rebuild", choices: ["Rebuild index", "Close"], downloadConfirm: false },
  { name: "decline download for incremental update", choices: ["Update index (incremental)", "Close"], downloadConfirm: false },
  { name: "unknown cache still requires consent", choices: ["Rebuild index", "Close"], cache: "Cache unknown", downloadConfirm: false },
  { name: "abort during download consent", choices: ["Rebuild index"], abortDownload: true },
  { name: "cache removed during confirmation", choices: ["Rebuild index", "Close"], cache: "Downloaded", cacheRemoved: true },
  { name: "missing model blocks submission", choices: ["Rebuild index", "Close"], missingModel: true },
  { name: "malformed status only allows viewing", choices: ["Close"], invalidStatus: true },
  { name: "accepted submission times out without retry", choices: ["Rebuild index"], submissionTimeout: true, expected: { rebuild: true } },
] satisfies PanelCase[]) {
  test(`panel: ${scenario.name}`, async (t) => {
    const config: PanelCase = scenario;
    const fixture = await isolateModelCache(t, config.cache === "Downloaded"
      ? ["local/qwen3-embedding-0.6b", "local/potion-code-16m-v2"] : [], config.cache === "Cache unknown");
    const snapshot = {
      ...base, indexed: config.indexed ?? true,
      runtime: { job_state: config.invalidStatus ? "future_status" : config.busy ? "running" : "succeeded" },
      persistent: { workspace_index: config.missingModel ? undefined : { embedding: { provider: "local", model: "qwen3-embedding-0.6b" } } },
    };
    const requestDeadline = new AbortController();
    if (config.submissionTimeout) t.mock.method(AbortSignal, "timeout", () => requestDeadline.signal);
    const { calls, env } = await mockServer(t, (message) => {
      if (message.params?.name !== "zvec_grep_index") return { result: { content: [], structuredContent: snapshot } };
      if (config.submissionTimeout) {
        snapshot.runtime.job_state = "running";
        requestDeadline.abort(new DOMException("Response deadline exceeded", "TimeoutError"));
      }
      return { result: config.failure
        ? { isError: true, content: [{ type: "text", text: "secret-token" }] }
        : { content: [], structuredContent: { state: "running" } } };
    });
    setEnv(t, { ...env, ZVEC_GREP_SERVER_TOKEN_FILE: undefined });
    const controller = new AbortController();
    const choices = [...config.choices];
    const menus: string[] = [];
    const modelMenus: string[][] = [];
    const notifications: string[] = [];
    let confirmations = 0;
    let downloadConfirmations = 0;
    const prompts: { title: string; message: string }[] = [];
    const ctx = { cwd: "/workspace", ui: {
      custom: async (factory: MenuFactory) => { menus.push(await renderMenu(factory)); return choices.shift(); },
      select: async (_title: string, labels: string[]) => {
        const model = choices.shift();
        modelMenus.push(labels);
        const label = labels.find((label) => model && label.endsWith(model));
        return label;
      },
      confirm: async (title: string, message: string) => {
        prompts.push({ title, message });
        if (title === "Download model?") {
          downloadConfirmations++;
          if (config.abortDownload) controller.abort();
          return config.downloadConfirm ?? true;
        }
        confirmations++;
        if (config.abort) controller.abort();
        if (config.changed) snapshot.runtime.job_state = "running";
        if (config.cacheRemoved) await rm(fixture.cache, { recursive: true, force: true });
        return config.confirm ?? true;
      },
      notify: (message: string) => notifications.push(message),
    } } as unknown as ExtensionContext;
    await openPanel(ctx, controller.signal);
    if (config.busy || config.invalidStatus) {
      assert.match(menus[0], /Refresh status/);
      assert.match(menus[0], /Close/);
      assert.doesNotMatch(menus[0], /Rebuild index|Update index|Switch model/);
    }
    const writes = calls.filter((call) => call.message?.params?.name === "zvec_grep_index");
    assert.equal(writes.length, config.expected ? 1 : 0);
    if (config.expected) {
      assert.equal(confirmations, 1);
      assert.equal(downloadConfirmations, config.cache === "Downloaded" ? 0 : 1);
      assert.deepEqual(writes[0].message?.params?.arguments,
        { root: "/workspace", ...config.expected, wait: false });
      assert.equal(notifications.length, 1);
      assert.match(notifications[0], config.failure || config.submissionTimeout ? /refresh status before retrying/ : /submitted/);
    }
    if (config.downloadConfirm === false || config.abortDownload) {
      assert.equal(downloadConfirmations, 1);
      assert.equal(confirmations, 0);
    }
    for (const labels of modelMenus) {
      assert.ok(labels.every((label) => /^\[(Downloaded|Not downloaded|Cache unknown)\]/.test(label)));
    }
    for (const prompt of prompts) {
      assert.match(prompt.message, prompt.title === "Download model?" ? /network bandwidth and local disk space/ : /Project: \/workspace/);
    }
    if (downloadConfirmations && confirmations) assert.equal(prompts[0].title, "Download model?");
    if (config.changed) assert.match(notifications[0], /state has changed/);
    if (config.cacheRemoved) assert.match(notifications[0], /cache has changed/);
    if (config.missingModel) assert.match(notifications[0], /Cannot determine the embedding model/);
    if (config.submissionTimeout) {
      assert.equal(await readStatus("/workspace", new AbortController().signal, env), "zvec: indexing");
      assert.equal(calls.filter((call) => call.message?.params?.name === "zvec_grep_index").length, 1);
    }
    if (!config.expected && !config.changed && !config.cacheRemoved && !config.missingModel) {
      assert.deepEqual(notifications, [], "viewing or cancelling must not hide a UI or assertion error");
    }
    assert.ok(notifications.every((message) => !message.includes("secret-token")));
  });
}
