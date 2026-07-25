import { AlertTriangle, RefreshCw, GitBranch } from 'lucide-react';
import RichInput from './RichInput.jsx';

/**
 * ConfigCard — renders a single variable row in the configuration provider page.
 *
 * Phase 7.3B rewrite: reads enriched metadata from entry.metadata (Phase 7.3A+)
 * with backward-compat fallback to flat entry fields. Delegates value input
 * rendering to RichInput. Shows riskLevel and restartRequired badges.
 *
 * External interface (props) is unchanged from Phase 7.2:
 *   entry         — ConfigurationObject from the API
 *   pendingChange — { value?, enabled? } from local state (not yet deployed)
 *   onChange      — fn({ key, op, value, enabled })
 *   disabled      — grey out inputs when a deploy is in progress
 *
 * New optional props (Phase 7.3B):
 *   onSelect   — fn(key) called when the card is clicked; enables selection highlight
 *   isSelected — boolean, true when this card is the active DetailsPanel entry
 */
export default function ConfigCard({
  entry,
  pendingChange,
  onChange,
  disabled = false,
  onSelect,
  isSelected = false,
}) {
  const meta   = entry.metadata ?? entry;
  const isDirty = pendingChange !== undefined;

  const currentValue   = pendingChange?.value   !== undefined ? pendingChange.value   : (entry.value   ?? '');
  const currentEnabled = pendingChange?.enabled !== undefined ? pendingChange.enabled : entry.enabled;

  const handleValueChange = (val) => {
    onChange({ key: entry.key, op: 'set', value: val, enabled: currentEnabled });
  };

  const handleToggle = () => {
    onChange({ key: entry.key, op: 'set', value: currentValue, enabled: !currentEnabled });
  };

  const showRiskBadge    = meta.riskLevel && meta.riskLevel !== 'low';
  const showRestartBadge = meta.restartRequired === true;
  const isUnknown        = meta.category === 'Custom';

  return (
    <div
      data-cfg-card
      onClick={onSelect ? () => onSelect(entry.key) : undefined}
      className={[
        'rounded-lg border transition-colors',
        isDirty
          ? 'border-brand/50 bg-brand/5 dark:bg-brand/10'
          : isSelected
            ? 'border-brand/40 bg-surface-panel ring-1 ring-brand/20'
            : 'border-surface-border bg-surface-panel',
        disabled ? 'opacity-60 pointer-events-none' : '',
        onSelect  ? 'cursor-pointer hover:border-brand/20' : '',
      ].filter(Boolean).join(' ')}
    >
      <div className="px-4 py-3 flex items-start gap-4">

        {/* Enable / disable toggle */}
        <button
          onClick={e => { e.stopPropagation(); handleToggle(); }}
          title={currentEnabled ? 'Disable this variable' : 'Enable this variable'}
          className={`mt-0.5 w-9 h-5 rounded-full relative transition-colors shrink-0
            ${currentEnabled
              ? 'bg-brand'
              : 'bg-surface-border dark:bg-surface-border/60'}`}>
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow
                           transition-transform duration-150
                           ${currentEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>

        {/* Label + description + badges */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`font-mono text-sm font-semibold
              ${currentEnabled ? 'text-text-primary' : 'text-text-muted line-through'}`}>
              {entry.key}
            </span>
            {meta.label && meta.label !== entry.key && (
              <span className="text-xs text-text-muted">{meta.label}</span>
            )}
            {isDirty && (
              <span className="text-[10px] font-bold uppercase tracking-wide
                               bg-brand/20 text-brand px-1.5 py-0.5 rounded-full">
                Modified
              </span>
            )}
            {!currentEnabled && (
              <span className="text-[10px] uppercase tracking-wide
                               text-text-muted bg-surface-border px-1.5 py-0.5 rounded-full">
                Disabled
              </span>
            )}
            {isUnknown && (
              <span className="text-[10px] uppercase tracking-wide
                               text-amber-600 dark:text-amber-400
                               bg-amber-50 dark:bg-amber-950
                               border border-amber-200 dark:border-amber-800
                               px-1.5 py-0.5 rounded-full">
                Custom
              </span>
            )}
          </div>

          {meta.description && (
            <p className="text-xs text-text-muted mt-0.5 leading-relaxed line-clamp-1">
              {meta.description}
            </p>
          )}

          {(showRiskBadge || showRestartBadge) && (
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              {showRiskBadge && (
                <span className={`text-[10px] flex items-center gap-0.5 font-medium
                                 px-1.5 py-0.5 rounded-full
                  ${meta.riskLevel === 'high'
                    ? 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950'
                    : 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950'}`}>
                  <AlertTriangle size={9} />
                  {meta.riskLevel} risk
                </span>
              )}
              {showRestartBadge && (
                <span className="text-[10px] flex items-center gap-0.5 font-medium
                                 px-1.5 py-0.5 rounded-full
                                 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950">
                  <RefreshCw size={9} />
                  restart required
                </span>
              )}
            </div>
          )}
        </div>

        {/* Value input — stopPropagation so clicking inside doesn't trigger onSelect */}
        <div className="shrink-0 w-56" onClick={e => e.stopPropagation()}>
          <RichInput
            entry={entry}
            value={currentValue}
            onChange={handleValueChange}
            disabled={!currentEnabled || disabled}
          />
        </div>
      </div>

      {/* Alternatives — only rendered when this key has multiple file definitions */}
      {entry.alternatives?.length > 0 && (
        <div
          className="px-4 pb-3 border-t border-surface-border/40"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center gap-1 mt-2 mb-1.5">
            <GitBranch size={10} className="text-text-muted" />
            <span className="text-[10px] uppercase tracking-wider text-text-muted font-medium">
              Alternatives
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {entry.alternatives.map(alt => (
              <div
                key={`${entry.key}:${alt.definitionId}`}
                className="flex items-center justify-between gap-3 py-0.5"
              >
                <span className="font-mono text-xs text-text-muted truncate flex-1">
                  {alt.value}
                </span>
                <span className="text-[10px] text-text-muted shrink-0">
                  {alt.disabledHint}
                </span>
                <button
                  onClick={() => onChange({
                    key:          entry.key,
                    op:           'enable',
                    definitionId: alt.definitionId,
                    value:        alt.value,
                    enabled:      true,
                  })}
                  disabled={disabled}
                  className="text-[10px] font-medium text-brand hover:text-brand/70
                             disabled:opacity-40 disabled:cursor-not-allowed
                             transition-colors shrink-0"
                >
                  Use this
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
