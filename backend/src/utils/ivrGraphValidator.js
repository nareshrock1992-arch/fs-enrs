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
  //
  // Per-node validation runs FIRST so each error is scoped to its node ID in
  // the format "node <nid>.<field>: message". If we let GraphSchema run first
  // it would also fail for the same per-node errors but report them as
  // "nodes.<nid>: message" (the Zod record path), which the frontend regex
  // cannot parse into a node ID. Full GraphSchema then handles structural
  // checks (entry_node_id existence) that per-node scans cannot detect.

  for (const [nid, node] of Object.entries(g.nodes || {})) {
    if (!node || typeof node !== 'object') continue; // already caught in pre-flight
    const r = AnyNodeSchema.safeParse(node);
    if (!r.success) {
      for (const issue of r.error.issues) {
        errors.push(`node ${nid}.${issue.path.join('.') || 'type'}: ${issue.message}`);
      }
    }
  }
  if (errors.length > 0) return { valid: false, errors, warnings };

  const parsed = GraphSchema.safeParse(g);
  if (!parsed.success) {
    return {
      valid:  false,
      errors: parsed.error.issues.map(i => `${i.path.join('.') || 'graph'}: ${i.message}`),
      warnings,
    };
  }

  const { entry_node_id, nodes } = parsed.data;

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
      errors.push(`node ${nid}: can never reach an end of call (hangup/transfer/ers) — infinite loop with no exit branch`);
    }
  }

  // 2d. Unreachable nodes (warnings only — builder may have WIP orphans)
  for (const nid of Object.keys(nodes)) {
    if (!reachable.has(nid)) {
      warnings.push(`Node "${nid}" is not reachable from entry_node_id`);
    }
  }

  // 2e. Designer lint — per-node warnings shown as yellow badges in the canvas
  for (const [nid, node] of Object.entries(nodes)) {
    if (!node) continue;

    // ERS Ring-All: missing configuration or tier
    if (node.type === 'ers_ring_all') {
      if (!node.ers_configuration_id) {
        warnings.push(`Node "${nid}" (ERS Ring-All): ERS Configuration is required`);
      }
      if (!node.tier) {
        warnings.push(`Node "${nid}" (ERS Ring-All): Responder Tier is required`);
      }
    }

    // ERS Overflow Check: must have all three branch targets
    if (node.type === 'ers_overflow_check') {
      if (!node.ers_configuration_id) {
        warnings.push(`Node "${nid}" (ERS Overflow Check): ERS Configuration is required`);
      }
      const br = node.branches || {};
      if (!br.primary)   warnings.push(`Node "${nid}" (ERS Overflow Check): "primary" branch not connected`);
      if (!br.secondary) warnings.push(`Node "${nid}" (ERS Overflow Check): "secondary" branch not connected`);
      if (!br.full)      warnings.push(`Node "${nid}" (ERS Overflow Check): "full" branch not connected`);
    }

    // ERS Overflow Wait: missing configuration
    if (node.type === 'ers_overflow_wait') {
      if (!node.ers_configuration_id) {
        warnings.push(`Node "${nid}" (ERS Overflow Wait): ERS Configuration is required`);
      }
    }

    // Record Message: warn if next node is missing (recording completes with nowhere to go)
    if (node.type === 'record_message' && !node.next) {
      warnings.push(`Node "${nid}" (Record): Next Node not connected — caller will be disconnected after recording`);
    }

    // ENS Blast Record: missing next node
    if (node.type === 'ens_blast_record' && !node.next) {
      warnings.push(`Node "${nid}" (ENS Blast Record): Next Node not connected`);
    }

    // ENS Playback: warn if no branches wired
    if (node.type === 'ens_playback') {
      const br = node.branches || {};
      for (const key of ['active', 'unauthorized', 'no_campaign', 'expired']) {
        if (!br[key]) {
          warnings.push(`Node "${nid}" (ENS Playback): branch "${key}" is not connected`);
        }
      }
    }

  }

  // Mixed ERS node types — legacy ers + ers_ring_all in same flow is confusing.
  // Flag once per offending node (not per iteration above to avoid O(n²) scan).
  {
    const legacyErsNodes   = Object.keys(nodes).filter(nid => nodes[nid]?.type === 'ers');
    const ringAllErsNodes  = Object.keys(nodes).filter(nid => nodes[nid]?.type === 'ers_ring_all');
    if (legacyErsNodes.length > 0 && ringAllErsNodes.length > 0) {
      for (const nid of [...legacyErsNodes, ...ringAllErsNodes]) {
        warnings.push(`Node "${nid}": Flow mixes legacy "Trigger ERS" and "ERS Ring-All" nodes — pick one pattern per flow`);
      }
    }
  }

  if (errors.length > 0) return { valid: false, errors, warnings };

  // ── Pass 2e: DB foreign key existence checks ──────────────────────────────

  // Track configId → nodeId so FK errors can reference the node that owns the bad ID.
  const ensIdToNode   = new Map(); // configId → nid
  const ersIdToNode   = new Map();
  const audioIdToNode = new Map();

  // Any node type carrying an ens_configuration_id / ers_configuration_id
  // gets FK-checked — collected by FIELD, not by a hardcoded type list, so
  // node types like ers_ring_all, ers_overflow_check, ens_blast_record and any
  // future registry type that references a configuration are covered automatically.
  for (const [nid, node] of Object.entries(nodes)) {
    if (!node) continue;
    if (typeof node.ens_configuration_id === 'number') ensIdToNode.set(node.ens_configuration_id, nid);
    if (typeof node.ers_configuration_id === 'number') ersIdToNode.set(node.ers_configuration_id, nid);
    if (node.type === 'play'   && node.audio_file_id)        audioIdToNode.set(node.audio_file_id, nid);
    if (node.type === 'hangup' && node.play_audio_file_id)   audioIdToNode.set(node.play_audio_file_id, nid);
    if (node.type === 'gather' && node.prompt_audio_file_id) audioIdToNode.set(node.prompt_audio_file_id, nid);
  }

  const ensIds       = [...ensIdToNode.keys()];
  const ersIds       = [...ersIdToNode.keys()];
  const audioFileIds = [...audioIdToNode.keys()];

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
          if (!found.has(id)) {
            const nid = ensIdToNode.get(id);
            errors.push(`node ${nid}: ens_configuration_id ${id} not found or wrong tenant`);
          }
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
          if (!found.has(id)) {
            const nid = ersIdToNode.get(id);
            errors.push(`node ${nid}: ers_configuration_id ${id} not found or wrong tenant`);
          }
        }
      }).catch(() => {
        warnings.push('ERS configuration FK check skipped (schema upgrade pending)');
      })
    );
  }

  if (audioFileIds.length > 0) {
    // media_files.tenant_id (added in migration 007) is the authoritative ownership
    // column.  Files with tenant_id IS NULL are shared/system audio accessible to
    // all tenants.  Files with a non-matching tenant_id fail the check.
    checks.push(
      query(
        `SELECT id FROM media_files
         WHERE id = ANY($1)
           AND deleted_at IS NULL
           AND (tenant_id = $2 OR tenant_id IS NULL)`,
        [audioFileIds, tenantId]
      ).then(r => {
        const found = new Set(r.rows.map(x => x.id));
        for (const id of audioFileIds) {
          if (!found.has(id)) {
            const nid = audioIdToNode.get(id);
            errors.push(`node ${nid}: audio_file_id ${id} not found or belongs to a different tenant`);
          }
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
