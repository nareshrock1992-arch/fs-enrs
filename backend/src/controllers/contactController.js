import { z } from 'zod';
import { readTabularFile } from '../utils/tabularFile.js';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { effectiveTenantId, validateTargetTenant } from '../middleware/tenantScope.js';
import { toCsv } from '../utils/csv.js';
import { buildWorkbook, columnLetter } from '../utils/xlsxWriter.js';
import { logger } from '../infrastructure/index.js';
import {
  normalizeExtension, normalizeMobile, findIdentityMatches, classifyIdentity,
  isIdentityViolation, IDENTITY_LOCK, OTHER_ORG_MESSAGE, CONFLICT_MESSAGE,
} from '../services/contactIdentity.js';

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

// ── Contact identity (services/contactIdentity.js) ──────────────────────────
// One extension / one mobile number = one live contact on the whole platform.

const httpErr = (status, body) => Object.assign(new Error(body.error), { status, httpBody: body });
const contactName = (c) => `${c.first_name || ''} ${c.last_name || ''}`.trim();

// 409 body for a refused identifier. Another organization's contact is never described.
function identityRejection(cls) {
  if (cls.kind === 'other_organization') {
    return httpErr(409, { error: OTHER_ORG_MESSAGE[cls.field], code: 'IDENTIFIER_IN_OTHER_ORGANIZATION', field: cls.field });
  }
  const body = { error: CONFLICT_MESSAGE, code: 'IDENTIFIER_CONFLICT' };
  if (cls.sameOrganization) {
    body.contacts = [
      { matched: 'extension', id: cls.contacts[0].id, name: contactName(cls.contacts[0]) },
      { matched: 'mobile', id: cls.contacts[1].id, name: contactName(cls.contacts[1]) },
    ];
  }
  return httpErr(409, body);
}

// Another organization's contact is never referenced, not even by id.
const identityAudit = (cls) => (cls.kind === 'other_organization'
  ? { kind: 'other_organization', field: cls.field }
  : { kind: 'conflict', ...(cls.sameOrganization ? { conflicting_contact_ids: cls.contacts.map((c) => c.id) } : {}) });

// A unique-index violation means a concurrent writer took the identifier first.
const identityTaken = () => httpErr(409, {
  error: 'This extension or mobile number was just assigned to another contact; reload and try again',
  code: 'IDENTIFIER_TAKEN',
});

async function withIdentityTransaction(fn) {
  try {
    return await withTransaction(async (tq) => { await tq(IDENTITY_LOCK); return fn(tq); });
  } catch (err) {
    if (isIdentityViolation(err)) throw identityTaken();
    throw err;
  }
}

