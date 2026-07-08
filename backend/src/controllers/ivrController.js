import { query, withTransaction } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateGraph } from '../utils/ivrGraphValidator.js';
import {
  CreateFlowSchema,
  UpdateFlowSchema,
  PublishFlowSchema,
  BindFlowSchema,
  UnbindFlowSchema,
  GraphSchema,
} from '../validators/ivrValidator.js';

// ── Internal helpers ──────────────────────────────────────────────────────────

async function fetchFlow(flowUuid, tenantId) {
  const { rows } = await query(
    `SELECT f.*,
       u1.email AS created_by_email,
       u2.email AS updated_by_email
     FROM ivr_flows f
     LEFT JOIN users u1 ON u1.id = f.created_by
     LEFT JOIN users u2 ON u2.id = f.updated_by
     WHERE f.flow_uuid = $1 AND f.tenant_id = $2 AND f.deleted_at IS NULL`,
    [flowUuid, tenantId]
  );
  return rows[0] || null;
}

async function fetchLatestVersion(flowId) {
  const { rows } = await query(
    `SELECT v.*, u.email AS published_by_email
     FROM ivr_flow_versions v
     LEFT JOIN users u ON u.id = v.published_by
     WHERE v.ivr_flow_id = $1
     ORDER BY v.version_number DESC LIMIT 1`,
    [flowId]
  );
  return rows[0] || null;
}

async function fetchBoundNumbers(flowId) {
  const { rows } = await query(
    `SELECT id, number, type FROM emergency_numbers
     WHERE ivr_flow_id = $1 AND deleted_at IS NULL`,
    [flowId]
  );
  return rows;
}

// ── GET /ivr/flows ────────────────────────────────────────────────────────────

