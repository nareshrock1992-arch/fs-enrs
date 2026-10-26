// ── Signed media URLs for <audio src> and downloads ──────────────────────────
// The backend issues a short-lived signature for ONE file + purpose
// (GET /<resource>/:id/access). The session token never goes into a URL.
// BASE already includes the sub-path prefix (/enrs/api/v1 in prod, /api/v1 in dev).
import { useCallback, useEffect, useState } from 'react';
import { api, BASE } from './client.js';

const RESOURCES = {
  media:     { path: 'media-library', client: () => api.mediaLibrary },
  recording: { path: 'recordings',    client: () => api.recordings },
};

/** Pure URL builder — exported for tests. */
export function signedMediaUrl(kind, id, purpose, sig) {
  const r = RESOURCES[kind];
  if (!r) throw new Error(`unknown media kind: ${kind}`);
  return `${BASE}/${r.path}/${encodeURIComponent(id)}/${purpose}?sig=${encodeURIComponent(sig)}`;
}

/** Ask the backend for a signature and return the ready-to-use URL. */
export async function fetchMediaUrl(kind, id, purpose = 'stream') {
  const { sig } = await RESOURCES[kind].client().access(id, purpose);
  return signedMediaUrl(kind, id, purpose, sig);
}

/**
 * React hook: signed URL for kind/id/purpose, or null while loading / when id is falsy.
 * `refresh()` fetches a fresh signature (e.g. after the link expired) and returns it.
 */
export function useMediaUrl(kind, id, purpose = 'stream') {
  const [state, setState] = useState({ key: null, url: null, error: null });
  const key = id ? `${kind}:${id}:${purpose}` : null;

  const refresh = useCallback(async () => {
    if (!id) return null;
    try {
      const url = await fetchMediaUrl(kind, id, purpose);
      setState({ key, url, error: null });
      return url;
    } catch (err) {
      setState({ key, url: null, error: err });
      return null;
    }
  }, [kind, id, purpose, key]);

  useEffect(() => {
    let cancelled = false;
    if (!id) return undefined;
    fetchMediaUrl(kind, id, purpose)
      .then(url => { if (!cancelled) setState({ key, url, error: null }); })
      .catch(error => { if (!cancelled) setState({ key, url: null, error }); });
    return () => { cancelled = true; };
  }, [kind, id, purpose, key]);

  // Never hand back a URL that belongs to a previous file.
  const current = state.key === key;
  return { url: current ? state.url : null, error: current ? state.error : null, refresh };
}

/** Start a browser download of one file via a freshly signed link. */
export async function downloadMedia(kind, id, filename) {
  const url = await fetchMediaUrl(kind, id, 'download');
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
