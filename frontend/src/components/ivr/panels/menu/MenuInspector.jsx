import { useEffect, useRef, useState } from 'react';
import { Trash2, ChevronUp, ChevronDown, RotateCcw } from 'lucide-react';
import { confirmAction } from '../../../ui/ConfirmDialog.jsx';
import {
  Switch, Segmented, InfoTip, InspectorSection, InspectorBlock, Messages, InlineRow, StackRow, NumberField,
} from '../inspectorControls.jsx';
import {
  MODE, COLLECT, effective, runtimeDefault, sourceOf, menuRows, unguardedRows, showTooFewDigits,
  togglePatch, sourcePatch, modePatch, collectType, collectTypePatch, retriesPatch,
  nextFreeKey, addOptionPatch, validateOptionKey, optionKeyWarning, renameOptionPatch, removeBranchPatch,
  setBranchPatch, menuExitLabel, defaultExitName, isWired, hasAnyExit, optionLabelPatch,
  addRoutePatch, updateRoutePatch, removeRoutePatch, moveRoutePatch,
  separateExits, separateExitsPatch, immediateExitReasons, retryFirstPatch,
  isModified, resetAdvancedPatch, summaryLine, menuLint,
} from './menuModel.js';
import { ROUTE_TYPES, routeError, routeWarnings, MAX_ROUTES } from './gatherRoutes.js';

// Inspector body for the Menu (Gather DTMF) node — one column, progressive
// disclosure (DTMF redesign, docs/ivr/DTMF_NODE_DESIGN.md §D):
//   Basic:    Mode · Prompt · Options or Digits + Routes · When something goes
//             wrong · one summary line with "Customize"
//   Advanced: retries, timeouts, prompts, barge-in, separate exits, reset.
// PRESENTATION ONLY: it edits stored fields in their stored formats and never
// writes anything because a node was opened. Every exit the canvas draws is
// placed exactly once (menuModel.menuRows). Sub-components are module scope so
// native <select>s reconcile in place (see branchRowRegression.test.js).

const MODES = [
  { value: COLLECT.MENU,   label: 'Press a key' },
  { value: COLLECT.DIGITS, label: 'Enter digits' },
];
const PROMPT_SOURCES = [
  { value: 'audio', label: 'Audio file' },
  { value: 'tts',   label: 'Text-to-speech' },
  { value: 'none',  label: 'None' },
];
const MESSAGE_SOURCES = [
  { value: 'none',  label: 'Replay prompt' },
  { value: 'tts',   label: 'Text-to-speech' },
  { value: 'audio', label: 'Audio file' },
];
const TERMINATORS = [
  { value: '',  label: 'None' },
  { value: '#', label: '#' },
  { value: '*', label: '*' },
];
const ROUTE_TYPE_LABELS = {
  equals: 'Equals', one_of: 'One of', range: 'Range', starts_with: 'Starts with', length: 'Length', pattern: 'Pattern (advanced)',
};
const ROUTE_PLACEHOLDERS = {
  equals: '1234', one_of: '1001, 1002, 1005', range: '1000', starts_with: '9', length: '6', pattern: '^[2-4]\\d{3}$',
};
const DISCONNECTED = 'Callers who reach this are disconnected — choose a destination';
const MESSAGE_FIELDS = ['no_input', 'invalid_option', 'invalid_length', 'max_attempts_exceeded']
  .flatMap(s => [`${s}_text`, `${s}_audio_url`, `${s}_source_type`]);
const INVALID_PREFIX = 'invalid_option_';

/** The single Invalid prompt writes the wrong-key and too-short slots together (D10). */
const withInvalidLength = patch => {
  const out = { ...patch };
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith(INVALID_PREFIX)) out[`invalid_length_${k.slice(INVALID_PREFIX.length)}`] = v;
  }
  return out;
};

function Note({ children, tone = 'muted' }) {
  const cls = tone === 'warn' ? 'text-amber-500' : tone === 'error' ? 'text-red-400' : 'text-text-muted';
  return <p className={`text-[11px] leading-relaxed ${cls}`}>{children}</p>;
}

function ModifiedDot({ on }) {
  if (!on) return null;
  return <span title="Changed from the default" aria-label="changed from default" className="inline-block h-1.5 w-1.5 rounded-full bg-brand" />;
}

function FieldLabel({ children, info, modified }) {
  return (
    <span className="flex items-center gap-1.5">
      <span>{children}</span>
      <ModifiedDot on={modified} />
      {info && <InfoTip text={info} />}
    </span>
  );
}

