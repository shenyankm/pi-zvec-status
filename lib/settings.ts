import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readMetadata } from "./metadata.ts";

export async function readAutoUpdateSetting(path: string, signal: AbortSignal) {
  try {
    const data: unknown = JSON.parse(await readMetadata(path, signal));
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      !("autoUpdate" in data) ||
      typeof data.autoUpdate !== "boolean"
    )
      throw new Error("Invalid auto-update setting.");
    return data.autoUpdate;
  } catch (error) {
    signal.throwIfAborted();
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function writeAutoUpdateSetting(path: string, enabled: boolean, signal: AbortSignal) {
  signal.throwIfAborted();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ autoUpdate: enabled }, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
      signal,
    });
    signal.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
