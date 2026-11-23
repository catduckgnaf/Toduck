import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentTypeFor, resolveStaticPath } from "./static-handler.mjs";

const DEFAULT_MAX_BODY = 1_500_000;
// 'unsafe-inline' in script-src is required: the built Web UI's index.html
// carries first-party inline bootstrap scripts (TanStack Start hydration).
// Without it the served app renders blank. All scripts are own build output.
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://grok.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' https://grok.com",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export function validateToken(raw) {
  const token = String(raw || "");
  if (!token || token === "change-me") throw new Error("TODUCK_TOKEN must be explicitly configured.");
  if (Buffer.byteLength(token) < 32) throw new Error("TODUCK_TOKEN must be at least 32 characters long.");
  return token;
}

function emptyState() {
  return { revision: 0, tasks: [], categories: [], projects: [], users: [] };
}

function isUserRecord(value) {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.tokenHash === "string"
  );
}

/**
 * Roles (#107): "admin" users may manage users; "user" is the default.
 * Records written before roles existed read as user/enabled, so existing
 * single-user state migrates on first load without wiping anything.
 */
function normalizeUserRecord(value) {
  const role = value.role === undefined ? "user" : value.role;
  if (role !== "admin" && role !== "user") throw new Error("State user role must be admin or user.");
  return { id: value.id, name: value.name, tokenHash: value.tokenHash, role, disabled: value.disabled === true };
}

function normalizeState(value) {
  if (!value || typeof value !== "object") throw new Error("State must be an object.");
  if (!Array.isArray(value.tasks) || !Array.isArray(value.categories)) throw new Error("State must include tasks and categories arrays.");
  // Projects are optional: state files and clients from before projects
  // existed have no projects array, which reads as an empty one.
  if (value.projects !== undefined && !Array.isArray(value.projects)) throw new Error("State projects must be an array when present.");
  // Users are optional for the same reason: older state files have none.
  if (value.users !== undefined && (!Array.isArray(value.users) || !value.users.every(isUserRecord))) {
    throw new Error("State users must be an array of user records when present.");
  }
  return {
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    tasks: value.tasks,
    categories: value.categories,
    projects: value.projects ?? [],
    users: (value.users ?? []).map(normalizeUserRecord),
  };
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

/** Names, ids and roles only — never token hashes. */
function publicUsers(state) {
  return state.users.map((user) => ({ id: user.id, name: user.name, role: user.role ?? "user", disabled: user.disabled === true }));
}

function publicUser(user) {
  return { id: user.id, name: user.name, role: user.role ?? "user", disabled: user.disabled === true };
}

/** The admin token, or a personal token with the admin role, may manage users. */
function isManager(auth) {
  return auth.kind === "admin" || auth.user?.role === "admin";
}

function taskOwnerId(task) {
  return typeof task?.ownerId === "string" ? task.ownerId : null;
}

function taskSharedWith(task) {
  return Array.isArray(task?.sharedWith) ? task.sharedWith.filter((id) => typeof id === "string") : [];
}

function visibleToUser(task, userId) {
  return taskOwnerId(task) === userId || taskSharedWith(task).includes(userId);
}

const REPEAT_KINDS = new Set(["none", "daily", "weekdays", "weekly", "monthly", "interval", "days"]);

/** Mirror normalizeRepeat in src/lib/toduck/model.ts; null = not a repeat shape at all. */
function normalizeRepeatInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !REPEAT_KINDS.has(value.kind)) return null;
  switch (value.kind) {
    case "interval": {
      const every = Math.min(99, Math.max(1, Math.floor(Number(value.every)) || 1));
      const unit = value.unit === "week" || value.unit === "month" ? value.unit : "day";
      return { kind: "interval", every, unit };
    }
    case "days": {
      if (!Array.isArray(value.days)) return null;
      const days = [...new Set(value.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
      return { kind: "days", days };
    }
    default:
      return { kind: value.kind };
  }
}

function isDateKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isNullableId(value) {
  return value === null || typeof value === "string";
}

/**
 * Build a stored task from a REST POST body, mirroring the Web client's
 * addTask shape/defaults (src/lib/toduck/store.ts). ownerId is stamped
 * from the caller's token by the handler, never taken from the body.
 * Returns { task } or { error }.
 */
function restTaskFromBody(parsed, ownerId) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "Invalid JSON" };
  const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 200) : "";
  if (!title) return { error: "A task title is required" };
  if (parsed.notes !== undefined && typeof parsed.notes !== "string") return { error: "notes must be a string" };
  const notes = (parsed.notes ?? "").trim().slice(0, 20_000);
  const date = parsed.date === undefined ? null : parsed.date;
  if (!(date === null || isDateKey(date))) return { error: "date must be YYYY-MM-DD or null" };
  const categoryId = parsed.categoryId === undefined ? null : parsed.categoryId;
  if (!isNullableId(categoryId)) return { error: "categoryId must be a string or null" };
  const projectId = parsed.projectId === undefined ? null : parsed.projectId;
  if (!isNullableId(projectId)) return { error: "projectId must be a string or null" };
  const repeat = parsed.repeat === undefined ? { kind: "none" } : normalizeRepeatInput(parsed.repeat);
  if (!repeat) return { error: "Invalid repeat" };
  const now = new Date().toISOString();
  return {
    task: {
      id: randomUUID(),
      title,
      notes,
      categoryId,
      projectId,
      date,
      repeat,
      done: false,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      ownerId,
      sharedWith: [],
    },
  };
}