function DescriptionField({ node, onChange }) {
  const [editing, setEditing] = useState(false);
  const value = node.description || '';
  if (!value && !editing) {
    return (
      <button type="button" onClick={() => setEditing(true)}
              className="text-[11px] text-text-muted hover:text-brand transition-colors">
        + Add description
      </button>
    );
  }
  return (
    <textarea
      autoFocus={editing && !value}
      value={value}
      onChange={e => onChange({ description: e.target.value || undefined })}
      onBlur={() => setEditing(false)}
      placeholder="Optional note shown on the node"
      rows={2}
      maxLength={500}
      aria-label="Description"
      className="w-full bg-surface-bg border border-surface-border rounded-md px-2 py-1.5 text-xs text-text-primary
                 placeholder:text-text-muted focus:outline-none focus:border-brand transition-colors resize-none"
    />
  );
}

function TextField({ value, onChange, placeholder, ariaLabel, mono = false, width = 'w-full', maxLength = 200, invalid = false }) {
  return (
    <input
      value={value ?? ''}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      maxLength={maxLength}
      className={`${width} min-w-0 bg-surface-bg border rounded-md px-2 py-1 text-xs text-text-primary placeholder:text-text-muted
                  focus:outline-none transition-colors ${mono ? 'font-mono' : ''}
                  ${invalid ? 'border-red-400' : 'border-surface-border focus:border-brand'}`}
    />
  );
}

/** Destination picker bound to one branch key. '' = not connected (removed when the flow is saved). */
function Picker({ branchKey, node, nodes, byType, onChange, controls, placeholder = 'Not connected' }) {
  const { NodePicker } = controls;
  return (
    <NodePicker
      value={node.branches?.[branchKey] || ''}
      onChange={v => onChange(setBranchPatch(node, branchKey, v))}
      nodes={nodes}
      excludeId={node.id}
      placeholder={placeholder}
      byType={byType}
    />
  );
}

/** One exit, label above its destination (single column). */
function ExitRow({ label, info, errors, warning, children }) {
  return (
    <StackRow label={label} info={info} errors={errors} warning={warning}>
      {children}
    </StackRow>
  );
}

/** One menu option: key, optional label, destination. */
function OptionRow({ node, optKey, nodes, byType, onChange, controls, errors }) {
  const [draft, setDraft] = useState(optKey);
  const [keyError, setKeyError] = useState(null);
  useEffect(() => { setDraft(optKey); setKeyError(null); }, [optKey]);

  const commitKey = () => {
    const k = draft.trim();
    if (k === optKey) { setKeyError(null); setDraft(optKey); return; }
    const err = validateOptionKey(node, k, optKey);
    if (err) { setKeyError(err); return; }
    const patch = renameOptionPatch(node, optKey, k);
    if (patch) onChange(patch);
  };

  const target = node.branches?.[optKey] || '';
  const advice = keyError ? null
    : !target ? 'Choose a destination — options without one are not saved'
    : optionKeyWarning(node, optKey);

  return (
    <div className="rounded-md border border-surface-border p-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <input
          value={draft}
          onChange={e => { setDraft(e.target.value); setKeyError(null); }}
          onBlur={commitKey}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commitKey(); }
            if (e.key === 'Escape') { setDraft(optKey); setKeyError(null); }
          }}
          maxLength={24}
          aria-label={`Key for option ${optKey}`}
          title="Key the caller presses"
          className={`w-12 shrink-0 bg-surface-bg border rounded-md px-1 py-1 text-xs font-mono text-center text-text-primary
                      focus:outline-none transition-colors ${keyError ? 'border-red-400' : 'border-surface-border focus:border-brand'}`}
        />
        <TextField
          value={node.option_labels?.[optKey]}
          onChange={v => onChange(optionLabelPatch(node, optKey, v))}
          placeholder="Label (e.g. Sales)"
          ariaLabel={`Label for option ${optKey}`}
          maxLength={40}
        />
        <button
          type="button"
          onClick={() => onChange(removeBranchPatch(node, optKey))}
          aria-label={`Remove option ${optKey}`}
          title="Remove option"
          className="shrink-0 p-1 text-text-muted hover:text-red-400 transition-colors"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <Picker branchKey={optKey} node={node} nodes={nodes} byType={byType} onChange={onChange} controls={controls}
              placeholder="Choose destination…" />
      <Messages errors={keyError ? [keyError, ...(errors || [])] : errors} warning={advice} />
    </div>
  );
}

