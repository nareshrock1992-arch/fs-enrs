// Run: node src/db/seed_multitenant.js
// Creates test tenants, tenant admins, and promotes naresh@enrs.local to SUPER_ADMIN.
import '../../load-env.js';
import bcrypt from 'bcryptjs';
import { pool, testConnection, query } from './pool.js';

async function seed() {
  const ok = await testConnection();
  if (!ok) process.exit(1);

  // 1. Promote naresh@enrs.local to SUPER_ADMIN (clears tenant_id)
  const { rowCount: nareshUpdated } = await query(
    `UPDATE users SET role = 'SUPER_ADMIN', tenant_id = NULL
     WHERE email = 'naresh@enrs.local' AND deleted_at IS NULL`
  );
  if (nareshUpdated) {
    console.log('[seed_mt] naresh@enrs.local → SUPER_ADMIN (tenant_id cleared)');
  } else {
    console.log('[seed_mt] naresh@enrs.local not found — skipped');
  }

  // 2. Tenant A
  const { rows: [tenantA] } = await query(
    `INSERT INTO tenants (name, code, contact_email)
     VALUES ('Tenant A', 'TENANT_A', 'admin@tenanta.local')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    []
  );

  // Tenant A org
  await query(
    `INSERT INTO organizations (tenant_id, name, code)
     VALUES ($1, 'Tenant A HQ', 'TENANT_A_HQ')
     ON CONFLICT DO NOTHING`,
    [tenantA.id]
  );

  // Tenant A admin
  const hashA = await bcrypt.hash('Admin@12345', 12);
  const { rows: [userA] } = await query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
     VALUES ($1, 'tenantA.admin@enrs.local', $2, 'Tenant A Admin', 'ADMIN')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING email`,
    [tenantA.id, hashA]
  );
  console.log(`[seed_mt] Created ${userA.email}  password: Admin@12345`);

  // 3. Tenant B
  const { rows: [tenantB] } = await query(
    `INSERT INTO tenants (name, code, contact_email)
     VALUES ('Tenant B', 'TENANT_B', 'admin@tenantb.local')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    []
  );

  // Tenant B org
  await query(
    `INSERT INTO organizations (tenant_id, name, code)
     VALUES ($1, 'Tenant B HQ', 'TENANT_B_HQ')
     ON CONFLICT DO NOTHING`,
    [tenantB.id]
  );

  // Tenant B admin
  const hashB = await bcrypt.hash('Admin@12345', 12);
  const { rows: [userB] } = await query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
     VALUES ($1, 'tenantB.admin@enrs.local', $2, 'Tenant B Admin', 'ADMIN')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING email`,
    [tenantB.id, hashB]
  );
  console.log(`[seed_mt] Created ${userB.email}  password: Admin@12345`);

  console.log('[seed_mt] Done. Run migration 044 first if SUPER_ADMIN role is not yet allowed.');
  await pool.end();
}

seed();