/**
 * Validate a REST PATCH body into a patch object holding only the fields
 * the caller actually sent. Ownership/sharing fields are not patchable.
 * Returns { patch } or { error }.
 */
function restPatchFromBody(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "Invalid JSON" };
  const has = (key) => Object.prototype.hasOwnProperty.call(parsed, key);
  const patch = {};
  if (has("title")) {
    const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 200) : "";
    if (!title) return { error: "A task title is required" };
    patch.title = title;
  }
  if (has("notes")) {
    if (typeof parsed.notes !== "string") return { error: "notes must be a string" };
    patch.notes = parsed.notes.slice(0, 20_000);
  }
  if (has("date")) {
    if (!(parsed.date === null || isDateKey(parsed.date))) return { error: "date must be YYYY-MM-DD or null" };
    patch.date = parsed.date;
  }
  if (has("categoryId")) {
    if (!isNullableId(parsed.categoryId)) return { error: "categoryId must be a string or null" };
    patch.categoryId = parsed.categoryId;
  }
  if (has("projectId")) {
    if (!isNullableId(parsed.projectId)) return { error: "projectId must be a string or null" };
    patch.projectId = parsed.projectId;
  }
  if (has("done")) {
    if (typeof parsed.done !== "boolean") return { error: "done must be a boolean" };
    patch.done = parsed.done;
  }
  return { patch };
}

function applyRestPatch(current, patch) {
  const now = new Date().toISOString();
  const next = { ...current, ...patch, updatedAt: now };
  if (patch.done !== undefined && patch.done !== current.done) {
    next.completedAt = patch.done ? now : null;
  }
  return next;
}

function taskVisibleForRest(task, auth) {
  if (!task || task.deleted) return false;
  return auth.kind === "admin" || visibleToUser(task, auth.user.id);
}

/** Keep only ids of registered users, de-duplicated. */
function sanitizeSharedWith(value, state) {
  const known = new Set(state.users.map((user) => user.id));
  return [...new Set(taskSharedWith({ sharedWith: value }))].filter((id) => known.has(id));
}

/**
 * Merge shared items (categories/projects) by id (#45): a user token's
 * PUT keeps every stored entry exactly and only adds entries with ids
 * the stored state has never seen — it can never rename or delete an
 * entry it does not own. Entries without a string id are dropped.
 */
