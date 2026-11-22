import { useEffect, useRef, useState } from "react";
import { Trash2, UserCheck, UserX } from "lucide-react";
import { Button, Modal, SectionLabel } from "@/components/toduck/ui";
import { activeCategories, activeProjects } from "@/lib/toduck/model";
import { useToduck } from "@/lib/toduck/store";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
import {
  checkServer,
  createUser,
  deleteUser,
  detectSameOriginServer,
  fetchMe,
  listUsers,
  normalizeServerUrl,
  readDoc,
  updateUser,
  type DirectoryUser,
  type ServerIdentity,
} from "@/lib/toduck/sync";
import { syncNow } from "@/lib/toduck/store";

/**
 * Admin-only panel: registered users on the connected server. Rendered only
 * when the saved connection is the admin token or an admin-role account — a
 * plain user token never sees it. Deleting a user asks first (#76) and offers
 * Undo: the token cannot be restored (a new one is issued instead), but the
 * person is back with the same name and role.
 */
export function UsersPanel({ url, token }: { url: string; token: string }) {
  const [me, setMe] = useState<ServerIdentity | null>(null);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<DirectoryUser | null>(null);
  const [lastDeleted, setLastDeleted] = useState<{ name: string; role: "admin" | "user" } | null>(null);

  async function refresh() {
    try {
      setUsers(await listUsers(url, token));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load users.");
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const identity = await fetchMe(url, token);
      if (cancelled) return;
      setMe(identity);
      if (identity.kind === "admin" || identity.role === "admin") await refresh();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, token]);

  const canManage = me?.kind === "admin" || (me?.kind === "user" && me.role === "admin");
  if (!me || !canManage) return null;

  async function addUser() {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const user = await createUser(url, token, trimmed, role);
      setCreated({ name: user.name, token: user.token });
      setCopied(false);
      setName("");
      setMessage(null);
      setLastDeleted(null);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create the user.");
    }
  }

  async function toggleDisabled(user: DirectoryUser) {
    try {
      await updateUser(url, token, user.id, { disabled: !user.disabled });
      setMessage(user.disabled ? `${user.name} re-enabled.` : `${user.name} disabled. Their token stops working until re-enabled.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not change the user.");
    }
  }

  async function removeUser(user: DirectoryUser) {
    setConfirming(null);
    try {
      await deleteUser(url, token, user.id);
      setLastDeleted({ name: user.name, role: user.role });
      setCreated(null);
      setMessage(
        `${user.name} removed. Their access is revoked, toducks shared with them are unshared, and their own toducks moved to the admin.`,
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not remove the user.");
    }
  }

  async function undoDelete() {
    if (!lastDeleted) return;
    try {
      const user = await createUser(url, token, lastDeleted.name, lastDeleted.role);
      setCreated({ name: user.name, token: user.token });
      setCopied(false);
      setLastDeleted(null);
      setMessage(
        `${user.name} restored with a new personal token (shown once below). Their toducks stayed with the admin and sharing must be re-done.`,
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not restore the user.");
    }
  }

  return (
    <section className="mt-6 border-t border-line pt-5">
      <SectionLabel>Users on this server</SectionLabel>
      <p className="mt-2 text-sm text-pretty text-muted">
        {me.kind === "admin"
          ? "You are connected with the admin token. Create a user for each person, then hand them their personal token to connect with. People only see their own toducks and ones shared with them."
          : "You are connected with an admin account. Create a user for each person, then hand them their personal token to connect with. People only see their own toducks and ones shared with them."}
      </p>
      {users.length ? (
        <ul className="mt-3 space-y-2">
          {users.map((user) => (
            <li key={user.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{user.name}</span>
              <span className="shrink-0 rounded-full bg-paper-2 px-2 py-0.5 text-xs text-muted">
                {user.role === "admin" ? "Admin" : "User"}
              </span>
              {user.disabled ? (
                <span className="shrink-0 rounded-full bg-paper-2 px-2 py-0.5 text-xs text-danger">Disabled</span>
              ) : null}
              <button
                type="button"
                className="grid size-11 shrink-0 place-items-center rounded-full text-ink"
                aria-label={user.disabled ? `Enable user ${user.name}` : `Disable user ${user.name}`}
                onClick={() => void toggleDisabled(user)}
              >
                {user.disabled ? <UserCheck className="size-4" /> : <UserX className="size-4" />}
              </button>
              <button
                type="button"
                className="grid size-11 shrink-0 place-items-center rounded-full text-danger"
                aria-label={`Delete user ${user.name}`}
                onClick={() => setConfirming(user)}
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted">No registered users yet.</p>
      )}
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void addUser();
        }}
      >
        <input
          className="field min-w-0 flex-1"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New user's name"
          aria-label="New user's name"
          maxLength={80}
        />
        <select
          className="field w-auto shrink-0"
          value={role}
          onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "user")}
          aria-label="Role for new user"
        >
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          Create user
        </Button>
      </form>
      {created ? (
        <div className="mt-3 rounded-2xl bg-paper-2 px-4 py-3">
          <p className="text-sm font-medium">Personal token for {created.name}</p>
          <p className="mt-1 text-sm text-danger">Shown once — copy it now. It can't be shown again.</p>
          <div className="mt-2 flex gap-2">
            <input className="field" readOnly value={created.token} aria-label="New user token" onFocus={(event) => event.target.select()} />
            <Button
              onClick={() => {
                void navigator.clipboard?.writeText(created.token).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p className="mt-2 text-sm text-muted" role="status" aria-live="polite">
          {message}{" "}
          {lastDeleted ? (
            <button type="button" className="font-medium text-ink underline underline-offset-2" onClick={() => void undoDelete()}>
              Undo
            </button>
          ) : null}
        </p>
      ) : null}
      <Modal
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={confirming ? `Delete ${confirming.name}?` : "Delete user?"}
        description="This revokes their personal token immediately."
      >
        <p className="text-sm text-pretty text-muted">
          {confirming
            ? `${confirming.name} will lose access at once, toducks shared with them will be unshared, and their own toducks will move to the admin. This cannot be undone — restoring them issues a new personal token.`
            : ""}
        </p>
        <div className="mt-5 flex gap-2">
          <Button onClick={() => setConfirming(null)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (confirming) void removeUser(confirming);
            }}
          >
            Delete user
          </Button>
        </div>
      </Modal>
    </section>
  );
}

export function CategoriesDialog({ onClose }: { onClose: () => void }) {
  const categories = useToduck((s) => s.categories);
  const addCategory = useToduck((s) => s.addCategory);
  const renameCategory = useToduck((s) => s.renameCategory);
  const deleteCategory = useToduck((s) => s.deleteCategory);
  const [draft, setDraft] = useState("");
  const items = activeCategories(categories);

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Tags"
      description="A toduck has one tag. Filter the list with the chips in the sidebar."
    >
      <ul className="space-y-2">
        {items.map((category) => (
          <CategoryRow
            key={category.id}
            name={category.name}
            onRename={(name) => renameCategory(category.id, name)}
            onDelete={() => deleteCategory(category.id)}
          />
        ))}
      </ul>
      {items.length === 0 ? <p className="text-sm text-muted">No tags yet.</p> : null}
      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (addCategory(draft)) setDraft("");
        }}
      >
        <input
          className="field"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="New tag"
          aria-label="New tag"
          maxLength={40}
        />
        <Button type="submit" variant="primary" disabled={!draft.trim()}>
          Add
        </Button>
      </form>
    </Modal>
  );
}

export function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const projects = useToduck((s) => s.projects);
  const addProject = useToduck((s) => s.addProject);
  const renameProject = useToduck((s) => s.renameProject);
  const deleteProject = useToduck((s) => s.deleteProject);
  const [draft, setDraft] = useState("");
  const items = activeProjects(projects);

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Projects"
      description="A toduck can belong to one project, alongside its tag. Removing a project keeps its toducks."
    >
      <ul className="space-y-2">
        {items.map((project) => (
          <CategoryRow
            key={project.id}
            name={project.name}
            onRename={(name) => renameProject(project.id, name)}
            onDelete={() => deleteProject(project.id)}
          />
        ))}
      </ul>
      {items.length === 0 ? <p className="text-sm text-muted">No projects yet.</p> : null}
      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (addProject(draft)) setDraft("");
        }}
      >
        <input
          className="field"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="New project"
          aria-label="New project"
          maxLength={40}
        />
        <Button type="submit" variant="primary" disabled={!draft.trim()}>
          Add
        </Button>
      </form>
    </Modal>
  );
}

function CategoryRow({ name, onRename, onDelete }: { name: string; onRename: (name: string) => void; onDelete: () => void }) {
  const [value, setValue] = useState(name);
  return (
    <li className="flex items-center gap-2">
      <input
        className="field"
        value={value}
        aria-label={`Rename ${name}`}
        maxLength={40}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => onRename(value)}
      />
      <button
        type="button"
        className="grid size-11 shrink-0 place-items-center rounded-full text-danger"
        aria-label={`Delete ${name}`}
        onClick={onDelete}
      >
        <Trash2 className="size-4" />
      </button>
    </li>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const serverUrl = useToduck((s) => s.serverUrl);
  const serverToken = useToduck((s) => s.serverToken);
  const syncStatus = useToduck((s) => s.syncStatus);
  const syncError = useToduck((s) => s.syncError);
  const lastSyncedAt = useToduck((s) => s.lastSyncedAt);
  const setServer = useToduck((s) => s.setServer);
  const importDoc = useToduck((s) => s.importDoc);
  const resetSamples = useToduck((s) => s.resetSamples);
  const clearDone = useToduck((s) => s.clearDone);
  const tasks = useToduck((s) => s.tasks);
  const categories = useToduck((s) => s.categories);
  const projects = useToduck((s) => s.projects);
  const [url, setUrl] = useState(serverUrl);
  const [token, setToken] = useState(serverToken);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [sameOrigin, setSameOrigin] = useState<string | null>(null);
  const tokenInput = useRef<HTMLInputElement | null>(null);

  // When nothing is connected yet, check whether the page itself was
  // served by a Toduck server, so the address can be filled in instead
  // of typed (#106). The probe never sends a token; connecting still
  // needs one, and a remote server is still entered by hand below.
  useEffect(() => {
    if (serverUrl) return;
    let cancelled = false;
    void detectSameOriginServer().then((found) => {
      if (!cancelled) setSameOrigin(found);
    });
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  function useSameOrigin() {
    if (!sameOrigin) return;
    setUrl(sameOrigin);
    setMessage("This server's address is filled in. Enter its token to connect.");
    tokenInput.current?.focus();
  }

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (!installEvent) return;
    await installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    if (outcome === "accepted") setInstalled(true);
    setInstallEvent(null);
  }

  async function saveServer() {
    const next = normalizeServerUrl(url);
    if (next === null) {
      setMessage("Enter a full address, including http or https.");
      return;
    }
    setServer(next, token.trim());
    setUrl(next);
    if (!next || !token.trim()) {
      setMessage("Server cleared. Toducks stay on this device.");
      return;
    }
    setMessage("Checking the server…");
    try {
      await checkServer(next, token.trim());
      await syncNow();
      setMessage("Connected. Notes, categories, projects, and toducks will stay in sync.");
    } catch (error) {
      const raw = error instanceof Error ? error.message : "Could not reach the server.";
      setMessage(
        raw.includes("Unauthorized")
          ? "That token was not accepted by the server. Check the token and try again."
          : raw.includes("Origin not allowed")
            ? "The server rejected this page's origin. Add this address to TODUCK_ALLOWED_ORIGINS on the server."
            : raw,
      );
    }
  }

  function exportJson() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            tasks: tasks.filter((task) => !task.deleted),
            categories: categories.filter((category) => !category.deleted),
            projects: projects.filter((project) => !project.deleted),
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "toduck.json";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Settings"
      description="This device keeps your list. Connect a server when you want the Android app to share it."
    >
      <section>
        <SectionLabel>Your server</SectionLabel>
        <p className="mt-2 text-sm text-pretty text-muted">
          Optional. Leave this blank to keep everything here. The address is remembered, but the token is held only for
          this open browser session. External clients such as Android use the same server token separately.
        </p>
        {sameOrigin && !serverUrl ? (
          <div className="mt-3 rounded-2xl bg-paper-2 px-4 py-3">
            <p className="text-sm font-medium">This page is served by your Toduck server.</p>
            <p className="mt-1 text-sm text-muted">
              {sameOrigin} — use it instead of typing the address. Your token is still required.
            </p>
            <Button className="mt-2" variant="primary" onClick={useSameOrigin}>
              Use this server
            </Button>
          </div>
        ) : null}
        <label className="mt-3 block text-sm font-medium" htmlFor="server-url">
          Address
        </label>
        <input
          id="server-url"
          className="field mt-1"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://tasks.example.com"
          autoComplete="off"
        />
        <label className="mt-3 block text-sm font-medium" htmlFor="server-token">
          Token
        </label>
        <input
          id="server-token"
          ref={tokenInput}
          className="field mt-1"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Secret from your server"
          type="password"
          autoComplete="off"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void saveServer()}>
            Save and sync
          </Button>
          <Button
            onClick={() => {
              setServer("", "");
              setUrl("");
              setToken("");
              setMessage("Disconnected. Local toducks were not changed.");
            }}
          >
            Disconnect
          </Button>
        </div>
        <p className="mt-2 text-sm text-muted" role="status" aria-live="polite">
          {message ??
            (syncStatus === "ok"
              ? `Synced${lastSyncedAt ? ` ${new Date(lastSyncedAt).toLocaleString()}` : ""}.`
              : syncStatus === "syncing"
                ? "Syncing…"
                : syncStatus === "error"
                  ? `Sync failed: ${syncError ?? "Check the address, token, and server status."}`
                  : "Not connected.")}
        </p>
        {serverUrl && serverToken ? <UsersPanel url={serverUrl} token={serverToken} /> : null}
      </section>

      <section className="mt-6 border-t border-line pt-5">
        <SectionLabel>Install</SectionLabel>
        <p className="mt-2 text-sm text-muted">
          Add Toduck to your home screen for a full-screen app. Works offline after the first load.
        </p>
        {installed ? (
          <p className="mt-2 text-sm text-sage">Installed.</p>
        ) : installEvent ? (
          <Button className="mt-3" variant="primary" onClick={() => void install()}>
            Install app
          </Button>
        ) : (
          <p className="mt-2 text-sm text-muted">Use your browser’s “Add to Home Screen” or install menu.</p>
        )}
      </section>

      <section className="mt-6 border-t border-line pt-5">
        <SectionLabel>Backup</SectionLabel>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            onClick={exportJson}
          >
            Export
          </Button>
          <label className="inline-flex min-h-11 cursor-pointer items-center rounded-full bg-paper-2 px-4 text-sm font-medium">
            Import
            <input
              className="sr-only"
              type="file"
              accept="application/json"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                try {
                  const doc = readDoc(JSON.parse(await file.text()));
                  importDoc(doc);
                  setMessage("Imported.");
                } catch {
                  setMessage("That file could not be read.");
                }
              }}
            />
          </label>
        </div>
      </section>

      <section className="mt-6 border-t border-line pt-5">
        <SectionLabel>Your list</SectionLabel>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={clearDone}>Clear finished</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!confirmReset) {
                setConfirmReset(true);
                return;
              }
              resetSamples();
              setConfirmReset(false);
            }}
          >
            {confirmReset ? "Replace list with samples" : "Restore samples"}
          </Button>
        </div>
      </section>
    </Modal>
  );
}
