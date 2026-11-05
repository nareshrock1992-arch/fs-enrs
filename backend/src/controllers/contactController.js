import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { effectiveTenantId } from '../middleware/tenantScope.js';
import { toCsv } from '../utils/csv.js';
import { logger } from '../infrastructure/index.js';

// ── Audit trail ──────────────────────────────────────────────────────────────
// Same convention as the other audit writers (media, settings, reports): one audit_logs
// row per administrative change, written after the change succeeded, best effort — a
// failed audit write is logged as an error and does not undo or block the change.
// details.tenant_id is the tenant of the affected contacts (the /audit filter key);
// scope_tenant_id is the caller's scope (null = SUPER_ADMIN under "All Tenants").
// Only ids, counts and field names are recorded: never names, numbers, e-mail
// addresses, file contents or tokens.
async function auditContacts(req, action, entityId, details) {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, 'emergency_contact', $3, $4)`,
      [req.user?.id ?? null, action, entityId === null || entityId === undefined ? null : String(entityId),
       JSON.stringify({ role: req.user?.role ?? null, scope_tenant_id: effectiveTenantId(req), ...details })]
    );
  } catch (err) {
    logger.error({ module: 'contacts', action, err: err.message }, 'Contact audit failed');
  }
}

const emptyToNull = (max) => z.preprocess(v => (v === '' ? null : v), z.string().max(max).nullable().optional());
const emptyToNullEmail = z.preprocess(v => (v === '' ? null : v), z.string().email().max(255).nullable().optional());

// ContactBaseSchema is a plain ZodObject — no .refine() attached.
// This is intentional: ZodObject.refine() returns ZodEffects, which does NOT have
// a .partial() method. Calling .partial() on ZodEffects throws "X.partial is not a
// function" at runtime. The cross-field check (mobile OR extension required) is
// added only on ContactSchema (create path) where .partial() is never called.
// See ivrValidator.js for the same pattern with a more detailed comment.
// Maximum lengths match the column sizes, so an over-long value is a 400, not a 500.
const ContactBaseSchema = z.object({
  organization_id:  z.number().int().positive(),
  location_id:      z.number().int().positive().optional().nullable(),
  department_id:    z.number().int().positive().optional().nullable(),
  first_name:       z.string().min(1).max(64),
  last_name:        z.string().min(1).max(64),
  role:             emptyToNull(64),
  mobile_number:    z.preprocess(v => (v === '' ? null : v), z.string().min(1).max(32).nullable().optional()),
  extension_number: emptyToNull(32),
  email:            emptyToNullEmail,
  is_active:        z.boolean().default(true),
});

const MOBILE_OR_EXTENSION = 'At least one of mobile_number or extension_number is required';

// ContactSchema (create / bulk-upload): full validation including cross-field refine.
const ContactSchema = ContactBaseSchema.refine(
  d => d.mobile_number || d.extension_number,
  { message: MOBILE_OR_EXTENSION }
);

// ContactUpdateSchema (PUT update): partial — only the fields present in the body are
// changed; a field sent as null (or '') is cleared. The mobile-or-extension rule is
// checked on the resulting row.
const ContactUpdateSchema = ContactBaseSchema.partial();

const UPDATABLE = ['organization_id', 'location_id', 'department_id', 'first_name', 'last_name',
  'role', 'mobile_number', 'extension_number', 'email', 'is_active'];

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const notFound   = (message) => Object.assign(new Error(message), { status: 404 });

// Organization (in the caller's tenant; SUPER_ADMIN under "All Tenants": any live one),
// and the department / location, which must belong to that organization.
async function verifyContactRefs(q, tenantId, orgId, departmentId, locationId) {
  const { rows: [org] } = await q(
    `SELECT id, tenant_id FROM organizations
     WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR tenant_id = $2)`,
    [orgId, tenantId]
  );
  if (!org) throw notFound('Organization not found');
  await verifyOrgChildren(q, orgId, departmentId, locationId);
  return org;
}

async function verifyOrgChildren(q, orgId, departmentId, locationId) {
  if (departmentId !== null && departmentId !== undefined) {
    const { rows } = await q(
      `SELECT 1 FROM departments WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [departmentId, orgId]);
    if (!rows[0]) throw badRequest('department_id does not belong to the selected organization');
  }
  if (locationId !== null && locationId !== undefined) {
    const { rows } = await q(
      `SELECT 1 FROM locations WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [locationId, orgId]);
    if (!rows[0]) throw badRequest('location_id does not belong to the selected organization');
  }
}

// ── List / export scope ──────────────────────────────────────────────────────

const ID_RE = /^[1-9]\d{0,9}$/;
export const isContactId = (v) => ID_RE.test(String(v)) && Number(v) <= 2147483647;

function optionalId(v, name) {
  if (v === undefined || v === null || v === '') return null;
  if (!isContactId(v)) throw badRequest(`${name} must be a positive integer`);
  return Number(v);
}

function optionalBool(v, name) {
  if (v === undefined || v === null || v === '') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw badRequest(`${name} must be true or false`);
}

function optionalText(v, name, max) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw badRequest(`${name} must be a single value`);
  const s = v.trim();
  if (s.length > max) throw badRequest(`${name} is too long`);
  return s || null;
}

// LIKE pattern for a literal substring: \ % _ are escaped (ESCAPE '\').
const likeContains = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

// Sort keys → ORDER BY expressions. Only these keys are accepted; values never reach SQL.
const SORTS = {
  name:         ['c.last_name', 'c.first_name'],
  mobile:       ['c.mobile_number'],
  extension:    ['c.extension_number'],
  email:        ['lower(c.email)'],
  role:         ['lower(c.role)'],
  organization: ['lower(o.name)'],
  department:   ['lower(d.name)'],
  location:     ['lower(l.name)'],
  status:       ['c.is_active'],
  tenant:       ['lower(t.name)'],
  created_at:   ['c.created_at'],
  updated_at:   ['c.updated_at'],
};
const DEFAULT_ORDER = 'c.last_name, c.first_name, c.id';

function orderBy(q) {
  const sort = optionalText(q.sort, 'sort', 32);
  const dirRaw = optionalText(q.dir, 'dir', 4);
  if (dirRaw && !['asc', 'desc'].includes(dirRaw.toLowerCase())) throw badRequest('dir must be asc or desc');
  if (!sort) return DEFAULT_ORDER;
  if (!Object.prototype.hasOwnProperty.call(SORTS, sort)) throw badRequest(`sort must be one of: ${Object.keys(SORTS).join(', ')}`);
  const dir = dirRaw?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return `${SORTS[sort].map(e => `${e} ${dir} NULLS LAST`).join(', ')}, ${DEFAULT_ORDER}`;
}

const FROM_SCOPED = `
     FROM emergency_contacts c
     JOIN organizations o ON o.id = c.organization_id
     LEFT JOIN tenants     t ON t.id = o.tenant_id
     LEFT JOIN locations   l ON l.id = c.location_id
     LEFT JOIN departments d ON d.id = c.department_id`;

// WHERE clause + params shared by list, count and export. The tenant predicate is
// always present; every other filter only narrows it.
function contactScope(req) {
  const tenantId = effectiveTenantId(req);
  if (req.user.role !== 'SUPER_ADMIN' && !tenantId) {
    throw Object.assign(new Error('Tenant context required'), { status: 403 });
  }
  const q = req.query;
  const params = [tenantId];
  const where = ['c.deleted_at IS NULL', '($1::int IS NULL OR o.tenant_id = $1)'];
  const add = (sqlFn, value) => { params.push(value); where.push(sqlFn(`$${params.length}`)); };

  const orgId  = optionalId(q.organization_id, 'organization_id');
  const deptId = optionalId(q.department_id, 'department_id');
  const locId  = optionalId(q.location_id, 'location_id');
  const active = optionalBool(q.is_active, 'is_active');
  const role   = optionalText(q.role, 'role', 64);
  const search = optionalText(q.search, 'search', 200);

  if (orgId  !== null) add(p => `c.organization_id = ${p}`, orgId);
  if (deptId !== null) add(p => `c.department_id = ${p}`, deptId);
  if (locId  !== null) add(p => `c.location_id = ${p}`, locId);
  if (active !== null) add(p => `c.is_active = ${p}`, active);
  if (role   !== null) add(p => `lower(c.role) = lower(${p})`, role);
  if (search !== null) {
    add(p => `(c.first_name ILIKE ${p} ESCAPE '\\' OR c.last_name ILIKE ${p} ESCAPE '\\'
            OR (c.first_name || ' ' || c.last_name) ILIKE ${p} ESCAPE '\\'
            OR c.mobile_number ILIKE ${p} ESCAPE '\\' OR c.extension_number ILIKE ${p} ESCAPE '\\'
            OR c.email ILIKE ${p} ESCAPE '\\' OR c.role ILIKE ${p} ESCAPE '\\')`, likeContains(search));
  }
  return { tenantId, where: where.join('\n       AND '), params };
}

// GET /api/v1/contacts?organization_id=&department_id=&location_id=&is_active=&role=&search=
//                      &sort=&dir=&page=&limit=
// Without the new parameters the result is the same as before (order, 50/200 limits, shape).
export const listContacts = asyncHandler(async (req, res) => {
  const { where, params } = contactScope(req);
  const order  = orderBy(req.query);
  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(200, Number(req.query.limit) || 50);
  const offset = (page - 1) * limit;

  const { rows } = await query(
    `SELECT c.*,
       o.name AS organization_name,
       o.tenant_id,
       t.name AS tenant_name,
       l.name AS location_name,
       d.name AS department_name
     ${FROM_SCOPED}
     WHERE ${where}
     ORDER BY ${order}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const { rows: cnt } = await query(
    `SELECT COUNT(*)::INT AS total ${FROM_SCOPED} WHERE ${where}`,
    params
  );

  res.json({ contacts: rows, total: cnt[0].total, page, limit });
});