export const listFlows = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  const { org, search, page = 1, limit = 20 } = req.query;
  const pageNum   = Math.max(1, parseInt(page) || 1);
  const limitNum  = Math.min(100, parseInt(limit) || 20);
  const offset    = (pageNum - 1) * limitNum;

  const conditions = ['f.tenant_id = $1', 'f.deleted_at IS NULL'];
  const params     = [tenantId];

  if (org) {
    params.push(parseInt(org));
    conditions.push(`f.organization_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${search.slice(0, 100)}%`);
    conditions.push(`f.name ILIKE $${params.length}`);
  }

  const where = conditions.join(' AND ');
  params.push(limitNum, offset);
  const limitIdx  = params.length - 1;
  const offsetIdx = params.length;

  const [{ rows: flows }, { rows: [{ total }] }] = await Promise.all([
    query(
      `SELECT f.id, f.flow_uuid, f.name, f.description, f.is_active,
              f.organization_id, f.created_at, f.updated_at,
              o.name AS organization_name,
              (SELECT version_number FROM ivr_flow_versions
               WHERE ivr_flow_id = f.id ORDER BY version_number DESC LIMIT 1) AS latest_version,
              (SELECT published_at FROM ivr_flow_versions
               WHERE ivr_flow_id = f.id ORDER BY version_number DESC LIMIT 1) AS last_published_at,
              (SELECT COUNT(*)::INT FROM emergency_numbers
               WHERE ivr_flow_id = f.id AND deleted_at IS NULL) AS bound_number_count
       FROM ivr_flows f
       LEFT JOIN organizations o ON o.id = f.organization_id
       WHERE ${where}
       ORDER BY f.updated_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    ),
    query(`SELECT COUNT(*)::INT AS total FROM ivr_flows f WHERE ${where}`, params.slice(0, -2)),
  ]);

  res.json({ flows, total, page: pageNum, limit: limitNum });
});

// ── POST /ivr/flows ───────────────────────────────────────────────────────────

export const createFlow = asyncHandler(async (req, res) => {
  const parsed = CreateFlowSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const { name, description, organization_id } = parsed.data;
  const tenantId = req.user.tenantId;

  const emptyGraph = JSON.stringify({ entry_node_id: '', nodes: {} });

  const { rows: [flow] } = await query(
    `INSERT INTO ivr_flows (name, description, organization_id, tenant_id, graph, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING *`,
    [name, description || null, organization_id || null, tenantId, emptyGraph, req.user.id]
  );

  res.status(201).json({ flow });
});

// ── GET /ivr/flows/:uuid ──────────────────────────────────────────────────────

export const getFlowById = asyncHandler(async (req, res) => {
  const flow = await fetchFlow(req.params.uuid, req.user.tenantId);
  if (!flow) return res.status(404).json({ error: 'Flow not found' });

  const [latestVersion, boundNumbers] = await Promise.all([
    fetchLatestVersion(flow.id),
    fetchBoundNumbers(flow.id),
  ]);

  res.json({ flow: { ...flow, latest_version: latestVersion, bound_numbers: boundNumbers } });
});

// ── PUT /ivr/flows/:uuid ──────────────────────────────────────────────────────

export const updateFlow = asyncHandler(async (req, res) => {
  const parsed = UpdateFlowSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const flow = await fetchFlow(req.params.uuid, req.user.tenantId);
  if (!flow) return res.status(404).json({ error: 'Flow not found' });

  const { name, description, graph } = parsed.data;

  // Structural-only validation on save (skip on empty canvas; DB ID checks run only on publish)
  if (graph && Object.keys(graph.nodes || {}).length > 0) {
    // Only run full structural checks when there are actual nodes to validate.
    // An empty graph (nodes:{}) is accepted — it represents a cleared canvas draft.
    const fullCheck = GraphSchema.safeParse(graph);
    if (fullCheck.success) {
      const result = await validateGraph(graph, req.user.tenantId);
      const structural = (result.errors || []).filter(e => !e.includes('not found') && !e.includes('wrong tenant'));
      if (structural.length > 0) {
        return res.status(400).json({ error: 'Graph structure invalid', errors: structural });
      }
    } else {
      const structural = fullCheck.error.issues.map(i => `${i.path.join('.') || 'graph'}: ${i.message}`)
        .filter(e => !e.includes('not found') && !e.includes('wrong tenant'));
      if (structural.length > 0) {
        return res.status(400).json({ error: 'Graph structure invalid', errors: structural });
      }
    }
  }

  const sets   = ['updated_at = now()', 'updated_by = $1'];
  const params = [req.user.id];

  if (name !== undefined)        { params.push(name);                           sets.push(`name = $${params.length}`); }
  if (description !== undefined) { params.push(description);                    sets.push(`description = $${params.length}`); }
  if (graph !== undefined) {
    // Strip _layout (frontend position hints) — never stored in the graph column
    const { _layout: _ignored, ...graphToStore } = graph;
    params.push(JSON.stringify(graphToStore));
    sets.push(`graph = $${params.length}`);
  }

  params.push(flow.id);
  const { rows: [updated] } = await query(
    `UPDATE ivr_flows SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  res.json({ flow: updated });
});

// ── DELETE /ivr/flows/:uuid ───────────────────────────────────────────────────

export const deleteFlow = asyncHandler(async (req, res) => {
  const flow = await fetchFlow(req.params.uuid, req.user.tenantId);
  if (!flow) return res.status(404).json({ error: 'Flow not found' });

  await withTransaction(async tq => {
    await tq(
      `UPDATE emergency_numbers SET ivr_flow_id = NULL WHERE ivr_flow_id = $1`,
      [flow.id]
    );
    await tq(
      `UPDATE ivr_flows SET deleted_at = now(), updated_by = $1 WHERE id = $2`,
      [req.user.id, flow.id]
    );
  });

  res.json({ message: 'Flow deleted and unbound from all numbers' });
});

// ── POST /ivr/flows/:uuid/validate ───────────────────────────────────────────

export const validateFlow = asyncHandler(async (req, res) => {
  const flow = await fetchFlow(req.params.uuid, req.user.tenantId);
  if (!flow) return res.status(404).json({ error: 'Flow not found' });

  // Allow validating a candidate graph without saving it
  const graphToCheck = req.body?.graph ?? flow.graph;
  const result = await validateGraph(graphToCheck, req.user.tenantId);

  res.json(result);
});

// ── POST /ivr/flows/:uuid/publish ─────────────────────────────────────────────

export const publishFlow = asyncHandler(async (req, res) => {
  const parsed = PublishFlowSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const flow = await fetchFlow(req.params.uuid, req.user.tenantId);
  if (!flow) return res.status(404).json({ error: 'Flow not found' });

  // Full validation (all DB checks) must pass before publish
  const result = await validateGraph(flow.graph, req.user.tenantId);
  if (!result.valid) {
    return res.status(400).json({
      error:    'Graph validation failed — fix errors before publishing',
      errors:   result.errors,
      warnings: result.warnings,
    });
  }

  const { rows: [version] } = await withTransaction(async tq => {
    const { rows: [{ next_ver }] } = await tq(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_ver
       FROM ivr_flow_versions WHERE ivr_flow_id = $1`,
      [flow.id]
    );
    return tq(
      `INSERT INTO ivr_flow_versions
         (ivr_flow_id, version_number, graph, published_by, change_notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *,
         (SELECT email FROM users WHERE id = $4) AS published_by_email`,
      [flow.id, next_ver, JSON.stringify(flow.graph), req.user.id, parsed.data.change_notes || null]
    );
  });

  res.status(201).json({ version: { ...version, warnings: result.warnings } });
});

// ── GET /ivr/flows/:uuid/versions ─────────────────────────────────────────────

export const listVersions = asyncHandler(async (req, res) => {
  const flow = await fetchFlow(req.params.uuid, req.user.tenantId);
  if (!flow) return res.status(404).json({ error: 'Flow not found' });

  const { rows: versions } = await query(
    `SELECT v.id, v.version_uuid, v.version_number, v.published_at, v.change_notes,
            u.email AS published_by_email
     FROM ivr_flow_versions v
     LEFT JOIN users u ON u.id = v.published_by
     WHERE v.ivr_flow_id = $1
     ORDER BY v.version_number DESC`,
    [flow.id]
  );

  res.json({ versions });
});

// ── GET /ivr/flows/:uuid/versions/:vnum ──────────────────────────────────────

export const getVersion = asyncHandler(async (req, res) => {
  const flow = await fetchFlow(req.params.uuid, req.user.tenantId);
  if (!flow) return res.status(404).json({ error: 'Flow not found' });

  const vnum = parseInt(req.params.vnum);
  if (!Number.isFinite(vnum)) return res.status(400).json({ error: 'Invalid version number' });

  const { rows: [version] } = await query(
    `SELECT v.*, u.email AS published_by_email
     FROM ivr_flow_versions v
     LEFT JOIN users u ON u.id = v.published_by
     WHERE v.ivr_flow_id = $1 AND v.version_number = $2`,
    [flow.id, vnum]
  );

  if (!version) return res.status(404).json({ error: 'Version not found' });
  res.json({ version });
});

// ── PATCH /ivr/flows/:uuid/bind ───────────────────────────────────────────────

export const bindNumber = asyncHandler(async (req, res) => {
  const parsed = BindFlowSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const flow = await fetchFlow(req.params.uuid, req.user.tenantId);
  if (!flow) return res.status(404).json({ error: 'Flow not found' });

  const { rows: [num] } = await query(
    `SELECT id, number, type FROM emergency_numbers
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [parsed.data.emergency_number_id, req.user.tenantId]
  );
  if (!num) return res.status(404).json({ error: 'Emergency number not found' });

  await query(
    `UPDATE emergency_numbers SET ivr_flow_id = $1 WHERE id = $2`,
    [flow.id, num.id]
  );

  res.json({ message: `Number ${num.number} bound to flow "${flow.name}"`, number: num });
});

// ── PATCH /ivr/flows/:uuid/unbind ────────────────────────────────────────────

export const unbindNumber = asyncHandler(async (req, res) => {
  const parsed = UnbindFlowSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const flow = await fetchFlow(req.params.uuid, req.user.tenantId);
  if (!flow) return res.status(404).json({ error: 'Flow not found' });

  const { rows: [num] } = await query(
    `UPDATE emergency_numbers SET ivr_flow_id = NULL
     WHERE id = $1 AND ivr_flow_id = $2 AND tenant_id = $3
     RETURNING id, number`,
    [parsed.data.emergency_number_id, flow.id, req.user.tenantId]
  );

  if (!num) return res.status(404).json({ error: 'Number not bound to this flow' });
  res.json({ message: `Number ${num.number} unbound`, number: num });
});
