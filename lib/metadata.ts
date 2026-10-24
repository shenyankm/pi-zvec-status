import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";

// shortcut: metadata is capped at 64 KiB; raise only for a legitimate larger config.
export const MAX_METADATA_BYTES = 64 * 1024;

export async function readMetadata(path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  // shortcut: kernel stat/open cannot be interrupted; isolate I/O if network mounts must be supported.
  if (!(await stat(path)).isFile()) throw new Error("Metadata must be a regular file.");
  signal.throwIfAborted();
  // Pre-check Windows devices; nonblocking open also closes the POSIX FIFO replacement race.
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  let stream: ReturnType<typeof file.createReadStream> | undefined;
  try {
    signal.throwIfAborted();
    if (!(await file.stat()).isFile()) throw new Error("Metadata must be a regular file.");
    signal.throwIfAborted();
    stream = file.createReadStream({ start: 0, end: MAX_METADATA_BYTES, autoClose: false, signal });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_METADATA_BYTES) throw new Error("Metadata exceeds the 64 KiB limit.");
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size).toString("utf8");
  } finally {
    stream?.destroy();
    await file.close();
  }
}
