import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../infrastructure/logger.js';

const log = logger.forModule('db:pool');

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
  log.error('Pool error', { message: err.message });
});

// Annotate a pg error with the originating SQL and params so the error
// handler can log them without a separate call stack inspection.
function annotateDbError(err, sql, params) {
  if (err && typeof err === 'object') {
    err._sql    = sql;
    err._params = params;
  }
  return err;
}

// Convenience wrapper — use `query(sql, params)` everywhere
export async function query(sql, params) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    throw annotateDbError(err, sql, params);
  }
}

// Transaction helper — fn receives a client-bound query function
// Usage: withTransaction(async (tq) => { await tq(sql, params); })
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tq = (sql, params) => client.query(sql, params).catch(err => {
      throw annotateDbError(err, sql, params);
    });
    const result = await fn(tq);
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
    log.info('Connected', { serverTime: rows[0].now });
    return true;
  } catch (err) {
    log.error('Connection failed', { message: err.message });
    return false;
  }
}
