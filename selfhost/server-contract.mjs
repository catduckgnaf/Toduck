// Shared behavioral contract for the Node reference and shipped Go server.
// Run via: node --test selfhost/server-contract.mjs (requires Go in PATH).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createToduckServer } from "./server.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";
const SHELL = "<!doctype html><title>Toduck contract</title>";
const ASSET = "console.log('contract');";
const goDir = resolve(dirname(fileURLToPath(import.meta.url)), "go");

async function freePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function startGo(dir, staticDir) {
  const binary = join(dir, "toduck-go");
  execFileSync("go", ["build", "-o", binary, "."], { cwd: goDir });
  const port = await freePort();
  const process = spawn(binary, [], {
    cwd: goDir,
    env: { ...globalThis.process.env, TODUCK_TOKEN: TOKEN, DATA_PATH: join(dir, "go-state.json"), STATIC_DIR: staticDir, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  process.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.exitCode !== null) throw new Error(`Go server exited during startup: ${errors}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.status === 200) return { process, url };
    } catch {
      // Server startup can follow the compile step by a few milliseconds.
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  process.kill();
  throw new Error(`Go server did not become healthy: ${errors}`);
}

async function api(base, method, path, body) {
  return fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body }),
  });
}

async function sampleContract(url) {
  const intervals = [
    ['{"title":"Float","repeat":{"kind":"interval","every":2.0}}', { kind: "interval", every: 2, unit: "day" }],
    ['{"title":"String","repeat":{"kind":"interval","every":"3"}}', { kind: "interval", every: 3, unit: "day" }],
    ['{"title":"Coerce","repeat":{"kind":"interval","every":"1000","unit":"week"}}', { kind: "interval", every: 99, unit: "week" }],
    ...[
      ["0x10", 16], ["0XFF", 99], ["0b101", 5], ["0o17", 15],
      ["  3.9e1  ", 39], ["Infinity", 99], ["1e999", 99],
      ["0x100000000000000000000", 99], ["0xG", 1],
      ["+0x10", 1], ["0b102", 1], ["1_0", 1], ["Inf", 1], ["0x1p4", 1],
    ].map(([every, expected]) => [
      JSON.stringify({ title: "Numeric string", repeat: { kind: "interval", every } }),
      { kind: "interval", every: expected, unit: "day" },
    ]),
    ['{"title":"Days","repeat":{"kind":"days","days":[1,2.5,"3",3,1,7,-1]}}', { kind: "days", days: [1, 3] }],
  ];
  const result = [];
  let firstTaskId;
  for (const [payload, expected] of intervals) {
    const response = await api(url, "POST", "/v1/tasks", payload);
    const task = await response.json();
    assert.equal(response.status, 201, payload);
    assert.deepEqual(task.repeat, expected, payload);
    result.push({ status: response.status, repeat: task.repeat });
    firstTaskId ??= task.id;
  }
  const done = await api(url, "PATCH", `/v1/tasks/${firstTaskId}`, '{"done":null}');
  result.push({ status: done.status, error: (await done.json()).error });
  assert.equal(done.status, 400);

  for (const [path, headers, expectedBody] of [
    ["/index.html", {}, SHELL],
    ["/index.html", { Range: "bytes=0-3" }, SHELL],
    ["/index.html", { "If-Modified-Since": "Wed, 01 Jan 2100 00:00:00 GMT" }, SHELL],
    ["/x/foo.bar-baz", {}, SHELL],
    ["/assets/app.js", { Range: "bytes=0-3" }, ASSET],
  ]) {
    const response = await fetch(url + path, { headers });
    const body = await response.text();
    assert.equal(response.status, 200, path);
    assert.equal(body, expectedBody, path);
    assert.equal(response.headers.get("last-modified"), null, path);
    result.push({ path, status: response.status, body });
  }
  return result;
}

test("Node and Go servers honor the same repeat, done and static response contract (#55)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "toduck-contract-"));
  const staticDir = join(dir, "static");
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await writeFile(join(staticDir, "index.html"), SHELL);
  await writeFile(join(staticDir, "assets", "app.js"), ASSET);
  const nodeServer = createToduckServer({ token: TOKEN, dataPath: join(dir, "node-state.json"), staticDir });
  await new Promise((done) => nodeServer.listen(0, "127.0.0.1", done));
  let goServer;
  try {
    goServer = await startGo(dir, staticDir);
    const nodeUrl = `http://127.0.0.1:${nodeServer.address().port}`;
    const nodeResults = await sampleContract(nodeUrl);
    const goResults = await sampleContract(goServer.url);
    assert.deepEqual(goResults, nodeResults);
  } finally {
    await new Promise((done) => nodeServer.close(done));
    if (goServer?.process && goServer.process.exitCode === null) {
      goServer.process.kill();
      await once(goServer.process, "exit");
    }
  }
});
