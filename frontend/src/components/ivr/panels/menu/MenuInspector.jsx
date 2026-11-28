import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { confirmAction } from '../../../ui/ConfirmDialog.jsx';
import {
  Switch, Segmented, InfoTip, InspectorSection, InspectorBlock, Messages, InlineRow, StackRow, NumberField,
} from '../inspectorControls.jsx';
import {
  MODE, MODE_LABELS, COLLECT, effective, runtimeDefault, sourceOf, menuRows, unguardedRows,
  showTooFewDigits, togglePatch, sourcePatch, modePatch, collectType, collectTypePatch, retriesPatch,
  nextFreeKey, addOptionPatch, validateOptionKey, optionKeyWarning, renameOptionPatch, removeBranchPatch,
  setBranchPatch, menuExitLabel, defaultExitName, isWired, hasAnyExit,
  WRONG_KEY, wrongKeyChoice, wrongKeyGoKey, wrongKeyChoicePatch, simulateEntry, describeEntry,
} from './menuModel.js';
import { nodeDisplayNames } from '../../canvas/nodeIdentity.js';

// Purpose-built inspector body for the Menu (Gather DTMF) node. One page that
// reads top to bottom as the questions an administrator asks:
//   1. What the caller hears
//   2. Keys the caller can press (or: The number the caller enters)
//   3. If the caller gets it wrong (no input / wrong key / too few digits / after the last try)
//   4. More settings (collapsed: timing, barge-in, failure handling, all fields)
//
// PRESENTATION ONLY: it edits the same stored fields as the generic panel, in
// the same formats, and never writes anything just because a node was opened.
// Call behaviour (exec_gather) is untouched. Every output the canvas draws
// appears here exactly once (menuModel.menuRows).
// All sub-components are module-scope so native <select>s reconcile in place
// (see branchRowRegression.test.js for why that matters).

const COLLECT_TYPES = [
  { value: COLLECT.MENU,   label: 'Presses a key' },
  { value: COLLECT.DIGITS, label: 'Enters a number' },
];
const PROMPT_SOURCES = [
  { value: 'audio', label: 'Audio file' },
  { value: 'tts',   label: 'Text to speech' },
  { value: 'none',  label: 'Nothing' },
];
const MESSAGE_SOURCES = [
  { value: 'none',  label: 'No message' },
  { value: 'tts',   label: 'Speak text' },
  { value: 'audio', label: 'Audio file' },
];
const THEN = [
  { value: 'retry', label: 'Ask again' },
  { value: 'exit',  label: 'Go to a node' },
];
const WRONG_KEY_CHOICES = [
  { value: WRONG_KEY.RETRY, label: 'Ask again' },
  { value: WRONG_KEY.GO,    label: 'Go straight to a node' },
];
const TERMINATORS = [
  { value: '',  label: 'None' },
  { value: '#', label: '#' },
  { value: '*', label: '*' },
];
const DISCONNECTED = 'Callers who reach this are disconnected — choose a destination';
const MESSAGE_FIELDS = ['no_input', 'invalid_option', 'invalid_length', 'max_attempts_exceeded']
  .flatMap(s => [`${s}_text`, `${s}_audio_url`, `${s}_source_type`]);
const MORE_FIELDS = ['retry_mode', 'inter_digit_timeout', 'reprompt_pause_ms'];


