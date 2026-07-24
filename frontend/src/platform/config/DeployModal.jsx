import { useState } from 'react';
import { CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import ConfigDiff from './ConfigDiff.jsx';

/**
 * DeployModal — step-by-step deploy progress dialog.
 *
 * Phases:
 *  1. 'confirm'  — show diff + reason input, waiting for user approval
 *  2. 'running'  — deploy in progress, shows live step statuses
 *  3. 'success'  — deploy completed
 *  4. 'error'    — deploy failed
 */
export default function DeployModal({ preview, deploying, result, error, onConfirm, onClose }) {
  const [reason, setReason] = useState('');
  const [showSteps, setShowSteps] = useState(false);

  const phase = result   ? 'success'
              : error    ? 'error'
              : deploying ? 'running'
              : 'confirm';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-surface-panel border border-surface-border rounded-xl shadow-xl
                      w-full max-w-lg">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border">
          <h2 className="font-semibold text-text-primary text-sm">
            {phase === 'success' ? 'Deployment Complete' :
             phase === 'error'   ? 'Deployment Failed' :
             phase === 'running' ? 'Deploying…' :
             'Review & Deploy'}
          </h2>
          {phase !== 'running' && (
            <button onClick={onClose}
              className="text-text-muted hover:text-text-primary transition-colors text-lg leading-none">
              ×
            </button>
          )}
        </div>

        <div className="px-5 py-4 space-y-4">

          {/* Confirm phase */}
          {phase === 'confirm' && (
            <>
              <div>
                <p className="text-xs font-medium text-text-muted mb-2 uppercase tracking-wide">
                  Changes ({preview?.changesApplied ?? 0})
                </p>
                <ConfigDiff diff={preview?.diffSummary} />
              </div>

              {preview?.validation?.warnings?.length > 0 && (
                <div className="rounded-lg bg-amber-50 dark:bg-amber-950 border border-amber-200
                               dark:border-amber-800 px-3 py-2">
                  {preview.validation.warnings.map((w, i) => (
                    <p key={i} className="text-xs text-amber-700 dark:text-amber-300">⚠ {w}</p>
                  ))}
                </div>
              )}

              <div>
                <label className="text-xs font-medium text-text-muted block mb-1">
                  Reason (optional)
                </label>
                <input
                  type="text"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="e.g. Updated domain name for new installation"
                  className="w-full rounded-lg border border-surface-border bg-surface-bg
                             px-3 py-2 text-sm text-text-primary placeholder-text-muted
                             focus:outline-none focus:ring-2 focus:ring-brand/50"
                />
              </div>

              <p className="text-xs text-text-muted">
                The current file will be backed up before any changes are written.
                Reload will apply immediately.
              </p>
            </>
          )}

          {/* Running phase */}
          {phase === 'running' && (
            <div className="flex flex-col items-center py-6 gap-3">
              <Loader2 size={32} className="text-brand animate-spin" />
              <p className="text-sm text-text-muted">Deploying configuration…</p>
            </div>
          )}

          {/* Success phase */}
          {phase === 'success' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 size={20} />
                <span className="text-sm font-medium">
                  Deployed in {result.durationMs}ms · Version {result.versionId}
                </span>
              </div>

              {result.verification?.checks?.length > 0 && (
                <div className="text-xs space-y-1">
                  {result.verification.checks.map((c, i) => (
                    <div key={i} className={`flex items-center gap-2
                      ${c.passed ? 'text-emerald-600 dark:text-emerald-400'
                                 : 'text-red-600 dark:text-red-400'}`}>
                      {c.passed ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                      <span className="font-mono">{c.key}</span>
                      <span className="text-text-muted">= {c.actual}</span>
                    </div>
                  ))}
                </div>
              )}

              <button
                onClick={() => setShowSteps(s => !s)}
                className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary">
                {showSteps ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {showSteps ? 'Hide' : 'Show'} deploy steps
              </button>

              {showSteps && result.steps && (
                <div className="space-y-1">
                  {result.steps.map((s, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      {s.status === 'ok'
                        ? <CheckCircle2 size={12} className="text-emerald-500" />
                        : <XCircle size={12} className="text-red-500" />}
                      <span className="text-text-muted">{s.name}</span>
                      {s.durationMs && (
                        <span className="ml-auto text-text-muted">{s.durationMs}ms</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Error phase */}
          {phase === 'error' && (
            <div className="rounded-lg bg-red-50 dark:bg-red-950 border border-red-200
                           dark:border-red-800 px-4 py-3">
              <div className="flex items-start gap-2">
                <XCircle size={16} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-surface-border flex justify-end gap-2">
          {phase === 'confirm' && (
            <>
              <button onClick={onClose} className="btn-ghost text-sm px-4 py-2 rounded-lg">
                Cancel
              </button>
              <button
                onClick={() => onConfirm(reason)}
                className="bg-brand text-white text-sm font-semibold px-4 py-2 rounded-lg
                           hover:bg-brand/90 transition-colors">
                Deploy Now
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
