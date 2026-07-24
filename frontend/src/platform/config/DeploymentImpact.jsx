import { AlertTriangle, Clock, RefreshCw, Layers } from 'lucide-react';
import StatusBadge from './StatusBadge.jsx';

/**
 * DeploymentImpact — renders structured provider deployment metadata.
 *
 * Props:
 *  meta — provider.deploymentMeta object from the preview response
 *         { action, actionLabel, description, affectedServices,
 *           restartRequired, estimatedDowntime, riskLevel, requiresConfirmation }
 */
export default function DeploymentImpact({ meta }) {
  if (!meta) return null;

  return (
    <div className="rounded-lg border border-surface-border bg-surface-bg p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-text-primary">{meta.actionLabel}</p>
          <p className="text-xs text-text-muted mt-0.5 leading-relaxed">{meta.description}</p>
        </div>
        <StatusBadge status={meta.riskLevel} label={`${meta.riskLevel} risk`} />
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex items-center gap-1.5 text-text-muted">
          <RefreshCw size={11} className="shrink-0" />
          <span className="font-medium">Restart required:</span>
          <span className={meta.restartRequired ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}>
            {meta.restartRequired ? 'Yes' : 'No'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-text-muted">
          <Clock size={11} className="shrink-0" />
          <span className="font-medium">Downtime:</span>
          <span>{meta.estimatedDowntime}</span>
        </div>
      </div>

      {meta.affectedServices?.length > 0 && (
        <div className="flex items-start gap-1.5 text-xs text-text-muted">
          <Layers size={11} className="shrink-0 mt-0.5" />
          <div>
            <span className="font-medium">Affects: </span>
            {meta.affectedServices.join(', ')}
          </div>
        </div>
      )}

      {meta.requiresConfirmation && (
        <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300
                        bg-amber-50 dark:bg-amber-950 rounded-lg px-2.5 py-1.5">
          <AlertTriangle size={11} className="shrink-0" />
          This deployment requires explicit confirmation.
        </div>
      )}
    </div>
  );
}
