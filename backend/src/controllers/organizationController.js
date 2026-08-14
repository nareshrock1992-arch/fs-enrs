import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { effectiveTenantId } from '../middleware/tenantScope.js';

const emptyToNull = z.preprocess(v => (v === '' ? null : v), z.string().nullable().optional());
const emptyToNullEmail = z.preprocess(v => (v === '' ? null : v), z.string().email().nullable().optional());

const OrgSchema = z.object({
  name:        z.string().min(1).max(128),
  code:        emptyToNull,
  description: emptyToNull,
  address:     emptyToNull,
  phone:       emptyToNull,
  email:       emptyToNullEmail,
  is_active:   z.boolean().default(true),
  // Only trusted when caller is SUPER_ADMIN; otherwise derived from JWT.
  tenant_id:   z.number().int().positive().optional(),
});

// ── Organizations ────────────────────────────────────────────

export const listOrganizations = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  if (req.user.role !== 'SUPER_ADMIN' && !tenantId) {
    return res.status(403).json({ error: 'Tenant context required' });
  }

  const page  = Math.max(1, Number(req.query.page)  || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const search = req.query.search ? `%${req.query.search}%` : null;

  const { rows } = await query(
    `SELECT o.id, o.tenant_id, o.name, o.code, o.description, o.address, o.phone, o.email,
            o.is_active, o.is_system, o.created_at, o.updated_at,
            t.name AS tenant_name,
       (SELECT COUNT(*) FROM emergency_contacts c WHERE c.organization_id = o.id AND c.deleted_at IS NULL) AS contact_count
     FROM organizations o
     LEFT JOIN tenants t ON t.id = o.tenant_id
     WHERE o.deleted_at IS NULL
       AND ($1::int  IS NULL OR o.tenant_id = $1)
       AND ($2::text IS NULL OR o.name ILIKE $2 OR o.code ILIKE $2)
     ORDER BY o.name ASC
     LIMIT $3 OFFSET $4`,
    [tenantId, search, limit, offset]
  );
  const { rows: cntRows } = await query(
    `SELECT COUNT(*)::INT AS total FROM organizations
     WHERE deleted_at IS NULL
       AND ($1::int  IS NULL OR tenant_id = $1)
       AND ($2::text IS NULL OR name ILIKE $2 OR code ILIKE $2)`,
    [tenantId, search]
  );

  res.json({ organizations: rows, total: cntRows[0].total, page, limit });
});

export const getOrganization = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rows } = await query(
    `SELECT id, tenant_id, name, code, description, address, phone, email,
            is_active, is_system, created_at, updated_at
     FROM organizations
     WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Organization not found' });
  res.json(rows[0]);
});

export const createOrganization = asyncHandler(async (req, res) => {
  const data = OrgSchema.parse(req.body);
  let tenantId;
  if (req.user.role === 'SUPER_ADMIN') {
    tenantId = data.tenant_id || null;
  } else {
    tenantId = req.user.tenantId;
    if (!tenantId) return res.status(403).json({ error: 'Tenant context required' });
  }
  const { rows } = await query(
    `INSERT INTO organizations (name, code, description, address, phone, email, is_active, tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [data.name, data.code, data.description, data.address, data.phone, data.email, data.is_active, tenantId]
  );
  res.status(201).json(rows[0]);
});

export const updateOrganization = asyncHandler(async (req, res) => {
  const data = OrgSchema.partial().parse(req.body);
  const tenantId = effectiveTenantId(req);
  const { rows } = await query(
    `UPDATE organizations SET
       name        = COALESCE($3, name),
       code        = COALESCE($4, code),
       description = COALESCE($5, description),
       address     = COALESCE($6, address),
       phone       = COALESCE($7, phone),
       email       = COALESCE($8, email),
       is_active   = COALESCE($9, is_active),
       updated_at  = now()
     WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)
     RETURNING *`,
    [req.params.id, tenantId, data.name, data.code, data.description, data.address, data.phone, data.email, data.is_active]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Organization not found' });
  res.json(rows[0]);
});

export const deleteOrganization = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rowCount } = await query(
    `UPDATE organizations SET deleted_at = now()
     WHERE id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Organization not found' });
  res.status(204).end();
});

// ── Locations ────────────────────────────────────────────────

const LocationSchema = z.object({
  organization_id: z.number().int().positive(),
  name:       z.string().min(1).max(128),
  address:    emptyToNull,
  building:   emptyToNull,
  floor:      emptyToNull,
  room:       emptyToNull,
  is_active:  z.boolean().default(true),
});

// Verify an organization belongs to the caller's effective tenant.
async function verifyOrgTenant(orgId, tenantId) {
  if (tenantId === null) return; // SUPER_ADMIN — no restriction
  const { rows: [org] } = await query(
    `SELECT id FROM organizations WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [orgId, tenantId]
  );
  if (!org) throw Object.assign(new Error('Organization not found'), { status: 404 });
}

