# Toduck self hosting

The Toduck container serves the compiled Web UI and the `/v1/state` synchronization API from one origin. Image tags:

* `ghcr.io/catduckgnaf/toduck:latest` and `v1.3.1` style release tags
* `ghcr.io/catduckgnaf/toduck:develop` and `:nightly`, floating tags that move only to a Quality-green `main` commit

## Prebuilt image

CI publishes the container to the GitHub Container Registry on every push to
`main` (tag `latest` plus the short commit SHA) and on every `v*` release tag
(tagged with the version), for both `linux/amd64` and `linux/arm64`:

```sh
docker pull ghcr.io/catduckgnaf/toduck:latest
```

With Compose, `docker compose -f selfhost/docker-compose.yml pull` fetches
that image instead of building; `up --build` still builds locally. On Unraid,
the image name `ghcr.io/catduckgnaf/toduck:latest` can be used directly as
the repository. If a pull is denied right after the first publish, open the
package settings on GitHub and make the package public (or link it to this
repository) — first-time GHCR packages are not always public by default.

## Security model

* `TODUCK_TOKEN` is required and must contain at least 32 characters. Startup fails without it.
* API clients send `Authorization: Bearer <token>`.
* The browser stores the server address, but keeps the token only in the current in memory session. Disconnecting clears it without deleting local tasks.
* Cross origin API calls are rejected unless their origin appears in `TODUCK_ALLOWED_ORIGINS`.
* The container runs as the unprivileged `toduck` user and exposes a public `/health` endpoint.
* State updates require the current ETag in `If-Match`. Stale writers receive `409 Conflict` and clients pull, merge, and retry.

Use TLS when exposing Toduck beyond a trusted private network.

## Docker Compose

Generate a secret and start the service:

```sh
export TODUCK_TOKEN="$(openssl rand -hex 32)"
docker compose -f selfhost/docker-compose.yml up --build -d
```

Open `http://localhost:8793`. By default Compose publishes container port `8787` on every host interface at port `8793`.

Optional settings:

```sh
export TODUCK_BIND="192.168.1.20"
export TODUCK_PORT="8793"
export TODUCK_ALLOWED_ORIGINS="https://tasks.example.com,https://mobile.example.com"
```

A `.env` file beside the Compose command may hold these values. Do not commit it.

## API

**Health:** `GET /health` returns `200` without authentication.

**Read state:**

```sh
curl -i \
  -H "Authorization: Bearer $TODUCK_TOKEN" \
  http://localhost:8793/v1/state
```

The response includes an `ETag`, such as `"7"`.

**Update state:**

```sh
curl -i -X PUT \
  -H "Authorization: Bearer $TODUCK_TOKEN" \
  -H 'If-Match: "7"' \
  -H "Content-Type: application/json" \
  --data '{"tasks":[],"categories":[]}' \
  http://localhost:8793/v1/state
```

A missing revision returns `428 Precondition Required`. A stale revision returns `409 Conflict`.

## Users and sharing

A server can host several registered users alongside the admin:

* `TODUCK_TOKEN` stays the **admin** credential. It keeps whole-state
  `GET`/`PUT /v1/state` semantics exactly as before, so existing Web and
  Android clients keep working unchanged. Accounts are admin-created —
  there is no open self-registration.
* **Roles:** every user is `admin` or `user` (the default). Admin-role users
  may manage users — create, change, disable, delete — but whole-state sync
  stays admin-token-only. A `disabled` user's token stops working
  everywhere until an admin re-enables them. Older user records without the
  fields read as enabled users, so existing state migrates on first load.
* **Create a user (admin only):** `POST /v1/users` with `{"name": "…",
  "role": "user"}` → `201 {"id", "name", "token", "role"}`. The personal
  token is returned **once**; the server stores only its SHA-256 hash in
  the state file. In the Web UI, connect with the admin token and use the
  Users panel in Settings.
* **Change a user (admin only):** `PATCH /v1/users/:id` with any of
  `{"name", "role", "disabled"}` → `200 {"id", "name", "role", "disabled"}`.
* **Directory (any authenticated token):** `GET /v1/users` →
  `[{id, name, role, disabled}]`.
* **Who am I:** `GET /v1/me` → `{"kind": "admin", "role": "admin"}` or
  `{"kind": "user", "id", "name", "role", "disabled"}`.
* **Delete a user (admin only):** `DELETE /v1/users/:id` revokes their
  access, removes them from every task's sharing list, moves their own
  tasks to the admin (never orphans them), and bumps the state revision so
  a stale client cannot write the removed user back. Returns
  `{"ok": true, "revision"}`. In the Web UI the delete asks first and
  offers Undo, which restores the person with a new one-time token.

Each task carries `ownerId` (a user id, or `null` for legacy tasks not
owned by any user) and `sharedWith` (user ids). With a **personal token**:

* `GET /v1/state` returns categories, projects, and only the tasks the
  user owns or that are shared with them. Unowned legacy tasks belong to
  the admin and are **not** visible to personal tokens.
