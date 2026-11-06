// Bump this name on any release that must not inherit the previous
// shell/asset cache: activate deletes every cache with a different name,
// so a bump is a clean break from a stale or mismatched cached shell.
const CACHE = "toduck-v4";
const SHELL = ["/", "/logo.png", "/__grok/icon-180.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GET
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Network-first for API / state
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req)),
    );
    return;
  }

  // Cache-first for static assets, network-first for navigations
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match("/") || caches.match(req)),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/") || /\.(js|css|mjs|png|svg|webp|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const type = res.headers.get("content-type") || "";
          if (res.ok && !type.includes("text/html")) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || Response.error())),
    );
    return;
  }
});