/** One Digits-mode route: rule, value(s), optional name, destination, order. */
function RouteRow({ node, route, index, count, nodes, byType, onChange, controls, warnings }) {
  const { Select } = controls;
  const err = routeError(route);
  const showErr = err && String(route.value ?? '').trim() !== '' ? err : null;   // don't shout at a fresh row
  const set = fields => onChange(updateRoutePatch(node, route.id, fields));
  const branchKey = `route_${route.id}`;
  return (
    <div className="rounded-md border border-surface-border p-2 space-y-1.5">
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-text-muted w-4 shrink-0 text-right">{index + 1}.</span>
        <div className="flex-1 min-w-0">
          <Select
            value={route.type}
            onChange={v => set({ type: v })}
            options={ROUTE_TYPES.map(t => ({ value: t, label: ROUTE_TYPE_LABELS[t] }))}
          />
        </div>
        <button type="button" aria-label="Move route up" title="Move up (checked earlier)" disabled={index === 0}
                onClick={() => { const p = moveRoutePatch(node, route.id, -1); if (p) onChange(p); }}
                className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30"><ChevronUp size={13} /></button>
        <button type="button" aria-label="Move route down" title="Move down (checked later)" disabled={index === count - 1}
                onClick={() => { const p = moveRoutePatch(node, route.id, 1); if (p) onChange(p); }}
                className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30"><ChevronDown size={13} /></button>
        <button type="button" aria-label="Remove route" title="Remove route"
                onClick={() => onChange(removeRoutePatch(node, route.id))}
                className="p-1 text-text-muted hover:text-red-400"><Trash2 size={13} /></button>
      </div>
      {route.type === 'range' ? (
        <div className="flex items-center gap-1.5">
          <TextField value={route.value} onChange={v => set({ value: v })} placeholder="1000" ariaLabel="Range from" mono invalid={!!showErr} />
          <span className="text-[11px] text-text-muted">to</span>
          <TextField value={route.value2} onChange={v => set({ value2: v })} placeholder="1999" ariaLabel="Range to" mono invalid={!!showErr} />
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <TextField value={route.value} onChange={v => set({ value: v })} placeholder={ROUTE_PLACEHOLDERS[route.type]}
                     ariaLabel="Route value" mono invalid={!!showErr} />
          {route.type === 'length' && <span className="text-[11px] text-text-muted shrink-0">digits</span>}
        </div>
      )}
      <TextField value={route.name} onChange={v => set({ name: v })} placeholder="Exit name (optional)" ariaLabel="Route name" maxLength={40} />
      <Picker branchKey={branchKey} node={node} nodes={nodes} byType={byType} onChange={onChange} controls={controls}
              placeholder="Choose destination…" />
      <Messages errors={showErr ? [showErr] : null} warning={warnings.join(' · ') || (isWired(node, branchKey) ? null : 'Not connected — matching entries skip this route')} />
    </div>
  );
}

/** Retry message: source plus its text or file, then whether the prompt replays. */
function MessageField({ slot, label, info, node, onChange, controls, fieldErrors, replay = true }) {
  const { InterpolableTextarea, MediaPickerField } = controls;
  const eff = effective(node);
  const src = sourceOf(node, slot);
  const finalSlot = slot === 'max_attempts_exceeded';
  const options = finalSlot ? [{ value: 'none', label: 'None' }, ...MESSAGE_SOURCES.slice(1)] : MESSAGE_SOURCES;
  return (
    <div className="space-y-1.5">
      <StackRow label={<FieldLabel info={info} modified={isModified(node, slot)}>{label}</FieldLabel>}>
        <Segmented value={src} options={options} label={label} onChange={v => onChange(sourcePatch(slot, v))} />
      </StackRow>
      {src === 'tts' && (
        <StackRow errors={fieldErrors[`${slot}_text`]}>
          <InterpolableTextarea
            value={node[`${slot}_text`]}
            onChange={v => onChange({ [`${slot}_text`]: v })}
            placeholder={finalSlot ? 'Sorry, we could not process your request.' : "Sorry, I didn't get that."}
            rows={2}
            compact
          />
        </StackRow>
      )}
      {src === 'audio' && (
        <StackRow errors={fieldErrors[`${slot}_audio_url`]}>
          <MediaPickerField value={node[`${slot}_audio_url`]} onChange={v => onChange({ [`${slot}_audio_url`]: v })} />
        </StackRow>
      )}
      {replay && !finalSlot && src !== 'none' && (
        <InlineRow label="Then replay the main prompt">
          <Switch checked={eff.replay[slot]} onChange={on => onChange(togglePatch(`${slot}_replay_menu`, on))}
                  label={`Replay the main prompt after the ${label.toLowerCase()}`} />
        </InlineRow>
      )}
    </div>
  );
}