* `PUT /v1/state` merges scoped to that user: new tasks are stamped with
  the user as owner, tasks they cannot see are preserved exactly, their
  own omitted tasks are deleted, and shared tasks stay editable by them —
  but a shared user cannot delete the owner's task, change its owner, or
  change who it is shared with (only the owner or the admin can share and
  unshare). A shared user also cannot undelete the owner's tombstoned task.
  Categories and projects are shared, not owned: a user `PUT` keeps every
  stored entry and only adds entries with ids it has never seen — it can
  never rename or delete one. An admin `PUT` still replaces them wholesale,
  but references to users who no longer exist are dropped.

Users connect from the Web UI with the server address and their personal
token, exactly like the admin flow. Per-user sign-in in the Android app is
not included; Android keeps using the admin token.

Web-app sign-in is separate: the Web UI's own sign-in (Better Auth,
`/api/auth`) guards the app surface, while this sync server keeps its own
admin and personal tokens. A web session does not by itself authorize
`/v1/*` — the admin creates a personal token per person in the Users panel
and hands it over. Single sign-on between the web session and the sync
server (one login for both) needs a shared secret or database between the
two processes and is a follow-up, not part of this setup.

## REST task API

A small task-level API sits beside the sync API, for automation — it is
what the [Home Assistant integration](../integrations/home-assistant/)
uses. Authentication and scoping follow the rules above exactly: send
`Authorization: Bearer <token>` with either the admin `TODUCK_TOKEN`
(sees and can change everything, new tasks are unowned) or a registered
user's personal token (sees their own tasks plus tasks shared with them;
new tasks are stamped with that user as owner).

| Method | Path | Success | Notes |
| --- | --- | --- | --- |
| `GET` | `/v1/tasks` | `200 {"tasks": [...]}` | The caller's visible tasks, deleted ones excluded. Full task objects, as stored. |
| `POST` | `/v1/tasks` | `201` + the created task | Body: `{"title": "…"}` (required) plus optional `date` (`YYYY-MM-DD` or `null`), `notes`, `categoryId`, `projectId`, `repeat`. The server assigns the id and timestamps. |
| `PATCH` | `/v1/tasks/:id` | `200` + the updated task | Body may carry `title`, `date`, `notes`, `done`, `categoryId`, `projectId`. Setting `done` stamps or clears `completedAt`, like checking a toduck off. Owner and sharing cannot be changed here. |
| `DELETE` | `/v1/tasks/:id` | `200` + the deleted task | Tombstones the task, like a client delete. Owner or admin only — a user the task is shared with gets `403`. |

Errors: `400` for invalid JSON, a missing/empty `title`, or a malformed
field; `401` for a missing or unknown token; `404` when the task does not
exist or is not visible to the caller.

```sh
# Create a toduck
curl -i -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"title":"Book the dentist","date":"2026-10-30"}' \
  http://localhost:8793/v1/tasks

# List the caller's toducks
curl -H "Authorization: Bearer $TOKEN" http://localhost:8793/v1/tasks

# Mark one done (or patch any of title/date/notes/categoryId/projectId)
curl -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"done":true}' \
  http://localhost:8793/v1/tasks/<task-id>

# Delete one (owner or admin)
curl -X DELETE -H "Authorization: Bearer $TOKEN" http://localhost:8793/v1/tasks/<task-id>
```

From Home Assistant, the same endpoints work as a `rest_command` — handy
for automations that should file a toduck (the custom integration's todo
entity can also create items; see its README):

```yaml
rest_command:
  toduck_add:
    url: "http://<server>:8793/v1/tasks"
    method: POST
    headers:
      authorization: "Bearer <personal-token>"
      content-type: "application/json"
    payload: '{"title": "{{ title }}"}'
```

## Data and recovery

The container stores state at `/data/state.json` and retains `/data/state.json.bak` as the last known good copy. Writes use a temporary file followed by an atomic rename. On startup, an invalid primary file is restored from the backup when possible. The runtime server is a Go binary; the Node implementation remains in this directory as the behavioral reference and its tests remain part of `npm test`.

Back up the entire mounted `/data` directory. To restore manually, stop the container, replace `state.json`, preserve valid JSON with `tasks` and `categories` arrays, then restart.

## Unraid

Community Applications uses the template in [catduck-unraid-templates](https://github.com/catduckgnaf/catduck-unraid-templates/blob/main/templates/toduck.xml). You can also import [selfhost/unraid-template.xml](unraid-template.xml).

1. Create `/mnt/user/appdata/toduck`.
2. Install the template, or add the container manually with image `ghcr.io/catduckgnaf/toduck:latest`.
3. Map host port `8793` to container port `8787`.
4. Map `/mnt/user/appdata/toduck` to `/data`.
5. Set `TODUCK_TOKEN` to a unique secret of at least 32 characters.
6. Open `http://<unraid-lan-ip>:8793/health` and confirm a `200` response.

`latest` and version tags are releases. `develop` and `nightly` are optional floating tags that move only to a Quality-green `main` commit. Change the repository line if you want one of those instead of `latest`.

## Build without Compose

```sh
docker build -f selfhost/Dockerfile -t toduck:local .
docker run --rm \
  -p 8793:8787 \
  -e TODUCK_TOKEN="$TODUCK_TOKEN" \
  -v toduck-data:/data \
  toduck:local
```

