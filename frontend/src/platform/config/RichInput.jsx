import { validateEntry } from './utils/validateEntry.js';

/**
 * RichInput — type-aware input control for a single configuration entry.
 *
 * Reads the entry type from entry.metadata.type (Phase 7.3A+) with
 * backward-compat fallback to entry.type. Renders the correct control
 * and shows an inline validation error when the value is invalid.
 *
 * Props:
 *   entry    — ConfigurationObject from the API
 *   value    — current display value (string)
 *   onChange — fn(newValue: string)
 *   disabled — greys out the control when true
 */
export default function RichInput({ entry, value, onChange, disabled = false }) {
  const meta    = entry.metadata ?? entry;
  const type    = meta.type ?? entry.type ?? 'string';
  const options = meta.validation?.allowedValues ?? meta.options ?? null;

  // Read-only: editable=false or type='readonly'
  if (meta.editable === false || type === 'readonly') {
    return (
      <span className="font-mono text-sm text-text-muted px-1 select-all" title={value}>
        {value || '—'}
      </span>
    );
  }

  const { valid, error } = validateEntry(entry, value);

  const baseCls = [
    'w-full rounded-lg border bg-surface-bg px-2 py-1.5 text-sm text-text-primary font-mono',
    'focus:outline-none focus:ring-2 focus:ring-brand/50 disabled:opacity-40',
    valid ? 'border-surface-border' : 'border-red-400 dark:border-red-600',
  ].join(' ');

  let control;

  if (type === 'boolean') {
    control = (
      <select value={value ?? 'true'} disabled={disabled}
        onChange={e => onChange(e.target.value)} className={baseCls}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  } else if (type === 'enum' && options) {
    control = (
      <select value={value ?? ''} disabled={disabled}
        onChange={e => onChange(e.target.value)} className={baseCls}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (type === 'multiline') {
    control = (
      <textarea
        value={value ?? ''}
        disabled={disabled}
        rows={3}
        onChange={e => onChange(e.target.value)}
        className={`${baseCls} resize-y`}
      />
    );
  } else {
    control = (
      <input
        type={type === 'password' ? 'password' : 'text'}
        value={value ?? ''}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className={baseCls}
      />
    );
  }

  return (
    <div>
      {control}
      {!valid && error && (
        <p className="text-[10px] text-red-500 dark:text-red-400 mt-0.5 px-0.5">{error}</p>
      )}
    </div>
  );
}
