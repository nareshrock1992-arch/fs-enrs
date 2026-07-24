import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * ChangeSummary — pre-deploy change table with risk and restart indicators.
 *
 * Renders a structured table of pending changes. Masks sensitive values.
 * Shows aggregate warnings for high-risk changes or restart-required changes.
 *
 * Props:
 *   changeDescriptions — array of describeChange() results:
 *     { key, label, from, to, restartRequired, riskLevel, sensitive }
 */
export default function ChangeSummary({ changeDescriptions }) {
  if (!changeDescriptions?.length) return null;

  const hasHighRisk  = changeDescriptions.some(c => c.riskLevel === 'high');
  const hasRestart   = changeDescriptions.some(c => c.restartRequired);
  const hasSensitive = changeDescriptions.some(c => c.sensitive);

  return (
    <div className="space-y-2">
      {/* Aggregate warnings */}
      {(hasHighRisk || hasRestart) && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800
                        bg-amber-50 dark:bg-amber-950 px-3 py-2 space-y-1">
          {hasHighRisk && (
            <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle size={11} />
              One or more changes are high risk — review carefully before deploying
            </div>
          )}
          {hasRestart && (
            <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
              <RefreshCw size={11} />
              FreeSWITCH restart may be required after this deployment
            </div>
          )}
        </div>
      )}

      {/* Change table */}
      <div className="overflow-x-auto rounded-lg border border-surface-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-surface-bg border-b border-surface-border">
              <th className="px-3 py-2 text-left text-text-muted font-medium w-2/5">Variable</th>
              <th className="px-3 py-2 text-left text-text-muted font-medium w-[25%]">From</th>
              <th className="px-3 py-2 text-left text-text-muted font-medium w-[25%]">To</th>
              <th className="px-3 py-2 text-left text-text-muted font-medium">Impact</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {changeDescriptions.map(c => (
              <tr key={c.key} className="hover:bg-surface-bg/40">
                <td className="px-3 py-2">
                  <p className="font-mono font-semibold text-text-primary truncate">{c.key}</p>
                  {c.label && c.label !== c.key && (
                    <p className="text-text-muted truncate">{c.label}</p>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-text-muted max-w-0">
                  <p className="truncate">{c.sensitive ? '••••••' : c.from}</p>
                </td>
                <td className="px-3 py-2 font-mono text-text-primary max-w-0">
                  <p className="truncate">{c.sensitive ? '••••••' : c.to}</p>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    {c.riskLevel && c.riskLevel !== 'low' && (
                      <span className={`text-[10px] font-medium capitalize ${
                        c.riskLevel === 'high'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-amber-600 dark:text-amber-400'}`}>
                        {c.riskLevel} risk
                      </span>
                    )}
                    {c.restartRequired && (
                      <span className="text-[10px] text-blue-600 dark:text-blue-400 flex items-center gap-0.5">
                        <RefreshCw size={8} />
                        restart
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasSensitive && (
        <p className="text-[10px] text-text-muted italic">
          Sensitive values are masked in this summary.
        </p>
      )}
    </div>
  );
}
