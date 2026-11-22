// Toduck service worker: the app shell and every build asset are precached on
// install, so the installed app launches and restarts offline.
//
// `npm run build` runs scripts/stamp-sw.mjs, which rewrites the two stamped
// lines below in the built copy of this file: BUILD_ID changes with every
// build, and PRECACHE_ASSETS lists every file under /assets/. In `npm run dev`
// the stamps keep their defaults and only runtime caching applies.
//
// Activation deletes every cache whose name is not the current one, so a new
// build never inherits an older shell or asset set. The worker never touches
// localStorage, so saved tasks are unaffected by updates or cache resets.
const BUILD_ID = "dev"; // @stamp build
const PRECACHE_ASSETS = []; // @stamp assets

const CACHE = "toduck-" + BUILD_ID;
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

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
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

async function hashedAsset(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && !isHtml(res)) remember(cache, req, res.clone());
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
    event.respondWith(navigate(req, url));
    return;
  }

  // Content-hashed build output never changes under the same name.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(hashedAsset(req));
    return;
  }

  // Icons, manifest and other unhashed files: fresh when online, cached offline.
  if (/\.(js|css|mjs|png|svg|webp|woff2?|webmanifest)$/.test(url.pathname)) {
    event.respondWith(networkFirst(req));
  }
});
