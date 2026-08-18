import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { effectiveTenantId } from '../middleware/tenantScope.js';

const emptyToNull = z.preprocess(v => (v === '' ? null : v), z.string().nullable().optional());
const emptyToNullEmail = z.preprocess(v => (v === '' ? null : v), z.string().email().nullable().optional());

// ContactBaseSchema is a plain ZodObject — no .refine() attached.
// This is intentional: ZodObject.refine() returns ZodEffects, which does NOT have
// a .partial() method. Calling .partial() on ZodEffects throws "X.partial is not a
// function" at runtime. The cross-field check (mobile OR extension required) is
// added only on ContactSchema (create path) where .partial() is never called.
// See ivrValidator.js for the same pattern with a more detailed comment.
const ContactBaseSchema = z.object({
  organization_id:  z.number().int().positive(),
  location_id:      z.number().int().positive().optional().nullable(),
  department_id:    z.number().int().positive().optional().nullable(),
  first_name:       z.string().min(1).max(64),
  last_name:        z.string().min(1).max(64),
  role:             emptyToNull,
  mobile_number:    z.preprocess(v => (v === '' ? null : v), z.string().min(1).max(32).nullable().optional()),
  extension_number: emptyToNull,
  email:            emptyToNullEmail,
  is_active:        z.boolean().default(true),
});

// ContactSchema (create / bulk-upload): full validation including cross-field refine.
const ContactSchema = ContactBaseSchema.refine(
  d => d.mobile_number || d.extension_number,
  { message: 'At least one of mobile_number or extension_number is required' }
);

// ContactUpdateSchema (PATCH/PUT update): partial — only sent fields are validated.
// The cross-field refine is intentionally omitted here: the update query uses COALESCE,
// so fields not present in the request body keep their existing database values.
// The mobile-or-extension invariant is preserved by the CREATE-time check above.
const ContactUpdateSchema = ContactBaseSchema.partial();

