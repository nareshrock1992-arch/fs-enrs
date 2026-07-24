import { useState } from 'react';
import { RotateCcw, Loader2, CheckCircle2, XCircle } from 'lucide-react';

/**
 * RollbackModal — confirm and execute a version rollback.
 */
export default function RollbackModal({ version, rolling, result, error, onConfirm, onClose }) {
  const [reason, setReason] = useState('');

  const phase = result  ? 'success'
              : error   ? 'error'
              : rolling ? 'running'
              : 'confirm';

  if (!version && phase === 'confirm') return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-surface-panel border border-surface-border rounded-xl shadow-xl
                      w-full max-w-md">

        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <RotateCcw size={16} />
            <h2 className="font-semibold text-sm text-text-primary">Rollback Configuration</h2>
          </div>
          {phase !== 'running' && (
            <button onClick={onClose}
              className="text-text-muted hover:text-text-primary text-lg leading-none">
              ×
            </button>
          )}
        </div>

        <div className="px-5 py-4 space-y-4">
          {phase === 'confirm' && version && (
            <>
              <div className="rounded-lg bg-amber-50 dark:bg-amber-950 border border-amber-200
                             dark:border-amber-800 px-4 py-3">
                <p className="text-sm text-amber-700 dark:text-amber-300 font-medium">
                  Restore to Version {version.version_num}
                </p>
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                  Deployed {new Date(version.deployed_at).toLocaleString()}
                  {version.deployed_by_name ? ` by ${version.deployed_by_name}` : ''}
                </p>
                {version.reason && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 italic">
                    "{version.reason}"
                  </p>
                )}
              </div>

              <p className="text-xs text-text-muted">
                The current live configuration will be backed up before the restore.
                The platform will reload immediately after the rollback.
              </p>

              <div>
                <label className="text-xs font-medium text-text-muted block mb-1">
                  Reason (optional)
                </label>
                <input
                  type="text"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="e.g. Reverting bad configuration change"
                  className="w-full rounded-lg border border-surface-border bg-surface-bg
                             px-3 py-2 text-sm text-text-primary placeholder-text-muted
                             focus:outline-none focus:ring-2 focus:ring-brand/50"
                />
              </div>
            </>
          )}

          {phase === 'running' && (
            <div className="flex flex-col items-center py-6 gap-3">
              <Loader2 size={28} className="text-amber-500 animate-spin" />
              <p className="text-sm text-text-muted">Rolling back…</p>
            </div>
          )}

          {phase === 'success' && (
            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 py-2">
              <CheckCircle2 size={18} />
              <span className="text-sm font-medium">
                Rollback successful · Version {result?.versionId}
              </span>
            </div>
          )}

          {phase === 'error' && (
            <div className="rounded-lg bg-red-50 dark:bg-red-950 border border-red-200
                           dark:border-red-800 px-4 py-3">
              <div className="flex items-start gap-2">
                <XCircle size={16} className="text-red-500 shrink-0 mt-0.5" />
                <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-surface-border flex justify-end gap-2">
          {phase === 'confirm' && (
            <>
              <button onClick={onClose} className="btn-ghost text-sm px-4 py-2 rounded-lg">
                Cancel
              </button>
              <button
                onClick={() => onConfirm(version.id, reason)}
                className="bg-amber-500 text-white text-sm font-semibold px-4 py-2 rounded-lg
                           hover:bg-amber-600 transition-colors">
                Confirm Rollback
              </button>
            </>
          )}
          {(phase === 'success' || phase === 'error') && (
            <button onClick={onClose}
              className="bg-brand text-white text-sm font-semibold px-4 py-2 rounded-lg
                         hover:bg-brand/90 transition-colors">
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
