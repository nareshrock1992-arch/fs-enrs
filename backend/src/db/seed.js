// Run: node src/db/seed.js
// Creates a default admin user and a sample tenant/organization.
import '../../load-env.js';
import bcrypt from 'bcryptjs';
import { pool, testConnection, query } from './pool.js';

async function seed() {
  const ok = await testConnection();
  if (!ok) process.exit(1);

  // Default admin — change password immediately after first login
  const email    = process.env.SEED_ADMIN_EMAIL    || 'admin@enrs.local';
  const password = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';
  const fullName = 'System Administrator';

  const hash = await bcrypt.hash(password, 12);

  // Tenant
  const { rows: [tenant] } = await query(
    `INSERT INTO tenants (name, code) VALUES ($1,$2)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    ['Default Tenant', 'DEFAULT']
  );

  // Admin user
  const { rows: [user] } = await query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
     VALUES ($1,$2,$3,$4,'ADMIN')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id, email`,
    [tenant.id, email, hash, fullName]
  );

  // Default organization
  const { rows: [org] } = await query(
    `INSERT INTO organizations (tenant_id, name, code, description)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [tenant.id, 'Default Organization', 'DEFAULT-ORG', 'Created by seed']
  );

  // ESL connection record
  await query(
    `INSERT INTO esl_connections (name, host, port, password)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING`,
    ['Primary FreeSWITCH',
     process.env.ESL_HOST || '127.0.0.1',
     Number(process.env.ESL_PORT || 8021),
     process.env.ESL_PASSWORD || 'ClueCon']
  );

  console.log(`[seed] Admin created: ${user.email}  password: ${password}`);
  console.log('[seed] Change the password after first login!');
  await pool.end();
}

seed();
