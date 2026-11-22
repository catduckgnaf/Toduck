# Toduck — project guide

Toduck is a local-first task inbox. Every task has a date. The Web UI calls tags what the stored model still names categories, so sync and Android stay compatible. It also has repeating tasks, projects, search, import/export, optional self-hosted sync, and an Android companion.

## Layout

- `src/components/toduck` — task manager UI
- `src/lib/toduck` — task model, state, persistence, and sync client
- `selfhost` — standalone sync server (Go runtime; the Node implementation is
  the behavioral reference), Docker image, Compose file, and Unraid template
- `android` — Android client and home-screen widget
- `e2e` — Playwright browser tests

## Development

Requirements: Node.js 22 or newer and npm.

```sh
npm ci
npm run dev        # http://localhost:8080
```

Quality checks (all run in CI via `.github/workflows/quality.yml`):

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm run test:e2e
cd selfhost/go && go test ./...
```

## Conventions

- Start Vite only through the npm scripts. They route through
  `scripts/with-app-env.mjs`, which merges `app-env.json` (repo root) into
  the environment (only `VITE_` keys; a real environment variable always
  wins). The file currently carries no client flags.
- There is no web sign-in screen and no client-side auth gate. A gate in the
  browser cannot protect data: tasks live in browser storage, and synced data is
  protected only by the server's bearer tokens (`TODUCK_TOKEN` admin, personal
  tokens per user). Never add a client-only gate and call it security. Any new
  data route must call the server's `authenticate` step first, in both
  `selfhost/go/server.go` and `selfhost/server.mjs`, and extend the route
  table in the "every API route" tests in both server test files.
- Tasks stay in browser storage unless sync is configured. The sync token
  (`TODUCK_TOKEN`, at least 32 characters) is kept only in the browser
  session — never commit it. See `selfhost/README.md` for the sync API,
  Docker, and Unraid details.
- Preview/runtime scratch files live under `.preview/` (gitignored). The
  production build output lands in `.vercel/output/` (also gitignored) —
  never commit either.
