import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

test("host dependencies follow Pi package guidelines without being bundled at runtime", async () => {
  for (const host of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    assert.equal(manifest.peerDependencies[host], "*");
    assert.equal(manifest.dependencies[host], undefined);
    assert.equal(typeof manifest.devDependencies[host], "string");
  }
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  assert.ok((await stat(new URL(manifest.pi.extensions[0], root))).isFile());
});

test("MIT license and public repository metadata are included in the package", async () => {
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.repository.type, "git");
  assert.equal(manifest.repository.url, "git+https://github.com/shenyankm/pi-zvec-status.git");
  assert.equal(manifest.bugs.url, "https://github.com/shenyankm/pi-zvec-status/issues");
  assert.ok(manifest.files.includes("LICENSE"));
  const license = await readFile(new URL("LICENSE", root), "utf8");
  assert.ok(license.startsWith("MIT License\n"));
  assert.match(license, /Copyright \(c\) 2026 shenyankm/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
});
