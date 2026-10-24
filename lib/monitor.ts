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
  let checkedAt: number | undefined;
  let startedAt = 0;
  let refreshAfterMs = intervalMs;
  let failures = 0;

  function refresh(): Promise<RefreshResult | undefined> {
    if (stopped) return Promise.resolve(undefined);
    if (pending) return pending;
    clearTimeout(timer);
    controller = new AbortController();
    startedAt = Date.now();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    pending = (async () => {
      await Promise.resolve();
      let onAbort = () => {};
      try {
        signal.throwIfAborted();
        render("zvec: checking");
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const text = await Promise.race([read(signal), aborted]);
        signal.throwIfAborted();
        checkedAt = Date.now();
        failures = 0;
        refreshAfterMs = /^zvec: (indexing|queued)( |$)/.test(text) ? Math.min(intervalMs, 2000) : intervalMs;
        if (!stopped) render(text);
        return { text };
      } catch {
        const error = "Cannot read zvec-grep status. Check the local daemon, MCP URL/token, and --mcp-toolset full.";
        checkedAt = Date.now();
        refreshAfterMs = Math.min(intervalMs * 2 ** Math.min(failures++, 3), 120_000);
        if (!stopped) render("zvec: unavailable");
        return { error };
      } finally {
        signal.removeEventListener("abort", onAbort);
        pending = undefined;
        if (!stopped) {
          timer = setTimeout(() => {
            void refresh();
          }, refreshAfterMs);
          timer.unref();
        }
      }
    })();
    return pending;
  }

  function wake() {
    if (stopped) return;
    if (pending) {
      if (Date.now() - startedAt >= timeoutMs) {
        controller?.abort(new DOMException("Status request expired", "TimeoutError"));
        void pending.then(() => refresh());
      }
    } else if (checkedAt !== undefined && Date.now() - checkedAt >= refreshAfterMs) {
      render("zvec: status expired");
      void refresh();
    }
  }
  const heartbeat = setInterval(wake, 1000);
  heartbeat.unref();

  return {
    refresh,
    wake,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      controller?.abort();
      await pending;
    },
  };
}
