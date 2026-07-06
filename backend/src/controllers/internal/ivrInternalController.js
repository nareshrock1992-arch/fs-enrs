import { query } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

/**
 * GET /api/v1/internal/ivr/lookup?number=<e164_number>
 *
 * Called by FreeSWITCH Lua on every inbound call.
 * Returns the latest published version's frozen graph JSON.
 * Returns 404 if number has no bound published flow → Lua falls
 * back to direct ENS/ERS routing.
 */
export const ivrLookup = asyncHandler(async (req, res) => {
  const rawNumber = req.query.number;
  if (!rawNumber || typeof rawNumber !== 'string') {
    return res.status(400).json({ error: 'number query param required' });
  }

  // Normalise: strip everything except digits and leading +
  const number = rawNumber.trim().replace(/[^\d+]/g, '');
  if (number.length < 3 || number.length > 20) {
    return res.status(400).json({ error: 'Invalid number format' });
  }

  // Look up emergency_number → bound ivr_flow → latest published version
  // tenant_id scoped through emergency_numbers to prevent cross-tenant graph exposure
  const { rows: [row] } = await query(
    `SELECT
       en.number,
       en.type        AS number_type,
       en.tenant_id,
       f.flow_uuid,
       f.name         AS flow_name,
       v.version_number,
       v.version_uuid,
       v.graph,
       v.published_at
     FROM emergency_numbers en
     JOIN ivr_flows f
       ON f.id = en.ivr_flow_id
      AND f.tenant_id = en.tenant_id
      AND f.deleted_at IS NULL
      AND f.is_active = true
     JOIN ivr_flow_versions v
       ON v.ivr_flow_id = f.id
      AND v.version_number = (
        SELECT MAX(version_number)
        FROM ivr_flow_versions
        WHERE ivr_flow_id = f.id
      )
     WHERE en.number = $1
       AND en.deleted_at IS NULL`,
    [number]
  );

  if (!row) {
    return res.status(404).json({ error: 'No published IVR flow bound to this number' });
  }

  // Expose the frozen graph with routing metadata — Lua uses this directly
  const graph = typeof row.graph === 'string' ? JSON.parse(row.graph) : row.graph;

  res.json({
    flow_uuid:      row.flow_uuid,
    flow_name:      row.flow_name,
    number:         row.number,
    number_type:    row.number_type,
    version_uuid:   row.version_uuid,
    version_number: row.version_number,
    published_at:   row.published_at,
    entry_node_id:  graph.entry_node_id,
    nodes:          graph.nodes,
  });
});
