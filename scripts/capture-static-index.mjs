import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function missingAssets(html, dir) {
  const urls = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1].split("?")[0]);
  return [...new Set(urls)].filter((url) => {
    if (url.startsWith("/__grok/")) return false;
    const file = join(dir, decodeURIComponent(url).replace(/^\/+/, ""));
    return !existsSync(file);
  });
}

async function main() {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const staticDir = join(root, ".vercel/output/static");
  const port = 8099;
  const preview = spawn(process.execPath, ["./node_modules/vite/bin/vite.js", "preview", "--port", String(port), "--host", "127.0.0.1", "--strictPort"], {
    cwd: root,
    stdio: "inherit",
  });
  let html = "";
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) {
          html = await response.text();
          break;
        }
      } catch {
        // Preview is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!html.includes("Toduck")) {
      console.error("Static shell did not render.");
      process.exitCode = 1;
      return;
    }
    const missing = missingAssets(html, staticDir);
    if (missing.length) {
      console.error(`Static shell references missing files: ${missing.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(join(staticDir, "index.html"), html);
    console.log("Wrote static index.html");
  } finally {
    preview.kill();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
  if (process.exitCode) process.exit(process.exitCode);
}
