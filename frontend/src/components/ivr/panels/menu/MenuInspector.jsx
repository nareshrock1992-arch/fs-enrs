import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { confirmAction } from '../../../ui/ConfirmDialog.jsx';
import {
  Switch, Segmented, InfoTip, InspectorSection, InspectorBlock, InspectorTabs, Messages, InlineRow, StackRow, NumberField,
} from '../inspectorControls.jsx';
import {
  MODE, MODE_LABELS, COLLECT, effective, runtimeDefault, sourceOf, menuRows, sectionSummaries, unguardedRows,
  showTooFewDigits, togglePatch, sourcePatch, modePatch, collectType, collectTypePatch, retriesPatch,
  nextFreeKey, addOptionPatch, validateOptionKey, optionKeyWarning, renameOptionPatch, removeBranchPatch,
  setBranchPatch, menuExitLabel, defaultExitName, isWired, hasAnyExit,
} from './menuModel.js';

// Purpose-built inspector body for the Menu (Gather DTMF) node, in two tabs:
//   Settings — what the caller hears and how the input is collected;
//   Exits    — where the call goes (options, failures, retries used up).
//
// PRESENTATION ONLY: it edits the same stored fields as the generic panel, in
// the same formats, and never writes anything just because a node was opened.
// Every output the canvas draws appears in the Exits tab exactly once
// (menuModel.menuRows), under the same name (menuModel.menuExitLabel).
// All sub-components are module-scope so native <select>s reconcile in place
// (see branchRowRegression.test.js for why that matters).

const COLLECT_TYPES = [
  { value: COLLECT.MENU,   label: 'Menu' },
  { value: COLLECT.DIGITS, label: 'Digits (PIN, account)' },
];
const PROMPT_SOURCES = [
  { value: 'tts',   label: 'Text to speech' },
  { value: 'audio', label: 'Audio file' },
  { value: 'none',  label: 'None' },
];
const ANNOUNCE_SOURCES = [
  { value: 'none',  label: 'None' },
  { value: 'tts',   label: 'Speak' },
  { value: 'audio', label: 'Audio' },
];
const TERMINATORS = [
  { value: '',  label: 'None' },
  { value: '#', label: '#' },
  { value: '*', label: '*' },
];
const DISCONNECTED = 'Callers who reach this are disconnected — choose a destination';
const MESSAGE_FIELDS = ['no_input', 'invalid_option', 'invalid_length', 'max_attempts_exceeded']
  .flatMap(s => [`${s}_text`, `${s}_audio_url`, `${s}_source_type`]);

const isExitErrorKey = k => k === 'branches' || k.startsWith('branch:');
const countErrors = (fieldErrors, pick) =>
  Object.entries(fieldErrors || {}).reduce((n, [k, v]) => n + (pick(k) ? (v?.length || 0) : 0), 0);

function Note({ children, tone = 'muted' }) {
  const cls = tone === 'warn' ? 'text-amber-500' : 'text-text-muted';
  return <p className={`text-[10px] leading-relaxed ${cls}`}>{children}</p>;
}

