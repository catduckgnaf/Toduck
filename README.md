# Toduck

Toduck 1.3.1 is a local-first task inbox. Every toduck has a date. The list stays compact, due dates sit on the right and are colored by when they fall (overdue, tomorrow, this week, next week, next month, future), and tags replace the old category column. It installs as a PWA, and an optional self-hosted server syncs the Web UI with the Android companion.

## Features

* Local first task storage in the browser
* Feed, day, upcoming, overdue, repeats, completed, workflow, and project views
* Tags, projects, search, and JSON backup
* Installable PWA
* Docker image tags: `latest` for releases, plus floating `develop` and `nightly` tags built only from a green `main`

## Development

Requirements: Node.js 22 or newer and npm.

```sh
npm ci
npm run dev
```

The development app listens on `http://localhost:8080`.

## Quality checks

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm run test:e2e
```

Playwright browser tests exercise the core task flow at desktop and 390 by 844 mobile viewports.

## Self hosting

The bundled container serves both the compiled Web UI and synchronization API from one origin.

```sh
export TODUCK_TOKEN="$(openssl rand -hex 32)"
docker compose -f selfhost/docker-compose.yml up --build -d
```

Open `http://localhost:8793`. The host address and port can be changed with `TODUCK_BIND` and `TODUCK_PORT`.

A prebuilt image is published to `ghcr.io/catduckgnaf/toduck` (amd64 and arm64); `docker compose -f selfhost/docker-compose.yml pull` uses it instead of building locally.

See [the self hosting guide](selfhost/README.md) for authentication, CORS, backups, API behavior, Docker, and Unraid instructions.

## Android

See [the Android guide](android/README.md) for build and connection instructions.

## Repository layout

* `src/components/toduck`: task manager UI
* `src/lib/toduck`: task model, state, persistence, and sync client
* `selfhost`: standalone server, Docker image, Compose file, and Unraid template
* `android`: Android client
* `e2e`: Playwright browser tests

## Data and security

Tasks remain in browser storage unless synchronization is configured. The server address may be remembered, but the bearer token is kept only in the current browser session and is cleared when disconnected. Use a unique token of at least 32 characters and put TLS or a trusted private network in front of any remote deployment.

## License

Toduck is open source software licensed under the [MIT License](LICENSE).
