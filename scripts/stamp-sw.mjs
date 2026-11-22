// Stamps the built service worker with this build's identity and asset list so
// the worker can precache everything the app needs to start offline.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_LINE = /^const BUILD_ID = .*; \/\/ @stamp build$/m;
const ASSETS_LINE = /^const PRECACHE_ASSETS = .*; \/\/ @stamp assets$/m;

export function listAssets(dir) {
  const assetsDir = join(dir, "assets");
  if (!existsSync(assetsDir)) return [];
  return readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".map"))
    .map((entry) => `/assets/${entry.name}`)
    .sort();
}

export function stampWorker(source, assets, fingerprint) {
  if (!BUILD_LINE.test(source) || !ASSETS_LINE.test(source)) {
    throw new Error("sw.js is missing its @stamp lines");
  }
  const buildId = createHash("sha256").update(source).update(fingerprint).update(assets.join("\n")).digest("hex").slice(0, 12);
  return source
    .replace(BUILD_LINE, () => `const BUILD_ID = ${JSON.stringify(buildId)}; // @stamp build`)
    .replace(ASSETS_LINE, () => `const PRECACHE_ASSETS = ${JSON.stringify(assets)}; // @stamp assets`);
}

function main() {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const dir = join(root, ".vercel/output/static");
  const swPath = join(dir, "sw.js");
  if (!existsSync(swPath)) throw new Error(`No built service worker at ${swPath}`);
  const assets = listAssets(dir);
  if (!assets.length) throw new Error("Build produced no /assets/ files to precache");
  // Unhashed files can change without their name changing, so they feed the build id.
  const fingerprint = ["manifest.webmanifest", "logo.png", "icon-192.png", "icon-maskable-512.png"]
    .map((name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name)) : ""))
    .map((data) => createHash("sha256").update(data).digest("hex"))
    .join("");
  writeFileSync(swPath, stampWorker(readFileSync(swPath, "utf8"), assets, fingerprint));
  console.log(`Stamped sw.js with ${assets.length} precached assets`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
