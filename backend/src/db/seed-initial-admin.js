/**
 * Initial SUPER_ADMIN bootstrap script.
 *
 * Usage:
 *   node src/db/seed-initial-admin.js
 *
 * Behaviour:
 *   1. Connects to the database using the existing pool configuration.
 *   2. Counts active SUPER_ADMIN users.
 *      - If one or more exist → logs and exits 0 (no changes).
 *   3. Validates INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD are set.
 *      - If missing → logs a clear error and exits 1.
 *   4. Checks for a soft-deleted user with the same email.
 *      - If found → logs an error and exits 1. Manual intervention required.
 *   5. Validates email format, password policy, and name.
 *   6. Hashes the password with bcryptjs (12 rounds — same as the application).
 *   7. Inserts the SUPER_ADMIN in a transaction.
 *      - On success → logs email and ID, exits 0.
 *      - On failure → rolls back, logs error, exits 1.
 *
 * Idempotency:
 *   Safe to run on every container startup. If a SUPER_ADMIN already exists
 *   the script performs one SELECT and exits without any writes.
 *
 * What is NEVER logged:
 *   - plaintext passwords
 *   - bcrypt hashes
 *
 * Security rules:
 *   - No hard-coded credentials.
 *   - Password comes exclusively from the INITIAL_ADMIN_PASSWORD env var.
 *   - tenant_id is always NULL for SUPER_ADMIN (platform-wide, per architecture).
 */

import '../../load-env.js';
import bcrypt from 'bcryptjs';
import { pool, withTransaction, testConnection } from './pool.js';

// Password policy mirrors the API: min 8 chars, upper, lower, digit, special.
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z\d])/;
const EMAIL_REGEX    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS  = 12;

function fail(message) {
  console.error(`[seed-initial-admin] ERROR: ${message}`);
  process.exit(1);
}

async function run() {
  // ── 1. Database connectivity ────────────────────────────────────────────────
  const ok = await testConnection();
  if (!ok) fail('Cannot connect to database — check DB_* env vars.');

  const client = await pool.connect();

  try {
    // ── 2. Check for existing SUPER_ADMIN ──────────────────────────────────────
    const { rows: existing } = await client.query(
      `SELECT id, email FROM users
       WHERE role = 'SUPER_ADMIN' AND deleted_at IS NULL
       LIMIT 1`
    );

    if (existing.length > 0) {
      console.log(`[seed-initial-admin] SUPER_ADMIN already exists (id=${existing[0].id}, email=${existing[0].email}). No changes made.`);
      return; // exit cleanly
    }

    console.log('[seed-initial-admin] No SUPER_ADMIN found. Checking bootstrap variables ...');

    // ── 3. Validate required env vars ──────────────────────────────────────────
    const email    = (process.env.INITIAL_ADMIN_EMAIL    || '').trim().toLowerCase();
    const password = (process.env.INITIAL_ADMIN_PASSWORD || '').trim();
    const fullName = (process.env.INITIAL_ADMIN_NAME     || 'System Administrator').trim();

    if (!email) {
      fail(
        'INITIAL_ADMIN_EMAIL is not set.\n' +
        '  Set it in .env or as an environment variable and re-run.\n' +
        '  Example: INITIAL_ADMIN_EMAIL=admin@example.com'
      );
    }

    if (!password) {
      fail(
        'INITIAL_ADMIN_PASSWORD is not set.\n' +
        '  Set it in .env or as an environment variable and re-run.\n' +
        '  Never commit the password to source control.'
      );
    }

    // ── 4. Validate email format ────────────────────────────────────────────────
    if (!EMAIL_REGEX.test(email)) {
      fail(`INITIAL_ADMIN_EMAIL "${email}" is not a valid email address.`);
    }

    // ── 5. Validate password policy ────────────────────────────────────────────
    if (password.length < 8) {
      fail('INITIAL_ADMIN_PASSWORD must be at least 8 characters.');
    }
    if (!PASSWORD_REGEX.test(password)) {
      fail(
        'INITIAL_ADMIN_PASSWORD must contain at least one uppercase letter, ' +
        'one lowercase letter, one digit, and one special character.'
      );
    }

    // ── 6. Validate name ───────────────────────────────────────────────────────
    if (fullName.length < 2 || fullName.length > 128) {
      fail('INITIAL_ADMIN_NAME must be between 2 and 128 characters.');
    }

    // ── 7. Check for soft-deleted user with same email ─────────────────────────
    //
    // The users table has a bare UNIQUE constraint on email (no WHERE deleted_at IS NULL).
    // A soft-deleted row with this email will cause the INSERT to fail with a
    // unique-violation error. We detect this early and fail with a clear message
    // so the operator knows exactly what manual intervention is required.
    const { rows: deleted } = await client.query(
      `SELECT id FROM users WHERE email = $1 AND deleted_at IS NOT NULL LIMIT 1`,
      [email]
    );

    if (deleted.length > 0) {
      fail(
        `A soft-deleted user with email "${email}" already exists (id=${deleted[0].id}).\n` +
        '  The users.email UNIQUE constraint prevents re-insertion.\n' +
        '  Manual intervention required. Options:\n' +
        '    A) Restore the user:  UPDATE users SET deleted_at = NULL WHERE id = <id>;\n' +
        '    B) Hard-delete:       DELETE FROM users WHERE id = <id>;  (irreversible)\n' +
        '    C) Use a different email in INITIAL_ADMIN_EMAIL.'
      );
    }

    // ── 8. Hash password ───────────────────────────────────────────────────────
    console.log('[seed-initial-admin] Hashing password ...');
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    // Never log the hash or the plaintext password.

    // ── 9. Insert in a transaction ─────────────────────────────────────────────
    //
    // tenant_id = NULL is correct for SUPER_ADMIN per the platform architecture
    // (migration 044 comment, seed_multitenant.js, and rbac.js confirm this).
    const created = await withTransaction(async (tq) => {
      const { rows: [user] } = await tq(
        `INSERT INTO users
           (tenant_id, email, password_hash, full_name, role, is_active, must_change_password)
         VALUES
           (NULL, $1, $2, $3, 'SUPER_ADMIN', true, false)
         RETURNING id, email, role`,
        [email, passwordHash, fullName]
      );
      return user;
    });

    console.log(`[seed-initial-admin] SUPER_ADMIN created successfully.`);
    console.log(`[seed-initial-admin]   id    : ${created.id}`);
    console.log(`[seed-initial-admin]   email : ${created.email}`);
    console.log(`[seed-initial-admin]   role  : ${created.role}`);
    console.log(`[seed-initial-admin]   tenant: NULL (platform-wide)`);

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(`[seed-initial-admin] Unexpected error: ${err.message}`);
  process.exit(1);
});
