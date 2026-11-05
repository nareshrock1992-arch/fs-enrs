import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

// Shared lists of ERS/ENS configurations for the IVR builder's config-picker
// fields — so a user never has to open PostgreSQL to look up an internal ID.
//
// Freshness: every mount refetches (stale-while-revalidate). The last list is
// shown immediately, then replaced by the server's answer, so a configuration
// created while the builder was already loaded appears without a page reload.
// Concurrent mounts (e.g. the canvas and the property panel) share one request.
//
// Completeness: the list endpoints cap a page at PAGE_SIZE rows, so all pages
// are fetched until `total` is reached — no configuration is silently dropped.
export const PAGE_SIZE = 200;
const MAX_PAGES = 50; // safety bound: 10,000 configurations

const cache = { ers: null, ens: null };
const inflight = { ers: null, ens: null };

const toOption = c => ({ id: c.id, name: c.name, description: c.description || '' });

/** Fetch every page of a config list. `list` is api.ers.list / api.ens.list. */
export async function fetchAllConfigs(list) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await list({ limit: PAGE_SIZE, page });
    const rows = r?.configurations || [];
    all.push(...rows);
    const total = Number(r?.total);
    if (rows.length === 0 || rows.length < PAGE_SIZE || (Number.isFinite(total) && all.length >= total)) break;
  }
  return all.map(toOption);
}

export function loadOptions(kind) {
  if (!inflight[kind]) {
    const list = kind === 'ers' ? api.ers.list : api.ens.list;
    inflight[kind] = fetchAllConfigs(list)
      .then(opts => { cache[kind] = opts; return opts; })
      .finally(() => { inflight[kind] = null; });
  }
  return inflight[kind];
}

/** kind: 'ers' | 'ens' */
export function useConfigOptions(kind) {
  const [options, setOptions] = useState(cache[kind] || []);
  const [loading, setLoading] = useState(!cache[kind]);

  useEffect(() => {
    let cancelled = false;
    if (cache[kind]) { setOptions(cache[kind]); setLoading(false); }
    loadOptions(kind)
      .then(opts => { if (!cancelled) setOptions(opts); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [kind]);

  return { options, loading };
}
