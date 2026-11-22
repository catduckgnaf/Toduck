import { activeCategories, activeProjects, type Category, type Project, type Repeat, type Task } from "./model.ts";

export type ToduckDoc = {
  tasks: Task[];
  categories: Category[];
  projects: Project[];
};

export type VersionedToduckDoc = {
  doc: ToduckDoc;
  revision: string;
};

const REPEAT_KINDS = new Set(["none", "daily", "weekdays", "weekly", "monthly", "interval", "days"]);

function isRepeat(value: unknown): value is Repeat {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && REPEAT_KINDS.has(kind);
}

export function isTask(value: unknown): value is Task {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<Task>;
  if (typeof t.id !== "string" || typeof t.title !== "string") return false;
  if (typeof t.notes !== "string") return false;
  if (!(t.categoryId === null || typeof t.categoryId === "string")) return false;
  // projectId arrived later than the other fields; older payloads omit it.
  if (!(t.projectId === undefined || t.projectId === null || typeof t.projectId === "string")) return false;
  // ownerId / sharedWith arrived with multi-user servers; older payloads omit both.
  if (!(t.ownerId === undefined || t.ownerId === null || typeof t.ownerId === "string")) return false;
  if (!(t.sharedWith === undefined || (Array.isArray(t.sharedWith) && t.sharedWith.every((id) => typeof id === "string")))) return false;
  if (!(t.date === null || (typeof t.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.date)))) return false;
  if (!isRepeat(t.repeat)) return false;
  if (typeof t.done !== "boolean") return false;
  if (typeof t.createdAt !== "string" || typeof t.updatedAt !== "string") return false;
  return true;
}

export function isCategory(value: unknown): value is Category {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<Category>;
  return typeof c.id === "string" && typeof c.name === "string" && typeof c.createdAt === "string" && typeof c.updatedAt === "string";
}

export function isProject(value: unknown): value is Project {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<Project>;
  return typeof p.id === "string" && typeof p.name === "string" && typeof p.createdAt === "string" && typeof p.updatedAt === "string";
}

export function readDoc(value: unknown): ToduckDoc {
  if (!value || typeof value !== "object") return { tasks: [], categories: [], projects: [] };
  const doc = value as { tasks?: unknown; categories?: unknown; projects?: unknown };
  return {
    tasks: Array.isArray(doc.tasks)
      ? doc.tasks
          .filter(isTask)
          .map((task) => ({ ...task, projectId: task.projectId ?? null, ownerId: task.ownerId ?? null, sharedWith: task.sharedWith ?? [] }))
      : [],
    categories: Array.isArray(doc.categories) ? doc.categories.filter(isCategory) : [],
    projects: Array.isArray(doc.projects) ? doc.projects.filter(isProject) : [],
  };
}

export function mergeById<T extends { id: string; updatedAt: string; deleted?: boolean }>(local: T[], remote: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of remote) map.set(item.id, item);
  for (const item of local) {
    const other = map.get(item.id);
    if (!other || item.updatedAt > other.updatedAt) map.set(item.id, item);
  }
  const cutoff = Date.now() - 30 * 86_400_000;
  return [...map.values()].filter((item) => {
    if (!item.deleted) return true;
    const time = new Date(item.updatedAt).getTime();
    return Number.isFinite(time) && time > cutoff;
  });
}

export function mergeDocs(local: ToduckDoc, remote: ToduckDoc): ToduckDoc {
  return {
    tasks: mergeById(local.tasks, remote.tasks),
    categories: mergeById(local.categories, remote.categories),
    projects: mergeById(local.projects, remote.projects),
  };
}

export function normalizeServerUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const path = url.pathname.replace(/\/$/, "");
    return path && path !== "/" ? url.origin + path : url.origin;
  } catch {
    return null;
  }
}

class ConflictError extends Error {}

async function request(url: string, token: string, path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new Error("Could not reach the server.");
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 180);
    if (res.status === 409) throw new ConflictError(text || "State changed on another device.");
    throw new Error(text || `Server responded ${res.status}.`);
  }
  return res;
}

export async function pullDoc(url: string, token: string): Promise<VersionedToduckDoc> {
  const res = await request(url, token, "/v1/state");
  const revision = res.headers.get("ETag");
  if (!revision) throw new Error("Server did not provide a state revision.");
  return { doc: readDoc(await res.json()), revision };
}

export async function pushDoc(url: string, token: string, doc: ToduckDoc, revision: string): Promise<string> {
  const res = await request(url, token, "/v1/state", {
    method: "PUT",
    headers: { "If-Match": revision },
    body: JSON.stringify({
      tasks: doc.tasks,
      categories: activeCategories(doc.categories).concat(doc.categories.filter((c) => c.deleted)),
      projects: activeProjects(doc.projects).concat(doc.projects.filter((p) => p.deleted)),
    }),
  });
  const nextRevision = res.headers.get("ETag");
  if (!nextRevision) throw new Error("Server did not confirm the new state revision.");
  return nextRevision;
}

