import { createServer, request as httpRequest, type Server } from "node:http";
import { expect, test } from "playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These tests load the built app from the self-host server, the way the
// installed app runs. They need `npm run build` and `node scripts/capture-static-index.mjs`
// first (CI does both before the browser job).
const staticDir = join(process.cwd(), ".vercel/output/static");
const token = "offline-token-that-is-longer-than-thirty-two-characters";

async function startApp(port: number) {
  const directory = await mkdtemp(join(tmpdir(), "toduck-pwa-"));
  const env: NodeJS.ProcessEnv = { ...process.env, TODUCK_TOKEN: token, DATA_PATH: join(directory, "state.json"), PORT: String(port), STATIC_DIR: staticDir };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) delete env[key];
  const child: ChildProcess = spawn(process.execPath, ["selfhost/server.mjs"], { cwd: process.cwd(), env, stdio: "ignore" });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { child, directory };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  child.kill();
  throw new Error("Server did not become ready");
}

/** A reverse proxy in front of the app that can be told to answer 502, like a broken Caddy upstream. */
function startProxy(port: number, upstream: number) {
  const state = { broken: false };
  const server: Server = createServer((req, res) => {
    if (state.broken) {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<!doctype html><title>Bad gateway</title><h1>Bad gateway</h1>");
      return;
    }
    const forward = httpRequest({ host: "127.0.0.1", port: upstream, path: req.url, method: req.method, headers: req.headers }, (back) => {
      res.writeHead(back.statusCode ?? 502, back.headers);
      back.pipe(res);
    });
    forward.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(forward);
  });
  return new Promise<{ server: Server; state: { broken: boolean } }>((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, state })));
}

test("installed app launches and restarts offline, keeps its tasks, and ignores a broken proxy page", async ({ browser }, testInfo) => {
  await stat(join(staticDir, "index.html")).catch(() => {
    throw new Error("Run `npm run build` and `node scripts/capture-static-index.mjs` before this test.");
  });
  const appPort = 18810 + testInfo.workerIndex;
  const proxyPort = 18820 + testInfo.workerIndex;
  const app = await startApp(appPort);
  const proxy = await startProxy(proxyPort, appPort);
  const origin = `http://127.0.0.1:${proxyPort}`;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    await expect(page.getByRole("heading", { name: "Feed" })).toBeVisible({ timeout: 30_000 });

    // The worker installs, takes control, and cached the shell plus every build asset.
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 30_000 });
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      const builds = names.filter((name) => name.startsWith("toduck-"));
      for (const name of builds) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
      return { names: builds, urls };
    });
    expect(cached.names).toHaveLength(1);
    // The open tab is recorded as running this build, so later updates keep its cache.
    await expect
      .poll(() => page.evaluate(async () => (await (await caches.open("toduck:clients")).keys()).length))
      .toBeGreaterThan(0);
    expect(cached.urls).toContain("/");
    expect(cached.urls.filter((url) => url.startsWith("/assets/") && url.endsWith(".js")).length).toBeGreaterThan(1);
    expect(cached.urls.filter((url) => url.endsWith(".css")).length).toBeGreaterThan(0);

    // The manifest is installable: standalone, with 192 and 512 icons and a maskable icon.
    const manifest = await (await page.request.get(`${origin}/manifest.webmanifest`)).json();
    expect(manifest.display).toBe("standalone");
    const icons = manifest.icons as { sizes: string; purpose: string }[];
    expect(icons.some((icon) => icon.sizes === "192x192")).toBe(true);
    expect(icons.some((icon) => icon.sizes === "512x512" && icon.purpose.includes("any"))).toBe(true);
    expect(icons.some((icon) => icon.purpose === "maskable")).toBe(true);

    await page.getByLabel("New toduck").fill("Written before going offline");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Written before going offline" })).toBeVisible();

    // Offline: reload, then a cold restart in a new page, both keep working and keep the task.
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Feed" })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Written before going offline" })).toBeVisible();
    await page.close();
    const restarted = await context.newPage();
    await restarted.goto(`${origin}/`);
    await expect(restarted.getByRole("heading", { name: "Feed" })).toBeVisible();
    await expect(restarted.getByRole("listitem").filter({ hasText: "Written before going offline" })).toBeVisible();

    // Back online but the proxy answers 502: the app still opens from the cached shell,
    // and the error page does not replace it.
    await context.setOffline(false);
    proxy.state.broken = true;
    await restarted.goto(`${origin}/`);
    await expect(restarted.getByRole("heading", { name: "Feed" })).toBeVisible();
    await context.setOffline(true);
    await restarted.reload();
    await expect(restarted.getByRole("heading", { name: "Feed" })).toBeVisible();
    await expect(restarted.getByRole("listitem").filter({ hasText: "Written before going offline" })).toBeVisible();
  } finally {
    await context.close();
    proxy.server.close();
    app.child.kill();
    await rm(app.directory, { recursive: true, force: true });
  }
});
