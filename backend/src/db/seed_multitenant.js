// Run: node src/db/seed_multitenant.js
// Prerequisites: migration 044 must already be applied (adds SUPER_ADMIN to role check constraint).
//
// What this does:
//   1. Promotes admin@enrs.local → SUPER_ADMIN, tenant_id = NULL  (platform admin)
//   2. Creates Tenant A and Tenant B (if they don't exist)
//   3. Ensures naresh@enrs.local exists as ADMIN in Tenant A  (NOT SUPER_ADMIN)
//   4. Creates tenantB.admin@enrs.local as ADMIN in Tenant B
//
// Dev passwords (all accounts): Admin@12345

import '../../load-env.js';
import bcrypt from 'bcryptjs';
import { pool, testConnection, query } from './pool.js';

async function seed() {
  const ok = await testConnection();
  if (!ok) process.exit(1);

  // ── 1. Promote admin@enrs.local → SUPER_ADMIN ─────────────────────────────
  const { rowCount: adminUpdated } = await query(
    `UPDATE users SET role = 'SUPER_ADMIN', tenant_id = NULL
     WHERE email = 'admin@enrs.local' AND deleted_at IS NULL`
  );
  if (adminUpdated) {
    console.log('[seed_mt] admin@enrs.local → SUPER_ADMIN (tenant_id = NULL)');
  } else {
    console.log('[seed_mt] admin@enrs.local not found — skipped (run seed.js first)');
  }

  // ── 2. Tenant A ────────────────────────────────────────────────────────────
  const { rows: [tenantA] } = await query(
    `INSERT INTO tenants (name, code)
     VALUES ('Tenant A', 'TENANT_A')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name`
  );
  console.log(`[seed_mt] Tenant A id=${tenantA.id}`);

  await query(
    `INSERT INTO organizations (tenant_id, name, code)
     VALUES ($1, 'Tenant A HQ', 'TENANT_A_HQ')
     ON CONFLICT DO NOTHING`,
    [tenantA.id]
  );

  // naresh@enrs.local → ADMIN in Tenant A  (never SUPER_ADMIN, never tenant_id=NULL)
  const hashNaresh = await bcrypt.hash('Admin@12345', 12);
  const { rows: [naresh] } = await query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
     VALUES ($1, 'naresh@enrs.local', $2, 'Naresh', 'ADMIN')
     ON CONFLICT (email) DO UPDATE
       SET tenant_id     = $1,
           role          = 'ADMIN',
           password_hash = EXCLUDED.password_hash
     RETURNING email, role, tenant_id`,
    [tenantA.id, hashNaresh]
  );
  console.log(`[seed_mt] naresh@enrs.local → role=${naresh.role} tenant_id=${naresh.tenant_id}  password: Admin@12345`);

  // ── 3. Tenant B ────────────────────────────────────────────────────────────
  const { rows: [tenantB] } = await query(
    `INSERT INTO tenants (name, code)
     VALUES ('Tenant B', 'TENANT_B')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name`
  );
  console.log(`[seed_mt] Tenant B id=${tenantB.id}`);

  await query(
    `INSERT INTO organizations (tenant_id, name, code)
     VALUES ($1, 'Tenant B HQ', 'TENANT_B_HQ')
     ON CONFLICT DO NOTHING`,
    [tenantB.id]
  );

  const hashB = await bcrypt.hash('Admin@12345', 12);
  const { rows: [userB] } = await query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
     VALUES ($1, 'tenantB.admin@enrs.local', $2, 'Tenant B Admin', 'ADMIN')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING email`,
    [tenantB.id, hashB]
  );
  console.log(`[seed_mt] ${userB.email}  password: Admin@12345`);

  console.log('[seed_mt] Done.');
  console.log('  admin@enrs.local      → SUPER_ADMIN  tenant_id=NULL');
  console.log('  naresh@enrs.local     → ADMIN        Tenant A');
  console.log('  tenantB.admin@…       → ADMIN        Tenant B');
  await pool.end();
}

seed();
