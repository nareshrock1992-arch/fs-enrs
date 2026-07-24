import { ExternalLink, RefreshCw, AlertTriangle, Info } from 'lucide-react';

/**
 * DetailsPanel — documentation panel for a selected configuration entry.
 *
 * Renders purpose, notes, defaultValue, recommendedValue, deployment impact,
 * cross-references (aliases, relatedVariables, usedBy), and documentationRef.
 *
 * Shows a placeholder when entry is null (nothing selected).
 *
 * Props:
 *   entry — ConfigurationObject from the API, or null
 */
export default function DetailsPanel({ entry }) {
  if (!entry) {
    return (
      <div className="rounded-xl border border-surface-border bg-surface-panel p-6
                      flex items-center justify-center min-h-[120px]">
        <p className="text-xs text-text-muted italic text-center">
          Select a variable to view documentation
        </p>
      </div>
    );
  }

  const meta = entry.metadata ?? entry;
  const hasDefaults = meta.defaultValue != null || meta.recommendedValue != null;
  const hasImpact   = meta.restartRequired || (meta.riskLevel && meta.riskLevel !== 'low')
                      || meta.estimatedDowntime || meta.affectedServices?.length;
  const hasRefs     = meta.aliases?.length || meta.relatedVariables?.length || meta.usedBy?.length;

  return (
    <div className="rounded-xl border border-surface-border bg-surface-panel overflow-hidden
                    divide-y divide-surface-border text-xs sticky top-4">

      {/* Key + category header */}
      <div className="px-4 py-3">
        <p className="font-mono font-semibold text-sm text-text-primary break-all">{entry.key}</p>
        {meta.label && meta.label !== entry.key && (
          <p className="text-text-secondary mt-0.5">{meta.label}</p>
        )}
        <p className="text-text-muted mt-0.5">
          {meta.category ?? 'Unknown'}
          {meta.group ? ` › ${meta.group}` : ''}
        </p>
        <div className="flex gap-1.5 flex-wrap mt-1.5">
          <span className="px-1.5 py-0.5 rounded-full bg-surface-border text-text-muted font-mono uppercase text-[10px]">
            {meta.type ?? 'string'}
          </span>
          <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${
            meta.visibility === 'expert'   ? 'bg-purple-100 dark:bg-purple-950 text-purple-600 dark:text-purple-400' :
            meta.visibility === 'advanced' ? 'bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400' :
                                             'bg-surface-border text-text-muted'
          }`}>
            {meta.visibility ?? 'basic'}
          </span>
        </div>
      </div>

      {/* Description + purpose */}
      {(meta.description || meta.purpose) && (
        <div className="px-4 py-3 space-y-1.5">
          {meta.description && (
            <p className="text-text-secondary leading-relaxed">{meta.description}</p>
          )}
          {meta.purpose && (
            <p className="text-text-muted leading-relaxed">{meta.purpose}</p>
          )}
        </div>
      )}

      {/* Default / recommended values */}
      {hasDefaults && (
        <div className="px-4 py-3 space-y-1.5">
          <p className="font-semibold text-text-primary">Defaults</p>
          {meta.defaultValue != null && (
            <div className="flex items-start justify-between gap-2">
              <span className="text-text-muted shrink-0">Built-in default</span>
              <span className="font-mono text-text-primary text-right break-all">
                {meta.defaultValue}
              </span>
            </div>
          )}
          {meta.recommendedValue != null && (
            <div className="flex items-start justify-between gap-2">
              <span className="text-text-muted shrink-0">Recommended</span>
              <span className="font-mono text-text-primary text-right break-all">
                {meta.recommendedValue}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Deployment impact */}
      {hasImpact && (
        <div className="px-4 py-3 space-y-1.5">
          <p className="font-semibold text-text-primary">Deployment Impact</p>
          {meta.restartRequired && (
            <div className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400">
              <RefreshCw size={10} />
              <span>Requires FreeSWITCH restart</span>
              {meta.estimatedDowntime && (
                <span className="text-text-muted">({meta.estimatedDowntime})</span>
              )}
            </div>
          )}
          {meta.riskLevel && meta.riskLevel !== 'low' && (
            <div className={`flex items-center gap-1.5 ${
              meta.riskLevel === 'high'
                ? 'text-red-600 dark:text-red-400'
                : 'text-amber-600 dark:text-amber-400'}`}>
              <AlertTriangle size={10} />
              <span className="capitalize">{meta.riskLevel} risk change</span>
            </div>
          )}
          {meta.affectedServices?.length > 0 && (
            <div className="text-text-muted">
              Affects:{' '}
              <span className="text-text-primary">{meta.affectedServices.join(', ')}</span>
            </div>
          )}
        </div>
      )}

      {/* Notes */}
      {meta.notes && (
        <div className="px-4 py-3">
          <div className="flex items-start gap-1.5">
            <Info size={10} className="text-text-muted mt-0.5 shrink-0" />
            <p className="text-text-muted leading-relaxed">{meta.notes}</p>
          </div>
        </div>
      )}

      {/* Cross-references */}
      {hasRefs && (
        <div className="px-4 py-3 space-y-1.5">
          {meta.aliases?.length > 0 && (
            <div>
              <span className="text-text-muted">Also known as: </span>
              <span className="font-mono text-text-primary">{meta.aliases.join(', ')}</span>
            </div>
          )}
          {meta.relatedVariables?.length > 0 && (
            <div>
              <span className="text-text-muted">Related: </span>
              <span className="font-mono text-text-primary">{meta.relatedVariables.join(', ')}</span>
            </div>
          )}
          {meta.usedBy?.length > 0 && (
            <div>
              <span className="text-text-muted">Used by: </span>
              <span className="text-text-primary">{meta.usedBy.join(', ')}</span>
            </div>
          )}
        </div>
      )}

      {/* Documentation link */}
      {meta.documentationRef && (
        <div className="px-4 py-3">
          <a
            href={meta.documentationRef}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-brand hover:underline">
            <ExternalLink size={10} />
            View documentation
          </a>
        </div>
      )}
    </div>
  );
}
