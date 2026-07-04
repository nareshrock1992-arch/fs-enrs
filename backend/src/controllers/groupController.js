import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const GroupSchema = z.object({
  organization_id: z.number().int().positive(),
  name:            z.string().min(1).max(128),
  description:     z.string().optional(),
  is_active:       z.boolean().default(true),
});

export const listGroups = asyncHandler(async (req, res) => {
  const orgId = req.query.organization_id || null;
  const { rows } = await query(
    `SELECT g.*,
       COUNT(m.id)::INT AS member_count,
       o.name AS organization_name
     FROM responder_groups g
     LEFT JOIN responder_group_members m ON m.responder_group_id = g.id
     LEFT JOIN organizations o ON o.id = g.organization_id
     WHERE g.deleted_at IS NULL
       AND ($1::int IS NULL OR g.organization_id = $1)
     GROUP BY g.id, o.name
     ORDER BY g.name`,
    [orgId]
  );
  res.json({ groups: rows });
});

export const getGroup = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT g.*, o.name AS organization_name
     FROM responder_groups g
     LEFT JOIN organizations o ON o.id = g.organization_id
     WHERE g.id = $1 AND g.deleted_at IS NULL`,
    [req.params.id]
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
  const { rows } = await query(
    `INSERT INTO responder_groups (organization_id, name, description, is_active)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [d.organization_id, d.name, d.description, d.is_active]
  );
  res.status(201).json(rows[0]);
});

export const updateGroup = asyncHandler(async (req, res) => {
  const d = GroupSchema.partial().parse(req.body);
  const { rows } = await query(
    `UPDATE responder_groups SET
       name        = COALESCE($2, name),
       description = COALESCE($3, description),
       is_active   = COALESCE($4, is_active),
       updated_at  = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id, d.name, d.description, d.is_active]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Group not found' });
  res.json(rows[0]);
});

export const deleteGroup = asyncHandler(async (req, res) => {
  await query(`UPDATE responder_groups SET deleted_at = now() WHERE id = $1`, [req.params.id]);
  res.status(204).end();
});

// POST /api/v1/groups/:id/members  { contact_ids: [1,2,3] }
export const addMembers = asyncHandler(async (req, res) => {
  const { contact_ids } = z.object({
    contact_ids: z.array(z.number().int().positive())
  }).parse(req.body);

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
  await query(
    `DELETE FROM responder_group_members
     WHERE responder_group_id = $1 AND emergency_contact_id = $2`,
    [req.params.id, req.params.contactId]
  );
  res.status(204).end();
});