function DigitCount({ node, onChange, fieldErrors, label, info, collectsDigits = false }) {
  const eff = effective(node);
  return (
    <StackRow
      label={<FieldLabel info={info}>{label}</FieldLabel>}
      errors={[...(fieldErrors.min_digits || []), ...(fieldErrors.max_digits || [])]}
      warning={eff.min_digits > eff.max_digits ? 'Minimum is larger than maximum' : null}
    >
      <span className="flex items-center gap-1.5">
        <NumberField value={node.min_digits} onChange={v => onChange({ min_digits: v })} min={1} max={11}
                     placeholder="1" ariaLabel="Minimum digits" width="w-14" />
        <span className="text-[11px] text-text-muted">to</span>
        <NumberField value={node.max_digits} onChange={v => onChange({ max_digits: v })}
                     min={collectsDigits ? 2 : 1} max={11} allowEmpty={!collectsDigits}
                     placeholder="1" ariaLabel="Maximum digits" width="w-14" />
        <span className="text-[11px] text-text-muted">digits</span>
      </span>
    </StackRow>
  );
}

function EndKey({ node, onChange, errors, info }) {
  const terminator = effective(node).terminators;
  const known = TERMINATORS.some(t => t.value === terminator);
  return (
    <StackRow label={<FieldLabel info={info}>End key</FieldLabel>} errors={errors}>
      {known
        ? <Segmented value={terminator} options={TERMINATORS} label="End key" onChange={v => onChange({ terminators: v })} />
        : <p className="text-xs font-mono text-text-primary">{terminator}</p>}
    </StackRow>
  );
}

function VariableField({ node, onChange, controls, errors, label }) {
  const { TextInput } = controls;
  return (
    <StackRow label={<FieldLabel info="Later nodes read the entry from this variable, for example a Condition.">{label}</FieldLabel>} errors={errors}>
      <TextInput value={node.variable_name} onChange={v => onChange({ variable_name: v || undefined })} placeholder="gather_result" mono />
    </StackRow>
  );
}

function ShowAllFields({ renderAllFields }) {
  const [open, setOpen] = useState(false);
  if (!renderAllFields) return null;
  return (
    <div className="pt-1">
      <button type="button" onClick={() => setOpen(o => !o)} className="text-[11px] text-brand hover:underline">
        {open ? 'Hide all fields' : 'Show all fields'}
      </button>
      {open && <div className="mt-2 pt-2 border-t border-surface-border">{renderAllFields()}</div>}
    </div>
  );
}