function Note({ children, tone = 'muted' }) {
  const cls = tone === 'warn' ? 'text-amber-500' : 'text-text-muted';
  return <p className={`text-[11px] leading-relaxed ${cls}`}>{children}</p>;
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

/** A label on the left, a control on the right (or the label above, when `stacked`). */
function Row({ label, info, errors, warning, stacked = false, children }) {
  return (
    <div>
      <div className={`relative ${stacked ? 'space-y-1' : 'flex items-center gap-2'}`}>
        <span className={`${stacked ? '' : 'w-[84px] shrink-0 '}flex items-center gap-1 text-[11px] text-text-secondary`}>
          <span>{label}</span>
          {info && <InfoTip text={info} />}
        </span>
        <div className="flex-1 min-w-0 flex items-center gap-1.5">{children}</div>
      </div>
      <Messages errors={errors} warning={warning} />
    </div>
  );
}

/** One situation in "If the caller gets it wrong": a titled card. */
function Situation({ title, children }) {
  return (
    <div className="rounded-md border border-surface-border bg-surface-bg/40 px-2.5 py-2 space-y-2">
      <p className="text-xs font-medium text-text-primary">{title}</p>
      {children}
    </div>
  );
}

/** One menu option: key, destination, remove. */
function OptionRow({ node, optKey, nodes, byType, onChange, controls, errors }) {
  const { NodePicker } = controls;
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
    : !target ? 'Choose where this key goes — keys without a destination are not saved'
    : optionKeyWarning(node, optKey);

  return (
    <div>
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
          title="Key the caller presses (click to change)"
          className={`w-11 shrink-0 bg-surface-bg border rounded-md px-1 py-1 text-xs font-mono font-semibold text-center text-text-primary
                      focus:outline-none transition-colors ${keyError ? 'border-red-400' : 'border-surface-border focus:border-brand'}`}
        />
        <span aria-hidden className="text-text-muted text-[11px]">→</span>
        <div className="flex-1 min-w-0">
          <NodePicker
            value={target}
            onChange={v => onChange(setBranchPatch(node, optKey, v))}
            nodes={nodes}
            excludeId={node.id}
            placeholder="Choose destination…"
            byType={byType}
          />
        </div>
        <button
          type="button"
          onClick={() => onChange(removeBranchPatch(node, optKey))}
          aria-label={`Remove key ${optKey}`}
          title="Remove key"
          className="shrink-0 p-1 text-text-muted hover:text-red-400 transition-colors"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <Messages errors={keyError ? [keyError, ...(errors || [])] : errors} warning={advice} />
    </div>
  );
}

/** A message the caller hears (No message / Speak text / Audio file) plus its text or file. */
function MessageField({ slot, label, node, onChange, controls, fieldErrors, placeholder }) {
  const { InterpolableTextarea, MediaPickerField } = controls;
  const src = sourceOf(node, slot);
  return (
    <div className="space-y-1.5">
      <StackRow label={label}>
        <Segmented value={src} options={MESSAGE_SOURCES} label={label} onChange={v => onChange(sourcePatch(slot, v))} />
      </StackRow>
      {src === 'tts' && (
        <StackRow errors={fieldErrors[`${slot}_text`]}>
          <InterpolableTextarea
            value={node[`${slot}_text`]}
            onChange={v => onChange({ [`${slot}_text`]: v })}
            placeholder={placeholder}
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
    </div>
  );
}

/**
 * One retryable failure (no input, wrong key, too few digits): Ask again
 * (retry_on_<slot> = yes, with an optional message) or Go to a node
 * (retry_on_<slot> = no, with the <slot> exit).
 */
function RetryOrExit({ slot, node, onChange, controls, fieldErrors, pickerProps, unguarded, placeholder }) {
  const eff = effective(node);
  const retry = eff.retry[slot];
  return (
    <>
      <Row label="Then">
        <Segmented
          value={retry ? 'retry' : 'exit'}
          options={THEN}
          label="Then"
          onChange={v => onChange(togglePatch(`retry_on_${slot}`, v === 'retry'))}
        />
      </Row>
      {retry ? (
        <>
          <MessageField slot={slot} label="Say first (optional)" node={node} onChange={onChange} controls={controls}
                        fieldErrors={fieldErrors} placeholder={placeholder} />
          <InlineRow label="Play the menu prompt again" info="After the message, play the main prompt again before waiting for keys.">
            <Switch checked={eff.replay[slot]} onChange={on => onChange(togglePatch(`${slot}_replay_menu`, on))}
                    label="Play the menu prompt again" />
          </InlineRow>
        </>
      ) : (
        <Row label="Go to" errors={fieldErrors[`branch:${slot}`]} warning={unguarded ? DISCONNECTED : null}>
          <Picker branchKey={slot} {...pickerProps} />
        </Row>
      )}
    </>
  );
}

function RetriesField({ node, onChange, errors }) {
  const eff = effective(node);
  return (
    <Row
      label="Tries"
      info="How many times the caller can try in total. Each no-input or wrong key that is asked again uses one try."
      errors={errors}
      warning={eff.attemptsSet ? null : 'Not set — the caller gets 1 try'}
    >
      <NumberField
        value={eff.attemptsSet ? eff.attempts : undefined}
        onChange={v => { const p = retriesPatch(Number(v) - 1); if (p) onChange(p); }}
        min={1} max={10}
        allowEmpty={false}
        placeholder="3"
        ariaLabel="Tries in total"
        width="w-12"
      />
      <span className="text-[11px] text-text-muted">in total</span>
    </Row>
  );
}

function DigitCount({ node, onChange, fieldErrors, label, info, collectsDigits = false }) {
  const eff = effective(node);
  return (
    <Row
      label={label}
      info={info}
      errors={[...(fieldErrors.min_digits || []), ...(fieldErrors.max_digits || [])]}
      warning={eff.min_digits > eff.max_digits ? 'Minimum is larger than maximum' : null}
    >
      <NumberField value={node.min_digits} onChange={v => onChange({ min_digits: v })} min={1} max={11}
                   placeholder="1" ariaLabel="Minimum digits" width="w-12" />
      <span className="text-[11px] text-text-muted">to</span>
      <NumberField value={node.max_digits} onChange={v => onChange({ max_digits: v })}
                   min={collectsDigits ? 2 : 1} max={11} allowEmpty={!collectsDigits}
                   placeholder="1" ariaLabel="Maximum digits" width="w-12" />
    </Row>
  );
}

function EndKey({ node, onChange, errors, info }) {
  const terminator = effective(node).terminators;
  const known = TERMINATORS.some(t => t.value === terminator);
  return (
    <Row label="End key" info={info} errors={errors}>
      {known
        ? <Segmented value={terminator} options={TERMINATORS} label="End key" onChange={v => onChange({ terminators: v })} />
        : <p className="text-xs font-mono text-text-primary">{terminator}</p>}
    </Row>
  );
}

function VariableField({ node, onChange, controls, errors, label }) {
  const { TextInput } = controls;
  return (
    <StackRow label={label} info="Later nodes read the entry from this variable, for example a Condition." errors={errors}>
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

function WarningList({ warnings }) {
  if (!warnings?.length) return null;
  return (
    <div className="mb-2 px-2.5 py-2 rounded-md bg-amber-500/10 border border-amber-500/20 space-y-1">
      {warnings.map((w, i) => (
        <p key={i} className="text-[11px] text-amber-500">{String(w).replace(/^Node "[^"]+" \([^)]*\):\s*/, '')}</p>
      ))}
    </div>
  );
}

// ── 1. What the caller hears ───────────────────────────────────────────────

function HearsSection({ node, onChange, fieldErrors, controls }) {
  const digits = collectType(node) === COLLECT.DIGITS;
  const src = effective(node).prompt_source_type;
  const rows = menuRows(node);

  const chooseCollect = async target => {
    const n = rows.options.length;
    if (target === COLLECT.DIGITS && n > 0) {
      const ok = await confirmAction({
        title: 'Collect a number instead of keys?',
        message: `This removes ${n === 1 ? 'key' : `the ${n} keys`} ${rows.options.join(', ')} and their destinations. `
          + 'Every number the caller enters then goes to one destination.',
        confirmLabel: 'Remove keys',
        variant: 'warning',
      });
      if (!ok) return;
    }
    const p = collectTypePatch(node, target);
    if (p) onChange(p);
  };

  return (
    <InspectorBlock title="1. What the caller hears">
      <Segmented value={src} options={PROMPT_SOURCES} label="Prompt" onChange={v => onChange(sourcePatch('prompt', v))} />
      {src === 'tts' && (
        <StackRow
          errors={fieldErrors.prompt_text}
          warning={String(node.prompt_text || '').trim() ? null : 'Callers hear nothing before the menu'}
        >
          <controls.InterpolableTextarea
            value={node.prompt_text}
            onChange={v => onChange({ prompt_text: v })}
            placeholder={digits ? 'Please enter your 4-digit PIN.' : 'For billing, press 1. For support, press 2.'}
            rows={3}
            compact
          />
        </StackRow>
      )}
      {src === 'audio' && (
        <StackRow errors={fieldErrors.prompt_audio_url}>
          <controls.MediaPickerField value={node.prompt_audio_url} onChange={v => onChange({ prompt_audio_url: v })} />
        </StackRow>
      )}
      {src === 'none' && <Note>Nothing is played — the node waits for keys straight away.</Note>}
      <Row stacked label="The caller" info="Presses a key: each key goes to its own destination. Enters a number: a PIN or account number, saved to a variable.">
        <Segmented value={digits ? COLLECT.DIGITS : COLLECT.MENU} options={COLLECT_TYPES} label="The caller" onChange={chooseCollect} />
      </Row>
    </InspectorBlock>
  );
}

// ── 2. Keys the caller can press / The number the caller enters ────────────

function KeysSection({ node, nodes, byType, onChange, fieldErrors, controls }) {
  const [showAnyOther, setShowAnyOther] = useState(false);
  const eff = effective(node);
  const rows = menuRows(node);
  const free = nextFreeKey(node);
  const pickerProps = { node, nodes, byType, onChange, controls };
  // Retry in this node: "Any other key" is the "Go straight to a node" answer in section 3.
  const anyOtherHere = eff.mode !== MODE.INTERNAL;
  return (
    <InspectorBlock title="2. Keys the caller can press" summary={`${rows.options.length} ${rows.options.length === 1 ? 'key' : 'keys'}`}>
      {rows.options.length === 0 && <Note>No keys yet — add the keys callers can press and where each one goes.</Note>}
      {rows.options.map(k => (
        <OptionRow key={k} optKey={k} {...pickerProps} errors={fieldErrors[`branch:${k}`]} />
      ))}
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => { const p = addOptionPatch(node); if (p) onChange(p); }}
          disabled={!free}
          title={free ? `Adds key ${free}` : 'All keypad keys are used'}
          className="text-[11px] text-brand hover:text-brand/80 disabled:text-text-muted disabled:cursor-not-allowed"
        >
          + Add key
        </button>
        {anyOtherHere && !rows.anyOther && !showAnyOther && (
          <button type="button" onClick={() => setShowAnyOther(true)}
                  title="Send every key that isn't listed to one destination"
                  className="text-[11px] text-text-muted hover:text-brand transition-colors">
            + {defaultExitName(node)}
          </button>
        )}
      </div>
      {anyOtherHere && (rows.anyOther || showAnyOther) && (
        <Row
          stacked
          label={defaultExitName(node)}
          info="Every key that isn't listed above goes here."
          errors={fieldErrors['branch:_default']}
        >
          <Picker branchKey="_default" {...pickerProps} />
        </Row>
      )}
      {eff.max_digits > 1 && (
        <Note>
          Callers can enter up to {eff.max_digits} digits per key. Collecting a PIN or account number?
          Choose <span className="text-text-secondary">Enters a number</span> above.
        </Note>
      )}
      <Messages errors={fieldErrors.branches} />
    </InspectorBlock>
  );
}

function NumberSection({ node, nodes, byType, onChange, fieldErrors, controls }) {
  const eff = effective(node);
  const pickerProps = { node, nodes, byType, onChange, controls };
  return (
    <InspectorBlock title="2. The number the caller enters">
      <Row
        stacked
        label="When the number is entered, go to"
        info="Every entry of the right length goes here. This only checks the length: check whether a PIN is correct in the next node, for example a Condition or REST API."
        errors={fieldErrors['branch:_default']}
        warning={isWired(node, '_default') ? null : 'Not connected — choose where the call goes after the number is entered'}
      >
        <Picker branchKey="_default" {...pickerProps} placeholder="Choose destination…" />
      </Row>
      <DigitCount
        node={node}
        onChange={onChange}
        fieldErrors={fieldErrors}
        collectsDigits
        label="Digits"
        info="For an exact length, such as a 4-digit PIN, use the same number twice."
      />
      <EndKey node={node} onChange={onChange} errors={fieldErrors.terminators}
              info="A key the caller presses to finish early. Useful when the length varies." />
      <BetweenDigitsField node={node} onChange={onChange} fieldErrors={fieldErrors}
                          info="When the caller stops typing for this long, the entry ends. Fewer digits than the minimum count as too few." />
      <VariableField node={node} onChange={onChange} controls={controls} errors={fieldErrors.variable_name} label="Save as variable" />
      <Note>
        Later nodes use it as <code className="font-mono text-text-secondary">{'${' + eff.variable_name + '}'}</code>.
        This checks the length only — check the PIN itself in the next node.
      </Note>
    </InspectorBlock>
  );
}

// ── 3. If the caller gets it wrong ─────────────────────────────────────────

function BetweenDigitsField({ node, onChange, fieldErrors, info, inline = false }) {
  const label = 'Time between digits';
  const field = (
    <NumberField value={node.inter_digit_timeout} onChange={v => onChange({ inter_digit_timeout: v })}
                 min={0} max={30} placeholder="2" unit="s" ariaLabel="Time between digits, seconds" />
  );
  const fullInfo = `${info} 0 uses the engine default. Empty uses 2 s.`;
  return inline
    ? <InlineRow label={label} info={fullInfo} errors={fieldErrors.inter_digit_timeout}>{field}</InlineRow>
    : <Row label={label} info={fullInfo} errors={fieldErrors.inter_digit_timeout}>{field}</Row>;
}

function WaitField({ node, onChange, fieldErrors }) {
  const what = collectType(node) === COLLECT.DIGITS ? 'the first digit' : 'a key';
  return (
    <Row label="Wait" info={`Seconds to wait for ${what} after the prompt. Empty uses ${runtimeDefault(node, 'timeout_seconds')} s.`}
         errors={fieldErrors.timeout_seconds}>
      <NumberField
        value={node.timeout_seconds}
        onChange={v => onChange({ timeout_seconds: v })}
        min={1} max={60}
        placeholder={String(runtimeDefault(node, 'timeout_seconds'))}
        unit="s"
        ariaLabel="Wait for a key, seconds"
      />
    </Row>
  );
}

function ClassicUpgrade({ node, onChange }) {
  const upgrade = async () => {
    const ok = await confirmAction({
      title: 'Make retries adjustable',
      message: 'This Menu node uses classic retries (3 fixed tries). Switch it to adjustable retries, starting with 3 tries? '
        + 'You can then choose what happens on no input and on a wrong key. Review them before publishing.',
      confirmLabel: 'Switch',
      variant: 'warning',
    });
    if (ok) onChange(modePatch(node, MODE.INTERNAL));
  };
  return (
    <div className="space-y-1.5">
      <Note>
        This is an older Menu node with 3 fixed tries: audio prompts are replayed; with a text prompt, no input moves on
        at once.
      </Note>
      <button type="button" onClick={upgrade}
              className="text-[11px] px-2 py-1 rounded-md bg-brand/10 text-brand border border-brand/20 hover:bg-brand/20 transition-colors">
        Make retries adjustable
      </button>
    </div>
  );
}

/**
 * Key menu, Retry in this node: one choice for a key that isn't listed.
 * Ask again (wrong-key message, then the menu again) or go straight to a node
 * (the "Any other key" exit). Never both, so they can't silently compete.
 */
function WrongKeyCard({ node, onChange, controls, fieldErrors, pickerProps, unguarded }) {
  const eff = effective(node);
  const choice = wrongKeyChoice(node);
  const goKey = wrongKeyGoKey(node);
  const choose = async v => {
    if (v === choice) return;
    if (v === WRONG_KEY.RETRY && isWired(node, '_default')) {
      const ok = await confirmAction({
        title: 'Ask again on a wrong key?',
        message: 'This disconnects “Any other key”. Keys that aren\'t listed then play the wrong-key message and ask again, '
          + 'using one of the tries.',
        confirmLabel: 'Ask again',
        variant: 'warning',
      });
      if (!ok) return;
    }
    const p = wrongKeyChoicePatch(node, v);
    if (p) onChange(p);
  };
  return (
    <Situation title="Presses a key that isn’t listed">
      <Segmented value={choice} options={WRONG_KEY_CHOICES} label="Key that isn't listed" onChange={choose} />
      {choice === WRONG_KEY.RETRY ? (
        <>
          <MessageField slot="invalid_option" label="Say first (optional)" node={node} onChange={onChange} controls={controls}
                        fieldErrors={fieldErrors} placeholder="That is not a valid option." />
          <InlineRow label="Play the menu prompt again" info="After the message, play the main prompt again before waiting for keys.">
            <Switch checked={eff.replay.invalid_option} onChange={on => onChange(togglePatch('invalid_option_replay_menu', on))}
                    label="Play the menu prompt again" />
          </InlineRow>
        </>
      ) : (
        <Row label="Go to" info="No message and no retry: the call goes straight here."
             errors={fieldErrors[`branch:${goKey}`]} warning={unguarded ? DISCONNECTED : null}>
          <Picker branchKey={goKey} {...pickerProps} />
        </Row>
      )}
    </Situation>
  );
}

function WrongSection({ node, nodes, byType, onChange, fieldErrors, controls }) {
  const eff = effective(node);
  const mode = eff.mode;
  const digits = collectType(node) === COLLECT.DIGITS;
  const rows = menuRows(node);
  const unguarded = unguardedRows(node);
  // Too few digits can only happen when more than one digit is required (or its exit is still connected).
  const tooFew = showTooFewDigits(node) && (eff.min_digits > 1 || !!rows.tooFew);
  const pickerProps = { node, nodes, byType, onChange, controls };
  const wrongName = digits ? 'Enters a wrong number' : 'Presses a key that isn’t listed';
  const errs = k => fieldErrors[k];
  const common = { node, onChange, controls, fieldErrors, pickerProps };

  if (mode !== MODE.INTERNAL) {
    const classic = mode === MODE.CLASSIC;
    return (
      <InspectorBlock title="3. If the caller gets it wrong">
        {classic
          ? <ClassicUpgrade node={node} onChange={onChange} />
          : <Note>One attempt: there are no retries — each problem goes straight to its destination.</Note>}
        <Situation title="Presses nothing">
          <WaitField node={node} onChange={onChange} fieldErrors={fieldErrors} />
          <Row label="Go to" info={classic ? 'If empty: Any other key.' : null} errors={errs('branch:timeout')}
               warning={unguarded.has('noResponse') ? DISCONNECTED : null}>
            <Picker branchKey="timeout" {...pickerProps} />
          </Row>
        </Situation>
        <Situation title={wrongName}>
          <Row label="Go to" errors={errs('branch:invalid')} warning={unguarded.has('wrongKey') ? DISCONNECTED : null}>
            <Picker branchKey="invalid" {...pickerProps} />
          </Row>
        </Situation>
      </InspectorBlock>
    );
  }

  const seconds = eff.timeout_seconds;
  // A number of the right length always leaves through "Number entered", so a
  // "wrong number" can only happen while that exit is not connected.
  const showWrong = !digits || !isWired(node, '_default');
  return (
    <InspectorBlock title="3. If the caller gets it wrong">
      <Situation title={`Presses nothing for ${seconds} s`}>
        <WaitField node={node} onChange={onChange} fieldErrors={fieldErrors} />
        <RetryOrExit slot="no_input" {...common} unguarded={unguarded.has('noResponse')}
                     placeholder="We didn't receive any input." />
      </Situation>

      {showWrong && (digits ? (
        <Situation title="Enters a number while “Number entered” isn't connected">
          <RetryOrExit slot="invalid_option" {...common} unguarded={unguarded.has('wrongKey')}
                       placeholder="That number is not valid." />
        </Situation>
      ) : (
        <WrongKeyCard {...common} unguarded={unguarded.has('wrongKey')} />
      ))}

      {tooFew && (
        <Situation title="Enters too few digits">
          <RetryOrExit slot="invalid_length" {...common} unguarded={unguarded.has('tooFew')}
                       placeholder="That number is too short." />
        </Situation>
      )}

      <Situation title={`Still not right after ${eff.attempts} ${eff.attempts === 1 ? 'try' : 'tries'}`}>
        <RetriesField node={node} onChange={onChange} errors={errs('max_attempts')} />
        <MessageField slot="max_attempts_exceeded" label="Say first (optional)" node={node} onChange={onChange}
                      controls={controls} fieldErrors={fieldErrors} placeholder="Sorry, we could not process your request." />
        <Row label="Then go to" errors={errs('branch:max_attempts_exceeded')}
             warning={unguarded.has('exhausted') ? DISCONNECTED : null}>
          <Picker branchKey="max_attempts_exceeded" {...pickerProps} placeholder="Not connected" />
        </Row>
      </Situation>
    </InspectorBlock>
  );
}

// ── Test an entry ──────────────────────────────────────────────────────────

function TestEntry({ node, nodes, byType }) {
  const [typed, setTyped] = useState(null);
  const eff = effective(node);
  const digits = collectType(node) === COLLECT.DIGITS;
  if (eff.mode === MODE.CLASSIC) return null;
  const names = nodeDisplayNames(nodes, byType);
  const nameOf = id => names[id] || 'a missing node';
  const rows = menuRows(node);
  const samples = digits
    ? [
        ...(eff.min_digits > 1 ? [{ label: `${eff.min_digits - 1} digits`, value: '1234567890'.slice(0, eff.min_digits - 1) }] : []),
        { label: `${eff.max_digits} digits`, value: '1234567890'.slice(0, eff.max_digits) },
      ]
    : [
        ...rows.options.slice(0, 4).map(k => ({ label: k, value: k })),
        ...(['9', '7', '0', '8'].filter(k => !rows.options.includes(k)).slice(0, 1).map(k => ({ label: k, value: k }))),
      ];
  samples.push({ label: 'Nothing', value: '' });
  const result = typed === null ? null : simulateEntry(node, typed);
  return (
    <InspectorBlock title="Test an entry" info="Shows what happens on the first try, step by step as the call engine does it. Nothing is dialled or saved.">
      <div className="flex flex-wrap items-center gap-1">
        {samples.map(s => (
          <button key={s.label} type="button" onClick={() => setTyped(s.value)}
                  className={`px-2 py-0.5 rounded-md border text-[11px] font-mono transition-colors
                              ${typed === s.value ? 'border-brand text-brand' : 'border-surface-border text-text-secondary hover:text-text-primary'}`}>
            {s.label}
          </button>
        ))}
        <input
          value={typed ?? ''}
          onChange={e => setTyped(e.target.value.replace(/[^0-9*#]/g, '').slice(0, 24))}
          placeholder={digits ? 'Type an entry' : 'Type keys'}
          aria-label="Entry to test"
          className="w-24 bg-surface-bg border border-surface-border rounded-md px-1.5 py-0.5 text-[11px] font-mono text-text-primary
                     placeholder:text-text-muted focus:outline-none focus:border-brand"
        />
      </div>
      {result && (
        <div className="rounded-md bg-surface-hover/40 px-2.5 py-2 space-y-1 text-[11px] leading-relaxed text-text-secondary">
          {result.entry !== typed && typed !== '' && (
            <p className="text-text-muted">Counted as {result.entry || 'nothing'} (the entry ends at {result.entry.length === eff.max_digits ? `${eff.max_digits} digits` : 'the end key'}).</p>
          )}
          {describeEntry(node, result, nameOf).map((l, i) => (
            <p key={i} className={i === 0 ? 'text-text-primary' : ''}>{l}</p>
          ))}
        </div>
      )}
    </InspectorBlock>
  );
}

// ── Old connections the current settings don't use ─────────────────────────

function FallbackSection({ node, nodes, byType, onChange, fieldErrors, controls }) {
  const rows = menuRows(node);
  if (!rows.other.length) return null;
  const pickerProps = { node, nodes, byType, onChange, controls };
  return (
    <InspectorBlock
      title="Other connections"
      info="Connections saved on this node that its current settings use only as a fallback, or not at all. Clear any you don't need."
    >
      {rows.other.map(k => (
        <Row key={k} label={menuExitLabel(node, k)} errors={fieldErrors[`branch:${k}`]}>
          <Picker branchKey={k} {...pickerProps} />
        </Row>
      ))}
    </InspectorBlock>
  );
}

// ── 4. More settings ───────────────────────────────────────────────────────

function MoreSection({ node, onChange, fieldErrors, controls, renderAllFields }) {
  const eff = effective(node);
  const mode = eff.mode;
  const digits = collectType(node) === COLLECT.DIGITS;
  const errs = k => fieldErrors[k];
  const forceOpen = [...MORE_FIELDS, ...(digits ? [] : ['min_digits', 'max_digits', 'variable_name', 'terminators'])]
    .some(k => fieldErrors[k]?.length);
  return (
    <InspectorSection title="4. More settings" defaultOpen={false} forceOpen={forceOpen}>
      {mode === MODE.CLASSIC ? (
        <Note>Older node: audio prompts can always be interrupted; text prompts play in full.</Note>
      ) : (
        <InlineRow label="Keys interrupt the prompt" info="The first key stops the prompt and counts as input. Off: the prompt always plays in full.">
          <Switch checked={eff.allow_barge_in} onChange={on => onChange(togglePatch('allow_barge_in', on))}
                  label="Keys interrupt the prompt" />
        </InlineRow>
      )}
      {!digits && (eff.max_digits > 1 || errs('inter_digit_timeout')?.length) && (
        <BetweenDigitsField node={node} onChange={onChange} fieldErrors={fieldErrors} inline
                            info="Seconds allowed between the digits of a multi-digit key." />
      )}
      {mode === MODE.INTERNAL && (
        <InlineRow label="Pause before asking again" info="Short silence after a message, before the prompt plays again. Empty uses 700 ms."
                   errors={errs('reprompt_pause_ms')}>
          <NumberField value={node.reprompt_pause_ms} onChange={v => onChange({ reprompt_pause_ms: v })}
                       min={0} max={5000} placeholder="700" unit="ms" width="w-20" ariaLabel="Pause before asking again, milliseconds" />
        </InlineRow>
      )}
      {!digits && (
        <>
          <DigitCount
            node={node}
            onChange={onChange}
            fieldErrors={fieldErrors}
            label="Digits per key"
            info="1 to 1 for a one-key menu. Raise the maximum for keys with more than one digit, such as 10 or 25."
          />
          <VariableField node={node} onChange={onChange} controls={controls} errors={errs('variable_name')} label="Save the key to variable" />
          <EndKey node={node} onChange={onChange} errors={errs('terminators')}
                  info="A key the caller presses to finish early. Best left at None for a key menu." />
        </>
      )}
      <StackRow
        label="Failure handling"
        info="Retry in this node: problems are asked again here (section 3). One attempt: no retries; every problem leaves the node at once."
        errors={errs('retry_mode')}
      >
        {mode === MODE.CLASSIC ? (
          <p className="text-xs text-text-primary">{MODE_LABELS[MODE.CLASSIC]}</p>
        ) : (
          <controls.Select
            value={mode}
            onChange={v => { const p = modePatch(node, v); if (p) onChange(p); }}
            options={[
              { value: MODE.INTERNAL, label: MODE_LABELS[MODE.INTERNAL] },
              { value: MODE.EXTERNAL, label: MODE_LABELS[MODE.EXTERNAL] },
            ]}
          />
        )}
      </StackRow>
      <ShowAllFields renderAllFields={renderAllFields} />
    </InspectorSection>
  );
}

export default function MenuInspector({ node, nodes, byType, onChange, fieldErrors = {}, warnings = [], controls, renderAllFields }) {
  const digits = collectType(node) === COLLECT.DIGITS;
  const props = { node, nodes, byType, onChange, fieldErrors, controls };
  return (
    <div>
      <WarningList warnings={warnings} />
      <div className="pb-1">
        <DescriptionField key={node.id} node={node} onChange={onChange} />
      </div>
      {!hasAnyExit(node) && (
        <div className="mt-1 px-2.5 py-2 rounded-md bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-500">
          Connect at least one destination — the flow can't be saved until this Menu has one.
        </div>
      )}
      <HearsSection {...props} />
      {digits ? <NumberSection key={node.id} {...props} /> : <KeysSection key={node.id} {...props} />}
      <WrongSection {...props} />
      <FallbackSection {...props} />
      <TestEntry key={`test-${node.id}`} node={node} nodes={nodes} byType={byType} />
      <MoreSection {...props} renderAllFields={renderAllFields} />
    </div>
  );
}
