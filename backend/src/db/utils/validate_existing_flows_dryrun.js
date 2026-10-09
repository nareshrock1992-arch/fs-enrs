// READ-ONLY dry-run: validate every stored IVR graph (drafts in ivr_flows and
// published snapshots in ivr_flow_versions) against the registry-DERIVED node
// schemas, and report any node that would newly fail. Performs NO writes.
//
// Purpose: before switching the live validator to the derived schemas, confirm
// that existing production flows still validate — and surface any field that
// was silently tolerated before (e.g. a numeric config ref stored as "" / null).
//
// Usage (run where the DB is reachable, e.g. the dev server):
//   node src/db/utils/validate_existing_flows_dryrun.js
// Exit code is always 0 (reporting tool); findings are printed to stdout.

import { query, pool } from '../pool.js';
import { validateNode } from '../../validators/nodeSchemaFromRegistry.js';

function nodesOf(graph) {
  const g = typeof graph === 'string' ? JSON.parse(graph) : graph;
  return g && g.nodes && typeof g.nodes === 'object' ? g.nodes : {};
}

async function run() {
  const findings = [];
  let flowCount = 0, versionCount = 0, nodeCount = 0;

  const scan = (source, ref, graph) => {
    const nodes = nodesOf(graph);
    for (const [nodeId, node] of Object.entries(nodes)) {
      nodeCount++;
      const { ok, issues } = validateNode(node);
      if (!ok) {
        for (const is of issues) {
          findings.push({ source, ref, nodeId, type: node?.type ?? '(none)', path: is.path, message: is.message });
        }
      }
    }
  };

  const { rows: flows } = await query(
    `SELECT id, flow_uuid, name, graph FROM ivr_flows WHERE deleted_at IS NULL`,
  );
  for (const f of flows) { flowCount++; scan('ivr_flows', `${f.name} (${f.flow_uuid})`, f.graph); }

  const { rows: versions } = await query(
    `SELECT v.id, v.ivr_flow_id, v.version_number, v.graph, f.name
       FROM ivr_flow_versions v JOIN ivr_flows f ON f.id = v.ivr_flow_id`,
  );
  for (const v of versions) { versionCount++; scan('ivr_flow_versions', `${v.name} v${v.version_number}`, v.graph); }

  console.log('── Registry-derived validation dry-run (READ-ONLY) ───────────────');
  console.log(`Scanned: ${flowCount} draft flow(s), ${versionCount} published version(s), ${nodeCount} node(s).`);
  if (findings.length === 0) {
    console.log('\n✅ No existing node would fail the derived validator. Safe to switch.');
  } else {
    console.log(`\n⚠ ${findings.length} finding(s) — existing nodes that would fail:\n`);
    // Group by type.path.message for a compact report.
    const grouped = {};
    for (const f of findings) {
      const key = `${f.type} · ${f.path} · ${f.message}`;
      (grouped[key] ||= []).push(`${f.source}:${f.ref} [${f.nodeId}]`);
    }
    for (const [key, where] of Object.entries(grouped)) {
      console.log(`• ${key}`);
      for (const w of where.slice(0, 10)) console.log(`    - ${w}`);
      if (where.length > 10) console.log(`    … and ${where.length - 10} more`);
    }
    console.log('\nReview each: either the stored data is genuinely invalid, or the');
    console.log('derivation is too strict and should be relaxed for backward-compat.');
  }
  await pool.end();
}

run().catch(async (e) => {
  console.error('dry-run failed:', e.message);
  try { await pool.end(); } catch { /* noop */ }
  process.exit(0); // reporting tool — never fail CI/callers
});