// GET /api/v1/contacts/roles — distinct roles in scope (for the Role filter)
export const listRoles = asyncHandler(async (req, res) => {
  // Only the tenant scope applies here; list filters are deliberately ignored.
  const { where, params } = contactScope({ user: req.user, body: req.body, query: { tenant_id: req.query.tenant_id } });
  const { rows } = await query(
    `SELECT DISTINCT ON (lower(c.role)) c.role ${FROM_SCOPED}
     WHERE ${where} AND c.role IS NOT NULL AND btrim(c.role) <> ''
     ORDER BY lower(c.role), c.role
     LIMIT 500`,
    params
  );
  res.json({ roles: rows.map(r => r.role) });
});

// GET /api/v1/contacts/export — CSV of every contact matching the list filters
// (all pages; page / limit are ignored). Same authorization and tenant scope as the list.
export const EXPORT_MAX_ROWS = 50000;
const EXPORT_COLUMNS = ['first_name', 'last_name', 'mobile_number', 'extension_number', 'email', 'role',
  'organization', 'department', 'location', 'is_active', 'created_at', 'updated_at'];

export const exportContacts = asyncHandler(async (req, res) => {
  const { tenantId, where, params } = contactScope(req);
  const order = orderBy(req.query);
  const { rows: [{ total }] } = await query(`SELECT COUNT(*)::INT AS total ${FROM_SCOPED} WHERE ${where}`, params);
  if (total > EXPORT_MAX_ROWS) {
    return res.status(422).json({
      error: `${total} contacts match; the export is limited to ${EXPORT_MAX_ROWS}. Narrow the filters and export in parts.`,
    });
  }
  const { rows } = await query(
    `SELECT c.first_name, c.last_name, c.mobile_number, c.extension_number, c.email, c.role,
       o.name AS organization, d.name AS department, l.name AS location, c.is_active,
       c.created_at, c.updated_at, t.name AS tenant
     ${FROM_SCOPED}
     WHERE ${where}
     ORDER BY ${order}`,
    params
  );
  const withTenant = req.user.role === 'SUPER_ADMIN' && tenantId === null;
  const header = withTenant ? [...EXPORT_COLUMNS, 'tenant'] : EXPORT_COLUMNS;
  const csv = toCsv(header, rows.map(r => header.map(k => r[k])));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="contacts-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send('﻿' + csv);
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
  const org = await verifyContactRefs(query, effectiveTenantId(req), d.organization_id, d.department_id, d.location_id);
  const { rows } = await query(
    `INSERT INTO emergency_contacts
       (organization_id, location_id, department_id, first_name, last_name,
        role, mobile_number, extension_number, email, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [d.organization_id, d.location_id, d.department_id, d.first_name, d.last_name,
     d.role, d.mobile_number, d.extension_number, d.email, d.is_active]
  );
  await auditContacts(req, 'contact_created', rows[0].id,
    { tenant_id: org.tenant_id, organization_id: d.organization_id });
  res.status(201).json(rows[0]);
});

// PUT /api/v1/contacts/:id — fields present in the body are applied (null clears an
// optional field). The organization may change within the contact's own tenant; the
// department and location must belong to the resulting organization.
export const updateContact = asyncHandler(async (req, res) => {
  const d = ContactUpdateSchema.parse(req.body);
  const tenantId = effectiveTenantId(req);
  const has = (k) => Object.prototype.hasOwnProperty.call(d, k) && d[k] !== undefined;

  const updated = await withTransaction(async (tq) => {
    const { rows: [cur] } = await tq(
      `SELECT c.*, o.tenant_id AS org_tenant_id
       FROM emergency_contacts c JOIN organizations o ON o.id = c.organization_id
       WHERE c.id = $1 AND c.deleted_at IS NULL
         AND ($2::int IS NULL OR o.tenant_id = $2)
       FOR UPDATE OF c`,
      [req.params.id, tenantId]
    );
    if (!cur) return null;

    const next = {};
    for (const k of UPDATABLE) next[k] = has(k) ? d[k] : cur[k];

    const orgChanged = next.organization_id !== cur.organization_id;
    if (orgChanged) {
      const { rows: [org] } = await tq(
        `SELECT id FROM organizations
         WHERE id = $1 AND deleted_at IS NULL AND tenant_id IS NOT DISTINCT FROM $2`,
        [next.organization_id, cur.org_tenant_id]);
      if (!org) throw badRequest("organization_id must be an organization of the contact's tenant");
    }
    if (orgChanged || has('department_id') || has('location_id')) {
      await verifyOrgChildren(tq,
        next.organization_id,
        orgChanged || has('department_id') ? next.department_id : null,
        orgChanged || has('location_id') ? next.location_id : null);
    }
    if (!next.mobile_number && !next.extension_number) throw badRequest(MOBILE_OR_EXTENSION);

    const { rows: [row] } = await tq(
      `UPDATE emergency_contacts SET
         organization_id = $2, location_id = $3, department_id = $4,
         first_name = $5, last_name = $6, role = $7, mobile_number = $8,
         extension_number = $9, email = $10, is_active = $11, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [cur.id, ...UPDATABLE.map(k => next[k])]
    );
    // Field names only (no values) for the audit trail.
    const changed = UPDATABLE.filter(k => (next[k] ?? null) !== (cur[k] ?? null));
    return { row, audit: {
      tenant_id: cur.org_tenant_id, organization_id: next.organization_id,
      ...(orgChanged ? { previous_organization_id: cur.organization_id } : {}),
      changed_fields: changed,
    } };
  });

  if (!updated) return res.status(404).json({ error: 'Contact not found' });
  await auditContacts(req, 'contact_updated', updated.row.id, updated.audit);
  res.json(updated.row);
});