function SubHeading({ children, info }) {
  return (
    <div className="relative flex items-center gap-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
      <span>{children}</span>
      {info && <InfoTip text={info} />}
    </div>
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

/** One exit: its name, then where it goes (a picker or a short status). */
function ExitRow({ label, info, errors, warning, stacked = false, children }) {
  return (
    <div>
      <div className={`relative ${stacked ? 'space-y-1' : 'flex items-center gap-2'}`}>
        <span className={`${stacked ? 'flex' : 'w-[108px] shrink-0 flex'} items-center gap-1 text-[11px] text-text-secondary min-w-0`}>
          <span className="truncate" title={label}>{label}</span>
          {info && <InfoTip text={info} />}
        </span>
        <div className="flex-1 min-w-0">{children}</div>
      </div>
      <Messages errors={errors} warning={warning} />
    </div>
  );
}

function RetriedHere({ onSettings }) {
  return (
    <p className="text-[11px] text-text-muted">
      Retried in this node
      {onSettings && (
        <> · <button type="button" onClick={onSettings} className="text-brand hover:underline">Change</button></>
      )}
    </p>
  );
}

function GoesTo({ node }) {
  return <p className="text-[11px] text-text-muted">Goes to {defaultExitName(node)}</p>;
}

/** One menu option: editable key → destination, removable. */
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
    : !target ? 'Choose a destination — options without one are not saved'
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
          title="Key the caller presses"
          className={`w-11 shrink-0 bg-surface-bg border rounded-md px-1 py-1 text-xs font-mono text-center text-text-primary
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
          aria-label={`Remove option ${optKey}`}
          title="Remove option"
          className="shrink-0 p-1 text-text-muted hover:text-red-400 transition-colors"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <Messages errors={keyError ? [keyError, ...(errors || [])] : errors} warning={advice} />
    </div>
  );
}

/** Message source (None / Speak / Audio) plus its text or audio file. */
function Announcement({ slot, label, info, node, onChange, controls, fieldErrors }) {
  const { InterpolableTextarea, MediaPickerField } = controls;
  const src = sourceOf(node, slot);
  return (
    <div className="space-y-1.5">
      <StackRow label={label} info={info}>
        <Segmented value={src} options={ANNOUNCE_SOURCES} label={label} onChange={v => onChange(sourcePatch(slot, v))} />
      </StackRow>
      {src === 'tts' && (
        <StackRow label="Text to speak" required errors={fieldErrors[`${slot}_text`]}>
          <InterpolableTextarea
            value={node[`${slot}_text`]}
            onChange={v => onChange({ [`${slot}_text`]: v })}
            placeholder={slot === 'max_attempts_exceeded' ? 'Sorry, we could not process your request.' : "Sorry, I didn't get that."}
            rows={2}
            compact
          />
        </StackRow>
      )}
      {src === 'audio' && (
        <StackRow label="Audio file" required errors={fieldErrors[`${slot}_audio_url`]}>
          <MediaPickerField value={node[`${slot}_audio_url`]} onChange={v => onChange({ [`${slot}_audio_url`]: v })} />
        </StackRow>
      )}
    </div>
  );
}

/** Retry messages, one failure type: the message and whether the prompt replays. */
function RetryMessage({ slot, title, node, onChange, controls, fieldErrors }) {
  const eff = effective(node);
  const final = slot === 'max_attempts_exceeded';
  return (
    <div className="space-y-2">
      <SubHeading>{title}</SubHeading>
      <Announcement
        slot={slot}
        label="Message"
        info={final
          ? 'Played once when the retries run out, before the caller leaves through Retries used up.'
          : 'Played before asking again. None asks again without a message.'}
        node={node}
        onChange={onChange}
        controls={controls}
        fieldErrors={fieldErrors}
      />
      {!final && (
        <InlineRow label="Replay the prompt afterwards" info="After the message, play the menu prompt again before collecting.">
          <Switch
            checked={eff.replay[slot]}
            onChange={on => onChange(togglePatch(`${slot}_replay_menu`, on))}
            label={`Replay the prompt after the ${title.toLowerCase()} message`}
          />
        </InlineRow>
      )}
    </div>
  );
}

function RetrySwitch({ slot, label, exitName, node, onChange }) {
  const eff = effective(node);
  return (
    <InlineRow label={label} info={`Ask again, using one of the retries. Off: the caller leaves through the ${exitName} exit.`}>
      <Switch checked={eff.retry[slot]} onChange={on => onChange(togglePatch(`retry_on_${slot}`, on))} label={label} />
    </InlineRow>
  );
}

function ClassicUpgrade({ node, onChange }) {
  const upgrade = async () => {
    const ok = await confirmAction({
      title: 'Make retries adjustable',
      message: 'This Menu node uses classic retries (3 fixed tries). Switch it to adjustable retries, starting with 2 retries (3 tries)? '
        + 'Each failure type then gets its own retry setting, message and exit. Review them before publishing.',
      confirmLabel: 'Switch',
      variant: 'warning',
    });
    if (ok) onChange(modePatch(node, MODE.INTERNAL));
  };
  return (
    <div className="space-y-1.5">
      <Note>
        Classic retries: audio prompts are replayed; with a text prompt, no input moves on at once and too few digits
        plays a built-in reminder.
      </Note>
      <button type="button" onClick={upgrade}
              className="text-[11px] px-2 py-1 rounded-md bg-brand/10 text-brand border border-brand/20 hover:bg-brand/20 transition-colors">
        Make adjustable
      </button>
    </div>
  );
}

function RetriesRow({ node, onChange, errors }) {
  const eff = effective(node);
  if (eff.mode === MODE.CLASSIC) {
    return (
      <>
        <InlineRow label="Retries" info="Older Menu nodes give the caller 3 fixed tries. Make them adjustable to choose the number of retries and what happens on each failure.">
          <span className="text-[11px] text-text-primary">Fixed · 3 tries</span>
        </InlineRow>
        <ClassicUpgrade node={node} onChange={onChange} />
      </>
    );
  }
  if (eff.mode === MODE.EXTERNAL) {
    return (
      <InlineRow label="Retries" info="Failure handling is set to One attempt (Advanced): every failure leaves the node through its exit.">
        <span className="text-[11px] text-text-primary">None · 1 try</span>
      </InlineRow>
    );
  }
  return (
    <InlineRow
      label="Retries"
      required
      info="How many more times the caller can try after the first attempt. 0 means one try only."
      errors={errors}
      warning={eff.attemptsSet ? null : 'Not set — the caller gets 1 try'}
    >
      <NumberField
        value={eff.attemptsSet ? eff.attempts - 1 : undefined}
        onChange={v => { const p = retriesPatch(v); if (p) onChange(p); }}
        min={0} max={9}
        allowEmpty={false}
        placeholder="2"
        ariaLabel="Retries"
        width="w-12"
      />
      <span className="text-[10px] text-text-muted whitespace-nowrap">
        {eff.attempts} {eff.attempts === 1 ? 'try' : 'tries'} in total
      </span>
    </InlineRow>
  );
}

/** Minimum / maximum digits. When collecting digits the maximum stays above 1 (1 would make it a key menu). */
function DigitCount({ node, onChange, fieldErrors, label, info, collectsDigits = false }) {
  const eff = effective(node);
  return (
    <InlineRow
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
    </InlineRow>
  );
}

function EndKey({ node, onChange, errors, info }) {
  const terminator = effective(node).terminators;
  const known = TERMINATORS.some(t => t.value === terminator);
  return (
    <StackRow label="End key" info={info} errors={errors}>
      {known
        ? <Segmented value={terminator} options={TERMINATORS} label="End key" onChange={v => onChange({ terminators: v })} />
        : <p className="text-xs font-mono text-text-primary">{terminator}</p>}
    </StackRow>
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
        <p key={i} className="text-[10px] text-amber-500">{String(w).replace(/^Node "[^"]+" \([^)]*\):\s*/, '')}</p>
      ))}
    </div>
  );
}

// ── Settings tab ───────────────────────────────────────────────────────────

function SettingsTab({ node, onChange, fieldErrors, controls, renderAllFields }) {
  const eff = effective(node);
  const mode = eff.mode;
  const internal = mode === MODE.INTERNAL;
  const digits = collectType(node) === COLLECT.DIGITS;
  const rows = menuRows(node);
  const sums = sectionSummaries(node);
  const tooFew = showTooFewDigits(node);
  // With Any other key / Entry complete connected, unmatched entries go there:
  // wrong-key handling never runs, so its switch and message are not offered.
  const wrongKeyHandled = !isWired(node, '_default');
  const wrongKeyName = digits ? 'Wrong entry' : 'Wrong key';
  const errs = k => fieldErrors[k];
  const hasErr = keys => keys.some(k => fieldErrors[k]?.length);
  const src = eff.prompt_source_type;

  const chooseCollect = async target => {
    const n = rows.options.length;
    if (target === COLLECT.DIGITS && n > 0) {
      const ok = await confirmAction({
        title: 'Collect digits instead',
        message: `This removes ${n === 1 ? 'the menu option' : `the ${n} menu options`} (${rows.options.join(', ')}). `
          + 'Every complete entry then goes to the Entry complete exit.',
        confirmLabel: 'Remove options',
        variant: 'warning',
      });
      if (!ok) return;
    }
    const p = collectTypePatch(node, target);
    if (p) onChange(p);
  };

  return (
    <>
      <InspectorBlock
        title="Collect"
        info="Menu: the caller presses a key to choose an option. Digits: the caller enters a number, such as a PIN or account number, and the call continues with it."
      >
        <Segmented value={digits ? COLLECT.DIGITS : COLLECT.MENU} options={COLLECT_TYPES} label="Collect" onChange={chooseCollect} />
      </InspectorBlock>

      <InspectorBlock
        title="Prompt"
        info="What the caller hears first. Text is spoken with the system voice; ${variables} are filled in during the call."
      >
        <Segmented value={src} options={PROMPT_SOURCES} label="Prompt source" onChange={v => onChange(sourcePatch('prompt', v))} />
        {src === 'tts' && (
          <StackRow
            errors={errs('prompt_text')}
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
          <StackRow label="Audio file" required errors={errs('prompt_audio_url')}>
            <controls.MediaPickerField value={node.prompt_audio_url} onChange={v => onChange({ prompt_audio_url: v })} />
          </StackRow>
        )}
        {src === 'none' && <Note>No prompt — the node waits for input without playing anything.</Note>}
      </InspectorBlock>

      {digits && (
        <InspectorBlock title="Digits" info="The number the caller enters. Every complete entry leaves through the Entry complete exit.">
          <DigitCount
            node={node}
            onChange={onChange}
            fieldErrors={fieldErrors}
            collectsDigits
            label="Number of digits"
            info="For an exact length, such as a 4-digit PIN, use the same number twice. For a range, callers can finish early with the end key."
          />
          <EndKey node={node} onChange={onChange} errors={errs('terminators')}
                  info="A key the caller presses to finish early. Useful when the length varies." />
          <VariableField node={node} onChange={onChange} controls={controls} errors={errs('variable_name')} label="Save digits as" />
          <Note>
            Later nodes use the entry as <code className="font-mono text-text-secondary">{'${' + eff.variable_name + '}'}</code>.
          </Note>
        </InspectorBlock>
      )}

      <InspectorBlock title="Input options">
        <InlineRow
          label="Wait for input"
          info={`Seconds to wait for the first key. Empty uses ${runtimeDefault(node, 'timeout_seconds')} s.`}
          errors={errs('timeout_seconds')}
        >
          <NumberField
            value={node.timeout_seconds}
            onChange={v => onChange({ timeout_seconds: v })}
            min={1} max={60}
            placeholder={String(runtimeDefault(node, 'timeout_seconds'))}
            unit="s"
            ariaLabel="Wait for input, seconds"
          />
        </InlineRow>
        <RetriesRow node={node} onChange={onChange} errors={errs('max_attempts')} />
        {internal && (
          <>
            <RetrySwitch slot="no_input" label="Retry on no input" exitName="No input" node={node} onChange={onChange} />
            {wrongKeyHandled && (
              <RetrySwitch slot="invalid_option" label={`Retry on ${wrongKeyName.toLowerCase()}`} exitName={wrongKeyName}
                           node={node} onChange={onChange} />
            )}
            {tooFew && (
              <RetrySwitch slot="invalid_length" label="Retry on too few digits" exitName="Too few digits" node={node} onChange={onChange} />
            )}
            {!wrongKeyHandled && !digits && (
              <Note>{defaultExitName(node)} is connected, so wrong keys go there instead of being retried.</Note>
            )}
          </>
        )}
        {mode === MODE.CLASSIC ? (
          <Note>Classic: audio prompts can always be interrupted; text prompts play in full.</Note>
        ) : (
          <InlineRow label="Keys interrupt the prompt" info="The first key stops the prompt and counts as input. Off: the prompt always plays in full.">
            <Switch checked={eff.allow_barge_in} onChange={on => onChange(togglePatch('allow_barge_in', on))}
                    label="Keys interrupt the prompt" />
          </InlineRow>
        )}
      </InspectorBlock>

      {internal && (
        <InspectorSection
          title="Retry messages"
          summary={sums.retryMessages}
          info="Optional messages: one before the caller tries again, and one when the retries run out."
          defaultOpen={false}
          forceOpen={hasErr(MESSAGE_FIELDS)}
        >
          {eff.retry.no_input && (
            <RetryMessage slot="no_input" title="No input" node={node} onChange={onChange} controls={controls} fieldErrors={fieldErrors} />
          )}
          {wrongKeyHandled && eff.retry.invalid_option && (
            <RetryMessage slot="invalid_option" title={wrongKeyName} node={node} onChange={onChange} controls={controls} fieldErrors={fieldErrors} />
          )}
          {tooFew && eff.retry.invalid_length && (
            <RetryMessage slot="invalid_length" title="Too few digits" node={node} onChange={onChange} controls={controls} fieldErrors={fieldErrors} />
          )}
          <RetryMessage slot="max_attempts_exceeded" title="When retries run out" node={node} onChange={onChange}
                        controls={controls} fieldErrors={fieldErrors} />
        </InspectorSection>
      )}

      <InspectorSection
        title="Advanced"
        summary={sums.advanced}
        defaultOpen={false}
        forceOpen={hasErr(['retry_mode', 'inter_digit_timeout', 'reprompt_pause_ms',
          ...(digits ? [] : ['min_digits', 'max_digits', 'variable_name', 'terminators'])])}
      >
        <StackRow
          label="Failure handling"
          info="Retry in this node: retries happen here, then the caller leaves through Retries used up. One attempt: no retries; every failure leaves the node at once."
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
        {!digits && (
          <>
            <DigitCount
              node={node}
              onChange={onChange}
              fieldErrors={fieldErrors}
              label="Digits per entry"
              info="1 and 1 for a one-key menu. Raise the maximum for options with more than one digit, such as 10 or 25."
            />
            <VariableField node={node} onChange={onChange} controls={controls} errors={errs('variable_name')} label="Save the entry to variable" />
            <EndKey node={node} onChange={onChange} errors={errs('terminators')}
                    info="A key the caller presses to finish early. Best left at None for a key menu." />
          </>
        )}
        <InlineRow label="Pause allowed between digits" info="Seconds allowed between digits. 0 uses the engine default. Empty uses 2 s."
                   errors={errs('inter_digit_timeout')}>
          <NumberField value={node.inter_digit_timeout} onChange={v => onChange({ inter_digit_timeout: v })}
                       min={0} max={30} placeholder="2" unit="s" ariaLabel="Pause allowed between digits, seconds" />
        </InlineRow>
        {internal && (
          <InlineRow label="Pause before replaying the prompt" info="Short silence after a retry message. Empty uses 700 ms."
                     errors={errs('reprompt_pause_ms')}>
            <NumberField value={node.reprompt_pause_ms} onChange={v => onChange({ reprompt_pause_ms: v })}
                         min={0} max={5000} placeholder="700" unit="ms" width="w-20" ariaLabel="Pause before replaying the prompt, milliseconds" />
          </InlineRow>
        )}
        <ShowAllFields renderAllFields={renderAllFields} />
      </InspectorSection>
    </>
  );
}

// ── Exits tab ──────────────────────────────────────────────────────────────

function ExitsTab({ node, nodes, byType, onChange, fieldErrors, controls, onSettings }) {
  const [showAnyOther, setShowAnyOther] = useState(false);
  const eff = effective(node);
  const mode = eff.mode;
  const internal = mode === MODE.INTERNAL;
  const digits = collectType(node) === COLLECT.DIGITS;
  const rows = menuRows(node);
  const sums = sectionSummaries(node);
  const unguarded = unguardedRows(node);
  const anyOtherSet = isWired(node, '_default');
  const tooFew = showTooFewDigits(node);
  const errs = k => fieldErrors[k];
  const pickerProps = { node, nodes, byType, onChange, controls };
  const free = nextFreeKey(node);
  const wrongKeyName = digits ? 'Wrong entry' : 'Wrong key';
  const wrongKeyBranch = internal ? 'invalid_option' : 'invalid';

  let wrongKey;
  if (mode === MODE.EXTERNAL) wrongKey = <Picker branchKey="invalid" {...pickerProps} />;
  else if (anyOtherSet && !isWired(node, wrongKeyBranch)) wrongKey = <GoesTo node={node} />;
  else if (!internal || rows.wrongKey) wrongKey = <Picker branchKey={wrongKeyBranch} {...pickerProps} />;
  else wrongKey = <RetriedHere onSettings={onSettings} />;

  return (
    <>
      {!hasAnyExit(node) && (
        <div className="mt-2.5 px-2.5 py-2 rounded-md bg-amber-500/10 border border-amber-500/20 text-[10px] text-amber-500">
          Connect at least one exit — the flow can't be saved until this Menu has one.
        </div>
      )}

      {digits ? (
        <InspectorBlock
          title="Entry complete"
          info={`Every complete entry goes here. The digits are saved in \${${eff.variable_name}}.`}
        >
          <ExitRow
            label="Send caller to"
            errors={errs('branch:_default')}
            warning={anyOtherSet ? null : 'Choose where the call goes after the digits are entered'}
          >
            <Picker branchKey="_default" {...pickerProps} placeholder="Choose destination…" />
          </ExitRow>
        </InspectorBlock>
      ) : (
        <InspectorBlock
          title="Menu options"
          summary={sums.options}
          info="The keys a caller can press and where each one goes. Click a key to change it."
        >
          {rows.options.length === 0 && <Note>No options yet — add the keys callers can press.</Note>}
          {rows.options.map(k => (
            <OptionRow key={k} optKey={k} {...pickerProps} errors={errs(`branch:${k}`)} />
          ))}
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => { const p = addOptionPatch(node); if (p) onChange(p); }}
              disabled={!free}
              title={free ? `Adds key ${free}` : 'All keypad keys are used — change a key to a multi-digit entry instead'}
              className="text-[11px] text-brand hover:text-brand/80 disabled:text-text-muted disabled:cursor-not-allowed"
            >
              + Add option
            </button>
            {!rows.anyOther && !showAnyOther && (
              <button type="button" onClick={() => setShowAnyOther(true)}
                      title="Send every key that isn't an option to one destination"
                      className="text-[11px] text-text-muted hover:text-brand transition-colors">
                + {defaultExitName(node)}
              </button>
            )}
          </div>
          {(rows.anyOther || showAnyOther) && (
            <ExitRow
              label={defaultExitName(node)}
              info="Catches every entry that isn't an option. While it is connected, wrong keys go here instead of being retried."
              errors={errs('branch:_default')}
            >
              <Picker branchKey="_default" {...pickerProps} />
            </ExitRow>
          )}
          <Messages errors={errs('branches')} />
        </InspectorBlock>
      )}

      <InspectorBlock
        title="If something goes wrong"
        info="Where callers go when they press nothing, enter something that doesn't match, or run out of retries."
      >
        <ExitRow
          label="No input"
          info={internal
            ? 'When the caller presses nothing. Turn off Retry on no input (Settings) to send them somewhere at once.'
            : mode === MODE.CLASSIC ? 'When the caller presses nothing. If empty: Any other key.' : 'One attempt: no retry, the caller goes straight here.'}
          errors={errs(internal ? 'branch:no_input' : 'branch:timeout')}
          warning={unguarded.has('noResponse') ? DISCONNECTED : null}
        >
          {internal
            ? (rows.noResponse ? <Picker branchKey="no_input" {...pickerProps} /> : <RetriedHere onSettings={onSettings} />)
            : <Picker branchKey="timeout" {...pickerProps} />}
        </ExitRow>
        <ExitRow
          label={wrongKeyName}
          info={mode === MODE.EXTERNAL
            ? 'When the entry matches no option, or has too few digits. One attempt: no retry.'
            : 'When the entry matches no option.'}
          errors={errs(`branch:${wrongKeyBranch}`)}
          warning={unguarded.has('wrongKey') ? DISCONNECTED : null}
        >
          {wrongKey}
        </ExitRow>
        {tooFew && (
          <ExitRow
            label="Too few digits"
            info="When the caller enters fewer digits than the minimum."
            errors={errs('branch:invalid_length')}
            warning={unguarded.has('tooFew') ? DISCONNECTED : null}
          >
            {rows.tooFew ? <Picker branchKey="invalid_length" {...pickerProps} /> : <RetriedHere onSettings={onSettings} />}
          </ExitRow>
        )}
        {internal && (
          <ExitRow
            label="Retries used up"
            info="After the last retry fails. If empty: the No input exit, then Any other key."
            errors={errs('branch:max_attempts_exceeded')}
            warning={unguarded.has('exhausted') ? DISCONNECTED : null}
          >
            <Picker branchKey="max_attempts_exceeded" {...pickerProps} placeholder="Not connected (recommended)" />
          </ExitRow>
        )}
      </InspectorBlock>

      {rows.other.length > 0 && (
        <InspectorBlock
          title="Fallback connections"
          info="Connections saved on this node that its current settings use only as a fallback, or not at all. Clear any you don't need."
        >
          {rows.other.map(k => (
            <ExitRow key={k} stacked label={menuExitLabel(node, k)} errors={errs(`branch:${k}`)}>
              <Picker branchKey={k} {...pickerProps} />
            </ExitRow>
          ))}
        </InspectorBlock>
      )}
    </>
  );
}

export default function MenuInspector({ node, nodes, byType, onChange, fieldErrors = {}, warnings = [], controls, renderAllFields }) {
  const [tab, setTab] = useState('settings');
  const exitErrors = countErrors(fieldErrors, isExitErrorKey);
  const settingsErrors = countErrors(fieldErrors, k => !isExitErrorKey(k));
  const exitWarnings = unguardedRows(node).size + (hasAnyExit(node) ? 0 : 1);
  const errorKeys = Object.keys(fieldErrors).filter(k => fieldErrors[k]?.length).sort().join('|');

  // Validation found problems only in the other tab: show that tab.
  useEffect(() => {
    if (tab === 'settings' && settingsErrors === 0 && exitErrors > 0) setTab('exits');
    if (tab === 'exits' && exitErrors === 0 && settingsErrors > 0) setTab('settings');
  }, [errorKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  const idPrefix = `menu-${node.id}`;
  return (
    <div>
      <WarningList warnings={warnings} />
      <div className="pb-2">
        <DescriptionField key={node.id} node={node} onChange={onChange} />
      </div>
      <InspectorTabs
        idPrefix={idPrefix}
        label="Menu settings"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'settings', label: 'Settings', badge: settingsErrors, tone: 'error', badgeTitle: `${settingsErrors} to fix` },
          {
            id: 'exits',
            label: 'Exits',
            badge: exitErrors || exitWarnings,
            tone: exitErrors ? 'error' : 'warn',
            badgeTitle: exitErrors ? `${exitErrors} to fix` : `${exitWarnings} to check`,
          },
        ]}
      />
      <div role="tabpanel" id={`${idPrefix}-panel`} aria-labelledby={`${idPrefix}-tab-${tab}`}>
        {tab === 'settings' ? (
          <SettingsTab node={node} onChange={onChange} fieldErrors={fieldErrors} controls={controls} renderAllFields={renderAllFields} />
        ) : (
          <ExitsTab key={node.id} node={node} nodes={nodes} byType={byType} onChange={onChange} fieldErrors={fieldErrors}
                    controls={controls} onSettings={() => setTab('settings')} />
        )}
      </div>
    </div>
  );
}
