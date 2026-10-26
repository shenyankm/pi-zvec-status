import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { readMetadata } from "./metadata.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { modelSnapshots, type ModelSnapshot } from "./model-cache-data.ts";

type CacheStatus = "Downloaded" | "Not downloaded" | "Cache unknown";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function missing(error: unknown) {
  return object(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function cacheDirectory(env: NodeJS.ProcessEnv, home: string, signal: AbortSignal) {
  let config: unknown;
  try {
    config = JSON.parse(await readMetadata(join(home, ".zvec-grep", "config.json"), signal));
    if (!object(config) || (config.defaults !== undefined && !object(config.defaults))) {
      throw new Error("Invalid global config.");
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const defaults = object(config) && object(config.defaults) ? config.defaults : undefined;
  const configured = defaults?.modelCacheDir;
  if (configured !== undefined && (typeof configured !== "string" || !configured.trim())) {
    throw new Error("Invalid model cache directory.");
  }
  return resolve(
    configured?.trim() ?? env.ZVEC_GREP_MODEL_CACHE ?? join(env.ZVEC_GREP_HOME ?? join(home, ".zvec-grep"), "models"),
  );
}

async function snapshotStatus(cache: string, snapshot: ModelSnapshot, signal: AbortSignal): Promise<CacheStatus> {
  try {
    const directory = join(cache, snapshot.directory);
    const marker: unknown = JSON.parse(
      await readMetadata(join(directory, `.zvec-grep-artifacts-${snapshot.fingerprint}.complete`), signal),
    );
    if (!object(marker) || marker.version !== 1 || marker.fingerprint !== snapshot.fingerprint) return "Not downloaded";
    const recorded = marker.files;
    if (!object(recorded)) return "Cache unknown";
    const files = await Promise.all(
      snapshot.files.map(async ([path, size, artifact = path]): Promise<CacheStatus> => {
        const info = await stat(join(directory, path));
        if (!info.isFile() || info.size !== size) return "Not downloaded";
        const file = recorded[artifact];
        return object(file) && file.size === info.size && file.mtimeMs === info.mtimeMs && file.ctimeMs === info.ctimeMs
          ? "Downloaded"
          : "Cache unknown";
      }),
    );
    signal.throwIfAborted();
    return files.includes("Not downloaded")
      ? "Not downloaded"
      : files.includes("Cache unknown")
        ? "Cache unknown"
        : "Downloaded";
  } catch (error) {
    signal.throwIfAborted();
    if (missing(error)) return "Not downloaded";
    return "Cache unknown";
  }
}

export async function confirmModelDownload(
  ui: Pick<ExtensionContext["ui"], "confirm">,
  choice: { model: string; status: CacheStatus },
  signal: AbortSignal,
) {
  if (signal.aborted) return false;
  if (choice.status === "Downloaded") return true;
  const confirmed = await ui.confirm(
    "Download model?",
    [
      `Model: ${choice.model}`,
      choice.status === "Not downloaded" ? "This model is not downloaded." : "The model cache could not be verified.",
      "Continuing may download model files from Hugging Face or ModelScope, using network bandwidth and local disk space.",
      "Downloading will only start after you also confirm the index operation. Allow this download?",
    ].join("\n"),
    { signal },
  );
  return confirmed && !signal.aborted;
}

export async function localModelChoices(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  signal = AbortSignal.timeout(10_000),
  onlyModel?: string,
) {
  signal.throwIfAborted();
  let cache: string | undefined;
  try {
    cache = await cacheDirectory(env, home, signal);
  } catch {
    signal.throwIfAborted();
  }
  // shortcut: matches zvec-grep 0.2.2 snapshots without hashing model weights; update when its catalog or cache format changes.
  const choices = await Promise.all(
    Object.entries(modelSnapshots)
      .filter(([model]) => onlyModel === undefined || model === onlyModel)
      .map(async ([model, snapshots]) => {
        const statuses = cache
          ? await Promise.all(snapshots.map((snapshot) => snapshotStatus(cache!, snapshot, signal)))
          : [];
        const status: CacheStatus = statuses.includes("Downloaded")
          ? "Downloaded"
          : !cache || statuses.includes("Cache unknown")
            ? "Cache unknown"
            : "Not downloaded";
        return { model, status, label: `[${status}]`.padEnd(17) + model };
      }),
  );
  signal.throwIfAborted();
  const order: Record<CacheStatus, number> = { Downloaded: 0, "Cache unknown": 1, "Not downloaded": 2 };
  return choices.sort((a, b) => order[a.status] - order[b.status]);
}