export const deleteContact = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rows: [deleted] } = await query(
    `UPDATE emergency_contacts c SET deleted_at = now()
     FROM organizations o
     WHERE c.id = $1 AND c.deleted_at IS NULL
       AND o.id = c.organization_id
       AND ($2::int IS NULL OR o.tenant_id = $2)
     RETURNING c.id, c.organization_id, o.tenant_id`,
    [req.params.id, tenantId]
  );
  if (!deleted) return res.status(404).json({ error: 'Contact not found' });
  await auditContacts(req, 'contact_deleted', deleted.id,
    { tenant_id: deleted.tenant_id, organization_id: deleted.organization_id });
  res.status(204).end();
});

// POST /api/v1/contacts/bulk-delete { ids: [..] } — soft-deletes, in one statement,
// the listed contacts that belong to the caller's tenant scope (the same rule as the
// single delete). Ids that are unknown, already deleted or outside the scope are
// returned in not_found and are never touched.
export const BULK_DELETE_MAX = 500;
const BulkDeleteSchema = z.object({
  ids: z.array(z.number().int().positive().max(2147483647)).min(1).max(BULK_DELETE_MAX),
});

export const bulkDeleteContacts = asyncHandler(async (req, res) => {
  const { ids } = BulkDeleteSchema.parse(req.body);
  const tenantId = effectiveTenantId(req);
  const unique = [...new Set(ids)];
  const { rows } = await query(
    `UPDATE emergency_contacts c SET deleted_at = now()
     FROM organizations o
     WHERE c.id = ANY($1::int[]) AND c.deleted_at IS NULL
       AND o.id = c.organization_id
       AND ($2::int IS NULL OR o.tenant_id = $2)
     RETURNING c.id, o.tenant_id`,
    [unique, tenantId]
  );
  const deleted = new Set(rows.map(r => r.id));
  const notFound = unique.filter(id => !deleted.has(id));

  // Audit summary: one record per affected tenant (so the audit tenant filter finds it),
  // or one record for the caller's scope when nothing was deleted. Ids and counts only.
  const byTenant = new Map();
  for (const r of rows) {
    if (!byTenant.has(r.tenant_id)) byTenant.set(r.tenant_id, []);
    byTenant.get(r.tenant_id).push(r.id);
  }
  if (byTenant.size === 0) byTenant.set(tenantId, []);
  for (const [tid, deletedIds] of byTenant) {
    await auditContacts(req, 'contacts_bulk_deleted', null, {
      tenant_id: tid, requested: unique.length, deleted: deletedIds.length,
      deleted_ids: deletedIds.sort((a, b) => a - b), not_found_count: notFound.length,
    });
  }

  res.json({
    deleted: deleted.size,
    deleted_ids: unique.filter(id => deleted.has(id)),
    not_found: notFound,
  });
});