export const listLocations = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const orgId = req.query.organization_id || null;
  const { rows } = await query(
    `SELECT l.* FROM locations l
     JOIN organizations o ON o.id = l.organization_id
     WHERE l.deleted_at IS NULL
       AND ($1::int IS NULL OR o.tenant_id = $1)
       AND ($2::int IS NULL OR l.organization_id = $2)
     ORDER BY l.name ASC`,
    [tenantId, orgId]
  );
  res.json({ locations: rows });
});

export const createLocation = asyncHandler(async (req, res) => {
  const d = LocationSchema.parse(req.body);
  await verifyOrgTenant(d.organization_id, effectiveTenantId(req));
  const { rows } = await query(
    `INSERT INTO locations (organization_id, name, address, building, floor, room, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [d.organization_id, d.name, d.address, d.building, d.floor, d.room, d.is_active]
  );
  res.status(201).json(rows[0]);
});

export const updateLocation = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const d = LocationSchema.partial().parse(req.body);
  const { rows } = await query(
    `UPDATE locations l SET
       name      = COALESCE($2, l.name),
       address   = COALESCE($3, l.address),
       building  = COALESCE($4, l.building),
       floor     = COALESCE($5, l.floor),
       room      = COALESCE($6, l.room),
       is_active = COALESCE($7, l.is_active),
       updated_at = now()
     FROM organizations o
     WHERE l.id = $1 AND l.deleted_at IS NULL
       AND o.id = l.organization_id
       AND ($8::int IS NULL OR o.tenant_id = $8)
     RETURNING l.*`,
    [req.params.id, d.name, d.address, d.building, d.floor, d.room, d.is_active, tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Location not found' });
  res.json(rows[0]);
});

export const deleteLocation = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rowCount } = await query(
    `UPDATE locations l SET deleted_at = now()
     FROM organizations o
     WHERE l.id = $1 AND l.deleted_at IS NULL
       AND o.id = l.organization_id
       AND ($2::int IS NULL OR o.tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Location not found' });
  res.status(204).end();
});

// ── Departments ──────────────────────────────────────────────

const DeptSchema = z.object({
  organization_id: z.number().int().positive(),
  location_id:     z.number().int().positive().optional().nullable(),
  name:            z.string().min(1).max(128),
  extension:       emptyToNull,
  type:            emptyToNull,
  notes:           emptyToNull,
  is_active:       z.boolean().default(true),
});

export const listDepartments = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const orgId = req.query.organization_id || null;
  const { rows } = await query(
    `SELECT d.*, l.name AS location_name FROM departments d
     LEFT JOIN locations l ON l.id = d.location_id
     JOIN organizations o ON o.id = d.organization_id
     WHERE d.deleted_at IS NULL
       AND ($1::int IS NULL OR o.tenant_id = $1)
       AND ($2::int IS NULL OR d.organization_id = $2)
     ORDER BY d.name ASC`,
    [tenantId, orgId]
  );
  res.json({ departments: rows });
});

export const createDepartment = asyncHandler(async (req, res) => {
  const d = DeptSchema.parse(req.body);
  await verifyOrgTenant(d.organization_id, effectiveTenantId(req));
  const { rows } = await query(
    `INSERT INTO departments (organization_id, location_id, name, extension, type, notes, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [d.organization_id, d.location_id, d.name, d.extension, d.type, d.notes, d.is_active]
  );
  res.status(201).json(rows[0]);
});

export const updateDepartment = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const d = DeptSchema.partial().parse(req.body);
  const { rows } = await query(
    `UPDATE departments dep SET
       name        = COALESCE($2, dep.name),
       location_id = COALESCE($3, dep.location_id),
       extension   = COALESCE($4, dep.extension),
       type        = COALESCE($5, dep.type),
       notes       = COALESCE($6, dep.notes),
       is_active   = COALESCE($7, dep.is_active),
       updated_at  = now()
     FROM organizations o
     WHERE dep.id = $1 AND dep.deleted_at IS NULL
       AND o.id = dep.organization_id
       AND ($8::int IS NULL OR o.tenant_id = $8)
     RETURNING dep.*`,
    [req.params.id, d.name, d.location_id, d.extension, d.type, d.notes, d.is_active, tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Department not found' });
  res.json(rows[0]);
});

export const deleteDepartment = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rowCount } = await query(
    `UPDATE departments dep SET deleted_at = now()
     FROM organizations o
     WHERE dep.id = $1 AND dep.deleted_at IS NULL
       AND o.id = dep.organization_id
       AND ($2::int IS NULL OR o.tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Department not found' });
  res.status(204).end();
});
