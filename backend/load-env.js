/**
 * Explicit dotenv loader — always resolves .env relative to THIS FILE,
 * never relative to process.cwd(). This means it works correctly whether
 * the process is started with:
 *   node server.js          (cwd = backend/)
 *   pm2 start ...           (cwd set by PM2 — may differ)
 *   npx vitest              (cwd = wherever vitest runs)
 *
 * Must be the FIRST import in server.js and any entry-point that needs env.
 * Does NOT overwrite env vars already set in the process environment, so
 * PM2's `env` / `env_file` block values are preserved when intentionally set.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env'), override: false });
