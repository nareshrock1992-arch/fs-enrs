/**
 * ConfigDiff — renders a human-readable diff summary from the provider.
 *
 * Each line starting with '+' = added/changed-to, '-' = removed/old,
 * '~' = modified, '(no …)' = informational.
 */
export default function ConfigDiff({ diff, className = '' }) {
  if (!diff) return null;

  const lines = String(diff).split('\n').filter(Boolean);

  if (lines.length === 0 || (lines.length === 1 && lines[0].startsWith('(no'))) {
    return (
      <p className={`text-xs text-text-muted italic ${className}`}>
        {lines[0] ?? 'No changes'}
      </p>
    );
  }

  return (
    <div className={`font-mono text-xs rounded-lg border border-surface-border
                     bg-surface-panel overflow-x-auto ${className}`}>
      {lines.map((line, i) => {
        const op = line[0];
        const colorClass =
          op === '+' ? 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300' :
          op === '-' ? 'bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300' :
          op === '~' ? 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300' :
          'text-text-muted';
        return (
          <div key={i} className={`px-3 py-0.5 whitespace-pre ${colorClass}`}>
            {line}
          </div>
        );
      })}
    </div>
  );
}
