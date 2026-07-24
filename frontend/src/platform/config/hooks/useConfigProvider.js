import { useState, useCallback, useRef } from 'react';
import { api } from '../../../api/client.js';

/**
 * useConfigProvider — manages the read state for one configuration provider.
 *
 * Returns the parsed entries, catalog, loading/error state, and a reload
 * function. Does NOT manage pending changes — that belongs to the page
 * component so it can track dirty state independently of the server state.
 *
 * @param {string} providerId — e.g. 'vars'
 */
export function useConfigProvider(providerId) {
  const [entries,  setEntries]  = useState([]);
  const [catalog,  setCatalog]  = useState({});
  const [checksum, setChecksum] = useState(null);
  const [filePath, setFilePath] = useState('');
  const [parsedAt, setParsedAt] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);

  // Stable ref so callers can read the latest value without stale closures.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const load = useCallback(async () => {
    if (!providerId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.platformConfig.read(providerId);
      setEntries(data.entries  ?? []);
      setCatalog(data.catalog  ?? {});
      setChecksum(data.checksum ?? null);
      setFilePath(data.filePath ?? '');
      setParsedAt(data.parsedAt ?? null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  return {
    entries,
    catalog,
    checksum,
    filePath,
    parsedAt,
    loading,
    error,
    load,
    entriesRef,
  };
}
