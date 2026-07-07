// Sequential migration runner
// Usage: node src/db/migrate.js
//
// Applies schema.sql then all numbered migrations in order.
// Tracks applied migrations in the migration_log table.
// Safe to run multiple times — skips already-applied migrations.

import { readFileSync, readdirSync } from 'fs';
import { join, dirname }  from 'path';
import { fileURLToPath }  from 'url';
import { pool, testConnection } from './pool.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dir, 'migrations');

async function ensureMigrationLog(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS migration_log (
      id         SERIAL       PRIMARY KEY,
      filename   VARCHAR(256) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ  NOT NULL DEFAULT now()
    )
  `);
}

async function getApplied(client) {
  const { rows } = await client.query(
    `SELECT filename FROM migration_log ORDER BY applied_at`
  );
  return new Set(rows.map(r => r.filename));
}

async function applyFile(client, filename, sql) {
  console.log(`[migrate] Applying: ${filename}`);
  await client.query(sql);
  await client.query(
    `INSERT INTO migration_log (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING`,
    [filename]
  );
  console.log(`[migrate]  ✓ ${filename}`);
}

async function migrate() {
  const ok = await testConnection();
  if (!ok) process.exit(1);

  const client = await pool.connect();
  try {
    // Step 1: Ensure migration_log exists (outside any transaction — DDL is fine here)
    await ensureMigrationLog(client);
    const applied = await getApplied(client);

    // Step 2: Apply schema.sql (idempotent — all IF NOT EXISTS)
    const schemaFile = 'schema.sql';
    if (!applied.has(schemaFile)) {
      const sql = readFileSync(join(__dir, schemaFile), 'utf8');
      await client.query('BEGIN');
      try {
        await applyFile(client, schemaFile, sql);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    } else {
      console.log(`[migrate] Skip (already applied): ${schemaFile}`);
    }

    // Step 3: Apply numbered migrations in sort order
    const migrationFiles = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();  // lexicographic sort: 002_... < 003_... < 004_... < 005_...

    for (const filename of migrationFiles) {
      if (applied.has(filename)) {
        console.log(`[migrate] Skip (already applied): ${filename}`);
        continue;
      }

      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');

      // Each migration runs in its own transaction.
      // Migrations that contain their own BEGIN/COMMIT are fine —
      // pg sends them as nested which Postgres handles correctly when
      // the outer is a single-statement execution. However since each
      // migration file already has BEGIN/COMMIT, we run them directly.
      try {
        await applyFile(client, filename, sql);
      } catch (err) {
        console.error(`[migrate] FAILED: ${filename} — ${err.message}`);
        console.error('[migrate] Fix the migration file and re-run. Database may be in partial state.');
        process.exit(1);
      }
    }

    console.log('[migrate] All migrations applied successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
