import { GraphSchema, AnyNodeSchema } from '../validators/ivrValidator.js';
import { query } from '../db/pool.js';

/**
 * Two-pass IVR graph validator.
 *
 * Pass 1 — Zod schema: every node matches its type's schema; entry_node_id exists.
 * Pass 2 — Graph integrity: cycle detection (DFS), dangling refs, DB ID existence.
 *
 * Returns { valid: true } or { valid: false, errors: string[], warnings: string[] }.
 */
export async function validateGraph(graph, tenantId) {
  const errors   = [];
  const warnings = [];

  // ── Pass 1: Zod schema ────────────────────────────────────────────────────

  const parsed = GraphSchema.safeParse(graph);
  if (!parsed.success) {
    return {
      valid:  false,
      errors: parsed.error.issues.map(i => `${i.path.join('.') || 'graph'}: ${i.message}`),
      warnings,
    };
  }

  const { entry_node_id, nodes } = parsed.data;

  // Per-node Zod validation (discriminated union already ran inside GraphSchema,
  // but we re-run individually to surface per-node error paths clearly)
  for (const [nid, node] of Object.entries(nodes)) {
    const r = AnyNodeSchema.safeParse(node);
    if (!r.success) {
      for (const issue of r.error.issues) {
        errors.push(`node ${nid}.${issue.path.join('.') || 'type'}: ${issue.message}`);
      }
    }
  }
  if (errors.length > 0) return { valid: false, errors, warnings };

  // ── Pass 2: Graph integrity ───────────────────────────────────────────────

  // Collect all node IDs referenced by edges (all node types)
  function refsOf(node) {
    const ids = [];
    if (node.next)           ids.push(node.next);
    if (node.target_node_id) ids.push(node.target_node_id);
    if (node.branches)       ids.push(...Object.values(node.branches));
    // condition node
    if (node.true_node)      ids.push(node.true_node);
    if (node.false_node)     ids.push(node.false_node);
    return ids.filter(Boolean);
  }

  // 2a. Dangling references (next/branch points to non-existent node)
  for (const [nid, node] of Object.entries(nodes)) {
    for (const ref of refsOf(node)) {
      if (!nodes[ref]) {
        errors.push(`node ${nid}: references non-existent node "${ref}"`);
      }
    }
  }

  // 2b. Cycle detection — iterative DFS from entry_node_id
  const visited  = new Set();
  const inStack  = new Set();
  const stack    = [[entry_node_id, null]]; // [nodeId, parentId]
  const reachable = new Set();

  while (stack.length > 0) {
    const [cur, parent] = stack[stack.length - 1];

    if (!visited.has(cur)) {
      visited.add(cur);
      inStack.add(cur);
      reachable.add(cur);

      const node = nodes[cur];
      if (node) {
        const children = refsOf(node).filter(r => nodes[r]);
        let pushed = false;
        for (const child of children) {
          if (inStack.has(child)) {
            errors.push(`Cycle detected: ${cur} → ${child}`);
          } else if (!visited.has(child)) {
            stack.push([child, cur]);
            pushed = true;
            break; // process one child at a time (DFS)
          }
        }
        if (!pushed) {
          stack.pop();
          inStack.delete(cur);
        }
      } else {
        stack.pop();
        inStack.delete(cur);
      }
    } else {
      stack.pop();
      inStack.delete(cur);
    }
  }

  // 2c. Unreachable nodes (warnings, not errors — builder may have WIP orphans)
  for (const nid of Object.keys(nodes)) {
    if (!reachable.has(nid)) {
      warnings.push(`Unreachable node: "${nid}" (not reachable from entry_node_id)`);
    }
  }

  if (errors.length > 0) return { valid: false, errors, warnings };

  // ── Pass 2d: DB foreign key existence checks ──────────────────────────────
  // Collect all ENS/ERS/audio_file IDs referenced in the graph

  const ensIds       = [];
  const ersIds       = [];
  const audioFileIds = [];

  for (const node of Object.values(nodes)) {
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
      })
    );
  }

  if (audioFileIds.length > 0) {
    checks.push(
      query(
        `SELECT id FROM media_files
         WHERE id = ANY($1) AND deleted_at IS NULL AND tenant_id = $2`,
        [audioFileIds, tenantId]
      ).then(r => {
        const found = new Set(r.rows.map(x => x.id));
        for (const id of audioFileIds) {
          if (!found.has(id)) errors.push(`audio_file_id ${id} not found or wrong tenant`);
        }
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
