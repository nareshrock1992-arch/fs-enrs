import pg from 'pg';
import { config } from '../config/index.js';

const { Pool } = pg;

export const pool = new Pool({
  host:     config.db.host,
  port:     config.db.port,
  database: config.db.name,
  user:     config.db.user,
  password: config.db.password,
  ssl:      config.db.ssl ? { rejectUnauthorized: false } : false,
  max:      20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[db] Pool error:', err.message);
});

// Convenience wrapper — use `query(sql, params)` everywhere
export async function query(sql, params) {
  const res = await pool.query(sql, params);
  return res;
}

// Transaction helper — fn receives a client bound query function
// Usage: withTransaction(async (tq) => { await tq(sql, params); })
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn((sql, params) => client.query(sql, params));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function testConnection() {
  try {
    const { rows } = await query('SELECT NOW() AS now');
    console.log('[db] Connected — server time:', rows[0].now);
    return true;
  } catch (err) {
    console.error('[db] Connection failed:', err.message);
    return false;
  }
}