export async function syncDoc(url: string, token: string, local: ToduckDoc, maxAttempts = 3): Promise<ToduckDoc> {
  let candidate = local;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const remote = await pullDoc(url, token);
    candidate = mergeDocs(candidate, remote.doc);
    try {
      await pushDoc(url, token, candidate, remote.revision);
      return candidate;
    } catch (error) {
      if (!(error instanceof ConflictError) || attempt === maxAttempts - 1) throw error;
    }
  }
  return candidate;
}

export async function checkServer(url: string, token: string): Promise<void> {
  await request(url, token, "/health");
  await pullDoc(url, token);
}

export type DirectoryUser = {
  id: string;
  name: string;
  /** "admin" users may manage users; "user" is the default. Older servers omit it. */
  role: "admin" | "user";
  /** A disabled user's token stops working until an admin re-enables them. */
  disabled: boolean;
};

export type ServerIdentity =
  | { kind: "admin"; role: "admin" }
  | { kind: "user"; id: string; name: string; role: "admin" | "user"; disabled: boolean };

/**
 * Who the given token is on this server. Servers from before multi-user
 * support have no /v1/me; their only token is the admin token, so a failed
 * lookup reads as admin.
 */
export async function fetchMe(url: string, token: string): Promise<ServerIdentity> {
  try {
    const res = await request(url, token, "/v1/me");
    const body = (await res.json()) as { kind?: unknown; id?: unknown; name?: unknown; role?: unknown; disabled?: unknown };
    if (body.kind === "user" && typeof body.id === "string" && typeof body.name === "string") {
      return {
        kind: "user",
        id: body.id,
        name: body.name,
        role: body.role === "admin" ? "admin" : "user",
        disabled: body.disabled === true,
      };
    }
    return { kind: "admin", role: "admin" };
  } catch {
    return { kind: "admin", role: "admin" };
  }
}

/** The server's user directory: names, ids and roles only, never token material. */
export async function listUsers(url: string, token: string): Promise<DirectoryUser[]> {
  const res = await request(url, token, "/v1/users");
  const body: unknown = await res.json();
  if (!Array.isArray(body)) return [];
  return body
    .filter(
      (user): user is DirectoryUser =>
        !!user && typeof user === "object" && typeof (user as DirectoryUser).id === "string" && typeof (user as DirectoryUser).name === "string",
    )
    .map((user) => ({
      id: user.id,
      name: user.name,
      role: (user as { role?: unknown }).role === "admin" ? ("admin" as const) : ("user" as const),
      disabled: (user as { disabled?: unknown }).disabled === true,
    }));
}

/** Admin only. The returned personal token is shown once and never stored by the server in raw form. */
export async function createUser(
  url: string,
  token: string,
  name: string,
  role: "admin" | "user" = "user",
): Promise<{ id: string; name: string; token: string; role: "admin" | "user" }> {
  const res = await request(url, token, "/v1/users", {
    method: "POST",
    body: JSON.stringify({ name, role }),
  });
  const body = (await res.json()) as { id?: unknown; name?: unknown; token?: unknown; role?: unknown };
  if (typeof body.id !== "string" || typeof body.name !== "string" || typeof body.token !== "string") {
    throw new Error("Server did not return a user token.");
  }
  return { id: body.id, name: body.name, token: body.token, role: body.role === "admin" ? "admin" : "user" };
}

/** Admin only. Rename a user, change their role, or disable / re-enable them. */
export async function updateUser(
  url: string,
  token: string,
  id: string,
  updates: { name?: string; role?: "admin" | "user"; disabled?: boolean },
): Promise<DirectoryUser> {
  const res = await request(url, token, `/v1/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
  const body = (await res.json()) as { id?: unknown; name?: unknown; role?: unknown; disabled?: unknown };
  if (typeof body.id !== "string" || typeof body.name !== "string") {
    throw new Error("Server did not return the updated user.");
  }
  return {
    id: body.id,
    name: body.name,
    role: body.role === "admin" ? "admin" : "user",
    disabled: body.disabled === true,
  };
}

/**
 * Admin only. Revokes the user's access, unshares everything shared with them,
 * and moves their own toducks to the admin instead of orphaning them. The
 * revision bumps, so a stale client cannot write the removed user back.
 */
export async function deleteUser(url: string, token: string, id: string): Promise<void> {
  await request(url, token, `/v1/users/${encodeURIComponent(id)}`, { method: "DELETE" });
}
