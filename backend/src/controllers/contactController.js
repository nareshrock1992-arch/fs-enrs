import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const emptyToNull = z.preprocess(v => (v === '' ? null : v), z.string().nullable().optional());
const emptyToNullEmail = z.preprocess(v => (v === '' ? null : v), z.string().email().nullable().optional());

const ContactSchema = z.object({
  organization_id:  z.number().int().positive(),
  location_id:      z.number().int().positive().optional().nullable(),
  department_id:    z.number().int().positive().optional().nullable(),
  first_name:       z.string().min(1).max(64),
  last_name:        z.string().min(1).max(64),
  role:             emptyToNull,
  mobile_number:    z.string().min(1).max(32),
  extension_number: emptyToNull,
  email:            emptyToNullEmail,
  is_active:        z.boolean().default(true),
});

// GET /api/v1/contacts?organization_id=&search=&page=&limit=
export const listContacts = asyncHandler(async (req, res) => {
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
     LEFT JOIN organizations o ON o.id = c.organization_id
     LEFT JOIN locations     l ON l.id = c.location_id
     LEFT JOIN departments   d ON d.id = c.department_id
     WHERE c.deleted_at IS NULL
       AND ($1::int IS NULL OR c.organization_id = $1)
       AND ($2::text IS NULL OR c.first_name ILIKE $2 OR c.last_name ILIKE $2
            OR c.mobile_number ILIKE $2 OR c.email ILIKE $2)
     ORDER BY c.last_name, c.first_name
     LIMIT $3 OFFSET $4`,
    [orgId, search, limit, offset]
  );

  const { rows: cnt } = await query(
    `SELECT COUNT(*)::INT AS total FROM emergency_contacts
     WHERE deleted_at IS NULL
       AND ($1::int IS NULL OR organization_id = $1)
       AND ($2::text IS NULL OR first_name ILIKE $2 OR last_name ILIKE $2
            OR mobile_number ILIKE $2 OR email ILIKE $2)`,
    [orgId, search]
  );

  res.json({ contacts: rows, total: cnt[0].total, page, limit });
});

export const getContact = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT c.*, o.name AS organization_name, l.name AS location_name, d.name AS department_name
     FROM emergency_contacts c
     LEFT JOIN organizations o ON o.id = c.organization_id
     LEFT JOIN locations     l ON l.id = c.location_id
     LEFT JOIN departments   d ON d.id = c.department_id
     WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Contact not found' });
  res.json(rows[0]);
});

export const createContact = asyncHandler(async (req, res) => {
  const d = ContactSchema.parse(req.body);
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
  const d = ContactSchema.partial().parse(req.body);
  const { rows } = await query(
    `UPDATE emergency_contacts SET
       first_name       = COALESCE($2,  first_name),
       last_name        = COALESCE($3,  last_name),
       role             = COALESCE($4,  role),
       mobile_number    = COALESCE($5,  mobile_number),
       extension_number = COALESCE($6,  extension_number),
       email            = COALESCE($7,  email),
       location_id      = COALESCE($8,  location_id),
       department_id    = COALESCE($9,  department_id),
       is_active        = COALESCE($10, is_active),
       updated_at       = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id, d.first_name, d.last_name, d.role, d.mobile_number,
     d.extension_number, d.email, d.location_id, d.department_id, d.is_active]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Contact not found' });
  res.json(rows[0]);
});

export const deleteContact = asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    `UPDATE emergency_contacts SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Contact not found' });
  res.status(204).end();
});

// POST /api/v1/contacts/bulk-upload  (multipart/form-data, field: file)
// CSV columns: first_name, last_name, role, mobile_number, extension_number, email, is_active
export const bulkUpload = asyncHandler(async (req, res) => {
  const orgId = Number(req.body.organization_id);
  if (!orgId || isNaN(orgId)) return res.status(400).json({ error: 'organization_id required' });
  if (!req.file) return res.status(400).json({ error: 'CSV file required' });

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

// GET /api/v1/contacts/by-pin?pin=XXX  — DEPRECATED (use /internal/ens/lookup?number=)
// B15 FIX — this endpoint breaks when ens_contacts and ers_responders are
// separated into their own tables. Kept for backward compat, marked Sunset.
export const getByPin = asyncHandler(async (req, res) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Mon, 31 Aug 2026 00:00:00 GMT');

  const pin = req.query.pin;
  if (!pin) return res.status(400).json({ error: 'pin required' });

  const { rows: configs } = await query(
    `SELECT id FROM ens_configurations
     WHERE pin = $1 AND is_active = true AND deleted_at IS NULL LIMIT 1`,
    [pin]
  );
  if (!configs[0]) return res.status(404).json({ error: 'No ENS configuration found for PIN' });

  const configId = configs[0].id;

  // Get contacts from groups + directly mapped contacts
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
