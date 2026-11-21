import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';

// Compact building blocks for purpose-built inspectors (the Menu node panel).
// Presentation only, in the builder's existing tokens (surface / text / brand).

/** Accessible on/off switch. */
export function Switch({ checked, onChange, disabled = false, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => { if (!disabled) onChange(!checked); }}
      className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
                  ${checked ? 'bg-brand' : 'bg-surface-border'}
                  ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        aria-hidden
        className={`inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform
                    ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}`}
      />
    </button>
  );
}

/** Small segmented choice (radio group) for 2–3 options. */
export function Segmented({ value, options, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label}
         className="flex flex-wrap w-full gap-0.5 rounded-md border border-surface-border bg-surface-hover/40 p-0.5">
      {options.map(o => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => { if (!on) onChange(o.value); }}
            className={`flex-1 basis-auto whitespace-nowrap rounded px-1.5 py-1 text-[11px] font-medium transition-colors
                        focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
                        ${on ? 'bg-surface-panel text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * ⓘ with a short explanation on hover or keyboard focus (replaces long help
 * paragraphs). The tooltip spans the width of the nearest positioned row (every
 * row and heading below is `relative`), so it never runs off the panel edge.
 */
export function InfoTip({ text }) {
  if (!text) return null;
  return (
    <span className="inline-flex group align-middle">
      <button type="button" aria-label={text}
              className="text-text-muted hover:text-text-primary focus:outline-none focus-visible:text-brand">
        <Info size={11} />
      </button>
      <span role="tooltip"
            className="pointer-events-none invisible opacity-0 group-hover:visible group-hover:opacity-100
                       group-focus-within:visible group-focus-within:opacity-100 transition-opacity
                       absolute left-0 right-0 top-full z-30 mt-1 rounded-md border border-surface-border
                       bg-surface-panel px-2 py-1.5 text-[10px] font-normal normal-case tracking-normal
                       leading-relaxed text-text-secondary shadow-lg">
        {text}
      </span>
    </span>
  );
}

/**
 * Collapsible section with a one-line summary on the right, so a closed
 * section still says what it does. Collapsing never touches values (they live
 * in the flow, not here). Opens itself when a field inside has an error.
 */
export function InspectorSection({ title, summary, info, defaultOpen = true, forceOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen || forceOpen);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  return (
    <section className="border-b border-surface-border/60 last:border-0">
      <div className="relative flex items-center gap-1.5 py-2">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className="flex flex-1 min-w-0 items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wide
                     text-text-secondary hover:text-text-primary focus:outline-none focus-visible:text-brand"
        >
          {open ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
          <span className="truncate">{title}</span>
          {summary && (
            <span className="ml-auto pl-2 text-[10px] font-normal normal-case tracking-normal text-text-muted truncate">
              {summary}
            </span>
          )}
        </button>
        {info && <InfoTip text={info} />}
      </div>
      {open && <div className="pb-3 space-y-2.5">{children}</div>}
    </section>
  );
}

/** Always-open group with a plain heading (the main settings of a tab). */
export function InspectorBlock({ title, summary, info, children }) {
  return (
    <section className="py-2.5 border-b border-surface-border/60 last:border-0">
      <div className="relative flex items-center gap-1.5 mb-2 min-w-0">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary truncate">{title}</h4>
        {info && <InfoTip text={info} />}
        {summary && <span className="ml-auto pl-2 text-[10px] text-text-muted truncate">{summary}</span>}
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

/**
 * Tab strip (Settings / Exits). A badge counts problems inside a tab so an
 * error is never hidden behind the other tab. Arrow keys move between tabs.
 */
export function InspectorTabs({ tabs, value, onChange, idPrefix, label }) {
  const onKeyDown = e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = tabs.findIndex(t => t.id === value);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    onChange(next.id);
    document.getElementById(`${idPrefix}-tab-${next.id}`)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown}
         className="flex gap-5 border-b border-surface-border mb-1">
      {tabs.map(t => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-selected={on}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 pb-2 text-xs font-medium transition-colors
                        focus:outline-none focus-visible:text-brand
                        ${on ? 'border-brand text-text-primary' : 'border-transparent text-text-muted hover:text-text-primary'}`}
          >
            {t.label}
            {t.badge > 0 && (
              <span
                title={t.badgeTitle}
                className={`inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-semibold
                            ${t.tone === 'error' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-500'}`}
              >
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Inline validation / advice lines under a control. */
export function Messages({ errors, warning }) {
  return (
    <>
      {(errors || []).map((e, i) => (
        <p key={i} className="text-[10px] text-red-400 mt-1 flex items-start gap-1">
          <span aria-hidden className="mt-px">⚠</span><span>{e}</span>
        </p>
      ))}
      {warning && (
        <p className="text-[10px] text-amber-500 mt-1 flex items-start gap-1">
          <span aria-hidden className="mt-px">⚠</span><span>{warning}</span>
        </p>
      )}
    </>
  );
}

/** Label-left, control-right row (toggles and short numbers). */
export function InlineRow({ label, info, required, errors, warning, children }) {
  return (
    <div className="relative">
      <div className="flex items-center gap-2 min-h-[24px]">
        <span className="flex items-center gap-1 flex-1 min-w-0 text-[11px] text-text-secondary">
          <span className="break-words">{label}</span>
          {required && <span className="text-red-400" title="Required" aria-label="required">*</span>}
          {info && <InfoTip text={info} />}
        </span>
        <span className="shrink-0 flex items-center gap-1.5">{children}</span>
      </div>
      <Messages errors={errors} warning={warning} />
    </div>
  );
}

/** Label-above block (wide controls: text, media, destination pickers). */
export function StackRow({ label, info, required, errors, warning, children }) {
  return (
    <div>
      {label && (
        <div className="relative flex items-center gap-1 mb-1 text-[11px] text-text-secondary">
          <span className="break-words">{label}</span>
          {required && <span className="text-red-400" title="Required" aria-label="required">*</span>}
          {info && <InfoTip text={info} />}
        </div>
      )}
      {children}
      <Messages errors={errors} warning={warning} />
    </div>
  );
}

/**
 * Whole-number input that only writes valid values. While the typed text is
 * out of range it shows an inline message instead of storing a value the
 * backend would reject. Empty writes `undefined` (the runtime default applies)
 * unless `allowEmpty` is false, in which case the stored value is kept.
 */
export function NumberField({ value, onChange, min, max, placeholder, allowEmpty = true, unit, ariaLabel, width = 'w-16' }) {
  const shown = value === undefined || value === null ? '' : String(value);
  const [text, setText] = useState(shown);
  const [error, setError] = useState(null);
  useEffect(() => { setText(shown); setError(null); }, [shown]);

  const commit = raw => {
    setText(raw);
    if (raw.trim() === '') {
      if (allowEmpty) { setError(null); onChange(undefined); }
      else setError('Required');
      return;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
      setError(`Whole number ${min ?? ''}–${max ?? ''}`);
      return;
    }
    setError(null);
    onChange(n);
  };

  return (
    <span className="flex flex-col items-end">
      <span className="flex items-center gap-1">
        <input
          type="number"
          inputMode="numeric"
          aria-label={ariaLabel}
          value={text}
          min={min}
          max={max}
          placeholder={placeholder}
          onChange={e => commit(e.target.value)}
          onBlur={() => { if (error) { setText(shown); setError(null); } }}
          className={`${width} bg-surface-bg border rounded-md px-1.5 py-1 text-xs text-right text-text-primary
                      placeholder:text-text-muted focus:outline-none transition-colors
                      ${error ? 'border-red-400' : 'border-surface-border focus:border-brand'}`}
        />
        {unit && <span className="text-[10px] text-text-muted w-5">{unit}</span>}
      </span>
      {error && <span className="text-[10px] text-red-400 mt-0.5">{error}</span>}
    </span>
  );
}
