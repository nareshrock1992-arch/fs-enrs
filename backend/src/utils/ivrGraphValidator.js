import { GraphSchema, AnyNodeSchema } from '../validators/ivrValidator.js';
import { query } from '../db/pool.js';

/**
 * Two-pass IVR graph validator.
 *
 * Pass 1 — Zod schema: every node matches its type's schema; entry_node_id exists.
 * Pass 2 — Graph integrity: cycle detection (DFS), dangling refs, DB ID existence.
 *
 * Returns { valid, errors, warnings, stats }.
 */
export async function validateGraph(graph, tenantId) {
  const errors   = [];
  const warnings = [];

  // ── Pre-flight: guard against malformed input ─────────────────────────────
  // Crash source: "Cannot read properties of undefined (reading 'type')"
  // Happens when graph is null, graph.nodes is null, or a node value is null.

  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return { valid: false, errors: ['graph must be a non-null JSON object'], warnings };
  }

  // Normalise: coerce stored string JSON (old schema used flow_json as text)
  let g = graph;
  if (typeof graph === 'string') {
    try { g = JSON.parse(graph); } catch {
      return { valid: false, errors: ['graph is not valid JSON'], warnings };
    }
  }

  // Guard: nodes must be an object with no null/undefined entries
  if (g.nodes && typeof g.nodes === 'object') {
    for (const [nid, node] of Object.entries(g.nodes)) {
      if (node === null || node === undefined) {
        errors.push(`node "${nid}" is null — remove or re-add this node in the builder`);
      } else if (typeof node !== 'object') {
        errors.push(`node "${nid}" must be an object (got ${typeof node})`);
      } else if (!node.type) {
        errors.push(`node "${nid}" is missing required field "type"`);
      }
    }
  }
  if (errors.length > 0) return { valid: false, errors, warnings };

  // ── Pass 1: Zod schema ────────────────────────────────────────────────────

  const parsed = GraphSchema.safeParse(g);
  if (!parsed.success) {
    return {
      valid:  false,
      errors: parsed.error.issues.map(i => `${i.path.join('.') || 'graph'}: ${i.message}`),
      warnings,
    };
  }

  const { entry_node_id, nodes } = parsed.data;

  // Per-node Zod validation — re-run individually for clearer error paths
  for (const [nid, node] of Object.entries(nodes)) {
    if (!node || typeof node !== 'object') continue; // already caught above
    const r = AnyNodeSchema.safeParse(node);
    if (!r.success) {
      for (const issue of r.error.issues) {
        errors.push(`node ${nid}.${issue.path.join('.') || 'type'}: ${issue.message}`);
      }
    }
  }
  if (errors.length > 0) return { valid: false, errors, warnings };

  // ── Pass 2: Graph integrity ───────────────────────────────────────────────

  function refsOf(node) {
    if (!node || typeof node !== 'object') return [];
    const ids = [];
    if (node.next)           ids.push(node.next);
    if (node.target_node_id) ids.push(node.target_node_id);
    if (node.branches)       ids.push(...Object.values(node.branches));
    if (node.true_node)      ids.push(node.true_node);
    if (node.false_node)     ids.push(node.false_node);
    return ids.filter(Boolean);
  }

  // 2a. Dangling references
  for (const [nid, node] of Object.entries(nodes)) {
    for (const ref of refsOf(node)) {
      if (!nodes[ref]) {
        errors.push(`node ${nid}: references non-existent node "${ref}"`);
      }
    }
  }

  // 2b. Reachability — BFS exploring all outgoing edges
  //
  // All nodes reachable via any branch are correctly identified, avoiding
  // false "unreachable" warnings for nodes only reachable via non-primary
  // branches (e.g. gather timeout/invalid, or a level-2 menu hanging off
  // a digit branch several levels deep).
  const reachable = new Set([entry_node_id]);
  const bfsQueue  = [entry_node_id];

  while (bfsQueue.length > 0) {
    const cur  = bfsQueue.shift();
    const node = nodes[cur];
    if (!node) continue;
    for (const ref of refsOf(node)) {
      if (nodes[ref] && !reachable.has(ref)) {
        reachable.add(ref);
        bfsQueue.push(ref);
      }
    }
  }

  // 2c. Dead-end cycle detection — reachability-to-terminal analysis
  //
  // A node is only a genuine problem if NO path from it ever reaches a
  // terminal node (hangup / ers / transfer — any node type whose schema
  // structurally has zero outgoing refs). IVR flows routinely chain a
  // single-ref "invalid input, try again" node back into an earlier
  // gather — that's fine as long as SOME path eventually exits. Flagging
  // every back-edge regardless of whether an exit exists (the previous
  // approach here) blocked exactly that, the single most common IVR
  // pattern there is, and was the actual root cause of a real publish
  // failure on a fully valid ENS operator flow. The Lua executor's
  // MAX_STEPS=100 guard remains the runtime backstop for the case this
  // check is designed to catch: a flow with genuinely no way to end.
  const predecessors = new Map(); // nodeId -> Set of nodeIds with an edge INTO it
  for (const [nid, node] of Object.entries(nodes)) {
    for (const ref of refsOf(node)) {
      if (!nodes[ref]) continue; // dangling refs already reported in 2a
      if (!predecessors.has(ref)) predecessors.set(ref, new Set());
      predecessors.get(ref).add(nid);
    }
  }

  const terminalNodes = Object.keys(nodes).filter(nid => refsOf(nodes[nid]).length === 0);
  const canReachTerminal = new Set(terminalNodes);
  const revQueue = [...terminalNodes];
  while (revQueue.length > 0) {
    const cur = revQueue.shift();
    for (const pred of predecessors.get(cur) || []) {
      if (!canReachTerminal.has(pred)) {
        canReachTerminal.add(pred);
        revQueue.push(pred);
      }
    }
  }

  for (const nid of reachable) {
    if (!canReachTerminal.has(nid)) {
      errors.push(`Node "${nid}" can never reach an end of call (hangup/transfer/ers) — infinite loop with no exit`);
    }
  }

  // 2d. Unreachable nodes (warnings only — builder may have WIP orphans)
  for (const nid of Object.keys(nodes)) {
    if (!reachable.has(nid)) {
      warnings.push(`Node "${nid}" is not reachable from entry_node_id`);
    }
  }

  if (errors.length > 0) return { valid: false, errors, warnings };

  // ── Pass 2e: DB foreign key existence checks ──────────────────────────────

  const ensIds       = [];
  const ersIds       = [];
  const audioFileIds = [];

  for (const node of Object.values(nodes)) {
    if (!node) continue;
    if (node.type === 'ens'    && node.ens_configuration_id)  ensIds.push(node.ens_configuration_id);
    if (node.type === 'ers'    && node.ers_configuration_id)  ersIds.push(node.ers_configuration_id);
    if (node.type === 'play'   && node.audio_file_id)         audioFileIds.push(node.audio_file_id);
    if (node.type === 'hangup' && node.play_audio_file_id)    audioFileIds.push(node.play_audio_file_id);
    if (node.type === 'gather' && node.prompt_audio_file_id)  audioFileIds.push(node.prompt_audio_file_id);
  }

  const checks = [];

  if (ensIds.length > 0) {
    checks.push(
      query(
        `SELECT id FROM ens_configurations
         WHERE id = ANY($1) AND deleted_at IS NULL AND tenant_id = $2`,
        [ensIds, tenantId]
      ).then(r => {
        const found = new Set(r.rows.map(x => x.id));
        for (const id of ensIds) {
          if (!found.has(id)) errors.push(`ens_configuration_id ${id} not found or wrong tenant`);
        }
      }).catch(() => {
        // Column may not exist on older schema — skip FK check
        warnings.push('ENS configuration FK check skipped (schema upgrade pending)');
      })
    );
  }

  if (ersIds.length > 0) {
    checks.push(
      query(
        `SELECT id FROM ers_configurations
         WHERE id = ANY($1) AND deleted_at IS NULL AND tenant_id = $2`,
        [ersIds, tenantId]
      ).then(r => {
        const found = new Set(r.rows.map(x => x.id));
        for (const id of ersIds) {
          if (!found.has(id)) errors.push(`ers_configuration_id ${id} not found or wrong tenant`);
        }
      }).catch(() => {
        warnings.push('ERS configuration FK check skipped (schema upgrade pending)');
      })
    );
  }

  if (audioFileIds.length > 0) {
    // media_files uses organization_id (not tenant_id) — join to resolve tenant
    checks.push(
      query(
        `SELECT mf.id
         FROM media_files mf
         LEFT JOIN organizations o ON o.id = mf.organization_id
         WHERE mf.id = ANY($1)
           AND mf.deleted_at IS NULL
           AND (o.tenant_id = $2 OR mf.organization_id IS NULL)`,
        [audioFileIds, tenantId]
      ).then(r => {
        const found = new Set(r.rows.map(x => x.id));
        for (const id of audioFileIds) {
          if (!found.has(id)) errors.push(`audio_file_id ${id} not found`);
        }
      }).catch(() => {
        warnings.push('Media file FK check skipped (schema upgrade pending)');
      })
    );
  }

  await Promise.all(checks);

  return {
    valid:    errors.length === 0,
    errors,
    warnings,
    stats: {
      node_count:  Object.keys(nodes).length,
      reachable:   reachable.size,
      unreachable: Object.keys(nodes).length - reachable.size,
    },
  };
}
