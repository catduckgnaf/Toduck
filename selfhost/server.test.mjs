import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createToduckServer, hashToken, loadState, validateToken } from "./server.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";

async function withServer(run, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "toduck-server-"));
  const dataPath = join(dir, "state.json");
  const server = createToduckServer({ token: TOKEN, dataPath, staticDir: dir, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await run({ url, dataPath, dir });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function auth(extra = {}) {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

test("validateToken rejects missing, default, and weak secrets", () => {
  assert.throws(() => validateToken(""), /TODUCK_TOKEN/);
  assert.throws(() => validateToken("change-me"), /TODUCK_TOKEN/);
  assert.throws(() => validateToken("short"), /32 characters/);
  assert.equal(validateToken(TOKEN), TOKEN);
});

test("health is public but state requires the configured token", async () => {
  await withServer(async ({ url }) => {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/v1/state`)).status, 401);
    assert.equal((await fetch(`${url}/v1/state`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const response = await fetch(`${url}/v1/state`, { headers: auth() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("etag"), '"0"');
  });
});

test("writes require the current revision and stale writers receive 409", async () => {
  await withServer(async ({ url }) => {
    const body = JSON.stringify({ tasks: [], categories: [] });
    const missing = await fetch(`${url}/v1/state`, { method: "PUT", headers: auth({ "Content-Type": "application/json" }), body });
    assert.equal(missing.status, 428);

    const first = await fetch(`${url}/v1/state`, {
      method: "PUT",
      headers: auth({ "Content-Type": "application/json", "If-Match": '"0"' }),
      body,
    });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("etag"), '"1"');

    const stale = await fetch(`${url}/v1/state`, {
      method: "PUT",
      headers: auth({ "Content-Type": "application/json", "If-Match": '"0"' }),
      body,
    });
    assert.equal(stale.status, 409);
  });
});

test("oversized bodies receive 413 without killing the server", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/v1/state`, {
      method: "PUT",
      headers: auth({ "Content-Type": "application/json", "If-Match": '"0"' }),
      body: "x".repeat(1_500_001),
    });
    assert.equal(response.status, 413);
    assert.equal((await fetch(`${url}/health`)).status, 200);
  });
});

test("CORS is absent by default and explicit origins are allowlisted", async () => {
  await withServer(async ({ url }) => {
    const rejected = await fetch(`${url}/v1/state`, { headers: auth({ Origin: "https://evil.example" }) });
    assert.equal(rejected.status, 403);
  });
  await withServer(
    async ({ url }) => {
      const allowed = await fetch(`${url}/v1/state`, { headers: auth({ Origin: "https://tasks.example" }) });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get("access-control-allow-origin"), "https://tasks.example");
      assert.equal(allowed.headers.get("access-control-expose-headers"), "ETag");
      const health = await fetch(`${url}/health`, { headers: { Origin: "https://tasks.example" } });
      assert.equal(health.status, 200);
      assert.equal(health.headers.get("access-control-allow-origin"), "https://tasks.example");
    },
    { allowedOrigins: ["https://tasks.example"] },
  );
});

test("security headers are returned for web responses", async () => {
  await withServer(async ({ url, dir }) => {
    await writeFile(join(dir, "index.html"), "<!doctype html><title>Toduck</title>");
    const response = await fetch(`${url}/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self' 'unsafe-inline'/);
  });
});

test("concurrent writes with the same revision result in exactly one winner and one 409", async () => {
  await withServer(async ({ url }) => {
    const makeBody = (title) => JSON.stringify({ tasks: [{ id: "t1", title, notes: "", categoryId: null, date: "2026-09-28", completedAt: null, repeat: { kind: "none" }, createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z" }], categories: [] });
    const [res1, res2] = await Promise.all([
      fetch(`${url}/v1/state`, { method: "PUT", headers: auth({ "Content-Type": "application/json", "If-Match": '"0"' }), body: makeBody("First") }),
      fetch(`${url}/v1/state`, { method: "PUT", headers: auth({ "Content-Type": "application/json", "If-Match": '"0"' }), body: makeBody("Second") }),
    ]);
    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const finalState = await fetch(`${url}/v1/state`, { headers: auth() });
    assert.equal(finalState.headers.get("etag"), '"1"');
  });
});

test("write queue recovers from an individual persistence failure", async () => {
  await withServer(async ({ dir }) => {
    const badPath = join(dir, "cannot-write-here");
    await writeFile(badPath, "existing-file");
    const brokenServer = createToduckServer({ token: TOKEN, dataPath: join(badPath, "nested.json"), staticDir: dir });
    await new Promise((resolve) => brokenServer.listen(0, "127.0.0.1", resolve));
    const brokenUrl = `http://127.0.0.1:${brokenServer.address().port}`;
    try {
      const failed = await fetch(`${brokenUrl}/v1/state`, {
        method: "PUT",
        headers: auth({ "Content-Type": "application/json", "If-Match": '"0"' }),
        body: JSON.stringify({ tasks: [], categories: [] }),
      });
      assert.equal(failed.status, 500);

      const stale = await fetch(`${brokenUrl}/v1/state`, {
        method: "PUT",
        headers: auth({ "Content-Type": "application/json", "If-Match": '"999"' }),
        body: JSON.stringify({ tasks: [], categories: [] }),
      });
      assert.equal(stale.status, 409);
    } finally {
      await new Promise((resolve, reject) => brokenServer.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

test("invalid primary state recovers from the last known good backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "toduck-recovery-"));
  const dataPath = join(dir, "state.json");
  const backup = `${dataPath}.bak`;
  await writeFile(dataPath, "{truncated");
  await writeFile(backup, JSON.stringify({ revision: 4, tasks: [], categories: [] }));
  const state = loadState(dataPath);
  assert.equal(state.revision, 4);
  assert.deepEqual(JSON.parse(await readFile(dataPath, "utf8")), state);
});

const stamp = "2026-09-28T00:00:00.000Z";
function makeTask(id, title, extra = {}) {
  return {
    id,
    title,
    notes: "",
    categoryId: null,
    projectId: null,
    date: null,
    repeat: { kind: "none" },
    done: false,
    completedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
    ownerId: null,
    sharedWith: [],
    ...extra,
  };
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function putState(url, token, revision, body) {
  return fetch(`${url}/v1/state`, {
    method: "PUT",
    headers: { ...bearer(token), "Content-Type": "application/json", "If-Match": `"${revision}"` },
    body: JSON.stringify(body),
  });
}

async function getState(url, token) {
  const response = await fetch(`${url}/v1/state`, { headers: bearer(token) });
  assert.equal(response.status, 200);
  return { body: await response.json(), revision: Number(response.headers.get("etag").replaceAll('"', "")) };
}

async function createUser(url, name) {
  const response = await fetch(`${url}/v1/users`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test("admin creates users; only the token hash is stored and the raw token is shown once", async () => {
  await withServer(async ({ url, dataPath }) => {
    const created = await createUser(url, "Teammate");
    assert.equal(created.name, "Teammate");
    assert.ok(created.id);
    assert.ok(created.token.length >= 32);

    const onDisk = await readFile(dataPath, "utf8");
    assert.ok(!onDisk.includes(created.token), "raw personal token must never be persisted");
    const stored = JSON.parse(onDisk);
    assert.equal(stored.users.length, 1);
    assert.equal(stored.users[0].id, created.id);
    assert.match(stored.users[0].tokenHash, /^[0-9a-f]{64}$/);

    // The directory lists names/ids/roles only, for any authenticated caller.
    const asUser = await fetch(`${url}/v1/users`, { headers: bearer(created.token) });
    assert.equal(asUser.status, 200);
    assert.deepEqual(await asUser.json(), [{ id: created.id, name: "Teammate", role: "user", disabled: false }]);
    assert.equal((await fetch(`${url}/v1/users`)).status, 401);

    // A user token cannot create users; /v1/me reports who a token is.
    const forbidden = await fetch(`${url}/v1/users`, {
      method: "POST",
      headers: { ...bearer(created.token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await (await fetch(`${url}/v1/me`, { headers: bearer(created.token) })).json(), {
      kind: "user",
      id: created.id,
      name: "Teammate",
      role: "user",
      disabled: false,
    });
    assert.deepEqual(await (await fetch(`${url}/v1/me`, { headers: auth() })).json(), { kind: "admin", role: "admin" });
  });
});

test("user tokens see only their own and shared tasks; legacy tasks stay the admin's", async () => {
  await withServer(async ({ url }) => {
    const alice = await createUser(url, "Alice");
    const bob = await createUser(url, "Bob");
    let revision = 0;
    // Alice creates a private task through scoped sync (forged owner ignored).
    let res = await putState(url, alice.token, revision, {
      tasks: [makeTask("a1", "Alice private", { ownerId: bob.id })],
      categories: [],
      projects: [],
    });
    assert.equal(res.status, 200);
    revision = 1;
    // Bob creates his own task.
    res = await putState(url, bob.token, revision, { tasks: [makeTask("b1", "Bob private")], categories: [], projects: [] });
    assert.equal(res.status, 200);
    revision = 2;
    // Admin adds a legacy unowned task.
    res = await putState(url, TOKEN, revision, {
      tasks: [makeTask("a1", "Alice private", { ownerId: alice.id }), makeTask("b1", "Bob private", { ownerId: bob.id }), makeTask("legacy", "Legacy")],
      categories: [],
      projects: [],
    });
    assert.equal(res.status, 200);

    const adminView = await getState(url, TOKEN);
    assert.deepEqual(adminView.body.tasks.map((t) => t.id).sort(), ["a1", "b1", "legacy"]);
    assert.equal(adminView.body.tasks.find((t) => t.id === "a1").ownerId, alice.id);

    const aliceView = await getState(url, alice.token);
    assert.deepEqual(aliceView.body.tasks.map((t) => t.id), ["a1"]);
    const bobView = await getState(url, bob.token);
    assert.deepEqual(bobView.body.tasks.map((t) => t.id), ["b1"]);
  });
});

test("sharing makes a task visible and editable by the other user, who cannot delete, re-own, or re-share it", async () => {
  await withServer(async ({ url }) => {
    const alice = await createUser(url, "Alice");
    const bob = await createUser(url, "Bob");
    // Alice owns a1 and shares it with Bob.
    let res = await putState(url, alice.token, 0, {
      tasks: [makeTask("a1", "Shared chore", { sharedWith: [bob.id] })],
      categories: [],
      projects: [],
    });
    assert.equal(res.status, 200);

    const bobView = await getState(url, bob.token);
    assert.deepEqual(bobView.body.tasks.map((t) => t.id), ["a1"]);

    // Bob edits the shared task's title but tries to steal ownership,
    // re-share it to nobody, and also sends Alice an unrelated forgery.
    res = await putState(url, bob.token, bobView.revision, {
      tasks: [makeTask("a1", "Shared chore, done by Bob", { ownerId: bob.id, sharedWith: [], done: true })],
      categories: [],
      projects: [],
    });
    assert.equal(res.status, 200);
    let adminView = await getState(url, TOKEN);
    const shared = adminView.body.tasks.find((t) => t.id === "a1");
    assert.equal(shared.title, "Shared chore, done by Bob");
    assert.equal(shared.done, true);
    assert.equal(shared.ownerId, alice.id);
    assert.deepEqual(shared.sharedWith, [bob.id]);

    // A tombstone from Bob (how the Web client deletes) is also ignored.
    res = await putState(url, bob.token, adminView.revision, {
      tasks: [makeTask("a1", "Shared chore, done by Bob", { ownerId: alice.id, sharedWith: [bob.id], done: true, deleted: true })],
      categories: [],
      projects: [],
    });
    assert.equal(res.status, 200);
    adminView = await getState(url, TOKEN);
    assert.equal(adminView.body.tasks.find((t) => t.id === "a1").deleted, undefined);

    // Bob's PUT omitting the shared task leaves it untouched.
    res = await putState(url, bob.token, adminView.revision, { tasks: [], categories: [], projects: [] });
    assert.equal(res.status, 200);
    adminView = await getState(url, TOKEN);
    assert.deepEqual(adminView.body.tasks.map((t) => t.id), ["a1"]);

    // Alice's PUT omitting her own task deletes it.
    const aliceView = await getState(url, alice.token);
    res = await putState(url, alice.token, aliceView.revision, { tasks: [], categories: [], projects: [] });
    assert.equal(res.status, 200);
    adminView = await getState(url, TOKEN);
    assert.deepEqual(adminView.body.tasks, []);
  });
});

test("a user PUT preserves other users' tasks exactly, and a deleted user loses access and shares", async () => {
  await withServer(async ({ url }) => {
    const alice = await createUser(url, "Alice");
    const bob = await createUser(url, "Bob");
    const bobTask = makeTask("b1", "Bob's exact task", { notes: "keep me byte-for-byte", sharedWith: [alice.id] });
    let res = await putState(url, bob.token, 0, { tasks: [bobTask], categories: [], projects: [] });
    assert.equal(res.status, 200);

    // Alice syncs (payload contains only what she can see, plus her own new task).
    const aliceView = await getState(url, alice.token);
    res = await putState(url, alice.token, aliceView.revision, {
      tasks: [bobTask, makeTask("a1", "Alice task")],
      categories: [],
      projects: [],
    });
    assert.equal(res.status, 200);
    const adminView = await getState(url, TOKEN);
    assert.deepEqual(adminView.body.tasks.find((t) => t.id === "b1"), { ...bobTask, ownerId: bob.id });

    // Deleting Bob revokes his token. (His own tasks stay stored for the
    // admin; shares *to* him are stripped — covered by Carol below.)
    const deleted = await fetch(`${url}/v1/users/${bob.id}`, { method: "DELETE", headers: auth() });
    assert.equal(deleted.status, 200);
    assert.equal((await fetch(`${url}/v1/state`, { headers: bearer(bob.token) })).status, 401);

    // Alice shares one of her tasks with Carol; deleting Carol unshares it.
    const carol = await createUser(url, "Carol");
    const before = await getState(url, TOKEN);
    res = await putState(url, TOKEN, before.revision, {
      tasks: [...before.body.tasks, makeTask("a2", "Alice shares with Carol", { ownerId: alice.id, sharedWith: [carol.id] })],
      categories: [],
      projects: [],
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await getState(url, carol.token)).body.tasks.map((t) => t.id), ["a2"]);
    const removedCarol = await fetch(`${url}/v1/users/${carol.id}`, { method: "DELETE", headers: auth() });
    assert.equal(removedCarol.status, 200);
    const finalView = await getState(url, TOKEN);
    assert.deepEqual(finalView.body.tasks.find((t) => t.id === "a2").sharedWith, []);
    assert.equal((await fetch(`${url}/v1/state`, { headers: bearer(carol.token) })).status, 401);
    assert.equal((await fetch(`${url}/v1/users/${carol.id}`, { method: "DELETE", headers: auth() })).status, 404);
  });
});

async function rest(url, token, method, path, body) {
  return fetch(`${url}${path}`, {
    method,
    headers: { ...(token ? bearer(token) : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
}

test("REST task API: admin create, list, patch done, delete happy path", async () => {
  await withServer(async ({ url }) => {
    const created = await rest(url, TOKEN, "POST", "/v1/tasks", { title: "Water the plants", date: "2026-10-01", notes: "Balcony too" });
    assert.equal(created.status, 201);
    const task = await created.json();
    assert.ok(task.id);
    assert.equal(task.title, "Water the plants");
    assert.equal(task.notes, "Balcony too");
    assert.equal(task.date, "2026-10-01");
    assert.deepEqual(task.repeat, { kind: "none" });
    assert.equal(task.done, false);
    assert.equal(task.completedAt, null);
    assert.equal(task.ownerId, null);
    assert.deepEqual(task.sharedWith, []);
    assert.ok(task.createdAt && task.createdAt === task.updatedAt);

    const listed = await (await rest(url, TOKEN, "GET", "/v1/tasks")).json();
    assert.deepEqual(listed.tasks.map((t) => t.id), [task.id]);

    const patched = await rest(url, TOKEN, "PATCH", `/v1/tasks/${task.id}`, { done: true });
    assert.equal(patched.status, 200);
    const doneTask = await patched.json();
    assert.equal(doneTask.done, true);
    assert.ok(doneTask.completedAt);
    // A completed task is still listed (only deleted ones are hidden).
    assert.equal((await (await rest(url, TOKEN, "GET", "/v1/tasks")).json()).tasks.length, 1);

    const reopened = await (await rest(url, TOKEN, "PATCH", `/v1/tasks/${task.id}`, { done: false, title: "Water the plants!" })).json();
    assert.equal(reopened.done, false);
    assert.equal(reopened.completedAt, null);
    assert.equal(reopened.title, "Water the plants!");

    const deleted = await rest(url, TOKEN, "DELETE", `/v1/tasks/${task.id}`);
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).deleted, true);
    assert.deepEqual((await (await rest(url, TOKEN, "GET", "/v1/tasks")).json()).tasks, []);
    // The tombstone is in the stored state, like a client delete.
    const stateView = await getState(url, TOKEN);
    assert.equal(stateView.body.tasks.find((t) => t.id === task.id).deleted, true);
    assert.equal((await rest(url, TOKEN, "PATCH", `/v1/tasks/${task.id}`, { done: true })).status, 404);
    assert.equal((await rest(url, TOKEN, "DELETE", `/v1/tasks/${task.id}`)).status, 404);
  });
});

test("REST task API: auth failures are 401 and bad bodies are 400", async () => {
  await withServer(async ({ url }) => {
    assert.equal((await rest(url, null, "GET", "/v1/tasks")).status, 401);
    assert.equal((await rest(url, "wrong-token", "GET", "/v1/tasks")).status, 401);
    assert.equal((await rest(url, null, "POST", "/v1/tasks", { title: "x" })).status, 401);
    assert.equal((await rest(url, TOKEN, "POST", "/v1/tasks", "{not json")).status, 400);
    assert.equal((await rest(url, TOKEN, "POST", "/v1/tasks", {})).status, 400);
    assert.equal((await rest(url, TOKEN, "POST", "/v1/tasks", { title: "   " })).status, 400);
    assert.equal((await rest(url, TOKEN, "POST", "/v1/tasks", { title: "x", date: "01/10/2026" })).status, 400);
    assert.equal((await rest(url, TOKEN, "POST", "/v1/tasks", { title: "x", repeat: { kind: "hourly" } })).status, 400);
    const created = await (await rest(url, TOKEN, "POST", "/v1/tasks", { title: "Real" })).json();
    assert.equal((await rest(url, TOKEN, "PATCH", `/v1/tasks/${created.id}`, "{nope")).status, 400);
    assert.equal((await rest(url, TOKEN, "PATCH", `/v1/tasks/${created.id}`, { done: "yes" })).status, 400);
    assert.equal((await rest(url, TOKEN, "PATCH", "/v1/tasks/does-not-exist", { done: true })).status, 404);
    assert.equal((await rest(url, TOKEN, "DELETE", "/v1/tasks/does-not-exist")).status, 404);
  });
});

test("REST task API: user tokens are scoped; shared tasks patch but do not delete", async () => {
  await withServer(async ({ url }) => {
    const alice = await createUser(url, "Alice");
    const bob = await createUser(url, "Bob");

    // Alice creates through REST: the task is stamped as hers.
    const aliceCreated = await rest(url, alice.token, "POST", "/v1/tasks", { title: "Alice toduck" });
    assert.equal(aliceCreated.status, 201);
    const aliceTask = await aliceCreated.json();
    assert.equal(aliceTask.ownerId, alice.id);

    // Bob creates his own; neither can see the other's in the REST list.
    const bobTask = await (await rest(url, bob.token, "POST", "/v1/tasks", { title: "Bob toduck" })).json();
    assert.deepEqual((await (await rest(url, alice.token, "GET", "/v1/tasks")).json()).tasks.map((t) => t.id), [aliceTask.id]);
    assert.deepEqual((await (await rest(url, bob.token, "GET", "/v1/tasks")).json()).tasks.map((t) => t.id), [bobTask.id]);
    assert.equal((await rest(url, bob.token, "PATCH", `/v1/tasks/${aliceTask.id}`, { done: true })).status, 404);
    assert.equal((await rest(url, bob.token, "DELETE", `/v1/tasks/${aliceTask.id}`)).status, 404);

    // Alice shares her task with Bob through scoped sync.
    const aliceView = await getState(url, alice.token);
    const shareRes = await putState(url, alice.token, aliceView.revision, {
      tasks: [{ ...aliceTask, sharedWith: [bob.id] }],
      categories: [],
      projects: [],
    });
    assert.equal(shareRes.status, 200);

    // Bob now lists it and can patch it (editable by both)…
    assert.deepEqual((await (await rest(url, bob.token, "GET", "/v1/tasks")).json()).tasks.map((t) => t.id).sort(), [aliceTask.id, bobTask.id].sort());
    const bobPatch = await rest(url, bob.token, "PATCH", `/v1/tasks/${aliceTask.id}`, { done: true });
    assert.equal(bobPatch.status, 200);
    assert.equal((await bobPatch.json()).done, true);
    // …but cannot delete it, and cannot forge ownership through PATCH.
    assert.equal((await rest(url, bob.token, "DELETE", `/v1/tasks/${aliceTask.id}`)).status, 403);
    const forge = await (await rest(url, bob.token, "PATCH", `/v1/tasks/${aliceTask.id}`, { title: "Still Alice's" })).json();
    assert.equal(forge.ownerId, alice.id);
    assert.deepEqual(forge.sharedWith, [bob.id]);

    // The admin sees all of it; Alice (owner) can delete her task.
    assert.equal((await (await rest(url, TOKEN, "GET", "/v1/tasks")).json()).tasks.length, 2);
    assert.equal((await rest(url, alice.token, "DELETE", `/v1/tasks/${aliceTask.id}`)).status, 200);
    assert.deepEqual((await (await rest(url, bob.token, "GET", "/v1/tasks")).json()).tasks.map((t) => t.id), [bobTask.id]);
  });
});

test("projects round-trip, and payloads without projects still work and do not wipe them", async () => {
  await withServer(async ({ url }) => {
    const project = { id: "p1", name: "House", createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z" };
    const withProjects = await fetch(`${url}/v1/state`, {
      method: "PUT",
      headers: auth({ "Content-Type": "application/json", "If-Match": '"0"' }),
      body: JSON.stringify({ tasks: [], categories: [], projects: [project] }),
    });
    assert.equal(withProjects.status, 200);

    const read = await fetch(`${url}/v1/state`, { headers: auth() });
    const body = await read.json();
    assert.deepEqual(body.projects, [project]);

    // An older client PUTs without projects: accepted, projects preserved.
    const legacy = await fetch(`${url}/v1/state`, {
      method: "PUT",
      headers: auth({ "Content-Type": "application/json", "If-Match": '"1"' }),
      body: JSON.stringify({ tasks: [], categories: [] }),
    });
    assert.equal(legacy.status, 200);
    const after = await (await fetch(`${url}/v1/state`, { headers: auth() })).json();
    assert.deepEqual(after.projects, [project]);
  });

  // A fresh server answers projects as an empty array.
  await withServer(async ({ url }) => {
    const body = await (await fetch(`${url}/v1/state`, { headers: auth() })).json();
    assert.deepEqual(body.projects, []);
  });
});

async function createUserWithRole(url, name, role) {
  const response = await fetch(`${url}/v1/users`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ name, role }),
  });
  assert.equal(response.status, 201, `create ${name} as ${role}`);
  return response.json();
}

test("roles: admin-role users manage users, user-role users cannot, disabled users get 401", async () => {
  await withServer(async ({ url }) => {
    const secondAdmin = await createUserWithRole(url, "Second Admin", "admin");
    assert.equal(secondAdmin.role, "admin");
    const plain = await createUserWithRole(url, "Plain", "user");
    assert.equal(plain.role, "user");
    const defaulted = await createUser(url, "Defaulted");
    assert.equal(defaulted.role, "user");

    const directory = await (await fetch(`${url}/v1/users`, { headers: auth() })).json();
    const byName = Object.fromEntries(directory.map((user) => [user.name, user]));
    assert.equal(byName["Second Admin"].role, "admin");
    assert.equal(byName["Plain"].role, "user");
    assert.equal(byName["Defaulted"].role, "user");
    assert.equal(byName["Plain"].disabled, false);

    // A user-role token cannot create users; an admin-role one can.
    const forbidden = await fetch(`${url}/v1/users`, {
      method: "POST",
      headers: { ...bearer(plain.token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });
    assert.equal(forbidden.status, 403);
    const allowed = await fetch(`${url}/v1/users`, {
      method: "POST",
      headers: { ...bearer(secondAdmin.token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Made By Admin" }),
    });
    assert.equal(allowed.status, 201);

    // Invalid roles are rejected at create and at patch.
    const badCreate = await fetch(`${url}/v1/users`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad", role: "superuser" }),
    });
    assert.equal(badCreate.status, 400);
    const badPatch = await fetch(`${url}/v1/users/${plain.id}`, {
      method: "PATCH",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ role: "root" }),
    });
    assert.equal(badPatch.status, 400);
    const missing = await fetch(`${url}/v1/users/does-not-exist`, {
      method: "PATCH",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(missing.status, 404);
    const empty = await fetch(`${url}/v1/users/${plain.id}`, {
      method: "PATCH",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);

    // Disable the plain user: their token stops working everywhere.
    const patched = await fetch(`${url}/v1/users/${plain.id}`, {
      method: "PATCH",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(await patched.json(), { id: plain.id, name: "Plain", role: "user", disabled: true });
    for (const path of ["/v1/state", "/v1/me", "/v1/tasks", "/v1/users"]) {
      assert.equal((await fetch(`${url}${path}`, { headers: bearer(plain.token) })).status, 401, path);
    }
    // A non-admin cannot patch users; an admin-role user can re-enable.
    assert.equal(
      (await fetch(`${url}/v1/users/${plain.id}`, {
        method: "PATCH",
        headers: { ...bearer(defaulted.token), "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: false }),
      })).status,
      403,
    );
    const reenabled = await fetch(`${url}/v1/users/${plain.id}`, {
      method: "PATCH",
      headers: { ...bearer(secondAdmin.token), "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: false }),
    });
    assert.equal(reenabled.status, 200);
    assert.equal((await fetch(`${url}/v1/state`, { headers: bearer(plain.token) })).status, 200);
    assert.deepEqual(await (await fetch(`${url}/v1/me`, { headers: bearer(plain.token) })).json(), {
      kind: "user",
      id: plain.id,
      name: "Plain",
      role: "user",
      disabled: false,
    });
  });
});

test("a user PUT cannot replace categories or projects (#45)", async () => {
  await withServer(async ({ url }) => {
    const alice = await createUser(url, "Alice");
    const cat1 = { id: "c1", name: "Home", createdAt: stamp, updatedAt: stamp };
    const proj1 = { id: "p1", name: "House", createdAt: stamp, updatedAt: stamp };
    let res = await putState(url, TOKEN, 0, { tasks: [], categories: [cat1], projects: [proj1] });
    assert.equal(res.status, 200);
    // Alice renames c1, drops p1, and adds her own c2/p2.
    const cat1Renamed = { ...cat1, name: "Renamed by Alice" };
    const cat2 = { id: "c2", name: "Alice tag", createdAt: stamp, updatedAt: stamp };
    const proj2 = { id: "p2", name: "Alice project", createdAt: stamp, updatedAt: stamp };
    res = await putState(url, alice.token, 1, { tasks: [], categories: [cat1Renamed, cat2], projects: [proj2] });
    assert.equal(res.status, 200);
    let state = await getState(url, TOKEN);
    assert.deepEqual(state.body.categories.map((c) => c.name), ["Home", "Alice tag"]);
    assert.deepEqual(state.body.projects.map((p) => p.name), ["House", "Alice project"]);
    // The admin token still replaces wholesale.
    res = await putState(url, TOKEN, state.revision, { tasks: [], categories: [], projects: [] });
    assert.equal(res.status, 200);
    state = await getState(url, TOKEN);
    assert.deepEqual(state.body.categories, []);
    assert.deepEqual(state.body.projects, []);
  });
});

test("deleting a user bumps the revision and reassigns their tasks to the admin (#50)", async () => {
  await withServer(async ({ url }) => {
    const alice = await createUser(url, "Alice");
    const bob = await createUser(url, "Bob");
    let res = await putState(url, alice.token, 0, {
      tasks: [makeTask("a1", "Alice task", { ownerId: alice.id, sharedWith: [bob.id] })],
      categories: [],
      projects: [],
    });
    assert.equal(res.status, 200);
    const before = await getState(url, TOKEN);
    const deleted = await fetch(`${url}/v1/users/${alice.id}`, { method: "DELETE", headers: auth() });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { ok: true, revision: before.revision + 1 });
    const after = await getState(url, TOKEN);
    assert.equal(after.revision, before.revision + 1);
    const task = after.body.tasks.find((t) => t.id === "a1");
    assert.equal(task.ownerId, null);
    assert.deepEqual(task.sharedWith, [bob.id]);
    // A stale client PUT with the pre-delete revision gets 409, so it
    // cannot write Alice's id back into sharedWith.
    const stale = await putState(url, TOKEN, before.revision, { tasks: [], categories: [], projects: [] });
    assert.equal(stale.status, 409);
    // Even an admin PUT naming the removed id has it sanitized away.
    res = await putState(url, TOKEN, after.revision, {
      tasks: [makeTask("a1", "Alice task", { ownerId: alice.id, sharedWith: [alice.id, bob.id] })],
      categories: [],
      projects: [],
    });
    assert.equal(res.status, 200);
    const rewritten = await getState(url, TOKEN);
    const again = rewritten.body.tasks.find((t) => t.id === "a1");
    assert.equal(again.ownerId, null);
    assert.deepEqual(again.sharedWith, [bob.id]);
  });
});

test("a shared user cannot undelete the owner's tombstoned task (#51)", async () => {
  await withServer(async ({ url }) => {
    const alice = await createUser(url, "Alice");
    const bob = await createUser(url, "Bob");
    let res = await putState(url, alice.token, 0, {
      tasks: [makeTask("a1", "Shared", { ownerId: alice.id, sharedWith: [bob.id] })],
      categories: [],
      projects: [],
    });
    assert.equal(res.status, 200);
    let view = await getState(url, TOKEN);
    // Alice tombstones her task.
    res = await putState(url, alice.token, view.revision, {
      tasks: [makeTask("a1", "Shared", { ownerId: alice.id, sharedWith: [bob.id], deleted: true })],
      categories: [],
      projects: [],
    });
    assert.equal(res.status, 200);
    // Bob syncs a stale live copy: the tombstone must stand.
    view = await getState(url, TOKEN);
    res = await putState(url, bob.token, view.revision, {
      tasks: [makeTask("a1", "Shared", { ownerId: alice.id, sharedWith: [bob.id] })],
      categories: [],
      projects: [],
    });
    assert.equal(res.status, 200);
    view = await getState(url, TOKEN);
    assert.equal(view.body.tasks.find((t) => t.id === "a1").deleted, true);
    // The owner themself may still undelete it.
    res = await putState(url, alice.token, view.revision, {
      tasks: [makeTask("a1", "Shared", { ownerId: alice.id, sharedWith: [bob.id] })],
      categories: [],
      projects: [],
    });
    assert.equal(res.status, 200);
    view = await getState(url, TOKEN);
    assert.equal(view.body.tasks.find((t) => t.id === "a1").deleted, undefined);
  });
});
// Issue #102: the Web UI has no client-side gate that protects data, so the
// server must refuse every data route without a valid bearer token. These
// tests enumerate the whole /v1 surface and match selfhost/go/server_test.go.

const PROTECTED_ROUTES = [
  ["GET", "/v1/state", undefined],
  ["PUT", "/v1/state", { tasks: [], categories: [] }],
  ["GET", "/v1/me", undefined],
  ["GET", "/v1/users", undefined],
  ["POST", "/v1/users", { name: "x" }],
  ["DELETE", "/v1/users/someone", undefined],
  ["GET", "/v1/tasks", undefined],
  ["POST", "/v1/tasks", { title: "x" }],
  ["PATCH", "/v1/tasks/abc", { done: true }],
  ["DELETE", "/v1/tasks/abc", undefined],
  // Paths no route claims must not fall through to the Web UI shell.
  ["GET", "/v1", undefined],
  ["GET", "/v1/", undefined],
  ["GET", "/v1/unknown", undefined],
  ["POST", "/v1/state/extra", {}],
  ["HEAD", "/v1/tasks/abc/extra", undefined],
];

test("every API route rejects missing and wrong credentials with 401", async () => {
  await withServer(async ({ url }) => {
    const credentials = {
      "no token": "",
      "wrong token": "not-the-token",
      "admin token minus 1": TOKEN.slice(0, -1),
      "admin token plus 1": `${TOKEN}x`,
      "hash of admin token": hashToken(TOKEN),
      "admin token reversed": [...TOKEN].reverse().join(""),
    };
    for (const [name, token] of Object.entries(credentials)) {
      for (const [method, path, body] of PROTECTED_ROUTES) {
        const response = await rest(url, token, method, path, body);
        const text = await response.text();
        assert.equal(response.status, 401, `${name}: ${method} ${path}`);
        assert.ok(!text.includes("<html"), `${name}: ${method} ${path} returned the Web UI shell`);
      }
    }
  });
});

test("data is never served without a token even when the Web UI shell exists", async () => {
  await withServer(async ({ url, dir }) => {
    await writeFile(join(dir, "index.html"), "<html>shell</html>");
    const seeded = await rest(url, TOKEN, "POST", "/v1/tasks", { title: "Private note" });
    assert.equal(seeded.status, 201);
    // The shell is public by design and carries no task data.
    const shell = await fetch(`${url}/`);
    assert.equal(shell.status, 200);
    assert.ok(!(await shell.text()).includes("Private note"));
    for (const path of ["/v1/state", "/v1/tasks", "/v1/anything"]) {
      const response = await rest(url, "", "GET", path);
      const text = await response.text();
      assert.equal(response.status, 401, path);
      assert.ok(!text.includes("Private note") && !text.includes("<html"), path);
    }
    // With the token, an unknown API path is a JSON 404, not the shell.
    const unknown = await rest(url, TOKEN, "GET", "/v1/anything");
    assert.equal(unknown.status, 404);
    assert.ok(!(await unknown.text()).includes("<html"));
  });
});

test("a deleted user's personal token is revoked immediately on every route", async () => {
  await withServer(async ({ url }) => {
    const alice = await createUser(url, "Alice");
    assert.equal((await rest(url, alice.token, "POST", "/v1/tasks", { title: "Alice only" })).status, 201);
    for (const [method, path, body] of PROTECTED_ROUTES.slice(0, 4)) {
      const response = await rest(url, alice.token, method, path, body);
      assert.notEqual(response.status, 401, `live token rejected on ${method} ${path}`);
    }
    assert.equal((await rest(url, TOKEN, "DELETE", `/v1/users/${alice.id}`)).status, 200);
    for (const [method, path, body] of PROTECTED_ROUTES) {
      const response = await rest(url, alice.token, method, path, body);
      assert.equal(response.status, 401, `revoked token: ${method} ${path}`);
    }
  });
});

test("a personal token cannot use admin-only routes or read other users' tasks", async () => {
  await withServer(async ({ url }) => {
    const alice = await createUser(url, "Alice");
    const bob = await createUser(url, "Bob");
    await rest(url, alice.token, "POST", "/v1/tasks", { title: "Alice secret" });
    await rest(url, TOKEN, "POST", "/v1/tasks", { title: "Admin legacy" });
    assert.equal((await rest(url, bob.token, "POST", "/v1/users", { name: "Mallory" })).status, 403);
    assert.equal((await rest(url, bob.token, "DELETE", `/v1/users/${alice.id}`)).status, 403);
    for (const path of ["/v1/state", "/v1/tasks"]) {
      const response = await rest(url, bob.token, "GET", path);
      assert.equal(response.status, 200, path);
      const text = await response.text();
      assert.ok(!text.includes("Alice secret") && !text.includes("Admin legacy"), `${path} leaked: ${text}`);
    }
  });
});

test("CORS and origin checks never stand in for authentication", async () => {
  await withServer(
    async ({ url }) => {
      const foreign = await fetch(`${url}/v1/state`, { headers: { ...auth(), Origin: "https://evil.example" } });
      assert.equal(foreign.status, 403);
      const allowedNoToken = await fetch(`${url}/v1/state`, { headers: { Origin: "https://allowed.example" } });
      assert.equal(allowedNoToken.status, 401);
      const foreignUnknown = await fetch(`${url}/v1/unknown`, { headers: { Origin: "https://evil.example" } });
      assert.equal(foreignUnknown.status, 403);
    },
    { allowedOrigins: ["https://allowed.example"] },
  );
});
