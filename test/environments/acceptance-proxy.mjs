// Transparent, source-labelled MCP proxy. Jobs run on the unmodified installed daemon.
import { createServer, request } from "node:http";
import { appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { modelSnapshots } from "../../lib/model-cache-data.ts";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { localModelChoices } from "../../lib/models.ts";

async function artifacts() {
  const result = {};
  for (const snapshots of Object.values(modelSnapshots)) {
    for (const snapshot of snapshots) {
      for (const [path] of snapshot.files) {
        const relativePath = join(snapshot.directory, path);
        try {
          const file = await stat(join(process.env.ZVEC_GREP_MODEL_CACHE, relativePath));
          result[relativePath] = { size: file.size, mtimeMs: file.mtimeMs, ctimeMs: file.ctimeMs };
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        }
      }
    }
  }
  return result;
}

const upstream = new URL(process.argv[2]);
const evidence = process.argv[3];
let tail = Promise.resolve();
const record = (value) => {
  tail = tail.then(() => appendFile(evidence, JSON.stringify({ at: Date.now(), ...value }) + "\n"));
};
function payload(text) {
  try {
    return JSON.parse(text);
  } catch {
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return data ? JSON.parse(data.slice(6)) : undefined;
  }
}
const server = createServer(async (incoming, outgoing) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const message = body.length ? payload(body.toString()) : undefined;
  const source = incoming.url?.slice(1) ?? "unknown";
  const headers = { ...incoming.headers, host: upstream.host };
  const forwarded = request(upstream, { method: incoming.method, headers }, (response) => {
    outgoing.writeHead(response.statusCode, response.headers);
    const result = [];
    response.on("data", (chunk) => result.push(chunk));
    response.on("end", () => {
      if (message?.method === "tools/call")
        record({
          source,
          tool: message.params.name,
          args: message.params.arguments,
          response: payload(Buffer.concat(result).toString()),
        });
    });
    response.pipe(outgoing);
  });
  forwarded.on("error", (error) => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end(JSON.stringify({ error: error.message }));
  });
  outgoing.on("close", () => forwarded.destroy());
  forwarded.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
console.log(JSON.stringify({ ready: true, url, choices: await localModelChoices(), artifacts: await artifacts() }));
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  queue = queue
    .then(async () => {
      const command = JSON.parse(line);
      if (command.action === "exit") {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await tail;
        process.exit(0);
      }
      if (command.action === "artifacts") {
        console.log(JSON.stringify({ id: command.id, artifacts: await artifacts() }));
        return;
      }
      const client = new Client({ name: "pi-menu-acceptance-observer", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(`${url}/probe`), {
        requestInit: { redirect: "error" },
      });
      const signal = AbortSignal.timeout(10_000);
      const close = () => {
        void client.close().catch(() => {});
      };
      signal.addEventListener("abort", close, { once: true });
      try {
        await client.connect(transport, { signal, timeout: 10_000 });
        const result = await client.callTool(
          { name: "zvec_grep_index_status", arguments: { root: command.root } },
          undefined,
          { signal, timeout: 10_000 },
        );
        if (result.isError) throw new Error(JSON.stringify(result));
        const status = result.structuredContent ?? payload(result.content.find((item) => item.type === "text").text);
        console.log(JSON.stringify({ id: command.id, status }));
      } catch (error) {
        console.log(JSON.stringify({ id: command.id, error: error.message }));
      } finally {
        try {
          await transport.terminateSession();
        } catch {}
        signal.removeEventListener("abort", close);
        await client.close();
      }
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
});
