import { realpath } from "node:fs/promises";
import { readMetadata } from "./metadata.ts";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readGit, sameGit } from "./git.ts";
import type { AutoUpdateSetting } from "./auto-update.ts";

async function canonicalRoot(root: string) {
  try {
    return await realpath(root);
  } catch (error) {
    if (object(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return resolve(root);
    throw error;
  }
}

export function serverUrl(value = "http://127.0.0.1:7999/mcp") {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Use a loopback MCP URL without credentials, query or fragment.");
  }
  return url;
}

async function requestTool(
  name: "zvec_grep_index_status" | "zvec_grep_index",
  args: Record<string, unknown>,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  signal.throwIfAborted();
  const url = serverUrl(env.ZVEC_GREP_SERVER_URL);
  const token =
    env.ZVEC_GREP_SERVER_TOKEN ||
    (env.ZVEC_GREP_SERVER_TOKEN_FILE
      ? (await readMetadata(env.ZVEC_GREP_SERVER_TOKEN_FILE, signal)).trim()
      : undefined);
  signal.throwIfAborted();
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  signal.throwIfAborted();
  const client = new Client({ name: "pi-zvec-status", version: "0.4.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      redirect: "error",
    },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  // Request cancellation alone does not necessarily stop an HTTP fetch.
  const close = () => {
    void client.close().catch(() => {});
  };
  signal.addEventListener("abort", close, { once: true });
  let data: unknown;
  try {
    await client.connect(transport, { signal, timeout: 10_000 });
    const result = await client.callTool(
      {
        name,
        arguments: args,
      },
      undefined,
      { signal, timeout: 10_000 },
    );
    if (result.isError) {
      throw new Error("Index status rejected or action rejected; check --mcp-toolset full.");
    }
    data =
      result.structuredContent ??
      JSON.parse(
        (Array.isArray(result.content) ? result.content : [])
          .filter(
            (item: unknown): item is { type: "text"; text: string } =>
              object(item) && item.type === "text" && typeof item.text === "string",
          )
          .map((item) => item.text)
          .join("\n"),
      );
    if (name === "zvec_grep_index_status") {
      if (!object(data) || typeof data.root !== "string" || !isAbsolute(data.root) || typeof args.root !== "string") {
        throw new Error("Unsupported index status root.");
      }
      const [requested, returned] = await Promise.all([canonicalRoot(args.root), canonicalRoot(data.root)]);
      signal.throwIfAborted();
      const inside = relative(returned, requested);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
        throw new Error("Index status belongs to a different workspace.");
    }
  } catch (error) {
    if (object(error) && error.code === -32601) {
      throw new Error("Status tool unavailable; start zg with --mcp-toolset full.");
    }
    throw error;
  } finally {
    try {
      await transport.terminateSession();
    } catch {
      // A stopped or stateless server may not accept session termination.
    } finally {
      signal.removeEventListener("abort", close);
      await client.close();
    }
  }
  signal.throwIfAborted();
  return data;
}

export async function readStatus(root: string, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env) {
  return describeStatus(await requestTool("zvec_grep_index_status", { root }, signal, env));
}

export async function readSnapshot(root: string, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env) {
  const before = await readGit(root, signal);
  const data = await requestTool("zvec_grep_index_status", { root }, signal, env);
  const git = await readGit(root, signal);
  const changed = !sameGit(before, git);
  const text = changed ? "zvec: unknown" : describeStatus(data);
  if (!object(data)) throw new Error("Unsupported index status response.");
  const persistent = object(data.persistent) ? data.persistent : undefined;
  const workspace = object(persistent?.workspace_index) ? persistent.workspace_index : undefined;
  const embedding = object(workspace?.embedding) ? workspace.embedding : undefined;
  const files = object(persistent?.files) ? persistent.files : undefined;
  const runtime = object(data.runtime) ? data.runtime : undefined;
  const progress = object(runtime?.progress) ? runtime.progress : undefined;
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  const model =
    typeof embedding?.provider === "string" && typeof embedding.model === "string"
      ? clean(`${embedding.provider}/${embedding.model}`)
      : undefined;
  return {
    text,
    git,
    checkedAt: Date.now(),
    indexed: data.indexed === true,
    busy: runtime?.job_state === "running" || runtime?.job_state === "queued",
    model,
    details: [
      `Project: ${clean(root)}`,
      `Status: ${text.replace(/^zvec: /, "")}`,
      `Model: ${model ?? "Unknown / not configured"}`,
      `Files: ${count(files?.stored) ? files.stored : "?"} · Pending: ${count(files?.pending) ? files.pending : "?"} · Failed: ${count(files?.failed) ? files.failed : "?"}`,
      `Index path: ${typeof persistent?.index_path === "string" ? clean(persistent.index_path) : "None"}`,
      ...([files?.added, files?.modified, files?.deleted].some((value) => value !== undefined)
        ? [
            `Index drift: +${count(files?.added) ? files.added : "?"} ~${count(files?.modified) ? files.modified : "?"} -${count(files?.deleted) ? files.deleted : "?"}`,
          ]
        : []),
      ...(git
        ? [
            `Branch: ${git.branch ? clean(git.branch) : "detached HEAD"}`,
            `HEAD: ${git.head?.slice(0, 12) ?? "No commit available"}`,
            `Worktree: ${clean(git.root)}`,
            `Changes: ${git.dirty ? "Uncommitted / untracked" : "Clean"}`,
            `Operation: ${git.operation ?? "None"}`,
            "Index HEAD: Not attested by daemon",
          ]
        : ["Git: Not available"]),
      ...(typeof progress?.detail === "string" ? [`Activity: ${clean(progress.detail)}`] : []),
      ...(runtime?.job_state === "running" ? ["Progress: Overall files, not embedding chunks"] : []),
      ...(changed ? ["Git state: Changed during query; refresh status"] : []),
    ].join("\n"),
  };
}

export type Snapshot = Awaited<ReturnType<typeof readSnapshot>>;
export interface StatusSource {
  autoUpdate?: AutoUpdateSetting;
  read: () => Promise<Snapshot>;
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
}

export async function indexWorkspace(
  root: string,
  options: { rebuild?: boolean; embedding?: string },
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
) {
  const result = await requestTool("zvec_grep_index", { root, ...options, wait: false }, signal, env);
  if (
    !object(result) ||
    typeof result.state !== "string" ||
    !["queued", "running", "succeeded"].includes(result.state)
  ) {
    throw new Error("Index submission not confirmed; check status before retrying.");
  }
  return result.state;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function describeStatus(data: unknown) {
  if (
    !object(data) ||
    typeof data.root !== "string" ||
    typeof data.indexed !== "boolean" ||
    (data.runtime != null && !object(data.runtime)) ||
    (data.persistent != null && !object(data.persistent))
  ) {
    throw new Error("Unsupported index status response.");
  }
  const runtime = data.runtime;
  const files = object(data.persistent?.files) ? data.persistent.files : undefined;
  const completion = object(runtime?.completion) ? runtime.completion : undefined;
  const indexStatus = object(runtime?.index_status) ? runtime.index_status : undefined;
  const compatibility = object(data.compatibility) ? data.compatibility : undefined;
  if (
    [runtime?.index_status, runtime?.completion, data.persistent?.files, data.compatibility].some(
      (value) => value !== undefined && !object(value),
    ) ||
    (indexStatus !== undefined && typeof indexStatus.status !== "string") ||
    (compatibility !== undefined &&
      (typeof compatibility.status !== "string" ||
        !["compatible", "rebuild_required", "unbuilt"].includes(compatibility.status))) ||
    (data.status !== undefined && typeof data.status !== "string") ||
    (data.index_policy !== undefined &&
      (typeof data.index_policy !== "string" || !["enabled", "disabled", "undecided", "uninitialized"].includes(data.index_policy))) ||
    [
      files?.stored,
      files?.pending,
      files?.failed,
      files?.added,
      files?.modified,
      files?.deleted,
      runtime?.dirty_revision,
      runtime?.indexed_revision,
    ].some((value) => value !== undefined && !count(value))
  ) {
    return "zvec: unknown";
  }
  const job = runtime?.job_state;
  if (
    job !== undefined &&
    (typeof job !== "string" || !["queued", "running", "succeeded", "failed", "cancelled"].includes(job))
  )
    return "zvec: unknown";
  if (job === "queued") return "zvec: queued";
  if (job === "running") {
    const done = completion?.completed;
    const total = completion?.total;
    const progress = count(done) && count(total) && total > 0 ? ` ${Math.min(done, total)}/${total}` : "";
    return `zvec: indexing${progress}`;
  }
  const state = indexStatus?.status ?? data.status;
  if (data.index_policy === "disabled" || state === "disabled") return "zvec: disabled";
  if (compatibility?.status === "rebuild_required" || state === "rebuild_required") {
    return "zvec: rebuild required";
  }
  if (job === "failed" || state === "failed" || (count(files?.failed) && files.failed > 0)) {
    return "zvec: failed";
  }
  if (job === "cancelled") return "zvec: cancelled";
  if (!data.indexed && (state === "missing" || state === "uninitialized")) return "zvec: no index";
  if (state !== undefined && state !== "ready" && state !== "stale") return "zvec: unknown";
  if (!data.indexed) return "zvec: no index";
  if (
    state === "stale" ||
    [files?.pending, files?.added, files?.modified, files?.deleted].some((value) => count(value) && value > 0) ||
    (count(runtime?.dirty_revision) &&
      count(runtime?.indexed_revision) &&
      runtime.dirty_revision > runtime.indexed_revision)
  ) {
    return "zvec: stale";
  }
  if (
    (runtime?.dirty_revision !== undefined) !== (runtime?.indexed_revision !== undefined) ||
    (state !== "ready" && !(count(files?.stored) && count(files?.pending) && count(files?.failed)))
  ) {
    return "zvec: unknown";
  }
  return count(files?.stored) ? `zvec: ready · ${files.stored} files` : "zvec: ready";
}