function mergeSharedItems(stored, incoming) {
  const seen = new Set(stored.map((item) => item?.id));
  const merged = [...stored];
  for (const item of incoming ?? []) {
    if (!item || typeof item.id !== "string" || seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

/**
 * Drop references to users who no longer exist from an admin PUT's tasks
 * (#50): sharedWith entries naming a removed user are dropped, and an
 * ownerId naming a removed user is cleared so the task falls back to the
 * admin instead of being orphaned again.
 */
function sanitizeTasksSharedWith(tasks, state) {
  const known = new Set(state.users.map((user) => user.id));
  return tasks.map((task) => ({
    ...task,
    ownerId: taskOwnerId(task) !== null && !known.has(taskOwnerId(task)) ? null : taskOwnerId(task),
    sharedWith: sanitizeSharedWith(taskSharedWith(task), state),
  }));
}

/**
 * Merge a user token's PUT into the stored state. The requester only ever
 * sees tasks they own or that are shared with them, so:
 * - tasks they cannot see are preserved exactly as stored;
 * - a task they own that is missing from the payload is deleted;
 * - a shared task missing from the payload is left untouched (only the
 *   owner can delete it);
 * - ownerId is stamped from the stored task (or the requester for new
 *   tasks) — a client can never forge or move ownership;
 * - sharedWith changes only for tasks the requester owns.
 */
function mergeUserState(state, parsed, userId) {
  const incomingById = new Map();
  for (const task of parsed.tasks) {
    if (task && typeof task.id === "string" && !incomingById.has(task.id)) incomingById.set(task.id, task);
  }
  const storedIds = new Set(state.tasks.map((task) => task?.id));
  const handled = new Set();
  const tasks = [];
  for (const stored of state.tasks) {
    const incoming = incomingById.get(stored?.id);
    if (!visibleToUser(stored, userId)) {
      if (incoming) handled.add(stored.id);
      tasks.push(stored);
      continue;
    }
    if (!incoming) {
      // Own task omitted from the payload: deleted. Shared task omitted:
      // not the requester's to delete, keep it.
      if (taskOwnerId(stored) !== userId) tasks.push(stored);
      continue;
    }
    handled.add(stored.id);
    const isOwner = taskOwnerId(stored) === userId;
    // A shared user can never resurrect the owner's tombstoned task: a
    // live copy from them is ignored and the tombstone stands (#51). The
    // owner themself may still undelete their own task.
    if (!isOwner && stored.deleted) {
      tasks.push(stored);
      continue;
    }
    // A shared user cannot delete the owner's task: a tombstone from them
    // is ignored (the Web client deletes by tombstone, not by omission).
    if (!isOwner && incoming.deleted && !stored.deleted) {
      tasks.push(stored);
      continue;
    }
    tasks.push({
      ...incoming,
      ownerId: taskOwnerId(stored),
      sharedWith: isOwner
        ? incoming.sharedWith === undefined
          ? taskSharedWith(stored)
          : sanitizeSharedWith(incoming.sharedWith, state)
        : taskSharedWith(stored),
    });
  }
  for (const incoming of parsed.tasks) {
    if (!incoming || typeof incoming.id !== "string" || handled.has(incoming.id) || storedIds.has(incoming.id)) continue;
    handled.add(incoming.id);
    tasks.push({ ...incoming, ownerId: userId, sharedWith: sanitizeSharedWith(incoming.sharedWith, state) });
  }
  // Categories and projects are shared, not owned: a user token's PUT
  // merges them by id (#45) instead of replacing them wholesale.
  return {
    revision: state.revision + 1,
    tasks,
    categories: mergeSharedItems(state.categories, parsed.categories),
    projects: parsed.projects === undefined ? state.projects : mergeSharedItems(state.projects, parsed.projects),
    users: state.users,
  };
}

function readStateFile(path) {
  return normalizeState(JSON.parse(readFileSync(path, "utf8")));
}

export function loadState(dataPath) {
  if (!existsSync(dataPath)) return emptyState();
  try {
    return readStateFile(dataPath);
  } catch (primaryError) {
    const backupPath = `${dataPath}.bak`;
    try {
      const recovered = readStateFile(backupPath);
      writeFileSync(dataPath, JSON.stringify(recovered));
      console.warn(`Recovered invalid primary state from ${backupPath}: ${primaryError.message}`);
      return recovered;
    } catch {
      throw new Error(`State file is invalid and no usable backup exists: ${primaryError.message}`);
    }
  }
}

function persistState(dataPath, state) {
  mkdirSync(dirname(dataPath), { recursive: true });
  const tmpPath = `${dataPath}.tmp`;
  const backupPath = `${dataPath}.bak`;
  writeFileSync(tmpPath, JSON.stringify(state));
  if (existsSync(dataPath)) copyFileSync(dataPath, backupPath);
  renameSync(tmpPath, dataPath);
  if (!existsSync(backupPath)) copyFileSync(dataPath, backupPath);
}

function etag(revision) {
  return `"${revision}"`;
}

function parseRevision(header) {
  const match = /^"(\d+)"$/.exec(String(header || ""));
  return match ? Number(match[1]) : null;
}

function tokenMatches(expected, authorization) {
  const supplied = String(authorization || "").replace(/^Bearer\s+/i, "");
  const expectedDigest = createHash("sha256").update(expected).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function bearerToken(authorization) {
  return String(authorization || "").replace(/^Bearer\s+/i, "");
}

/**
 * Resolve a request's credential: the TODUCK_TOKEN is the admin (full,
 * legacy access); a registered user's personal token scopes state access
 * to that user. Returns null when neither matches.
 */
function authenticate(state, configuredToken, authorization) {
  if (tokenMatches(configuredToken, authorization)) return { kind: "admin" };
  const suppliedHash = hashToken(bearerToken(authorization));
  const suppliedDigest = Buffer.from(suppliedHash, "utf8");
  for (const user of state.users) {
    // A disabled user's token stops working everywhere, until an admin
    // re-enables them.
    if (user.disabled === true) continue;
    const storedDigest = Buffer.from(user.tokenHash, "utf8");
    if (storedDigest.length === suppliedDigest.length && timingSafeEqual(storedDigest, suppliedDigest)) {
      return { kind: "user", user };
    }
  }
  return null;
}

function readBody(req, maxBody) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBody) {
        settled = true;
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function send(res, status, body, type = "application/json; charset=utf-8", headers = {}, headOnly = false) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(headOnly ? undefined : body);
}

export function createToduckServer({ token, dataPath = "/data/state.json", staticDir = "/app/static", maxBody = DEFAULT_MAX_BODY, allowedOrigins = [] } = {}) {
  const configuredToken = validateToken(token);
  const origins = new Set(allowedOrigins.filter(Boolean));
  let state = loadState(dataPath);
  let writing = Promise.resolve();

  function corsHeaders(req) {
    const origin = req.headers.origin;
    return origin && origins.has(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Expose-Headers": "ETag",
          Vary: "Origin",
        }
      : {};
  }

  /**
   * Is this Origin the same origin as the request's own host? Browsers send
   * an Origin header on same-origin PUT/POST/PATCH/DELETE, so the bundled
   * Web UI would otherwise be rejected unless its own origin was
   * allow-listed (#36). The Host header is the request's own host — a
   * reverse proxy forwards the public host, so this holds behind one too.
   * Scheme is not part of the comparison beyond the default port it
   * implies, because a proxy may terminate TLS in front of a plain-http
   * server. X-Forwarded-Host is deliberately NOT consulted: any client
   * can send it, so trusting it would let a foreign origin vouch for
   * itself. This is only an origin allowlist — every API call still
   * needs its bearer token, so it grants nothing by itself.
   */
  function isSameOrigin(origin, req) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return false;
    const defaultPort = parsed.protocol === "https:" ? "443" : "80";
    const originPort = parsed.port || defaultPort;
    let host;
    try {
      host = new URL(`http://${req.headers.host}`);
    } catch {
      return false;
    }
    return host.hostname.toLowerCase() === parsed.hostname.toLowerCase() && (host.port || defaultPort) === originPort;
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    return !origin || origins.has(origin) || isSameOrigin(origin, req);
  }

  function serveStatic(req, res, pathname) {
    const filePath = resolveStaticPath(staticDir, pathname === "/" ? "/index.html" : pathname);
    if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
      const isAsset = pathname.startsWith("/assets/") || pathname.startsWith("/__grok/");
      // The SPA shell carries a marker so the Web UI can tell a Toduck
      // server from any other host serving the same files (#106): the
      // client probes the shell, which always exists, instead of an
      // endpoint that may 404 and log a console error.
      const shellHeaders = filePath.endsWith("index.html") ? { "X-Toduck-Server": "1" } : {};
      send(res, 200, readFileSync(filePath), contentTypeFor(filePath), { "Cache-Control": isAsset ? "public, max-age=31536000, immutable" : "no-cache", ...shellHeaders }, req.method === "HEAD");
      return true;
    }
    const fallback = join(staticDir, "index.html");
    const assetRequest = pathname.startsWith("/assets/") || pathname.startsWith("/__grok/") || /\.[a-z0-9]+$/i.test(pathname);
    if (assetRequest || !existsSync(fallback)) return false;
    send(res, 200, readFileSync(fallback), "text/html; charset=utf-8", { "Cache-Control": "no-cache", "X-Toduck-Server": "1" }, req.method === "HEAD");
    return true;
  }

  /**
   * Serialize a mutation through the same write queue as state PUTs.
   * The mutator returns undefined for "no such thing" (nothing persisted),
   * { value } to answer without persisting, or { nextState, value } to
   * persist nextState and answer with value.
   */
  function mutateState(mutator) {
    const nextPromise = writing.catch(() => {}).then(async () => {
      const result = mutator(state);
      if (result === undefined) return undefined;
      if (result.nextState === undefined) return result.value;
      await persistState(dataPath, result.nextState);
      state = result.nextState;
      return result.value;
    });
    writing = nextPromise.catch(() => {});
    return nextPromise;
  }

  const mutateUsers = mutateState;

  const handleRequest = async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");

    if ((url.pathname === "/v1/users" || url.pathname.startsWith("/v1/users/") || url.pathname === "/v1/me") && req.method === "OPTIONS") {
      if (!originAllowed(req)) {
        send(res, 403, JSON.stringify({ error: "Origin not allowed" }));
        return;
      }
      send(res, 204, "", "text/plain", { ...corsHeaders(req), "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS" });
      return;
    }

    if (url.pathname === "/v1/me" && req.method === "GET") {
      if (!originAllowed(req)) {
        send(res, 403, JSON.stringify({ error: "Origin not allowed" }));
        return;
      }
      const headers = corsHeaders(req);
      const auth = authenticate(state, configuredToken, req.headers.authorization);
      if (!auth) {
        send(res, 401, JSON.stringify({ error: "Unauthorized" }), undefined, headers);
        return;
      }
      send(res, 200, JSON.stringify(auth.kind === "admin" ? { kind: "admin", role: "admin" } : { kind: "user", id: auth.user.id, name: auth.user.name, role: auth.user.role ?? "user", disabled: auth.user.disabled === true }), undefined, headers);
      return;
    }

    if (url.pathname === "/v1/users" && req.method === "GET") {
      if (!originAllowed(req)) {
        send(res, 403, JSON.stringify({ error: "Origin not allowed" }));
        return;
      }
      const headers = corsHeaders(req);
      const auth = authenticate(state, configuredToken, req.headers.authorization);
      if (!auth) {
        send(res, 401, JSON.stringify({ error: "Unauthorized" }), undefined, headers);
        return;
      }
      send(res, 200, JSON.stringify(publicUsers(state)), undefined, headers);
      return;
    }

    if (url.pathname === "/v1/users" && req.method === "POST") {
      if (!originAllowed(req)) {
        send(res, 403, JSON.stringify({ error: "Origin not allowed" }));
        return;
      }
      const headers = corsHeaders(req);
      const auth = authenticate(state, configuredToken, req.headers.authorization);
      if (!auth) {
        send(res, 401, JSON.stringify({ error: "Unauthorized" }), undefined, headers);
        return;
      }
      if (!isManager(auth)) {
        send(res, 403, JSON.stringify({ error: "Only an admin can create users" }), undefined, headers);
        return;
      }
      let rawBody = "";
      try {
        rawBody = await readBody(req, maxBody);
      } catch (error) {
        req.resume();
        const status = error?.statusCode === 413 ? 413 : 400;
        send(res, status, JSON.stringify({ error: status === 413 ? "Request body too large" : "Invalid request" }), undefined, headers);
        return;
      }
      let parsedBody;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        send(res, 400, JSON.stringify({ error: "Invalid JSON" }), undefined, headers);
        return;
      }
      const name = typeof parsedBody?.name === "string" ? parsedBody.name.trim().slice(0, 80) : "";
      if (!name) {
        send(res, 400, JSON.stringify({ error: "A user name is required" }), undefined, headers);
        return;
      }
      const role = parsedBody?.role === undefined ? "user" : parsedBody.role;
      if (role !== "admin" && role !== "user") {
        send(res, 400, JSON.stringify({ error: "role must be admin or user" }), undefined, headers);
        return;
      }
      // The raw personal token is returned once, here; only its SHA-256
      // hash is ever stored.
      const personalToken = randomBytes(32).toString("base64url");
      const record = { id: randomUUID(), name, tokenHash: hashToken(personalToken), role, disabled: false };
      try {
        await mutateUsers((current) => ({ nextState: { ...current, users: [...current.users, record] }, value: record }));
      } catch {
        send(res, 500, JSON.stringify({ error: "Failed to persist state" }), undefined, headers);
        return;
      }
      send(res, 201, JSON.stringify({ id: record.id, name: record.name, token: personalToken, role: record.role }), undefined, headers);
      return;
    }

    const userDeleteMatch = /^\/v1\/users\/([^/]+)$/.exec(url.pathname);
    if (userDeleteMatch && req.method === "PATCH") {
      if (!originAllowed(req)) {
        send(res, 403, JSON.stringify({ error: "Origin not allowed" }));
        return;
      }
      const headers = corsHeaders(req);
      const auth = authenticate(state, configuredToken, req.headers.authorization);
      if (!auth) {
        send(res, 401, JSON.stringify({ error: "Unauthorized" }), undefined, headers);
        return;
      }
      if (!isManager(auth)) {
        send(res, 403, JSON.stringify({ error: "Only an admin can change users" }), undefined, headers);
        return;
      }
      let targetId;
      try {
        targetId = decodeURIComponent(userDeleteMatch[1]);
      } catch {
        send(res, 400, JSON.stringify({ error: "Invalid user ID" }), undefined, headers);
        return;
      }
      let rawBody = "";
      try {
        rawBody = await readBody(req, maxBody);
      } catch (error) {
        req.resume();
        const status = error?.statusCode === 413 ? 413 : 400;
        send(res, status, JSON.stringify({ error: status === 413 ? "Request body too large" : "Invalid request" }), undefined, headers);
        return;
      }
      let parsedBody;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        send(res, 400, JSON.stringify({ error: "Invalid JSON" }), undefined, headers);
        return;
      }
      const updates = {};
      if (parsedBody?.name !== undefined) {
        const name = typeof parsedBody.name === "string" ? parsedBody.name.trim().slice(0, 80) : "";
        if (!name) {
          send(res, 400, JSON.stringify({ error: "A user name is required" }), undefined, headers);
          return;
        }
        updates.name = name;
      }
      if (parsedBody?.role !== undefined) {
        if (parsedBody.role !== "admin" && parsedBody.role !== "user") {
          send(res, 400, JSON.stringify({ error: "role must be admin or user" }), undefined, headers);
          return;
        }
        updates.role = parsedBody.role;
      }
      if (parsedBody?.disabled !== undefined) {
        if (typeof parsedBody.disabled !== "boolean") {
          send(res, 400, JSON.stringify({ error: "disabled must be a boolean" }), undefined, headers);
          return;
        }
        updates.disabled = parsedBody.disabled;
      }
      if (Object.keys(updates).length === 0) {
        send(res, 400, JSON.stringify({ error: "Nothing to update" }), undefined, headers);
        return;
      }
      try {
        const updated = await mutateUsers((current) => {
          const index = current.users.findIndex((user) => user.id === targetId);
          if (index < 0) return undefined;
          const users = [...current.users];
          users[index] = { ...users[index], ...updates };
          return { nextState: { ...current, users }, value: publicUser(users[index]) };
        });
        if (!updated) {
          send(res, 404, JSON.stringify({ error: "User not found" }), undefined, headers);
          return;
        }
        send(res, 200, JSON.stringify(updated), undefined, headers);
      } catch {
        send(res, 500, JSON.stringify({ error: "Failed to persist state" }), undefined, headers);
        return;
      }
      return;
    }

    if (userDeleteMatch && req.method === "DELETE") {
      if (!originAllowed(req)) {
        send(res, 403, JSON.stringify({ error: "Origin not allowed" }));
        return;
      }
      const headers = corsHeaders(req);
      const auth = authenticate(state, configuredToken, req.headers.authorization);
      if (!auth) {
        send(res, 401, JSON.stringify({ error: "Unauthorized" }), undefined, headers);
        return;
      }
      if (!isManager(auth)) {
        send(res, 403, JSON.stringify({ error: "Only an admin can delete users" }), undefined, headers);
        return;
      }
      const targetId = decodeURIComponent(userDeleteMatch[1]);
      try {
        const removed = await mutateUsers((current) => {
          if (!current.users.some((user) => user.id === targetId)) return undefined;
          return {
            nextState: {
              ...current,
              // Deleting a user is a state change other clients must see:
              // the revision bumps so a stale client cannot PUT against
              // the pre-delete revision and write the id back (#50).
              revision: current.revision + 1,
              users: current.users.filter((user) => user.id !== targetId),
              // The deleted user's own tasks are reassigned to the admin
              // (ownerId null) instead of being orphaned with a dead
              // owner; everything shared with them is unshared.
              tasks: current.tasks.map((task) => {
                const owned = taskOwnerId(task) === targetId;
                const shared = taskSharedWith(task).includes(targetId);
                if (!owned && !shared) return task;
                return {
                  ...task,
                  ownerId: owned ? null : taskOwnerId(task),
                  sharedWith: shared ? taskSharedWith(task).filter((id) => id !== targetId) : taskSharedWith(task),
                };
              }),
            },
            value: true,
          };
        });
        if (!removed) {
          send(res, 404, JSON.stringify({ error: "User not found" }), undefined, headers);
          return;
        }
      } catch {
        send(res, 500, JSON.stringify({ error: "Failed to persist state" }), undefined, headers);
        return;
      }
      send(res, 200, JSON.stringify({ ok: true, revision: state.revision }), undefined, headers);
      return;
    }

    if ((url.pathname === "/v1/tasks" || url.pathname.startsWith("/v1/tasks/")) && req.method === "OPTIONS") {
      if (!originAllowed(req)) {
        send(res, 403, JSON.stringify({ error: "Origin not allowed" }));
        return;
      }
      send(res, 204, "", "text/plain", { ...corsHeaders(req), "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS" });
      return;
    }

    // REST task API (used by the Home Assistant integration and other
    // automation). Scoping follows the sync API exactly: the admin token
    // sees everything; a personal token sees its own tasks plus tasks
    // shared with it, and new tasks are stamped with that user as owner.
    const taskItemMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
    if (url.pathname === "/v1/tasks" || taskItemMatch) {
      const isCollection = url.pathname === "/v1/tasks";
      const handled = isCollection ? req.method === "GET" || req.method === "POST" : req.method === "PATCH" || req.method === "DELETE";
      if (!handled) {
        send(res, 404, JSON.stringify({ error: "Not found" }));
        return;
      }
      if (!originAllowed(req)) {
        send(res, 403, JSON.stringify({ error: "Origin not allowed" }));
        return;
      }
      const headers = corsHeaders(req);
      const auth = authenticate(state, configuredToken, req.headers.authorization);
      if (!auth) {
        send(res, 401, JSON.stringify({ error: "Unauthorized" }), undefined, headers);
        return;
      }

      if (isCollection && req.method === "GET") {
        const tasks = state.tasks.filter((task) => taskVisibleForRest(task, auth));
        send(res, 200, JSON.stringify({ tasks }), undefined, headers);
        return;
      }

      let parsed;
      if (isCollection || req.method === "PATCH") {
        let rawBody = "";
        try {
          rawBody = await readBody(req, maxBody);
        } catch (error) {
          req.resume();
          const status = error?.statusCode === 413 ? 413 : 400;
          send(res, status, JSON.stringify({ error: status === 413 ? "Request body too large" : "Invalid request" }), undefined, headers);
          return;
        }
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          send(res, 400, JSON.stringify({ error: "Invalid JSON" }), undefined, headers);
          return;
        }
      }

      if (isCollection && req.method === "POST") {
        const built = restTaskFromBody(parsed, auth.kind === "admin" ? null : auth.user.id);
        if (built.error) {
          send(res, 400, JSON.stringify({ error: built.error }), undefined, headers);
          return;
        }
        try {
          // New tasks go first, like the Web client's addTask.
          await mutateState((current) => ({
            nextState: { ...current, revision: current.revision + 1, tasks: [built.task, ...current.tasks] },
            value: built.task,
          }));
        } catch {
          send(res, 500, JSON.stringify({ error: "Failed to persist state" }), undefined, headers);
          return;
        }
        send(res, 201, JSON.stringify(built.task), undefined, headers);
        return;
      }

      const targetId = decodeURIComponent(taskItemMatch[1]);

      if (req.method === "PATCH") {
        const built = restPatchFromBody(parsed);
        if (built.error) {
          send(res, 400, JSON.stringify({ error: built.error }), undefined, headers);
          return;
        }
        let outcome;
        try {
          outcome = await mutateState((current) => {
            const index = current.tasks.findIndex((task) => task?.id === targetId);
            const stored = index >= 0 ? current.tasks[index] : undefined;
            if (!taskVisibleForRest(stored, auth)) return { value: { status: 404 } };
            const updated = applyRestPatch(stored, built.patch);
            const tasks = [...current.tasks];
            tasks[index] = updated;
            return { nextState: { ...current, revision: current.revision + 1, tasks }, value: { status: 200, task: updated } };
          });
        } catch {
          send(res, 500, JSON.stringify({ error: "Failed to persist state" }), undefined, headers);
          return;
        }
        if (outcome.status === 404) {
          send(res, 404, JSON.stringify({ error: "Task not found" }), undefined, headers);
          return;
        }
        send(res, 200, JSON.stringify(outcome.task), undefined, headers);
        return;
      }

      // DELETE: tombstone like a client delete. Only the owner or the
      // admin may delete; a user the task is shared with gets 403.
      let outcome;
      try {
        outcome = await mutateState((current) => {
          const index = current.tasks.findIndex((task) => task?.id === targetId);
          const stored = index >= 0 ? current.tasks[index] : undefined;
          if (!taskVisibleForRest(stored, auth)) return { value: { status: 404 } };
          if (auth.kind !== "admin" && taskOwnerId(stored) !== auth.user.id) return { value: { status: 403 } };
          const tombstone = { ...stored, deleted: true, updatedAt: new Date().toISOString() };
          const tasks = [...current.tasks];
          tasks[index] = tombstone;
          return { nextState: { ...current, revision: current.revision + 1, tasks }, value: { status: 200, task: tombstone } };
        });
      } catch {
        send(res, 500, JSON.stringify({ error: "Failed to persist state" }), undefined, headers);
        return;
      }
      if (outcome.status === 404) {
        send(res, 404, JSON.stringify({ error: "Task not found" }), undefined, headers);
        return;
      }
      if (outcome.status === 403) {
        send(res, 403, JSON.stringify({ error: "Only the owner can delete this task" }), undefined, headers);
        return;
      }
      send(res, 200, JSON.stringify(outcome.task), undefined, headers);
      return;
    }

    if (url.pathname === "/health" && req.method === "OPTIONS") {
      if (!originAllowed(req)) {
        send(res, 403, JSON.stringify({ error: "Origin not allowed" }));
        return;
      }
      send(res, 204, "", "text/plain", { ...corsHeaders(req), "Access-Control-Allow-Headers": "Authorization", "Access-Control-Allow-Methods": "GET, OPTIONS" });
      return;
    }

    if (url.pathname === "/health" && req.method === "GET") {
      if (!originAllowed(req)) {
        send(res, 403, JSON.stringify({ error: "Origin not allowed" }));
        return;
      }
      send(res, 200, JSON.stringify({ ok: true, name: "toduck" }), undefined, corsHeaders(req));
      return;
    }

    if (url.pathname === "/v1/state" && req.method === "OPTIONS") {
      if (!originAllowed(req)) {
        send(res, 403, JSON.stringify({ error: "Origin not allowed" }));
        return;
      }
      send(res, 204, "", "text/plain", { ...corsHeaders(req), "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match", "Access-Control-Allow-Methods": "GET, PUT, OPTIONS" });
      return;
    }

    if (url.pathname === "/v1/state" && (req.method === "GET" || req.method === "PUT")) {
      if (!originAllowed(req)) {
        send(res, 403, JSON.stringify({ error: "Origin not allowed" }));
        return;
      }
      const headers = corsHeaders(req);
      const auth = authenticate(state, configuredToken, req.headers.authorization);
      if (!auth) {
        send(res, 401, JSON.stringify({ error: "Unauthorized" }), undefined, headers);
        return;
      }
      if (req.method === "GET") {
        // A personal token sees categories, projects, and only the tasks
        // they own or that are shared with them. Unowned legacy tasks are
        // the admin's and are not visible to user tokens.
        const tasks = auth.kind === "admin" ? state.tasks : state.tasks.filter((task) => visibleToUser(task, auth.user.id));
        send(res, 200, JSON.stringify({ tasks, categories: state.categories, projects: state.projects }), undefined, { ...headers, ETag: etag(state.revision) });
        return;
      }

      const expectedRevision = parseRevision(req.headers["if-match"]);
      if (expectedRevision === null) {
        send(res, 428, JSON.stringify({ error: "If-Match revision required" }), undefined, headers);
        return;
      }

      let rawBody = "";
      try {
        rawBody = await readBody(req, maxBody);
      } catch (error) {
        req.resume();
        const status = error?.statusCode === 413 ? 413 : 400;
        send(res, status, JSON.stringify({ error: status === 413 ? "Request body too large" : "Invalid request" }), undefined, headers);
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        send(res, 400, JSON.stringify({ error: "Invalid JSON" }), undefined, headers);
        return;
      }

      if (!parsed || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.categories)) {
        send(res, 400, JSON.stringify({ error: "Expected tasks and categories arrays" }), undefined, headers);
        return;
      }
      if (parsed.projects !== undefined && !Array.isArray(parsed.projects)) {
        send(res, 400, JSON.stringify({ error: "Expected projects to be an array when present" }), undefined, headers);
        return;
      }
      if (parsed.tasks.length > 5000 || parsed.categories.length > 200 || (parsed.projects?.length ?? 0) > 200) {
        send(res, 400, JSON.stringify({ error: "Too many items" }), undefined, headers);
        return;
      }

      const nextPromise = writing.catch(() => {}).then(async () => {
        if (expectedRevision !== state.revision) {
          const conflict = new Error("State changed");
          conflict.statusCode = 409;
          conflict.revision = state.revision;
          throw conflict;
        }
        // A client that predates projects (e.g. the Android app) omits the
        // array; keep the stored projects instead of wiping them.
        // The admin token keeps whole-state semantics; a personal token's
        // payload is merged in scoped to that user (see mergeUserState).
        // An admin PUT still drops references to users who no longer
        // exist (#50) instead of resurrecting them.
        const nextState =
          auth.kind === "admin"
            ? {
                revision: state.revision + 1,
                tasks: sanitizeTasksSharedWith(parsed.tasks, state),
                categories: parsed.categories,
                projects: parsed.projects ?? state.projects,
                users: state.users,
              }
            : mergeUserState(state, parsed, auth.user.id);
        await persistState(dataPath, nextState);
        state = nextState;
        return nextState.revision;
      });

      writing = nextPromise.catch(() => {});

      try {
        const savedRevision = await nextPromise;
        send(res, 200, JSON.stringify({ ok: true, revision: savedRevision }), undefined, { ...headers, ETag: etag(savedRevision) });
      } catch (error) {
        if (error?.statusCode === 409) {
          send(res, 409, JSON.stringify({ error: "State changed", revision: error.revision }), undefined, { ...headers, ETag: etag(error.revision) });
          return;
        }
        send(res, 500, JSON.stringify({ error: "Failed to persist state" }), undefined, headers);
      }
      return;
    }

    // The API namespace never falls through to the static Web UI shell: a
    // caller without a valid bearer token gets 401 exactly as on a real route,
    // so the response does not reveal which paths exist.
    if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
      if (!originAllowed(req)) {
        send(res, 403, JSON.stringify({ error: "Origin not allowed" }));
        return;
      }
      const headers = corsHeaders(req);
      if (!authenticate(state, configuredToken, req.headers.authorization)) {
        send(res, 401, JSON.stringify({ error: "Unauthorized" }), undefined, headers);
        return;
      }
      send(res, 404, JSON.stringify({ error: "Not found" }), undefined, headers);
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && serveStatic(req, res, url.pathname)) return;
    send(res, 404, JSON.stringify({ error: "Not found" }));
  };

  // Async request handlers must not leave rejected promises unobserved:
  // malformed URLs are client errors, unexpected failures get a safe 500.
  return createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      const malformed = error instanceof URIError || error?.code === "ERR_INVALID_URL";
      send(res, malformed ? 400 : 500, JSON.stringify({
        error: malformed ? "Invalid request" : "Internal server error",
      }));
    });
  });
}

function runFromEnvironment() {
  const allowedOrigins = String(process.env.TODUCK_ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
  const server = createToduckServer({ token: process.env.TODUCK_TOKEN, dataPath: process.env.DATA_PATH || "/data/state.json", staticDir: process.env.STATIC_DIR || "/app/static", allowedOrigins });
  const port = Number(process.env.PORT || 8787);
  server.listen(port, "0.0.0.0", () => console.log(`Toduck server listening on ${port}`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    runFromEnvironment();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
