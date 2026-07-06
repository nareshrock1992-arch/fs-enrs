import { useEffect, useState } from 'react';
import { X, RotateCcw, Clock } from 'lucide-react';
import { api } from '../../../api/client.js';

function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

export default function VersionDrawer({ flowUuid, currentVersion, onClose, onRestore }) {
  const [versions, setVersions] = useState([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    if (!flowUuid) return;
    api.ivr.versions(flowUuid)
      .then(r => setVersions(r.versions || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [flowUuid]);

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed top-0 right-0 h-full w-80 z-50 flex flex-col
                      bg-surface-panel border-l border-surface-border shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border shrink-0">
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-brand" />
            <h2 className="text-sm font-semibold text-text-primary">Version History</h2>
          </div>
          <button onClick={onClose} className="btn-ghost p-1"><X size={16} /></button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading && (
            <p className="text-xs text-text-muted text-center py-8">Loading…</p>
          )}
          {!loading && versions.length === 0 && (
            <div className="text-center py-8">
              <p className="text-xs text-text-muted">No published versions yet</p>
              <p className="text-[10px] text-text-muted mt-1">Click Publish to create the first version</p>
            </div>
          )}
          {versions.map(v => {
            const isCurrent = v.version_number === currentVersion;
            return (
              <div key={v.version_uuid}
                   className={`rounded-xl border p-3 transition-colors
                     ${isCurrent
                       ? 'bg-brand/10 border-brand/30'
                       : 'bg-surface border-surface-border hover:bg-surface-hover'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full
                    ${isCurrent ? 'bg-brand text-white' : 'bg-surface-hover text-text-muted'}`}>
                    v{v.version_number}
                  </span>
                  {isCurrent && (
                    <span className="text-[9px] text-brand font-medium">LIVE</span>
                  )}
                  <span className="text-[10px] text-text-muted ml-auto">{fmt(v.published_at)}</span>
                </div>
                <p className="text-[10px] text-text-muted truncate">
                  by {v.published_by_email || 'unknown'}
                </p>
                {v.change_notes && (
                  <p className="text-[10px] text-text-primary mt-1 line-clamp-2">
                    {v.change_notes}
                  </p>
                )}
                {!isCurrent && (
                  <button
                    onClick={() => onRestore?.(v)}
                    className="mt-2 w-full flex items-center justify-center gap-1 text-[10px]
                               py-1 rounded-lg border border-surface-border text-text-muted
                               hover:bg-surface-hover hover:text-text-primary transition-colors"
                  >
                    <RotateCcw size={10} /> View / Restore
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-surface-border">
          <p className="text-[10px] text-text-muted">
            Versions are immutable snapshots. FreeSWITCH always uses the latest published version.
          </p>
        </div>
      </div>
    </>
  );
}
