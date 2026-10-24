interface MonitorOptions {
  read: (signal: AbortSignal) => Promise<string>;
  render: (text: string) => void;
  intervalMs?: number;
  timeoutMs?: number;
}

type RefreshResult = { text: string; error?: never } | { error: string; text?: never };

export function createMonitor({ read, render, intervalMs = 30_000, timeoutMs = 10_000 }: MonitorOptions) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<RefreshResult | undefined> | undefined;
  let controller: AbortController | undefined;

  function refresh(): Promise<RefreshResult | undefined> {
    if (stopped) return Promise.resolve(undefined);
    if (pending) return pending;
    clearTimeout(timer);
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    pending = (async () => {
      await Promise.resolve();
      try {
        const text = await read(signal);
        if (!stopped) render(text);
        return { text };
      } catch {
        const error = "Cannot read zvec-grep status. Check the local daemon, MCP URL/token, and --mcp-toolset full.";
        if (!stopped) render("zvec: unavailable");
        return { error };
      } finally {
        pending = undefined;
        if (!stopped) {
          timer = setTimeout(() => { void refresh(); }, intervalMs);
          timer.unref();
        }
      }
    })();
    return pending;
  }

  return {
    refresh,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      await pending;
    },
  };
}
