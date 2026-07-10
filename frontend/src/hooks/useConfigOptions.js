import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

// Shared, cached lists of ERS/ENS configurations for the IVR builder's
// config-picker fields — so a user never has to open PostgreSQL to look
// up an internal ID again. Cache is per page load; invalidated on reload,
// which matches how often configs change while building a flow.
const cache = { ers: null, ens: null };
const inflight = { ers: null, ens: null };

async function loadOptions(kind) {
  if (cache[kind]) return cache[kind];
  if (!inflight[kind]) {
    const fetcher = kind === 'ers'
      ? () => api.ers.list({ limit: 1000 })
      : () => api.ens.list({ limit: 1000 });
    inflight[kind] = fetcher()
      .then(r => {
        cache[kind] = (r.configurations || []).map(c => ({
          id:          c.id,
          name:        c.name,
          description: c.description || '',
        }));
        return cache[kind];
      })
      .catch(err => { inflight[kind] = null; throw err; });
  }
  return inflight[kind];
}

/** kind: 'ers' | 'ens' */
export function useConfigOptions(kind) {
  const [options, setOptions] = useState(cache[kind] || []);
  const [loading, setLoading] = useState(!cache[kind]);

  useEffect(() => {
    if (cache[kind]) { setOptions(cache[kind]); setLoading(false); return; }
    let cancelled = false;
    loadOptions(kind)
      .then(opts => { if (!cancelled) setOptions(opts); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [kind]);

  return { options, loading };
}
