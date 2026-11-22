// Toduck service worker: the app shell and every build asset are precached on
// install, so the installed app launches and restarts offline.
//
// `npm run build` runs scripts/stamp-sw.mjs, which rewrites the two stamped
// lines below in the built copy of this file: BUILD_ID changes with every
// build, and PRECACHE_ASSETS lists every file under /assets/. In `npm run dev`
// the stamps keep their defaults and only runtime caching applies.
//
// Activation keeps the current cache, the cache of every build an open tab is
// still running, and the one build before the current one; it deletes the rest.
// The new worker takes over open tabs at once (skipWaiting), and a tab still
// running an older build may later lazy-load one of that build's chunks, even
// after several later deployments. The worker records which build cache each
// tab loads its assets from (in the CLIENTS_CACHE bookkeeping cache), so those
// requests keep succeeding offline or after the server removed the old files.
// Only build assets fall back to older caches; the app shell always comes from
// the current one. The worker never touches localStorage, so saved tasks are
// unaffected by updates.
const BUILD_ID = "dev"; // @stamp build
const PRECACHE_ASSETS = []; // @stamp assets

const CACHE = "toduck-" + BUILD_ID;
// Maps an open tab (client id) to the build cache it runs. Not a build cache.
const CLIENTS_CACHE = "toduck:clients";
const CLIENT_KEY = "/__toduck/client/";
// The page and the build assets must cache or installation fails (and the
// previous worker with its complete cache keeps serving). Icons are best effort.
const REQUIRED = ["/"];
const OPTIONAL = ["/manifest.webmanifest", "/logo.png", "/icon-192.png", "/icon-maskable-512.png", "/__grok/icon-180.png"];
// A navigation waits this long for the network before the cached shell is used,
// so a connection that is up but not answering does not freeze the app.
const NAVIGATION_TIMEOUT_MS = 4000;

async function fetchForCache(url) {
  // `reload` bypasses the HTTP cache so a stale copy is never pinned.
  const res = await fetch(new Request(url, { cache: "reload" }));
  if (!res.ok || res.redirected) throw new Error("precache failed: " + url + " " + res.status);
  return res;
}

async function precache() {
  const cache = await caches.open(CACHE);
  const required = [...new Set([...REQUIRED, ...PRECACHE_ASSETS])];
  await Promise.all(required.map(async (url) => cache.put(url, await fetchForCache(url))));
  await Promise.allSettled(OPTIONAL.map(async (url) => cache.put(url, await fetchForCache(url))));
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

// caches.keys() lists caches in creation order, so the last older Toduck cache
// belongs to the build this worker replaces. `inUse` holds the caches that open
// tabs are still running.
function cachesToDelete(keys, inUse = new Set()) {
  const older = keys.filter((k) => k !== CACHE && k !== CLIENTS_CACHE);
  const ours = older.filter((k) => k.startsWith("toduck-"));
  const previous = ours[ours.length - 1];
  return older.filter((k) => k !== previous && !inUse.has(k));
}

// Records which build cache a tab runs. A navigation fixes it: the page opens
// on the build this worker serves. A tab that loaded before any worker
// controlled it is recorded by its first asset request instead (`ifAbsent`), so
// an asset two builds share never moves a tab to the wrong build. Records live in
// Cache Storage, so they outlive this worker.
const recorded = new Map();
async function recordClient(clientId, cacheName, ifAbsent = false) {
  if (!clientId || recorded.get(clientId) === cacheName) return;
  try {
    const meta = await caches.open(CLIENTS_CACHE);
    const key = CLIENT_KEY + encodeURIComponent(clientId);
    if (ifAbsent && (await meta.match(key))) return;
    recorded.set(clientId, cacheName);
    await meta.put(key, new Response(cacheName));
  } catch {
    // Bookkeeping is best effort; cleanup keeps every cache when it is missing.
  }
}

// Returns the caches open tabs still run, and forgets tabs that have closed.
async function cachesInUse(live) {
  const meta = await caches.open(CLIENTS_CACHE);
  const inUse = new Set();
  for (const key of await meta.keys()) {
    const id = decodeURIComponent(new URL(key.url).pathname.slice(CLIENT_KEY.length));
    if (live.has(id)) {
      const res = await meta.match(key);
      if (res) inUse.add(await res.text());
    } else {
      await meta.delete(key);
    }
  }
  return inUse;
}

async function cleanUp() {
  const live = new Set((await self.clients.matchAll({ type: "window", includeUncontrolled: true })).map((c) => c.id));
  const inUse = await cachesInUse(live).catch(() => null);
  // Without the bookkeeping, keep every Toduck cache rather than guess.
  if (!inUse) return;
  const keys = await caches.keys();
  // On the first install, the tabs already open loaded this build before any
  // worker ran, so nothing recorded them yet.
  if (!keys.some((k) => k !== CACHE && k.startsWith("toduck-"))) {
    await Promise.all([...live].map((id) => recordClient(id, CACHE, true)));
  }
  await Promise.all(cachesToDelete(keys, inUse).map((k) => caches.delete(k)));
}

self.addEventListener("activate", (event) => {
  event.waitUntil(cleanUp().then(() => self.clients.claim()));
});

function isHtml(res) {
  return (res.headers.get("content-type") || "").includes("text/html");
}

function remember(cache, key, res) {
  cache.put(key, res).catch(() => {});
}

async function navigate(req, url) {
  const cache = await caches.open(CACHE);
  let timer;
  const network = fetch(req).then(
    (res) => {
      // Only a successful HTML page may replace the cached shell. A 502 from a
      // reverse proxy must never become the offline app.
      if (res.ok && !res.redirected && isHtml(res)) remember(cache, url.pathname, res.clone());
      return res;
    },
    () => null,
  );
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS);
  });
  const res = await Promise.race([network, timeout]);
  clearTimeout(timer);
  if (res && res.ok) return res;
  // Offline, timed out, or the server answered with an error page: serve the
  // cached shell. With nothing cached, show what the server said.
  const cached = (await cache.match(url.pathname)) || (await cache.match("/"));
  if (cached) return cached;
  return res || (await network) || Response.error();
}

async function cacheHolding(req) {
  const current = await caches.open(CACHE);
  const hit = await current.match(req);
  if (hit) return { name: CACHE, hit };
  for (const name of (await caches.keys()).reverse()) {
    if (name === CACHE || !name.startsWith("toduck-")) continue;
    const older = await (await caches.open(name)).match(req);
    if (older) return { name, hit: older };
  }
  return null;
}

async function hashedAsset(req, clientId) {
  // A tab still on an older build asks for that build's chunks.
  const found = await cacheHolding(req);
  if (found) {
    recordClient(clientId, found.name, true);
    return found.hit;
  }
  const res = await fetch(req);
  if (res.ok && !isHtml(res)) {
    const cache = await caches.open(CACHE);
    remember(cache, req, res.clone());
    recordClient(clientId, CACHE, true);
  }
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && !isHtml(res)) remember(cache, req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GET
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Sync and API calls always go to the network. The app keeps its data
  // locally and syncs again when the server is reachable.
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    // The page this opens runs the build this worker serves.
    recordClient(event.resultingClientId, CACHE);
    event.respondWith(navigate(req, url));
    return;
  }

  // Content-hashed build output never changes under the same name.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(hashedAsset(req, event.clientId));
    return;
  }

  // Icons, manifest and other unhashed files: fresh when online, cached offline.
  if (/\.(js|css|mjs|png|svg|webp|woff2?|webmanifest)$/.test(url.pathname)) {
    event.respondWith(networkFirst(req));
  }
});
