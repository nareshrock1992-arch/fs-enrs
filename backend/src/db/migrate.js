// Run: node src/db/migrate.js
// Applies schema.sql to the connected database.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool, testConnection } from './pool.js';

const __dir = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const ok = await testConnection();
  if (!ok) process.exit(1);

  const sql = readFileSync(join(__dir, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('[migrate] Schema applied successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] Failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
