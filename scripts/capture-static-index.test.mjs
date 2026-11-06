import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { missingAssets } from "./capture-static-index.mjs";

test("static shell must point at files that exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "toduck-static-"));
  await writeFile(join(dir, "app.js"), "export {}");
  const html = '<script type="module" src="/app.js"></script><link rel="stylesheet" href="/missing.css">';
  assert.deepEqual(missingAssets(html, dir), ["/missing.css"]);
});