// ── CSV import ───────────────────────────────────────────────────────────────
// Accepted columns: first_name, last_name, mobile_number, extension_number, email, role,
// optional is_active (true/false/yes/no/1/0). Header names are case-insensitive;
// "phone"/"mobile" and "extension" are accepted as aliases. Other columns are ignored.
//
// Duplicate detection: a row is skipped as a duplicate when a live contact of the same
// organization (or an earlier row of the same file) has the same first and last name
// (case-insensitive, trimmed) and the same mobile and extension numbers, compared with
// spaces, dots, dashes and brackets removed. Imports into the same organization are
// serialised with a transaction-scoped advisory lock, so two concurrent imports cannot
// both insert the same person. Contacts created one by one at the same moment are not
// covered (there is no database uniqueness constraint).

const HEADER_ALIASES = { phone: 'mobile_number', mobile: 'mobile_number', extension: 'extension_number' };

function importHeaders(header) {
  const names = header.map(h => String(h).trim().toLowerCase());
  return names.map(n => (HEADER_ALIASES[n] && !names.includes(HEADER_ALIASES[n]) ? HEADER_ALIASES[n] : n));
}

const ACTIVE_WORDS = { true: true, yes: true, 1: true, active: true, false: false, no: false, 0: false, inactive: false };

function importRow(row) {
  const out = { ...row };
  if (row.is_active === undefined || row.is_active === '') delete out.is_active;
  else {
    const v = ACTIVE_WORDS[String(row.is_active).trim().toLowerCase()];
    out.is_active = v === undefined ? row.is_active : v;
  }
  return out;
}

