import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isMigrationFile, listMigrationFiles, migrationName, pendingMigrations } from "./migration-plan.mjs";
import { projectRoot } from "./with-app-env.mjs";

const AUTH_MIGRATION = "0001_auth.sql";

test("_migrations keys on basename, not path", () => {
  assert.equal(migrationName("/migrations/0002_todos.sql"), "0002_todos.sql");
  assert.equal(migrationName("migrations/auth/0001_auth.sql"), "0001_auth.sql");
  assert.equal(migrationName("0001_auth.sql"), "0001_auth.sql");
});

test("a file already applied from another directory does not re-apply", () => {
  // The auth-on path copies migrations/auth/0001_auth.sql into the globbed
  // directory; a database that already has it must not run it twice.
  assert.deepEqual(pendingMigrations(["/migrations/0001_auth.sql"], ["0001_auth.sql"]), []);
});

test("pending migrations are returned in name order", () => {
  assert.deepEqual(
    pendingMigrations(
      ["/migrations/0003_c.sql", "/migrations/0001_a.sql", "/migrations/0002_b.sql"],
      ["0001_a.sql"],
    ),
    [
      { name: "0002_b.sql", path: "/migrations/0002_b.sql" },
      { name: "0003_c.sql", path: "/migrations/0003_c.sql" },
    ],
  );
});

test("non-.sql entries are dropped (readdir also yields the auth/ directory)", () => {
  assert.equal(isMigrationFile("auth"), false);
  assert.deepEqual(pendingMigrations(["auth", "README.md"], []), []);
});

test("the auth schema under migrations/auth/ is in scope for both appliers", () => {
  const migrationsDir = join(projectRoot(), "migrations");
  assert.ok(readdirSync(join(migrationsDir, "auth")).includes(AUTH_MIGRATION));
  // The recursive appliers see it; the top level still has no .sql of its own.
  assert.deepEqual(pendingMigrations(readdirSync(migrationsDir), []), []);
  assert.deepEqual(pendingMigrations([`auth/${AUTH_MIGRATION}`], []), [
    { name: AUTH_MIGRATION, path: `auth/${AUTH_MIGRATION}` },
  ]);
});

test("listMigrationFiles descends into subdirectories", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrations-"));
  mkdirSync(join(root, "migrations/auth"), { recursive: true });
  writeFileSync(join(root, "migrations/0002_top.sql"), "select 2;\n");
  writeFileSync(join(root, "migrations/auth", AUTH_MIGRATION), "select 1;\n");
  writeFileSync(join(root, "migrations/README.md"), "not a migration\n");
  const files = await listMigrationFiles(join(root, "migrations"));
  assert.deepEqual([...files].sort(), ["0002_top.sql", `auth/${AUTH_MIGRATION}`]);
});

test("the same basename in two directories applies once, top-level first", () => {
  // A database that already applied a copied-up auth schema must not re-run
  // the source file in the same pass (the second _migrations insert would fail).
  assert.deepEqual(
    pendingMigrations([`auth/${AUTH_MIGRATION}`, AUTH_MIGRATION], []),
    [{ name: AUTH_MIGRATION, path: AUTH_MIGRATION }],
  );
  assert.deepEqual(
    pendingMigrations([AUTH_MIGRATION, `auth/${AUTH_MIGRATION}`], []),
    [{ name: AUTH_MIGRATION, path: AUTH_MIGRATION }],
  );
});
