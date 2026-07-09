/**
 * fs-enrs database migration runner
 *
 * Usage:  node src/db/migrate.js
 *
 * Behaviour
 * ─────────
 * Fresh database (tenants table does not exist):
 *   1. Apply schema.sql  — creates the base tables (001 equivalent).
 *   2. Mark 001 as applied; run every other migration normally (they are
 *      idempotent, so this also heals any schema.sql drift).
 *
 * Existing database (tenants table exists):
 *   1. Skip schema.sql entirely — never replay DDL against existing tables.
 *   2. Apply only numbered migration files that have not been recorded yet.
 *
 * In both cases:
 *   • schema_migrations tracks every applied filename.
 *   • Each migration file manages its own transaction (BEGIN/COMMIT inside
 *     the SQL file).  The runner does NOT add an outer transaction.
 *   • All migrations must be idempotent (IF NOT EXISTS, ON CONFLICT, etc.).
 *   • If a migration fails the error is printed and the process exits 1.
 *     The migration file's ROLLBACK (if any) fires automatically.
 *     Fix the file and re-run — already-applied migrations are skipped.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname }             from 'path';
import { fileURLToPath }             from 'url';
import { pool, testConnection }      from './pool.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dir, 'migrations');

// ── schema_migrations table ───────────────────────────────────────────────────

async function ensureMigrationsTable(client) {
  // Create the tracking table using the standard name.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(256) PRIMARY KEY,
      applied_at TIMESTAMPTZ  NOT NULL DEFAULT now()
    )
  `);

  // One-time backward-compat copy from the old migration_log table (Sprint B6).
  // Safe to run repeatedly — ON CONFLICT DO NOTHING is idempotent.
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'migration_log'
      ) THEN
        INSERT INTO schema_migrations (version, applied_at)
        SELECT filename, applied_at FROM migration_log
        ON CONFLICT (version) DO NOTHING;
      END IF;
    END $$
  `);
}

async function getApplied(client) {
  const { rows } = await client.query(
    `SELECT version FROM schema_migrations ORDER BY applied_at`
  );
  return new Set(rows.map(r => r.version));
}

async function recordApplied(client, version) {
  await client.query(
    `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
    [version]
  );
}

// ── Fresh-database detection ──────────────────────────────────────────────────

// Returns true when no application tables exist (brand-new / empty database).
// Uses the 'tenants' table as the sentinel — it is always the first table
// created by schema.sql.
async function isFreshDatabase(client) {
  const { rows } = await client.query(`
    SELECT NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name   = 'tenants'
    ) AS is_fresh
  `);
  return rows[0].is_fresh;
}

// ── Apply helpers ─────────────────────────────────────────────────────────────

async function applySchema(client, sqlPath) {
  console.log('[migrate] Fresh database — applying schema.sql');
  const sql = readFileSync(sqlPath, 'utf8');
  await client.query(sql);
  await recordApplied(client, 'schema.sql');
  console.log('[migrate]  ✓ schema.sql');
}

async function applyMigration(client, filename, sql) {
  console.log(`[migrate] Applying: ${filename}`);
  // The migration file owns its own BEGIN/COMMIT — do not wrap.
  await client.query(sql);
  await recordApplied(client, filename);
  console.log(`[migrate]  ✓ ${filename}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function migrate() {
  const ok = await testConnection();
  if (!ok) {
    console.error('[migrate] Cannot connect to database — check DB_* env vars.');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    // Step 1 — Ensure tracking table exists (and migrate from migration_log).
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);

    // Step 2 — Collect numbered migration files in sort order.
    const migrationFiles = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();   // lexicographic: 002_ < 003_ < 004_ < 005_

    // Step 3 — Handle schema.sql.
    if (!applied.has('schema.sql')) {
      const fresh = await isFreshDatabase(client);

      if (fresh) {
        // Fresh install: schema.sql creates the base tables.
        await applySchema(client, join(__dir, 'schema.sql'));

        // schema.sql covers the base tables of migration 001 only.
        // Migrations 002+ MUST still run even on fresh installs — schema.sql
        // has drifted from them before (e.g. organizations.address/phone/email
        // from 002 were missing), and they are all idempotent, so re-running
        // them on a schema.sql database is safe and self-healing.
        const coveredBySchema = new Set([
          '001_initial_schema.sql',
        ]);
        for (const f of migrationFiles) {
          if (coveredBySchema.has(f)) {
            await recordApplied(client, f);
            console.log(`[migrate]  ✓ Skipped (covered by schema.sql): ${f}`);
          }
        }

        // Fall through to Step 4 so migrations 006+ are applied normally.

      } else {
        // Existing database: record schema.sql as "done" without running it.
        await recordApplied(client, 'schema.sql');
        console.log('[migrate] Existing database — schema.sql skipped, running migrations only.');
      }
    }

    // Step 4 — Apply pending numbered migrations.
    const currentApplied = await getApplied(client);   // refresh after step 3
    let pendingCount = 0;

    for (const filename of migrationFiles) {
      if (currentApplied.has(filename)) {
        console.log(`[migrate] Skip (already applied): ${filename}`);
        continue;
      }

      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      try {
        await applyMigration(client, filename, sql);
        pendingCount++;
      } catch (err) {
        console.error(`[migrate] FAILED: ${filename}`);
        console.error(`[migrate] ${err.message}`);
        console.error('[migrate] Fix the migration file and re-run.');
        process.exit(1);
      }
    }

    if (pendingCount === 0) {
      console.log('[migrate] Database is already up to date.');
    } else {
      console.log(`[migrate] Applied ${pendingCount} migration(s) successfully.`);
    }

  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
