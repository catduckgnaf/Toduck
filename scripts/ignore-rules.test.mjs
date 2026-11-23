import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function ignorePatterns(filename) {
  return new Set(
    readFileSync(join(root, filename), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  );
}

test("Docker build context excludes env files and preview data at any depth", () => {
  const patterns = ignorePatterns(".dockerignore");
  for (const required of [".env*", "**/.env*", ".preview", "**/.preview"]) {
    assert.ok(patterns.has(required), `.dockerignore must exclude ${required}`);
  }
});

test("Git ignores generated smoke baselines and unused lock artifacts", () => {
  const patterns = ignorePatterns(".gitignore");
  for (const required of ["screenshots/app-builder-preview*", ".node_modules.lock"]) {
    assert.ok(patterns.has(required), `.gitignore must exclude ${required}`);
  }
});
