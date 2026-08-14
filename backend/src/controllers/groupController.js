import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { effectiveTenantId } from '../middleware/tenantScope.js';

const emptyToNull = z.preprocess(v => (v === '' ? null : v), z.string().nullable().optional());

const GroupSchema = z.object({
  organization_id: z.number().int().positive(),
  name:            z.string().min(1).max(128),
  description:     emptyToNull,
  is_active:       z.boolean().default(true),
});

// Verify organization belongs to the caller's effective tenant.
async function verifyGroupTenant(groupId, tenantId) {
  if (tenantId === null) return; // SUPER_ADMIN — no restriction
  const { rows: [g] } = await query(
    `SELECT rg.id FROM responder_groups rg
     JOIN organizations o ON o.id = rg.organization_id
     WHERE rg.id = $1 AND rg.deleted_at IS NULL AND o.tenant_id = $2`,
    [groupId, tenantId]
  );
  if (!g) throw Object.assign(new Error('Group not found'), { status: 404 });
}

export const listGroups = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  if (req.user.role !== 'SUPER_ADMIN' && !tenantId) {
    return res.status(403).json({ error: 'Tenant context required' });
  }

  const orgId = req.query.organization_id || null;
  const { rows } = await query(
    `SELECT g.*,
       COUNT(m.id)::INT AS member_count,
       o.name AS organization_name
     FROM responder_groups g
     LEFT JOIN responder_group_members m ON m.responder_group_id = g.id
     JOIN organizations o ON o.id = g.organization_id
     WHERE g.deleted_at IS NULL
       AND ($1::int IS NULL OR o.tenant_id = $1)
       AND ($2::int IS NULL OR g.organization_id = $2)
     GROUP BY g.id, o.name
     ORDER BY g.name`,
    [tenantId, orgId]
  );
  res.json({ groups: rows });
});

export const getGroup = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rows } = await query(
    `SELECT g.*, o.name AS organization_name
     FROM responder_groups g
     JOIN organizations o ON o.id = g.organization_id
     WHERE g.id = $1 AND g.deleted_at IS NULL
       AND ($2::int IS NULL OR o.tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Group not found' });

  const { rows: members } = await query(
    `SELECT c.id, c.first_name, c.last_name, c.mobile_number, c.email, c.role
     FROM emergency_contacts c
     JOIN responder_group_members m ON m.emergency_contact_id = c.id
     WHERE m.responder_group_id = $1 AND c.deleted_at IS NULL
     ORDER BY c.last_name, c.first_name`,
    [req.params.id]
  );

  res.json({ ...rows[0], members });
});

export const createGroup = asyncHandler(async (req, res) => {
  const d = GroupSchema.parse(req.body);
  const tenantId = effectiveTenantId(req);

  // Verify the organization belongs to the caller's tenant.
  if (tenantId !== null) {
    const { rows: [org] } = await query(
      `SELECT id FROM organizations WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [d.organization_id, tenantId]
    );
    if (!org) return res.status(404).json({ error: 'Organization not found' });
  }

  const { rows } = await query(
    `INSERT INTO responder_groups (organization_id, name, description, is_active)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [d.organization_id, d.name, d.description, d.is_active]
  );
  res.status(201).json(rows[0]);
});

export const updateGroup = asyncHandler(async (req, res) => {
  const d = GroupSchema.partial().parse(req.body);
  const tenantId = effectiveTenantId(req);
  const { rows } = await query(
    `UPDATE responder_groups g SET
       name        = COALESCE($3, g.name),
       description = COALESCE($4, g.description),
       is_active   = COALESCE($5, g.is_active),
       updated_at  = now()
     FROM organizations o
     WHERE g.id = $1 AND g.deleted_at IS NULL
       AND o.id = g.organization_id
       AND ($2::int IS NULL OR o.tenant_id = $2)
     RETURNING g.*`,
    [req.params.id, tenantId, d.name, d.description, d.is_active]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Group not found' });
  res.json(rows[0]);
});

export const deleteGroup = asyncHandler(async (req, res) => {
  const tenantId = effectiveTenantId(req);
  const { rowCount } = await query(
    `UPDATE responder_groups g SET deleted_at = now()
     FROM organizations o
     WHERE g.id = $1 AND g.deleted_at IS NULL
       AND o.id = g.organization_id
       AND ($2::int IS NULL OR o.tenant_id = $2)`,
    [req.params.id, tenantId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Group not found' });
  res.status(204).end();
});

// POST /api/v1/groups/:id/members  { contact_ids: [1,2,3] }
export const addMembers = asyncHandler(async (req, res) => {
  const { contact_ids } = z.object({
    contact_ids: z.array(z.number().int().positive())
  }).parse(req.body);

  await verifyGroupTenant(req.params.id, effectiveTenantId(req));

  for (const cid of contact_ids) {
    await query(
      `INSERT INTO responder_group_members (responder_group_id, emergency_contact_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.params.id, cid]
    );
  }
  res.json({ ok: true, added: contact_ids.length });
});

// DELETE /api/v1/groups/:id/members/:contactId
export const removeMember = asyncHandler(async (req, res) => {
  await verifyGroupTenant(req.params.id, effectiveTenantId(req));
  await query(
    `DELETE FROM responder_group_members
     WHERE responder_group_id = $1 AND emergency_contact_id = $2`,
    [req.params.id, req.params.contactId]
  );
  res.status(204).end();
});
