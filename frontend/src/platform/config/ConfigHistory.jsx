import { useEffect, useState, useCallback } from 'react';
import { History, RotateCcw, AlertCircle } from 'lucide-react';
import { api } from '../../api/client.js';
import RollbackModal from './RollbackModal.jsx';
import { useDeployment } from './hooks/useDeployment.js';

/**
 * ConfigHistory — version history slide-over panel.
 */
export default function ConfigHistory({ providerId, onRollbackSuccess }) {
  const [versions,   setVersions]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [loadError,  setLoadError]  = useState(null);
  const [selected,   setSelected]   = useState(null);

  const { rolling, result, error, rollback, clearResult } = useDeployment(providerId);

  const load = useCallback(async () => {
    if (!providerId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.platformConfig.history(providerId);
      setVersions(data.versions ?? []);
    } catch (err) {
      setLoadError(err?.message ?? 'Failed to load version history.');
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => { load(); }, [load]);

  const handleRollback = async (versionId, reason) => {
    const res = await rollback(versionId, reason);
    if (res?.success) {
      await load();
      onRollbackSuccess?.();
    }
  };

  const handleClose = () => {
    setSelected(null);
    clearResult();
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-text-muted py-4 px-2">
        <History size={14} />
        Loading history…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 py-4 px-2">
        <AlertCircle size={14} className="shrink-0 mt-0.5" />
        {loadError}
      </div>
    );
  }

  if (versions.length === 0) {
    return (
      <p className="text-xs text-text-muted py-4 px-2 italic">
        No versions yet — deploy a change to create the first snapshot.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {versions.map(v => (
        <div key={v.id}
          className={`rounded-lg border px-3 py-2.5 text-xs
            ${v.is_active
              ? 'border-brand/50 bg-brand/5'
              : 'border-surface-border bg-surface-panel'}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-0.5 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-text-primary">v{v.version_num}</span>
                {v.is_active && (
                  <span className="bg-brand text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                    LIVE
                  </span>
                )}
              </div>
              <div className="text-text-muted">
                {new Date(v.deployed_at).toLocaleString()}
                {v.deployed_by_name && ` · ${v.deployed_by_name}`}
              </div>
              {v.reason && (
                <div className="text-text-muted italic truncate">{v.reason}</div>
              )}
              {v.changed_keys?.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {v.changed_keys.slice(0, 5).map(k => (
                    <span key={k} className="bg-surface-bg border border-surface-border
                                            rounded px-1 py-0.5 font-mono text-[10px] text-text-muted">
                      {k}
                    </span>
                  ))}
                  {v.changed_keys.length > 5 && (
                    <span className="text-text-muted">+{v.changed_keys.length - 5} more</span>
                  )}
                </div>
              )}
            </div>
            {!v.is_active && (
              <button
                onClick={() => setSelected(v)}
                title="Roll back to this version"
                className="flex items-center gap-1 text-amber-600 dark:text-amber-400
                           hover:text-amber-700 dark:hover:text-amber-300 shrink-0
                           text-[10px] font-semibold transition-colors">
                <RotateCcw size={11} />
                Rollback
              </button>
            )}
          </div>
        </div>
      ))}

      {selected && (
        <RollbackModal
          version={selected}
          rolling={rolling}
          result={result}
          error={error}
          onConfirm={handleRollback}
          onClose={handleClose}
        />
      )}
    </div>
  );
}
