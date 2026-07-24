/**
 * ConfigCard — renders a single variable row in the System Variables page.
 *
 * Props:
 *  entry         — ConfigEntry from the server (key, value, enabled, category, label, description, type)
 *  pendingChange — { value?, enabled? } from local state (not yet deployed)
 *  onChange      — fn({ key, value?, enabled? })
 *  disabled      — grey out inputs when a deploy is in progress
 */
export default function ConfigCard({ entry, pendingChange, onChange, disabled = false }) {
  const isDirty = pendingChange !== undefined;

  const currentValue   = pendingChange?.value   !== undefined ? pendingChange.value   : entry.value;
  const currentEnabled = pendingChange?.enabled !== undefined ? pendingChange.enabled : entry.enabled;

  const handleValueChange = (val) => {
    onChange({ key: entry.key, op: 'set', value: val, enabled: currentEnabled });
  };

  const handleToggle = () => {
    // Always emit op:'set' with the current value so that a prior value edit
    // is not overwritten when the enable/disable state changes.
    onChange({ key: entry.key, op: 'set', value: currentValue, enabled: !currentEnabled });
  };

  return (
    <div className={`rounded-lg border transition-colors
      ${isDirty
        ? 'border-brand/50 bg-brand/5 dark:bg-brand/10'
        : 'border-surface-border bg-surface-panel'
      } ${disabled ? 'opacity-60 pointer-events-none' : ''}`}>

      <div className="px-4 py-3 flex items-start gap-4">

        {/* Enable/disable toggle */}
        <button
          onClick={handleToggle}
          title={currentEnabled ? 'Disable this variable' : 'Enable this variable'}
          className={`mt-0.5 w-9 h-5 rounded-full relative transition-colors shrink-0
            ${currentEnabled
              ? 'bg-brand'
              : 'bg-surface-border dark:bg-surface-border/60'}`}>
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow
                           transition-transform duration-150
                           ${currentEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>

        {/* Label + description */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`font-mono text-sm font-semibold
              ${currentEnabled ? 'text-text-primary' : 'text-text-muted line-through'}`}>
              {entry.key}
            </span>
            {entry.label && entry.label !== entry.key && (
              <span className="text-xs text-text-muted">{entry.label}</span>
            )}
            {isDirty && (
              <span className="text-[10px] font-bold uppercase tracking-wide
                               bg-brand/20 text-brand px-1.5 py-0.5 rounded-full">
                Modified
              </span>
            )}
          </div>
          {entry.description && (
            <p className="text-xs text-text-muted mt-0.5 leading-relaxed">{entry.description}</p>
          )}
        </div>

        {/* Value input */}
        <div className="shrink-0 w-56">
          {entry.type === 'boolean' ? (
            <select
              value={currentValue}
              disabled={!currentEnabled || disabled}
              onChange={e => handleValueChange(e.target.value)}
              className="w-full rounded-lg border border-surface-border bg-surface-bg
                         px-2 py-1.5 text-sm text-text-primary font-mono
                         focus:outline-none focus:ring-2 focus:ring-brand/50
                         disabled:opacity-40">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : entry.type === 'enum' && entry.options ? (
            <select
              value={currentValue}
              disabled={!currentEnabled || disabled}
              onChange={e => handleValueChange(e.target.value)}
              className="w-full rounded-lg border border-surface-border bg-surface-bg
                         px-2 py-1.5 text-sm text-text-primary font-mono
                         focus:outline-none focus:ring-2 focus:ring-brand/50
                         disabled:opacity-40">
              {entry.options.map(o => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input
              type={entry.type === 'password' ? 'password' : 'text'}
              value={currentValue}
              disabled={!currentEnabled || disabled}
              onChange={e => handleValueChange(e.target.value)}
              className="w-full rounded-lg border border-surface-border bg-surface-bg
                         px-2 py-1.5 text-sm text-text-primary font-mono
                         focus:outline-none focus:ring-2 focus:ring-brand/50
                         disabled:opacity-40"
            />
          )}
        </div>
      </div>
    </div>
  );
}
