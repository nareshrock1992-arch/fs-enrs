/**
 * Usage: node src/db/utils/check_flow_graph.js "ERS — Emergency 1222 Multi-Level Response (Production)"
 *
 * Fetches the latest published version of the named flow and reports
 * every node unreachable from entry_node_id.
 */

import { pool } from '../pool.js';
import { validateGraph } from '../../utils/ivrGraphValidator.js';

const flowName = process.argv[2];
if (!flowName) {
  console.error('Usage: node check_flow_graph.js "<flow name>"');
  process.exit(1);
}

const client = await pool.connect();
try {
  const { rows } = await client.query(
    `SELECT fv.graph, fv.version_number, fv.published_at, f.name, f.flow_uuid, f.tenant_id
     FROM ivr_flow_versions fv
     JOIN ivr_flows f ON f.id = fv.ivr_flow_id
     WHERE f.name = $1 AND f.deleted_at IS NULL
     ORDER BY fv.version_number DESC
     LIMIT 1`,
    [flowName]
  );

  if (!rows.length) {
    console.error(`No flow found with name: "${flowName}"`);
    process.exit(1);
  }

  const row = rows[0];
  console.log(`\nFlow:     ${row.name}`);
  console.log(`UUID:     ${row.flow_uuid}`);
  console.log(`Version:  ${row.version_number}  (published ${row.published_at})`);

  const graph  = typeof row.graph === 'string' ? JSON.parse(row.graph) : row.graph;
  const result = await validateGraph(graph, row.tenant_id);

  const unreachable = result.warnings.filter(w => w.includes('not reachable'));
  if (!unreachable.length) {
    console.log('\n✓ No unreachable nodes — graph is fully connected.\n');
  } else {
    console.log(`\n⚠ Unreachable nodes (${unreachable.length}):\n`);
    unreachable.forEach(w => console.log('  •', w));
    console.log();
  }

  if (result.errors.length) {
    console.log(`Errors (${result.errors.length}):`);
    result.errors.forEach(e => console.log('  ✗', e));
  }
} finally {
  client.release();
  await pool.end();
}
