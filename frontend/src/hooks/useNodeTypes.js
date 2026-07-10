import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

// Module-level cache — the registry is static per deploy (it only changes
// when the backend restarts with a new registry.js), so every component
// that needs node-type metadata shares one fetch instead of one per mount.
let cache = null;
let inflight = null;

async function loadNodeTypes() {
  if (cache) return cache;
  if (!inflight) {
    inflight = api.ivr.nodeTypes()
      .then(r => { cache = r.node_types || []; return cache; })
      .catch(err => { inflight = null; throw err; });
  }
  return inflight;
}

/**
 * Single source of truth for IVR node-type metadata on the frontend —
 * backend/src/nodeTypes/registry.js is authoritative; this hook just
 * fetches and caches GET /api/v1/ivr/node-types. NodePalette, FlowNode,
 * and PropertyPanel all read from this instead of hardcoding per-type
 * data, so adding a node type to the registry is enough for it to appear
 * everywhere with zero frontend code changes.
 */
export function useNodeTypes() {
  const [nodeTypes, setNodeTypes] = useState(cache || []);
  const [loading, setLoading] = useState(!cache);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (cache) return;
    let cancelled = false;
    loadNodeTypes()
      .then(types => { if (!cancelled) setNodeTypes(types); })
      .catch(err => { if (!cancelled) setError(err); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const byType = Object.fromEntries(nodeTypes.map(n => [n.type, n]));

  return { nodeTypes, byType, loading, error };
}