// Verify that an organization belongs to the caller's effective tenant.
async function verifyOrgTenant(orgId, tenantId) {
  if (tenantId === null) return; // SUPER_ADMIN — no restriction
  const { rows: [org] } = await query(
    `SELECT id FROM organizations WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [orgId, tenantId]
  );
  if (!org) throw Object.assign(new Error('Organization not found'), { status: 404 });
}

// GET /api/v1/contacts?organization_id=&search=&page=&limit=
export const listContacts = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  if (req.user.role !== 'SUPER_ADMIN' && !tenantId) {
    return res.status(403).json({ error: 'Tenant context required' });
  }

  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(200, Number(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const orgId  = req.query.organization_id || null;
  const search = req.query.search ? `%${req.query.search}%` : null;

  const { rows } = await query(
    `SELECT c.*,
       o.name AS organization_name,
       l.name AS location_name,
       d.name AS department_name
     FROM emergency_contacts c
     JOIN organizations o ON o.id = c.organization_id
     LEFT JOIN locations  l ON l.id = c.location_id
     LEFT JOIN departments d ON d.id = c.department_id
     WHERE c.deleted_at IS NULL
       AND ($1::int  IS NULL OR o.tenant_id = $1)
       AND ($2::int  IS NULL OR c.organization_id = $2)
       AND ($3::text IS NULL OR c.first_name ILIKE $3 OR c.last_name ILIKE $3
            OR c.mobile_number ILIKE $3 OR c.email ILIKE $3)
     ORDER BY c.last_name, c.first_name
     LIMIT $4 OFFSET $5`,
    [tenantId, orgId, search, limit, offset]
  );

  const { rows: cnt } = await query(
    `SELECT COUNT(*)::INT AS total
     FROM emergency_contacts c
     JOIN organizations o ON o.id = c.organization_id
     WHERE c.deleted_at IS NULL
       AND ($1::int  IS NULL OR o.tenant_id = $1)
       AND ($2::int  IS NULL OR c.organization_id = $2)
       AND ($3::text IS NULL OR c.first_name ILIKE $3 OR c.last_name ILIKE $3
            OR c.mobile_number ILIKE $3 OR c.email ILIKE $3)`,
    [tenantId, orgId, search]
  );

  res.json({ contacts: rows, total: cnt[0].total, page, limit });
});

export const getContact = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rows } = await query(
    `SELECT c.*, o.name AS organization_name, l.name AS location_name, d.name AS department_name
     FROM emergency_contacts c
     JOIN organizations o ON o.id = c.organization_id
     LEFT JOIN locations  l ON l.id = c.location_id
     LEFT JOIN departments d ON d.id = c.department_id
     WHERE c.id = $1 AND c.deleted_at IS NULL
       AND ($2::int IS NULL OR o.tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Contact not found' });
  res.json(rows[0]);
});

export const createContact = asyncHandler(async (req, res) => {
  const d = ContactSchema.parse(req.body);
  await verifyOrgTenant(d.organization_id, effectiveTenantId(req));
  const { rows } = await query(
    `INSERT INTO emergency_contacts
       (organization_id, location_id, department_id, first_name, last_name,
        role, mobile_number, extension_number, email, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [d.organization_id, d.location_id, d.department_id, d.first_name, d.last_name,
     d.role, d.mobile_number, d.extension_number, d.email, d.is_active]
  );
  res.status(201).json(rows[0]);
});

export const updateContact = asyncHandler(async (req, res) => {
  const d = ContactUpdateSchema.parse(req.body);
  const tenantId = effectiveTenantId(req);
  const { rows } = await query(
    `UPDATE emergency_contacts c SET
       first_name       = COALESCE($3,  c.first_name),
       last_name        = COALESCE($4,  c.last_name),
       role             = COALESCE($5,  c.role),
       mobile_number    = COALESCE($6,  c.mobile_number),
       extension_number = COALESCE($7,  c.extension_number),
       email            = COALESCE($8,  c.email),
       location_id      = COALESCE($9,  c.location_id),
       department_id    = COALESCE($10, c.department_id),
       is_active        = COALESCE($11, c.is_active),
       updated_at       = now()
     FROM organizations o
     WHERE c.id = $1 AND c.deleted_at IS NULL
       AND o.id = c.organization_id
       AND ($2::int IS NULL OR o.tenant_id = $2)
     RETURNING c.*`,
    [req.params.id, tenantId, d.first_name, d.last_name, d.role, d.mobile_number,
     d.extension_number, d.email, d.location_id, d.department_id, d.is_active]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Contact not found' });
  res.json(rows[0]);
});

export const deleteContact = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rowCount } = await query(
    `UPDATE emergency_contacts c SET deleted_at = now()
     FROM organizations o
     WHERE c.id = $1 AND c.deleted_at IS NULL
       AND o.id = c.organization_id
       AND ($2::int IS NULL OR o.tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Contact not found' });
  res.status(204).end();
});

// POST /api/v1/contacts/bulk-upload
export const bulkUpload = asyncHandler(async (req, res) => {
  const orgId = Number(req.body.organization_id);
  if (!orgId || isNaN(orgId)) return res.status(400).json({ error: 'organization_id required' });
  if (!req.file) return res.status(400).json({ error: 'CSV file required' });

  await verifyOrgTenant(orgId, effectiveTenantId(req));

  const records = parse(req.file.buffer, {
    columns: true, skip_empty_lines: true, trim: true,
  });

  let inserted = 0;
  const errors = [];

  for (const [i, row] of records.entries()) {
    const lineNum = i + 2;
    try {
      const d = ContactSchema.parse({ ...row, organization_id: orgId });
      await query(
        `INSERT INTO emergency_contacts
           (organization_id, first_name, last_name, role, mobile_number,
            extension_number, email, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [orgId, d.first_name, d.last_name, d.role, d.mobile_number,
         d.extension_number, d.email, d.is_active]
      );
      inserted++;
    } catch (err) {
      errors.push({ line: lineNum, error: err.message });
    }
  }

  res.json({ inserted, errors, total: records.length });
});

// GET /api/v1/contacts/by-pin?pin=XXX — DEPRECATED
export const getByPin = asyncHandler(async (req, res) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Mon, 31 Aug 2026 00:00:00 GMT');

  const pin = req.query.pin;
  if (!pin) return res.status(400).json({ error: 'pin required' });

  const tenantId = effectiveTenantId(req);

  const { rows: configs } = await query(
    `SELECT id FROM ens_configurations
     WHERE pin = $1 AND is_active = true AND deleted_at IS NULL
       AND ($2::int IS NULL OR tenant_id = $2)
     LIMIT 1`,
    [pin, tenantId]
  );
  if (!configs[0]) return res.status(404).json({ error: 'No ENS configuration found for PIN' });

  const configId = configs[0].id;

  const { rows } = await query(
    `SELECT DISTINCT c.id, c.first_name, c.last_name, c.mobile_number,
       c.extension_number, c.email, c.role
     FROM emergency_contacts c
     WHERE c.deleted_at IS NULL AND c.is_active = true
       AND (
         c.id IN (
           SELECT rgm.emergency_contact_id FROM responder_group_members rgm
           JOIN ens_configuration_groups ecg ON ecg.responder_group_id = rgm.responder_group_id
           WHERE ecg.ens_configuration_id = $1
         )
         OR c.id IN (
           SELECT ecc.emergency_contact_id FROM ens_configuration_contacts ecc
           WHERE ecc.ens_configuration_id = $1
         )
       )
     ORDER BY c.last_name, c.first_name`,
    [configId]
  );

  res.json({ pin, config_id: configId, contacts: rows });
});
