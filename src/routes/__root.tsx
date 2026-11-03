import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import appCss from "../styles.css?url";

const APP_NAME = "Toduck";

/**
 * Boot watchdog, inlined in the shell like the service-worker registration
 * below. The served page is a loading skeleton until the app bundle loads
 * and a route reports a finished boot by setting `window.__toduckBooted`
 * (Home once its data is ready, the login page as soon as it renders). If
 * that never happens — the bundle was blocked or served stale, hydration
 * threw before Home mounted, a cached service-worker shell outlived its
 * assets — the skeleton would otherwise sit there forever with no error
 * and no way out. After 9 seconds this script offers recovery instead:
 * a plain reload, or clearing this browser's saved app data (service
 * workers, caches, and the persisted local store) before reloading.
 * It must stay dependency-free inline script: it exists precisely for
 * the case where the bundle never runs.
 */
const BOOT_WATCHDOG_SCRIPT = `(function () {
  var elapsed = 0;
  var timer = setInterval(function () {
    if (window.__toduckBooted) {
      // Startup finished — possibly after the panel below already appeared
      // on a slow load — so withdraw the panel and stop watching.
      clearInterval(timer);
      var stale = document.getElementById("toduck-boot-recovery");
      if (stale) stale.remove();
      return;
    }
    elapsed += 500;
    if (elapsed < 9000) return;
    if (!document.body || document.getElementById("toduck-boot-recovery")) return;
    var box = document.createElement("div");
    box.id = "toduck-boot-recovery";
    box.setAttribute("style", "position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;background:#23211d;color:#f2efe9;border:1px solid #4a463f;border-radius:12px;padding:16px;font-family:system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)");
    var heading = document.createElement("strong");
    heading.textContent = "Toduck is stuck loading";
    heading.setAttribute("style", "font-size:16px");
    var text = document.createElement("p");
    text.textContent = "The app did not finish starting. This is usually a stale cached copy or saved site data in this browser. Reloading may fix it. Clearing saved app data also fixes it, but removes tasks stored only in this browser — anything synced to your server is safe.";
    text.setAttribute("style", "margin:8px 0 12px;font-size:14px;line-height:1.45");
    var buttonStyle = "margin-right:8px;padding:8px 14px;border-radius:8px;border:1px solid #4a463f;background:#31302b;color:#f2efe9;font-size:14px;cursor:pointer";
    var reload = document.createElement("button");
    reload.textContent = "Reload";
    reload.setAttribute("style", buttonStyle);
    reload.addEventListener("click", function () { location.reload(); });
    var clear = document.createElement("button");
    clear.textContent = "Clear saved app data and reload";
    clear.setAttribute("style", buttonStyle);
    clear.addEventListener("click", function () {
      var done = function () { location.reload(); };
      var jobs = [];
      try {
        if ("serviceWorker" in navigator) {
          jobs.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
            return Promise.all(regs.map(function (reg) { return reg.unregister(); }));
          }));
        }
        if (window.caches) {
          jobs.push(caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (key) { return caches.delete(key); }));
          }));
        }
      } catch (e) { /* fall through to the reload */ }
      try { localStorage.removeItem("toduck"); localStorage.removeItem("cadence"); } catch (e) { /* ignore */ }
      Promise.all(jobs).then(done, done);
    });
    box.appendChild(heading);
    box.appendChild(text);
    box.appendChild(reload);
    box.appendChild(clear);
    document.body.appendChild(box);
  }, 500);
})();`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      {
        name: "description",
        content: "A dark task feed. Repeats show once, and checking one moves it to the next date.",
      },
      { name: "theme-color", content: "#141311" },
    ],
    links: [
      { rel: "icon", type: "image/png", href: "/logo.png" },
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,500;6..72,600&family=Outfit:wght@400;500;600&display=swap",
      },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
    ],
  }),
  component: () => (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); }); }",
          }}
        />
        <script dangerouslySetInnerHTML={{ __html: BOOT_WATCHDOG_SCRIPT }} />
        <PreviewHostBridge />
        <AuthProvider>
          <Outlet />
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  ),
});
