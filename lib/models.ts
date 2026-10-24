import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
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

async function cacheDirectory(env: NodeJS.ProcessEnv, home: string) {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(join(home, ".zvec-grep", "config.json"), "utf8"));
    if (!object(config)) throw new Error("Invalid global config.");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const defaults = object(config) && object(config.defaults) ? config.defaults : undefined;
  const configured = defaults?.modelCacheDir;
  if (configured !== undefined && (typeof configured !== "string" || !configured.trim())) {
    throw new Error("Invalid model cache directory.");
  }
  return resolve(configured ?? env.ZVEC_GREP_MODEL_CACHE ?? join(env.ZVEC_GREP_HOME ?? join(home, ".zvec-grep"), "models"));
}

async function snapshotStatus(cache: string, snapshot: ModelSnapshot): Promise<CacheStatus> {
  try {
    const directory = join(cache, snapshot.directory);
    const marker: unknown = JSON.parse(await readFile(join(directory, `.zvec-grep-artifacts-${snapshot.fingerprint}.complete`), "utf8"));
    if (!object(marker) || marker.version !== 1 || marker.fingerprint !== snapshot.fingerprint) return "Not downloaded";
    const files = await Promise.all(snapshot.files.map(async ([path, size]) => {
      const info = await stat(join(directory, path));
      return info.isFile() && info.size === size;
    }));
    return files.every(Boolean) ? "Downloaded" : "Not downloaded";
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return "Not downloaded";
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
  const confirmed = await ui.confirm("Download model?", [
    `Model: ${choice.model}`,
    choice.status === "Not downloaded" ? "This model is not downloaded." : "The model cache could not be verified.",
    "Continuing may download model files from Hugging Face or ModelScope, using network bandwidth and local disk space.",
    "Downloading will only start after you also confirm the index operation. Allow this download?",
  ].join("\n"), { signal });
  return confirmed && !signal.aborted;
}

export async function localModelChoices(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  let cache: string | undefined;
  try { cache = await cacheDirectory(env, home); } catch { /* Do not mislabel an unreadable cache as empty. */ }
  // shortcut: matches zvec-grep 0.2.2 snapshots without hashing model weights; update when its catalog or cache format changes.
  const choices = await Promise.all(Object.entries(modelSnapshots).map(async ([model, snapshots]) => {
    const statuses = cache ? await Promise.all(snapshots.map((snapshot) => snapshotStatus(cache!, snapshot))) : [];
    const status: CacheStatus = statuses.includes("Downloaded") ? "Downloaded"
      : !cache || statuses.includes("Cache unknown") ? "Cache unknown" : "Not downloaded";
    return { model, status, label: `[${status}]`.padEnd(17) + model };
  }));
  const order: Record<CacheStatus, number> = { Downloaded: 0, "Cache unknown": 1, "Not downloaded": 2 };
  return choices.sort((a, b) => order[a.status] - order[b.status]);
}