const normName  = (v) => String(v ?? '').trim().toLowerCase();
const normPhone = (v) => String(v ?? '').replace(/[\s().-]/g, '');
const dupKey = (r) => [normName(r.first_name), normName(r.last_name),
  normPhone(r.mobile_number), normPhone(r.extension_number)].join('\u0000');

function rowError(err) {
  if (err?.name === 'ZodError') {
    return err.errors.map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).join('; ');
  }
  return err?.message || 'Could not be saved';
}

// POST /api/v1/contacts/bulk-upload
export const bulkUpload = asyncHandler(async (req, res) => {
  if (req.body.organization_id === undefined || req.body.organization_id === '') {
    return res.status(400).json({ error: 'organization_id required' });
  }
  const orgId = optionalId(req.body.organization_id, 'organization_id');
  if (!req.file) return res.status(400).json({ error: 'CSV file required' });

  const org = await verifyContactRefs(query, effectiveTenantId(req), orgId);

  let records;
  try {
    records = parse(req.file.buffer, {
      columns: importHeaders, bom: true, skip_empty_lines: true, trim: true,
    });
  } catch (err) {
    return res.status(400).json({ error: `The CSV file could not be read: ${err.message}` });
  }

  const result = await withTransaction(async (tq) => {
    await tq(`SELECT pg_advisory_xact_lock(hashtext('enrs:contacts-import'), $1)`, [orgId]);
    const { rows: existing } = await tq(
      `SELECT first_name, last_name, mobile_number, extension_number
       FROM emergency_contacts WHERE organization_id = $1 AND deleted_at IS NULL`,
      [orgId]);
    const seen = new Map(existing.map(r => [dupKey(r), 0]));

    let inserted = 0;
    const errors = [];
    const duplicates = [];
    for (const [i, row] of records.entries()) {
      const line = i + 2;
      let d;
      try {
        d = ContactSchema.parse({ ...importRow(row), organization_id: orgId });
      } catch (err) {
        errors.push({ line, error: rowError(err) });
        continue;
      }
      const key = dupKey(d);
      if (seen.has(key)) {
        const first = seen.get(key);
        duplicates.push({ line, reason: first ? `Same contact as line ${first}` : 'Contact already exists' });
        continue;
      }
      await tq('SAVEPOINT contact_row');
      try {
        await tq(
          `INSERT INTO emergency_contacts
             (organization_id, first_name, last_name, role, mobile_number,
              extension_number, email, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [orgId, d.first_name, d.last_name, d.role, d.mobile_number,
           d.extension_number, d.email, d.is_active]
        );
        await tq('RELEASE SAVEPOINT contact_row');
        seen.set(key, line);
        inserted++;
      } catch (err) {
        await tq('ROLLBACK TO SAVEPOINT contact_row');
        errors.push({ line, error: rowError(err) });
      }
    }
    return { inserted, skipped: duplicates.length, duplicates, errors };
  });

  // Summary only: counts, never the file name, rows or contact details.
  await auditContacts(req, 'contacts_imported', null, {
    tenant_id: org.tenant_id, organization_id: orgId, total_rows: records.length,
    inserted: result.inserted, skipped_duplicates: result.skipped, error_rows: result.errors.length,
  });
  res.json({ ...result, total: records.length });
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
