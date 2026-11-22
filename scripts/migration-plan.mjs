// @ts-check
/**
 * Migration bookkeeping shared by the two appliers — `scripts/migrate.mjs`
 * (deploy, `readdir`) and `src/lib/db.ts` (PGLite preview, `import.meta.glob`).
 *
 * Applied files are keyed by BASENAME, so the same file applies once no matter
 * which directory it is globbed from. That is what makes the auth schema safe
 * to keep under `migrations/auth/`: a database that already applied a copy of
 * `0001_auth.sql` from `migrations/` will not re-run the source file.
 *
 * Both appliers descend into subdirectories, so `migrations/auth/*.sql` is in
 * scope for both — the auth tables apply wherever sign-in is configured.
 */

/**
 * All `.sql` files under `dir`, as paths relative to `dir` (e.g.
 * `auth/0001_auth.sql`), in traversal order. Used by the deploy migrator;
 * the PGLite applier uses a recursive `import.meta.glob` instead. The fs
 * import is dynamic so this shared module stays importable from bundled
 * (non-Node) code that never calls this function.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listMigrationFiles(dir) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { recursive: true });
  return entries.filter(isMigrationFile);
}

/**
 * The `_migrations` key for a migration path (or bare filename).
 * @param {string} path
 * @returns {string}
 */
export function migrationName(path) {
  return path.split("/").pop() ?? path;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isMigrationFile(path) {
  return path.endsWith(".sql");
}

/**
 * Migrations in `paths` that are not yet in `applied`, in apply order.
 * Non-`.sql` entries (a `readdir` also yields `migrations/auth/`) are dropped.
 * When the same basename shows up in two directories (a copied-up auth schema
 * plus its source), only the first — top-level before nested — is returned, so
 * the file can never be applied twice in one pass.
 * @param {Iterable<string>} paths
 * @param {Iterable<string>} applied
 * @returns {Array<{ name: string, path: string }>}
 */
export function pendingMigrations(paths, applied) {
  const done = new Set(applied);
  const seen = new Set();
  return [...paths]
    .filter(isMigrationFile)
    .map((path) => ({ name: migrationName(path), path }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    .filter(({ name }) => {
      if (done.has(name) || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
}
