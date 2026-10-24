// Isolated real backend for environment tests; deterministic inference, no model download.
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const backendRoot = resolve(
  process.env.ZG_TEST_BACKEND_ROOT ?? fileURLToPath(new URL("../../../zvec-grep/", import.meta.url)),
);
const load = (path) => import(pathToFileURL(join(backendRoot, path)).href);
const { createZvecGrep } = await load("dist/index.js");
const { DaemonBackend } = await load("dist/daemon/backend.js");
const { DaemonHttpServer } = await load("dist/daemon/http-server.js");
const { FakeEmbeddingModel } = await load("test/helpers/fake-embedding.mjs");
const root = resolve(process.argv[2]);
class Model extends FakeEmbeddingModel {
  constructor() {
    super();
    this.info = { ...this.info, cacheIdentity: "environment-v1" };
  }
  async doEmbed(contents, options) {
    if (options.purpose === "document") await new Promise((done) => setTimeout(done, 300));
    return super.doEmbed(contents);
  }
}
const initial = await createZvecGrep({ root, embeddingModel: new Model() });
await initial.index({ globs: ["*.ts"] });
await initial.close();
const backend = new DaemonBackend({
  version: "environment-test",
  modelPoolOptions: { createModel: () => new Model() },
});
let port = 0;
let server;
async function online() {
  server = new DaemonHttpServer({
    host: "127.0.0.1",
    port,
    token: "environment-test",
    version: "environment-test",
    mcpToolset: "full",
    backend,
  });
  port = (await server.start()).port;
}
await online();
console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}/mcp`, token: "environment-test" }));
let queue = Promise.resolve();
let sequence = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  queue = queue
    .then(async () => {
      const command = JSON.parse(line);
      if (command.action === "offline") await server.close();
      else if (command.action === "online") await online();
      else if (command.action === "change") {
        await writeFile(join(root, "value.ts"), `export const value = ${++sequence};\n`);
        await backend.index({ root, wait: false });
      } else if (command.action === "exit") {
        await server.close();
        await backend.close();
        process.exit(0);
      } else throw new Error("Unknown test command.");
      console.log(JSON.stringify({ ack: command.action }));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
});
process.once("SIGTERM", () => {
  void server
    .close()
    .then(() => backend.close())
    .then(() => process.exit(0));
});
