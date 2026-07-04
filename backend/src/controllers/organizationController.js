import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

// Coerce empty string → null for optional string fields so '' doesn't fail .email() etc.
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
  tenant_id:   z.number().int().positive().optional(),
});

// ── Organizations ────────────────────────────────────────────
export const listOrganizations = asyncHandler(async (req, res) => {
  const page  = Math.max(1, Number(req.query.page)  || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const search = req.query.search ? `%${req.query.search}%` : null;

  const { rows } = await query(
    `SELECT o.*, t.name AS tenant_name,
       (SELECT COUNT(*) FROM emergency_contacts c WHERE c.organization_id = o.id AND c.deleted_at IS NULL) AS contact_count
     FROM organizations o
     LEFT JOIN tenants t ON t.id = o.tenant_id
     WHERE o.deleted_at IS NULL
       AND ($1::text IS NULL OR o.name ILIKE $1 OR o.code ILIKE $1)
     ORDER BY o.name ASC
     LIMIT $2 OFFSET $3`,
    [search, limit, offset]
  );
  const total = rows.length > 0
    ? (await query(`SELECT COUNT(*) FROM organizations WHERE deleted_at IS NULL ${search ? 'AND (name ILIKE $1 OR code ILIKE $1)' : ''}`, search ? [search] : [])).rows[0].count
    : 0;

  res.json({ organizations: rows, total: Number(total), page, limit });
});

export const getOrganization = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM organizations WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Organization not found' });
  res.json(rows[0]);
});

export const createOrganization = asyncHandler(async (req, res) => {
  const data = OrgSchema.parse(req.body);
  const { rows } = await query(
    `INSERT INTO organizations (name, code, description, address, phone, email, is_active, tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [data.name, data.code, data.description, data.address, data.phone, data.email, data.is_active, data.tenant_id]
  );
  res.status(201).json(rows[0]);
});

export const updateOrganization = asyncHandler(async (req, res) => {
  const data = OrgSchema.partial().parse(req.body);
  const { rows } = await query(
    `UPDATE organizations SET
       name        = COALESCE($2, name),
       code        = COALESCE($3, code),
       description = COALESCE($4, description),
       address     = COALESCE($5, address),
       phone       = COALESCE($6, phone),
       email       = COALESCE($7, email),
       is_active   = COALESCE($8, is_active),
       updated_at  = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [req.params.id, data.name, data.code, data.description, data.address, data.phone, data.email, data.is_active]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Organization not found' });
  res.json(rows[0]);
});

export const deleteOrganization = asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    `UPDATE organizations SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
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

export const listLocations = asyncHandler(async (req, res) => {
  const orgId = req.query.organization_id;
  const { rows } = await query(
    `SELECT * FROM locations
     WHERE deleted_at IS NULL ${orgId ? 'AND organization_id = $1' : ''}
     ORDER BY name ASC`,
    orgId ? [orgId] : []
  );
  res.json({ locations: rows });
});

export const createLocation = asyncHandler(async (req, res) => {
  const d = LocationSchema.parse(req.body);
  const { rows } = await query(
    `INSERT INTO locations (organization_id, name, address, building, floor, room, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [d.organization_id, d.name, d.address, d.building, d.floor, d.room, d.is_active]
  );
  res.status(201).json(rows[0]);
});

export const updateLocation = asyncHandler(async (req, res) => {
  const d = LocationSchema.partial().parse(req.body);
  const { rows } = await query(
    `UPDATE locations SET
       name      = COALESCE($2, name),
       address   = COALESCE($3, address),
       building  = COALESCE($4, building),
       floor     = COALESCE($5, floor),
       room      = COALESCE($6, room),
       is_active = COALESCE($7, is_active),
       updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id, d.name, d.address, d.building, d.floor, d.room, d.is_active]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Location not found' });
  res.json(rows[0]);
});

export const deleteLocation = asyncHandler(async (req, res) => {
  await query(`UPDATE locations SET deleted_at = now() WHERE id = $1`, [req.params.id]);
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
  const orgId = req.query.organization_id;
  const { rows } = await query(
    `SELECT d.*, l.name AS location_name FROM departments d
     LEFT JOIN locations l ON l.id = d.location_id
     WHERE d.deleted_at IS NULL ${orgId ? 'AND d.organization_id = $1' : ''}
     ORDER BY d.name ASC`,
    orgId ? [orgId] : []
  );
  res.json({ departments: rows });
});

export const createDepartment = asyncHandler(async (req, res) => {
  const d = DeptSchema.parse(req.body);
  const { rows } = await query(
    `INSERT INTO departments (organization_id, location_id, name, extension, type, notes, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [d.organization_id, d.location_id, d.name, d.extension, d.type, d.notes, d.is_active]
  );
  res.status(201).json(rows[0]);
});

export const updateDepartment = asyncHandler(async (req, res) => {
  const d = DeptSchema.partial().parse(req.body);
  const { rows } = await query(
    `UPDATE departments SET
       name        = COALESCE($2, name),
       location_id = COALESCE($3, location_id),
       extension   = COALESCE($4, extension),
       type        = COALESCE($5, type),
       notes       = COALESCE($6, notes),
       is_active   = COALESCE($7, is_active),
       updated_at  = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id, d.name, d.location_id, d.extension, d.type, d.notes, d.is_active]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Department not found' });
  res.json(rows[0]);
});

export const deleteDepartment = asyncHandler(async (req, res) => {
  await query(`UPDATE departments SET deleted_at = now() WHERE id = $1`, [req.params.id]);
  res.status(204).end();
});