function CheckList({ lint, warnings }) {
  const server = (warnings || []).map(w => String(w).replace(/^Node "[^"]+" \([^)]*\):\s*/, ''));
  const items = [
    ...lint.errors.map(t => ['error', t]),
    ...[...new Set([...lint.warnings, ...server])].map(t => ['warn', t]),
  ];
  if (!items.length) return null;
  return (
    <div className="mb-2 px-2.5 py-2 rounded-md bg-amber-500/10 border border-amber-500/20 space-y-1" role="status">
      {items.map(([tone, t], i) => (
        <p key={i} className={`text-[11px] leading-snug ${tone === 'error' ? 'text-red-400' : 'text-amber-500'}`}>⚠ {t}</p>
      ))}
    </div>
  );
}

/** Older settings the new panel does not offer, shown only when present, each with a one-click upgrade. */
function OlderSettings({ node, onChange }) {
  const mode = effective(node).mode;
  const upgradeClassic = async () => {
    const ok = await confirmAction({
      title: 'Retry in this node',
      message: 'This older Menu gives callers 3 fixed tries. Switch to adjustable retries (2 retries, 3 tries)? Review the exits before publishing.',
      confirmLabel: 'Switch', variant: 'warning',
    });
    if (ok) onChange(modePatch(node, MODE.INTERNAL));
  };
  const immediate = immediateExitReasons(node);
  const names = { no_input: 'No input', invalid_option: 'Invalid', invalid_length: 'Too few digits' };
  if (mode === MODE.CLASSIC) {
    return (
      <div className="space-y-1.5">
        <Note>Older setting: 3 fixed tries; audio prompts replay, and a text prompt moves on after no input.</Note>
        <button type="button" onClick={upgradeClassic}
                className="text-[11px] px-2 py-1 rounded-md bg-brand/10 text-brand border border-brand/20 hover:bg-brand/20">
          Retry in this node
        </button>
      </div>
    );
  }
  if (mode === MODE.EXTERNAL) {
    return (
      <div className="space-y-1.5">
        <Note>Older setting: one attempt — every failure leaves the node at once.</Note>
        <button type="button" onClick={() => onChange(modePatch(node, MODE.INTERNAL))}
                className="text-[11px] px-2 py-1 rounded-md bg-brand/10 text-brand border border-brand/20 hover:bg-brand/20">
          Retry in this node
        </button>
      </div>
    );
  }
  if (!immediate.length) return null;
  return (
    <div className="space-y-1.5">
      {immediate.map(r => (
        <div key={r} className="flex items-center justify-between gap-2">
          <Note>Older setting: {names[r]} leaves the node without retrying.</Note>
          <button type="button" onClick={() => onChange(retryFirstPatch(r))}
                  className="shrink-0 text-[11px] text-brand hover:underline">Retry first</button>
        </div>
      ))}
    </div>
  );
}

export default function MenuInspector({ node, nodes, byType, onChange, fieldErrors = {}, warnings = [], controls, renderAllFields }) {
  const [advanced, setAdvanced] = useState(false);
  const advancedRef = useRef(null);
  const eff = effective(node);
  const mode = eff.mode;
  const internal = mode === MODE.INTERNAL;
  const digits = collectType(node) === COLLECT.DIGITS;
  const rows = menuRows(node);
  const unguarded = unguardedRows(node);
  const separate = separateExits(node);
  const tooFew = showTooFewDigits(node);
  const lint = menuLint(node);
  const anyOtherSet = isWired(node, '_default');
  const errs = k => fieldErrors[k];
  const hasErr = keys => keys.some(k => fieldErrors[k]?.length);
  const pickerProps = { node, nodes, byType, onChange, controls };
  const free = nextFreeKey(node);
  const src = eff.prompt_source_type;
  const routes = node.routes || [];
  const routeWarns = routeWarnings(routes);
  const [showAnyOther, setShowAnyOther] = useState(false);
  useEffect(() => { setShowAnyOther(false); }, [node.id]);

  const chooseMode = async target => {
    const n = rows.options.length;
    if (target === COLLECT.DIGITS && n > 0) {
      const ok = await confirmAction({
        title: 'Enter digits instead',
        message: `This removes ${n === 1 ? 'the option' : `the ${n} options`} (${rows.options.join(', ')}). `
          + 'Add routes to branch on the entered number; anything else goes to Any valid entry.',
        confirmLabel: 'Remove options', variant: 'warning',
      });
      if (!ok) return;
    }
    if (target === COLLECT.MENU && routes.length) {
      const ok = await confirmAction({
        title: 'Press a key instead',
        message: `This removes the ${routes.length === 1 ? 'route' : `${routes.length} routes`} and their connections.`,
        confirmLabel: 'Remove routes', variant: 'warning',
      });
      if (!ok) return;
      let patched = node;
      let merged = {};
      for (const r of routes) {
        const p = removeRoutePatch(patched, r.id);
        patched = { ...patched, ...p };
        merged = { ...merged, ...p };
      }
      onChange({ ...merged, ...collectTypePatch(node, target) });
      return;
    }
    const p = collectTypePatch(node, target);
    if (p) onChange(p);
  };

  const toggleSeparate = async on => {
    if (!on && ['no_input', 'invalid_option', 'invalid_length'].some(k => isWired(node, k))) {
      const ok = await confirmAction({
        title: 'Use one Failed exit',
        message: 'This disconnects the No input and Invalid exits. Every failure is retried and then leaves through Failed.',
        confirmLabel: 'Disconnect', variant: 'warning',
      });
      if (!ok) return;
    }
    onChange(separateExitsPatch(node, on));
  };

  const openAdvanced = () => {
    setAdvanced(true);
    requestAnimationFrame(() => advancedRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };

  const failedRow = internal && (
    <ExitRow label="Failed" info="After the last retry, whatever the reason."
             errors={errs('branch:max_attempts_exceeded')} warning={unguarded.has('exhausted') ? DISCONNECTED : null}>
      <Picker branchKey="max_attempts_exceeded" {...pickerProps} placeholder="Not connected (recommended)" />
    </ExitRow>
  );

  return (
    <div className="space-y-0">
      <CheckList lint={lint} warnings={warnings} />
      <div className="pb-1">
        <DescriptionField key={node.id} node={node} onChange={onChange} />
      </div>

      <InspectorBlock title="Mode" info="Press a key: each key goes to its own exit. Enter digits: a number such as a PIN or account number, saved to a variable and routed by rules.">
        <Segmented value={digits ? COLLECT.DIGITS : COLLECT.MENU} options={MODES} label="Mode" onChange={chooseMode} />
      </InspectorBlock>

      <InspectorBlock title="Prompt" info="What the caller hears first. Text is spoken with the system voice; ${variables} are filled in during the call.">
        <Segmented value={src} options={PROMPT_SOURCES} label="Prompt source" onChange={v => onChange(sourcePatch('prompt', v))} />
        {src === 'tts' && (
          <StackRow errors={errs('prompt_text')} warning={String(node.prompt_text || '').trim() ? null : 'Callers hear nothing before entering digits'}>
            <controls.InterpolableTextarea
              value={node.prompt_text}
              onChange={v => onChange({ prompt_text: v })}
              placeholder={digits ? 'Please enter your 4-digit PIN.' : 'For sales, press 1. For support, press 2.'}
              rows={3}
              compact
            />
          </StackRow>
        )}
        {src === 'audio' && (
          <StackRow errors={errs('prompt_audio_url')} warning={node.prompt_audio_url ? null : 'Choose an audio file'}>
            <controls.MediaPickerField value={node.prompt_audio_url} onChange={v => onChange({ prompt_audio_url: v })} />
          </StackRow>
        )}
        {src === 'none' && <Note>No prompt — the node waits for input without playing anything.</Note>}
      </InspectorBlock>

      {digits ? (
        <>
          <InspectorBlock title="Digits">
            <DigitCount node={node} onChange={onChange} fieldErrors={fieldErrors} collectsDigits label="Length"
                        info="For an exact length, such as a 4-digit PIN, use the same number twice." />
            <EndKey node={node} onChange={onChange} errors={errs('terminators')} info="A key the caller presses to finish early." />
            <VariableField node={node} onChange={onChange} controls={controls} errors={errs('variable_name')} label="Save as variable" />
          </InspectorBlock>
          <InspectorBlock title="Routes" summary={`${routes.length} of ${MAX_ROUTES}`}
                          info="Checked top to bottom; the first match wins. Each route is its own exit. Anything that matches no route goes to Any valid entry.">
            {routes.length === 0 && <Note>No routes — every complete entry goes to Any valid entry.</Note>}
            {routes.map((r, i) => (
              <RouteRow key={r.id} route={r} index={i} count={routes.length} {...pickerProps}
                        warnings={routeWarns.filter(w => w.index === i).map(w => w.message)} />
            ))}
            {(errs('routes') || []).length > 0 && <Messages errors={errs('routes')} />}
            <button type="button" onClick={() => { const p = addRoutePatch(node); if (p) onChange(p); }}
                    disabled={routes.length >= MAX_ROUTES}
                    className="text-[11px] text-brand hover:text-brand/80 disabled:text-text-muted">+ Add route</button>
            <ExitRow label="Any valid entry" info="Every complete entry that matches no route."
                     errors={errs('branch:_default')}
                     warning={anyOtherSet || routes.length ? null : 'Choose where the call goes after the digits are entered'}>
              <Picker branchKey="_default" {...pickerProps} placeholder="Not connected" />
            </ExitRow>
          </InspectorBlock>
        </>
      ) : (
        <InspectorBlock title="Options" summary={`${rows.options.length} option${rows.options.length === 1 ? '' : 's'}`}
                        info="The keys a caller can press and where each one goes. The label is shown on the canvas exit.">
          {rows.options.length === 0 && <Note>No options yet — add the keys callers can press.</Note>}
          {rows.options.map(k => <OptionRow key={k} optKey={k} {...pickerProps} errors={errs(`branch:${k}`)} />)}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <button type="button" onClick={() => { const p = addOptionPatch(node); if (p) onChange(p); }} disabled={!free}
                    title={free ? `Adds key ${free}` : 'All keypad keys are used'}
                    className="text-[11px] text-brand hover:text-brand/80 disabled:text-text-muted">+ Add option</button>
            {!rows.anyOther && !showAnyOther && (
              <button type="button" onClick={() => setShowAnyOther(true)}
                      className="text-[11px] text-text-muted hover:text-brand">+ {defaultExitName(node)}</button>
            )}
          </div>
          {(rows.anyOther || showAnyOther) && (
            <ExitRow label={defaultExitName(node)} info="Catches every key that isn't an option. While it is connected, wrong keys go here instead of being retried."
                     errors={errs('branch:_default')}>
              <Picker branchKey="_default" {...pickerProps} />
            </ExitRow>
          )}
          <Messages errors={errs('branches')} />
        </InspectorBlock>
      )}

      <InspectorBlock title="When something goes wrong"
                      info="Retries happen inside the node. After the last retry the caller leaves through Failed — or, with separate exits, through No input or Invalid.">
        {!hasAnyExit(node) && <Note tone="warn">Connect at least one exit before publishing.</Note>}
        {separate && (
          <>
            <ExitRow label="No input" info={internal ? 'No digits within the wait time.' : 'No digits within the wait time (no retry).'}
                     errors={errs(internal ? 'branch:no_input' : 'branch:timeout')}
                     warning={unguarded.has('noResponse') ? DISCONNECTED : null}>
              <Picker branchKey={internal ? 'no_input' : 'timeout'} {...pickerProps} />
            </ExitRow>
            <ExitRow label="Invalid" info="A wrong key, or an entry no route matched."
                     errors={errs(internal ? 'branch:invalid_option' : 'branch:invalid')}
                     warning={unguarded.has('wrongKey') ? DISCONNECTED : null}>
              {anyOtherSet && !isWired(node, internal ? 'invalid_option' : 'invalid')
                ? <Note>Goes to {defaultExitName(node)}</Note>
                : <Picker branchKey={internal ? 'invalid_option' : 'invalid'} {...pickerProps} />}
            </ExitRow>
            {internal && tooFew && rows.tooFew && (
              <ExitRow label="Invalid (too short)" errors={errs('branch:invalid_length')}
                       warning={unguarded.has('tooFew') ? DISCONNECTED : null}>
                <Picker branchKey="invalid_length" {...pickerProps} />
              </ExitRow>
            )}
          </>
        )}
        {failedRow}
        {rows.other.map(k => (
          <ExitRow key={k} label={menuExitLabel(node, k)} errors={errs(`branch:${k}`)}
                   info="A saved connection the current settings use only as a fallback, or not at all.">
            <Picker branchKey={k} {...pickerProps} />
          </ExitRow>
        ))}
      </InspectorBlock>

      <div className="py-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-surface-border/60">
        <span className="text-[11px] text-text-secondary">{summaryLine(node)}</span>
        <button type="button" onClick={advanced ? () => setAdvanced(false) : openAdvanced} className="text-[11px] text-brand hover:underline">
          {advanced ? 'Hide' : 'Customize'}
        </button>
      </div>

      <div ref={advancedRef}>
        <InspectorSection
          key={advanced ? 'open' : 'closed'}
          title="Advanced"
          defaultOpen={advanced}
          forceOpen={hasErr(['max_attempts', 'timeout_seconds', 'inter_digit_timeout', 'reprompt_pause_ms', 'retry_mode', ...MESSAGE_FIELDS,
            ...(digits ? [] : ['min_digits', 'max_digits', 'variable_name', 'terminators'])])}
        >
          <OlderSettings node={node} onChange={onChange} />
          {internal && (
            <StackRow label={<FieldLabel info="How many more times the caller can try after the first attempt. 0 = one try." modified={isModified(node, 'max_attempts')}>Retries</FieldLabel>}
                      errors={errs('max_attempts')} warning={eff.attemptsSet ? null : 'Not set — the caller gets 1 try'}>
              <span className="flex items-center gap-1.5">
                <NumberField value={eff.attemptsSet ? eff.attempts - 1 : undefined}
                             onChange={v => { const p = retriesPatch(v); if (p) onChange(p); }}
                             min={0} max={9} allowEmpty={false} placeholder="2" ariaLabel="Retries" width="w-14" />
                <span className="text-[11px] text-text-muted">{eff.attempts} {eff.attempts === 1 ? 'try' : 'tries'} in total</span>
              </span>
            </StackRow>
          )}
          <StackRow label={<FieldLabel info={`Seconds to wait for the first key. Empty uses ${runtimeDefault(node, 'timeout_seconds')} s.`} modified={isModified(node, 'timeout_seconds')}>First-digit timeout</FieldLabel>}
                    errors={errs('timeout_seconds')}>
            <NumberField value={node.timeout_seconds} onChange={v => onChange({ timeout_seconds: v })} min={1} max={60}
                         placeholder={String(runtimeDefault(node, 'timeout_seconds'))} unit="s" ariaLabel="First-digit timeout, seconds" width="w-14" />
          </StackRow>
          <StackRow label={<FieldLabel info="Seconds allowed between digits. 0 uses the engine default." modified={isModified(node, 'inter_digit_timeout')}>Inter-digit timeout</FieldLabel>}
                    errors={errs('inter_digit_timeout')}>
            <NumberField value={node.inter_digit_timeout} onChange={v => onChange({ inter_digit_timeout: v })} min={0} max={30}
                         placeholder="2" unit="s" ariaLabel="Inter-digit timeout, seconds" width="w-14" />
          </StackRow>
          {internal && (
            <>
              <MessageField slot="no_input" label="No-input prompt" info="Played before asking again after no input. Replay prompt = just play the main prompt again."
                            node={node} onChange={onChange} controls={controls} fieldErrors={fieldErrors} />
              <MessageField slot="invalid_option" label="Invalid prompt" info="Played before asking again after a wrong key, too few digits, or no matching route."
                            node={node} onChange={p => onChange(withInvalidLength(p))} controls={controls} fieldErrors={fieldErrors} />
              {sourceOf(node, 'invalid_length') !== sourceOf(node, 'invalid_option')
                || (node.invalid_length_text ?? '') !== (node.invalid_option_text ?? '') ? (
                  <Note>Too-few-digits uses a different prompt (older setting). Editing the Invalid prompt replaces it; "Show all fields" edits it alone.</Note>
                ) : null}
              <MessageField slot="max_attempts_exceeded" label="Failed prompt" info="Played once before the caller leaves through Failed."
                            node={node} onChange={onChange} controls={controls} fieldErrors={fieldErrors} replay={false} />
              <StackRow label={<FieldLabel info="Short silence after a retry prompt." modified={isModified(node, 'reprompt_pause_ms')}>Re-prompt pause</FieldLabel>}
                        errors={errs('reprompt_pause_ms')}>
                <NumberField value={node.reprompt_pause_ms} onChange={v => onChange({ reprompt_pause_ms: v })}
                             min={0} max={5000} placeholder="700" unit="ms" width="w-20" ariaLabel="Re-prompt pause, milliseconds" />
              </StackRow>
            </>
          )}
          {mode !== MODE.CLASSIC && (
            <InlineRow label={<FieldLabel info="The first key stops the prompt and counts as input." modified={isModified(node, 'allow_barge_in')}>Barge-in</FieldLabel>}>
              <Switch checked={eff.allow_barge_in} onChange={on => onChange(togglePatch('allow_barge_in', on))} label="Barge-in" />
            </InlineRow>
          )}
          {internal && (
            <InlineRow label={<FieldLabel info="Off: every failure is retried, then leaves through Failed. On: after the retries, No input and Invalid get their own exits." modified={isModified(node, 'separate')}>Separate exits for No input and Invalid</FieldLabel>}>
              <Switch checked={separate} onChange={toggleSeparate} label="Separate exits for No input and Invalid" />
            </InlineRow>
          )}
          {!digits && (
            <>
              <DigitCount node={node} onChange={onChange} fieldErrors={fieldErrors} label="Digits per entry"
                          info="Set automatically from the longest option key. Raise it for keys such as 10 or 25." />
              <VariableField node={node} onChange={onChange} controls={controls} errors={errs('variable_name')} label="Save the key to variable" />
              <EndKey node={node} onChange={onChange} errors={errs('terminators')} info="Best left at None for a key menu." />
            </>
          )}
          <div className="flex items-center justify-between pt-1">
            <button type="button" onClick={() => onChange(resetAdvancedPatch(node))}
                    className="flex items-center gap-1 text-[11px] text-text-muted hover:text-brand">
              <RotateCcw size={11} /> Reset to defaults
            </button>
          </div>
          <ShowAllFields renderAllFields={renderAllFields} />
        </InspectorSection>
      </div>
    </div>
  );
}
