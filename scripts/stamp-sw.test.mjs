import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listAssets, stampWorker } from "./stamp-sw.mjs";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

test("stampWorker writes the build id and asset list and keeps the file valid", () => {
  const stamped = stampWorker(source, ["/assets/a.js", "/assets/b.css"], "fp");
  assert.match(stamped, /^const BUILD_ID = "[0-9a-f]{12}"; \/\/ @stamp build$/m);
  assert.match(stamped, /^const PRECACHE_ASSETS = \["\/assets\/a\.js","\/assets\/b\.css"\]; \/\/ @stamp assets$/m);
  assert.doesNotThrow(() => new Function(stamped));
});

test("stampWorker changes the build id when the assets change", () => {
  const first = stampWorker(source, ["/assets/a.js"], "fp");
  const second = stampWorker(source, ["/assets/a2.js"], "fp");
  assert.notEqual(first.match(/BUILD_ID = "(\w+)"/)[1], second.match(/BUILD_ID = "(\w+)"/)[1]);
});

test("stampWorker refuses a worker without stamp lines", () => {
  assert.throws(() => stampWorker("self.addEventListener('fetch', () => {});", [], ""), /@stamp/);
});

test("listAssets lists build files, sorted, without source maps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "toduck-stamp-"));
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "assets", "b.js"), "");
  await writeFile(join(dir, "assets", "a.css"), "");
  await writeFile(join(dir, "assets", "a.css.map"), "");
  assert.deepEqual(listAssets(dir), ["/assets/a.css", "/assets/b.js"]);
});

test("the shipped worker only caches successful HTML navigations and falls back to the shell", () => {
  assert.match(source, /res\.ok && !res\.redirected && isHtml\(res\)/);
  assert.match(source, /cache\.match\("\/"\)/);
});

test("activation keeps the current and previous Toduck caches and deletes the rest", async () => {
  const { runInNewContext } = await import("node:vm");
  const stamped = stampWorker(source, ["/assets/a.js"], "fp");
  const sandbox = { self: { addEventListener() {}, location: { origin: "http://x" } }, caches: {}, fetch() {}, URL, Request: class {}, Response: class {}, setTimeout, clearTimeout };
  runInNewContext(stamped, sandbox);
  const current = runInNewContext("CACHE", sandbox);
  assert.deepEqual(runInNewContext("cachesToDelete", sandbox)(["toduck-old", "other", "toduck-prev", current]), ["toduck-old", "other"]);
  assert.deepEqual(runInNewContext("cachesToDelete", sandbox)([current]), []);
});