// POST /api/v1/contacts — creates a contact, or, when the extension or mobile number
// already belongs to a contact of the same organization, updates that contact with the
// supplied fields (200, upserted: true). Another organization's identifier or a split
// match (extension of one contact, mobile of another) is refused with 409.
export const createContact = asyncHandler(async (req, res) => {
  const d = ContactSchema.parse(req.body);
  const org = await verifyContactRefs(query, effectiveTenantId(req), d.organization_id, d.department_id, d.location_id);
  const supplied = (k) => Object.prototype.hasOwnProperty.call(req.body ?? {}, k);

  const out = await withIdentityTransaction(async (tq) => {
    const cls = classifyIdentity(
      await findIdentityMatches(tq, { extension: d.extension_number, mobile: d.mobile_number }), d.organization_id);
    if (cls.kind === 'other_organization' || cls.kind === 'conflict') return { rejected: cls };

    if (cls.kind === 'new') {
      const { rows: [row] } = await tq(
        `INSERT INTO emergency_contacts
           (organization_id, location_id, department_id, first_name, last_name,
            role, mobile_number, extension_number, email, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [d.organization_id, d.location_id, d.department_id, d.first_name, d.last_name,
         d.role, d.mobile_number, d.extension_number, d.email, d.is_active]
      );
      return { created: row };
    }

    // Same organization: update the existing contact with the supplied fields only.
    const { rows: [cur] } = await tq(`SELECT * FROM emergency_contacts WHERE id = $1 FOR UPDATE`, [cls.contact.id]);
    const next = {};
    for (const k of UPDATABLE) next[k] = supplied(k) ? (d[k] ?? null) : cur[k];
    next.organization_id = cur.organization_id;
    if (!next.mobile_number && !next.extension_number) throw badRequest(MOBILE_OR_EXTENSION);
    const { rows: [row] } = await tq(
      `UPDATE emergency_contacts SET
         organization_id = $2, location_id = $3, department_id = $4,
         first_name = $5, last_name = $6, role = $7, mobile_number = $8,
         extension_number = $9, email = $10, is_active = $11, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [cur.id, ...UPDATABLE.map((k) => next[k])]
    );
    return { updated: row, matchedBy: cls.matchedBy, changed: UPDATABLE.filter((k) => (next[k] ?? null) !== (cur[k] ?? null)) };
  });

  if (out.rejected) {
    await auditContacts(req, 'contact_identifier_conflict', null,
      { tenant_id: org.tenant_id, organization_id: d.organization_id, source: 'manual', ...identityAudit(out.rejected) });
    throw identityRejection(out.rejected);
  }
  if (out.created) {
    await auditContacts(req, 'contact_created', out.created.id,
      { tenant_id: org.tenant_id, organization_id: d.organization_id, source: 'manual' });
    return res.status(201).json(out.created);
  }
  await auditContacts(req, 'contact_duplicate_prevented', out.updated.id, {
    tenant_id: org.tenant_id, organization_id: out.updated.organization_id, source: 'manual',
    matched_by: out.matchedBy, changed_fields: out.changed,
  });
  res.json({ ...out.updated, upserted: true, matched_by: out.matchedBy });
});

// GET /api/v1/contacts/identity-check?organization_id=&extension_number=&mobile_number=&exclude_id=
// What saving these identifiers would do (feedback while typing; the save re-checks).
export const identityCheck = asyncHandler(async (req, res) => {
  const orgId = optionalId(req.query.organization_id, 'organization_id');
  if (orgId === null) throw badRequest('organization_id is required');
  const excludeId = optionalId(req.query.exclude_id, 'exclude_id');
  const extension = optionalText(req.query.extension_number, 'extension_number', 32);
  const mobile = optionalText(req.query.mobile_number, 'mobile_number', 32);
  await verifyContactRefs(query, effectiveTenantId(req), orgId);
  const matches = await findIdentityMatches(query, { extension, mobile, excludeId });
  const cls = classifyIdentity(matches, orgId);
  if (cls.kind === 'new') return res.json({ status: 'new' });
  if (cls.kind === 'other_organization') return res.json({ status: 'other_organization', field: cls.field, message: OTHER_ORG_MESSAGE[cls.field] });
  if (cls.kind === 'conflict') {
    return res.json({ status: 'conflict', message: CONFLICT_MESSAGE,
      ...(cls.sameOrganization ? { contacts: cls.contacts.map((c) => ({ id: c.id, name: contactName(c) })) } : {}) });
  }
  res.json({ status: 'update', matched_by: cls.matchedBy, contact: { id: cls.contact.id, name: contactName(cls.contact) } });
});

// PUT /api/v1/contacts/:id — fields present in the body are applied (null clears an
// optional field). The organization may change within the contact's own tenant; the
// department and location must belong to the resulting organization.
export const updateContact = asyncHandler(async (req, res) => {
  const d = ContactUpdateSchema.parse(req.body);
  const tenantId = effectiveTenantId(req);
  const has = (k) => Object.prototype.hasOwnProperty.call(d, k) && d[k] !== undefined;

  const updated = await withIdentityTransaction(async (tq) => {
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

    // An extension / mobile number held by any other live contact is refused.
    const extChanged = normalizeExtension(next.extension_number) !== normalizeExtension(cur.extension_number);
    const mobChanged = normalizeMobile(next.mobile_number) !== normalizeMobile(cur.mobile_number);
    if (extChanged || mobChanged) {
      const m = await findIdentityMatches(tq, {
        extension: extChanged ? next.extension_number : null, mobile: mobChanged ? next.mobile_number : null, excludeId: cur.id });
      const other = m.byExtension || m.byMobile;
      if (other) {
        const field = m.byExtension && m.byMobile ? 'both' : m.byExtension ? 'extension' : 'mobile';
        return { rejected: { field, contact: other, sameOrganization: other.organization_id === next.organization_id }, cur };
      }
    }

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
  if (updated.rejected) {
    const r = updated.rejected;
    await auditContacts(req, 'contact_identifier_conflict', updated.cur.id, {
      tenant_id: updated.cur.org_tenant_id, organization_id: updated.cur.organization_id, source: 'manual',
      kind: r.sameOrganization ? 'in_use' : 'other_organization', field: r.field,
      ...(r.sameOrganization ? { conflicting_contact_ids: [r.contact.id] } : {}),
    });
    const what = { extension: 'extension', mobile: 'mobile number', both: 'extension and mobile number' }[r.field];
    throw r.sameOrganization
      ? httpErr(409, { error: `This ${what} already belongs to another contact in this organization (${contactName(r.contact)})`,
        code: 'IDENTIFIER_IN_USE', field: r.field, contact: { id: r.contact.id, name: contactName(r.contact) } })
      : httpErr(409, { error: OTHER_ORG_MESSAGE[r.field], code: 'IDENTIFIER_IN_OTHER_ORGANIZATION', field: r.field });
  }
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

// ── Bulk import (CSV and Excel) and import templates ─────────────────────────
// One pipeline for both formats: utils/tabularFile.js turns the upload (.csv or .xlsx)
// into numbered rows; everything below is the same for both.
//
// Columns (header names case-insensitive; "phone"/"mobile" and "extension" are accepted
// as aliases; other columns are ignored): first_name, last_name, mobile_number,
// extension_number, email, role, organization, department, location, is_active.
//
// Organization: with an `organization` column every row names its organization, resolved
// by name among the live organizations of the target tenant — a tenant user's own tenant,
// or the tenant a SUPER_ADMIN selected / chose explicitly (never a value from the file).
// Without the column (older CSV files) the organization chosen in the import dialog is
// used. A value that cannot be resolved is a row error; there is no fallback.
// Department / location: resolved by name within the row's organization.
//
// Contact identity (services/contactIdentity.js; the same rules as POST /contacts): an
// extension or mobile number already held by a contact of the row's organization updates
// that contact with the filled-in cells (blank cells keep the current value); one held in
// another organization, or an extension and a mobile of two different contacts, makes the
// row a conflict. Rows are applied in file order, so a repeated person is created once and
// then updated. The commit holds the platform-wide identity lock; unique indexes on the
// normalised identifiers (migration 051) are the final guard.
//
// mode=preview runs every check without writing; mode=commit (default) re-runs them in
// the transaction and inserts the valid rows. Limits: 5 MB (route), 10,000 data rows,
// workbook archive limits below.

export const IMPORT_MAX_ROWS = 10000;
const IMPORT_ZIP_LIMITS = { maxEntries: 200, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 };
export const IMPORT_SHEET = 'Emergency Contacts';
export const IMPORT_FIELDS = ['first_name', 'last_name', 'mobile_number', 'extension_number', 'email',
  'role', 'organization', 'department', 'location', 'is_active'];
const FIELD_LABEL = {
  first_name: 'First name', last_name: 'Last name', mobile_number: 'Mobile number',
  extension_number: 'Extension number', email: 'Email', role: 'Role', organization: 'Organization',
  department: 'Department', location: 'Location', is_active: 'Status (is_active)',
};

const HEADER_ALIASES = { phone: 'mobile_number', mobile: 'mobile_number', extension: 'extension_number' };
const ACTIVE_WORDS = { true: true, yes: true, 1: true, active: true, false: false, no: false, 0: false, inactive: false };

const normName  = (v) => String(v ?? '').trim().toLowerCase();

// The template's example rows. An unchanged example row (all ten columns exactly as in
// the template; is_active compared as true/false) is refused, so a forgotten example can
// never be imported. A real contact that merely shares some example values is not affected.
export const TEMPLATE_EXAMPLES = [
  { first_name: 'User1', last_name: 'Test', mobile_number: '1000', extension_number: '1000', email: '', role: 'IT',
    organization: 'Default Organization', department: 'IT', location: '', is_active: 'true' },
  { first_name: 'User2', last_name: 'Test', mobile_number: '1001', extension_number: '1001', email: '', role: '',
    organization: 'Default Organization', department: 'IT', location: '', is_active: 'true' },
  { first_name: 'User3', last_name: 'Test', mobile_number: '1002', extension_number: '1002', email: '', role: 'Security',
    organization: 'Default Organization', department: 'IT', location: 'Bengaluru', is_active: 'true' },
  { first_name: 'User4', last_name: 'Test', mobile_number: '1003', extension_number: '1003', email: '', role: '',
    organization: 'Default Organization', department: 'IT', location: '', is_active: 'true' },
];
const exampleKey = (r) => IMPORT_FIELDS.map((f) => {
  const v = String(r[f] ?? '').trim();
  return f === 'is_active' ? String(ACTIVE_WORDS[v.toLowerCase()] ?? v) : v;
}).join('\u0000');
const EXAMPLE_KEYS = new Set(TEMPLATE_EXAMPLES.map(exampleKey));

// Header row → column index of every known field.
function mapHeader(values) {
  const names = values.map((h) => String(h ?? '').trim().toLowerCase());
  const canonical = names.map((n) => (HEADER_ALIASES[n] && !names.includes(HEADER_ALIASES[n]) ? HEADER_ALIASES[n] : n));
  const cols = {};
  const repeated = new Set();
  canonical.forEach((n, i) => {
    if (!IMPORT_FIELDS.includes(n)) return;
    if (cols[n] !== undefined) repeated.add(n); else cols[n] = i;
  });
  if (repeated.size) throw badRequest(`The column ${[...repeated].join(', ')} appears more than once in the header row`);
  const missing = ['first_name', 'last_name'].filter((f) => cols[f] === undefined);
  if (cols.mobile_number === undefined && cols.extension_number === undefined) missing.push('mobile_number or extension_number');
  if (missing.length) throw badRequest(`Missing required column: ${missing.join(', ')}. Keep the header row of the import template.`);
  return { cols, named: canonical.map((n) => n !== '') };
}

// Zod issues → administrator-friendly sentences.
function friendlyIssues(error) {
  return error.errors.map((i) => {
    const f = i.path[0];
    if (!f) return i.message === MOBILE_OR_EXTENSION ? 'Both mobile number and extension number are empty' : i.message;
    const label = FIELD_LABEL[f] || f;
    if (i.code === 'too_small') return `${label} is required`;
    if (i.code === 'too_big') return `${label} is longer than ${i.maximum} characters`;
    if (i.code === 'invalid_string' && i.validation === 'email') return 'Email is not a valid email address';
    if (i.code === 'invalid_type' && (i.received === 'null' || i.received === 'undefined')) return `${label} is required`;
    return `${label}: ${i.message}`;
  });
}

// Target tenant and organization context of an import (authorization rules above).
async function importContext(req, cols) {
  const scope = effectiveTenantId(req);
  if (req.user.role === 'SUPER_ADMIN' && scope !== null) await validateTargetTenant(query, scope);
  if (cols.organization !== undefined) {
    if (scope === null) throw badRequest('Select the target tenant for this import: the file has an organization column');
    return { perRow: true, tenantId: scope };
  }
  const raw = req.body.organization_id;
  if (raw === undefined || raw === '') {
    throw badRequest('Choose the organization for this file in the import dialog: the file has no organization column');
  }
  const org = await verifyContactRefs(query, scope, optionalId(raw, 'organization_id'));
  return { perRow: false, tenantId: org.tenant_id, fallbackOrg: { id: org.id } };
}

function byName(list) {
  const map = new Map();
  for (const x of list) {
    const k = normName(x.name);
    map.set(k, [...(map.get(k) || []), x]);
  }
  return map;
}

// Organizations of the target tenant (or the chosen one) and their departments / locations.
async function loadDirectory(q, ctx, cols) {
  const orgs = ctx.perRow
    ? (await q(`SELECT id, name FROM organizations WHERE tenant_id = $1 AND deleted_at IS NULL`, [ctx.tenantId])).rows
    : [ctx.fallbackOrg];
  const ids = orgs.map((o) => o.id);
  const children = async (table, needed) => {
    const lists = new Map(ids.map((id) => [id, []]));
    if (needed && ids.length) {
      const { rows } = await q(`SELECT id, organization_id, name FROM ${table} WHERE organization_id = ANY($1::int[]) AND deleted_at IS NULL`, [ids]);
      for (const r of rows) lists.get(r.organization_id).push(r);
    }
    return new Map([...lists].map(([id, list]) => [id, byName(list)]));
  };
  return {
    orgsByName: byName(orgs),
    depts: await children('departments', cols.department !== undefined),
    locs: await children('locations', cols.location !== undefined),
  };
}

function resolveOne(index, name, notFound, ambiguous) {
  const hits = index?.get(normName(name)) || [];
  if (!hits.length) return { error: notFound };
  if (hits.length > 1) return { error: ambiguous };
  return { id: hits[0].id };
}

// Validate and resolve every data row. Returns [{ row, status: 'valid'|'invalid', errors?, orgId, record? }].
function evaluateRows(table, header, ctx, dir) {
  const { cols, named } = header;
  const hasAllColumns = IMPORT_FIELDS.every((f) => cols[f] !== undefined);
  return table.rows.map((r) => {
    const get = (f) => (cols[f] === undefined ? '' : (r.values[cols[f]] ?? ''));
    const problems = [];
    for (const f of IMPORT_FIELDS) {
      if (cols[f] === undefined) continue;
      if (r.formulas.includes(cols[f])) problems.push(`${FIELD_LABEL[f]} contains a formula; enter the value itself`);
      else if (r.errors.includes(cols[f])) problems.push(`${FIELD_LABEL[f]} contains a spreadsheet error value`);
    }
    // A formula or error cell has no usable value: report only that for the row.
    if (problems.length) return { row: r.row, status: 'invalid', orgId: ctx.perRow ? null : ctx.fallbackOrg.id, errors: problems };
    const stray = r.values.findIndex((v, i) => v !== '' && !named[i]);
    if (stray >= 0) problems.push(`Column ${columnLetter(stray)} has a value but no column heading`);

    if (hasAllColumns && EXAMPLE_KEYS.has(exampleKey(Object.fromEntries(IMPORT_FIELDS.map((f) => [f, get(f)]))))) {
      return { row: r.row, status: 'invalid', orgId: null, errors: ['This is an example row from the template; remove it before importing'] };
    }

    const input = {
      organization_id: 1, // replaced by the resolved organization below
      first_name: get('first_name'), last_name: get('last_name'), role: get('role'),
      mobile_number: get('mobile_number'), extension_number: get('extension_number'), email: get('email'),
    };
    const active = get('is_active');
    if (active !== '') {
      const v = ACTIVE_WORDS[active.toLowerCase()];
      if (v === undefined) problems.push('Status (is_active) must be true/false, yes/no or 1/0'); else input.is_active = v;
    }
    if (!input.mobile_number && !input.extension_number) problems.push('Both mobile number and extension number are empty');
    const parsed = ContactSchema.safeParse(input);
    if (!parsed.success) problems.push(...friendlyIssues(parsed.error));

    let orgId = null;
    if (ctx.perRow) {
      const name = get('organization');
      if (!name) problems.push('Organization is required');
      else {
        const o = resolveOne(dir.orgsByName, name, 'Organization not found', 'Organization name matches more than one organization');
        if (o.error) problems.push(o.error); else orgId = o.id;
      }
    } else {
      orgId = ctx.fallbackOrg.id;
    }
    let deptId = null;
    let locId = null;
    if (orgId !== null) {
      if (get('department')) {
        const d = resolveOne(dir.depts.get(orgId), get('department'),
          'Department does not belong to the specified organization', 'Department name matches more than one department of the organization');
        if (d.error) problems.push(d.error); else deptId = d.id;
      }
      if (get('location')) {
        const l = resolveOne(dir.locs.get(orgId), get('location'),
          'Location does not belong to the specified organization', 'Location name matches more than one location of the organization');
        if (l.error) problems.push(l.error); else locId = l.id;
      }
    }
    if (problems.length) return { row: r.row, status: 'invalid', orgId, errors: [...new Set(problems)] };
    // Fields that a match may update: filled-in cells only (a blank cell keeps the current value).
    const supplied = new Set(['first_name', 'last_name']);
    for (const f of ['mobile_number', 'extension_number', 'email', 'role']) if (get(f) !== '') supplied.add(f);
    if (get('department') !== '') supplied.add('department_id');
    if (get('location') !== '') supplied.add('location_id');
    if (active !== '') supplied.add('is_active');
    return { row: r.row, status: 'valid', orgId, supplied,
      record: { ...parsed.data, organization_id: orgId, department_id: deptId, location_id: locId } };
  });
}

// Apply the contact identity rules (services/contactIdentity.js) to the valid rows, in file
// order: create, update a same-organization contact with the filled-in cells, leave it
// unchanged, or refuse (identifier of another organization / split match). Later rows see
// contacts created or changed by earlier ones. With `write` (commit, inside the caller's
// transaction holding IDENTITY_LOCK) the changes are made; otherwise they are simulated.
async function applyIdentities(q, evaluated, { write }) {
  const valid = evaluated.filter((e) => e.status === 'valid');
  const exts = [...new Set(valid.map((e) => normalizeExtension(e.record.extension_number)).filter(Boolean))];
  const mobs = [...new Set(valid.map((e) => normalizeMobile(e.record.mobile_number)).filter(Boolean))];
  const byExt = new Map();
  const byMob = new Map();
  // prev: the contact's identifiers before an update (their entries are removed; O(1) per row).
  const index = (c, prev = null) => {
    if (prev?.ext && prev.ext !== c.extension_norm && byExt.get(prev.ext) === c) byExt.delete(prev.ext);
    if (prev?.mob && prev.mob !== c.mobile_norm && byMob.get(prev.mob) === c) byMob.delete(prev.mob);
    if (c.extension_norm) byExt.set(c.extension_norm, c);
    if (c.mobile_norm) byMob.set(c.mobile_norm, c);
  };
  if (exts.length || mobs.length) {
    const { rows } = await q(
      `SELECT * FROM emergency_contacts
       WHERE deleted_at IS NULL AND (extension_norm = ANY($1::text[]) OR mobile_norm = ANY($2::text[]))`, [exts, mobs]);
    rows.forEach((r) => index({ ...r, ref: `db:${r.id}` }));
  }

  for (const e of evaluated) {
    if (e.status !== 'valid') continue;
    const ext = normalizeExtension(e.record.extension_number);
    const mob = normalizeMobile(e.record.mobile_number);
    const cls = classifyIdentity({ byExtension: ext ? byExt.get(ext) || null : null, byMobile: mob ? byMob.get(mob) || null : null }, e.orgId);
    if (cls.kind === 'other_organization' || cls.kind === 'conflict') {
      e.status = 'invalid';
      e.conflict = true;
      e.errors = [cls.kind === 'other_organization' ? OTHER_ORG_MESSAGE[cls.field] : CONFLICT_MESSAGE];
      continue;
    }
    if (cls.kind === 'new') {
      const fresh = { ...e.record, extension_norm: ext, mobile_norm: mob, ref: `row:${e.row}`, fromRow: e.row };
      if (write) {
        const row = await savepoint(q, e, () => q(
          `INSERT INTO emergency_contacts
             (organization_id, department_id, location_id, first_name, last_name, role,
              mobile_number, extension_number, email, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [e.record.organization_id, e.record.department_id, e.record.location_id, e.record.first_name, e.record.last_name,
           e.record.role, e.record.mobile_number, e.record.extension_number, e.record.email, e.record.is_active]));
        if (!row) continue;
        Object.assign(fresh, row);
      }
      e.status = 'created';
      index(fresh);
      continue;
    }
    // Same organization: the filled-in cells overwrite, blank cells keep the current value.
    const target = cls.contact;
    const next = {};
    for (const k of UPDATABLE) next[k] = e.supplied.has(k) ? (e.record[k] ?? null) : (target[k] ?? null);
    next.organization_id = target.organization_id;
    const changed = UPDATABLE.filter((k) => (next[k] ?? null) !== (target[k] ?? null));
    e.matchedBy = cls.matchedBy;
    e.sourceRow = target.fromRow || null;
    if (!changed.length) { e.status = 'unchanged'; continue; }
    const prev = { ext: target.extension_norm, mob: target.mobile_norm };
    if (write) {
      const row = await savepoint(q, e, () => q(
        `UPDATE emergency_contacts SET
           organization_id = $2, location_id = $3, department_id = $4,
           first_name = $5, last_name = $6, role = $7, mobile_number = $8,
           extension_number = $9, email = $10, is_active = $11, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [target.id, ...UPDATABLE.map((k) => next[k])]));
      if (!row) continue;
      Object.assign(target, row);
    } else {
      Object.assign(target, next, { extension_norm: normalizeExtension(next.extension_number), mobile_norm: normalizeMobile(next.mobile_number) });
    }
    e.status = 'updated';
    e.changed = changed;
    index(target, prev);
  }
}

// One row's write inside a savepoint; a database error makes only that row invalid.
async function savepoint(q, e, fn) {
  await q('SAVEPOINT contact_row');
  try {
    const { rows: [row] } = await fn();
    await q('RELEASE SAVEPOINT contact_row');
    return row;
  } catch (err) {
    await q('ROLLBACK TO SAVEPOINT contact_row');
    e.status = 'invalid';
    e.errors = [isIdentityViolation(err) ? 'This extension or mobile number was just assigned to another contact' : (err?.message || 'Could not be saved')];
    return null;
  }
}

function summarise(evaluated, format, preview) {
  const errors = [];
  const duplicates = [];
  const updates = [];
  let created = 0;
  let conflicts = 0;
  const by = (e) => (e.sourceRow ? `the contact from row ${e.sourceRow}` : `an existing contact (matched by ${e.matchedBy})`);
  for (const e of evaluated) {
    if (e.status === 'invalid') {
      errors.push({ line: e.row, error: e.errors.join('; ') });
      if (e.conflict) conflicts++;
    } else if (e.status === 'unchanged') {
      duplicates.push({ line: e.row, reason: `Same as ${by(e)}; nothing to update` });
    } else if (e.status === 'updated') {
      updates.push({ line: e.row, reason: `Updates ${by(e)}` });
    } else if (e.status === 'created') {
      created++;
    }
  }
  return {
    ...(preview ? { preview: true } : {}),
    format, total: evaluated.length, valid: created + updates.length, invalid: errors.length,
    inserted: preview ? 0 : created, created, updated: updates.length, unchanged: duplicates.length, conflicts,
    duplicates_prevented: updates.length + duplicates.length,
    skipped: duplicates.length, duplicates, updates, errors,
  };
}

// POST /api/v1/contacts/bulk-upload  (multipart: file, organization_id?, tenant_id?, mode?)
export const bulkUpload = asyncHandler(async (req, res) => {
  const started = Date.now();
  const mode = String(req.body?.mode ?? req.query?.mode ?? 'commit').toLowerCase();
  if (mode !== 'preview' && mode !== 'commit') throw badRequest('mode must be preview or commit');
  if (!req.file) throw badRequest('A file is required: upload an Excel workbook (.xlsx) or a CSV file (.csv)');

  const table = readTabularFile(req.file.buffer, {
    filename: req.file.originalname, maxDataRows: IMPORT_MAX_ROWS, sheetName: IMPORT_SHEET, zip: IMPORT_ZIP_LIMITS,
  });
  if (!table.header) throw badRequest('The file has no header row. Use the import template.');
  const header = mapHeader(table.header.values);
  const ctx = await importContext(req, header.cols);

  let evaluated;
  if (mode === 'preview') {
    const dir = await loadDirectory(query, ctx, header.cols);
    evaluated = evaluateRows(table, header, ctx, dir);
    await applyIdentities(query, evaluated, { write: false });
  } else {
    evaluated = await withIdentityTransaction(async (tq) => {
      const dir = await loadDirectory(tq, ctx, header.cols);
      const rows = evaluateRows(table, header, ctx, dir);
      await applyIdentities(tq, rows, { write: true });
      return rows;
    });

    // Audit: one summary per organization (counts only — never contact details or the file).
    const empty = () => ({ total_rows: 0, inserted: 0, updated: 0, skipped_duplicates: 0, error_rows: 0, conflicts: 0 });
    const groups = new Map();
    for (const e of evaluated) {
      const g = groups.get(e.orgId) || empty();
      g.total_rows++;
      if (e.status === 'created') g.inserted++;
      else if (e.status === 'updated') g.updated++;
      else if (e.status === 'unchanged') g.skipped_duplicates++;
      else if (e.status === 'invalid') { g.error_rows++; if (e.conflict) g.conflicts++; }
      groups.set(e.orgId, g);
    }
    if (!groups.size) groups.set(ctx.perRow ? null : ctx.fallbackOrg.id, empty());
    const order = [...groups.keys()].sort((a, b) => (a === null) - (b === null) || a - b);
    for (const orgId of order) {
      await auditContacts(req, 'contacts_imported', null, {
        tenant_id: ctx.tenantId, organization_id: orgId, format: table.format, ...groups.get(orgId), file_rows: evaluated.length,
      });
    }
  }

  const result = summarise(evaluated, table.format, mode === 'preview');
  logger.info({
    module: 'contacts', mode, format: table.format, rows: result.total, valid: result.valid,
    invalid: result.invalid, created: result.created, updated: result.updated, unchanged: result.unchanged,
    conflicts: result.conflicts,
    organizations: new Set(evaluated.map((e) => e.orgId).filter((id) => id !== null)).size,
    durationMs: Date.now() - started,
  }, mode === 'preview' ? 'Contacts import checked' : 'Contacts import committed');
  res.json(result);
});

// ── Import templates ─────────────────────────────────────────────────────────

const TEMPLATE_COLUMNS = [
  { key: 'first_name', width: 16 }, { key: 'last_name', width: 16 },
  { key: 'mobile_number', width: 18, format: 'text' }, { key: 'extension_number', width: 18, format: 'text' },
  { key: 'email', width: 28 }, { key: 'role', width: 18 }, { key: 'organization', width: 26 },
  { key: 'department', width: 20 }, { key: 'location', width: 20 }, { key: 'is_active', width: 12 },
];
const LAST_TEMPLATE_ROW = IMPORT_MAX_ROWS + 1;

const TEMPLATE_RULES = [
  'Enter one contact per row on the "Emergency Contacts" sheet.',
  'Do not rename or remove the column headers.',
  'first_name and last_name are mandatory.',
  'At least one of mobile_number or extension_number is mandatory.',
  'organization is mandatory: the exact name of an organization of the tenant you import into.',
  'Department and location must belong to the selected organization.',
  'Email is optional.',
  'Role is optional.',
  'is_active accepts true/false, yes/no, and 1/0 (blank means true).',
  'Leave optional fields blank when not applicable.',
  'Rows 2 to 5 (User1 Test to User4 Test) are sample records. Do not modify sample values without understanding that they are examples.',
  'Remove the sample rows before uploading actual records. Unchanged sample rows are rejected.',
  'Do not enter created_at or updated_at; the application manages these fields.',
  'mobile_number and extension_number are text columns, so leading zeros, a leading + and long numbers are kept.',
  'Save as Excel Workbook (.xlsx) or CSV UTF-8 (.csv). At most 10,000 contacts and 5 MB per file.',
];
const COLUMN_RULES = [
  ['first_name', 'Required. Up to 64 characters.'],
  ['last_name', 'Required. Up to 64 characters.'],
  ['mobile_number', 'Required unless extension_number is filled in. Up to 32 characters.'],
  ['extension_number', 'Required unless mobile_number is filled in. Up to 32 characters.'],
  ['email', 'Optional. A valid e-mail address, up to 255 characters.'],
  ['role', 'Optional. Up to 64 characters.'],
  ['organization', 'Required. Name of an organization of the target tenant.'],
  ['department', 'Optional. Name of a department of that organization.'],
  ['location', 'Optional. Name of a location of that organization.'],
  ['is_active', 'Optional. true/false, yes/no or 1/0; blank means true.'],
];

function templateWorkbook() {
  return buildWorkbook([
    {
      name: IMPORT_SHEET,
      columns: TEMPLATE_COLUMNS.map((c) => ({ header: c.key, key: c.key, width: c.width, format: c.format, empty: null })),
      rows: TEMPLATE_EXAMPLES,
      validations: [{
        sqref: `J2:J${LAST_TEMPLATE_ROW}`, list: ['true', 'false'], errorStyle: 'information',
        promptTitle: 'is_active', prompt: 'true or false (yes/no and 1/0 are also accepted; blank = true)',
        errorTitle: 'is_active', error: 'Use true or false. yes/no and 1/0 are also accepted.',
      }],
      ignoredErrors: [{ sqref: `C2:D${LAST_TEMPLATE_ROW}`, numberStoredAsText: true }],
    },
    {
      name: 'Instructions',
      title: 'Emergency Contacts import — instructions',
      items: [
        { section: 'How to fill in the template' },
        ...TEMPLATE_RULES.map((label) => ({ label, value: null, empty: null })),
        { section: 'Columns' },
        ...COLUMN_RULES.map(([label, value]) => ({ label, value })),
      ],
    },
  ]);
}

// GET /api/v1/contacts/import-template?format=xlsx|csv — static: no tenant or contact data.
export const importTemplate = asyncHandler(async (req, res) => {
  const format = String(req.query.format ?? 'xlsx').toLowerCase();
  res.setHeader('Cache-Control', 'no-store');
  if (format === 'csv') {
    const csv = toCsv(IMPORT_FIELDS, TEMPLATE_EXAMPLES.map((e) => IMPORT_FIELDS.map((f) => e[f])));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="emergency-contacts-template.csv"');
    return res.send(String.fromCharCode(0xFEFF) + csv); // UTF-8 byte-order mark: Excel opens the file as UTF-8
  }
  if (format !== 'xlsx') throw badRequest('format must be xlsx or csv');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="emergency-contacts-template.xlsx"');
  return res.send(templateWorkbook());
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
