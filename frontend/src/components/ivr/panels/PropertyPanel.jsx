import { Trash2, Star } from 'lucide-react';
import { NODE_CONFIG } from '../canvas/FlowNode.jsx';

// ── Field components ──────────────────────────────────────────────────────────

function Field({ label, hint, children }) {
  return (
    <div className="mb-3">
      <label className="block text-[10px] font-medium text-text-muted mb-1 uppercase tracking-wide">
        {label}
      </label>
      {children}
      {hint && <p className="text-[9px] text-text-muted mt-1 opacity-70">{hint}</p>}
    </div>
  );
}

function TextInput({ value, onChange, placeholder, mono }) {
  return (
    <input
      type="text"
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full bg-surface border border-surface-border rounded-lg px-2.5 py-1.5
                  text-xs text-text-primary placeholder:text-text-muted focus:outline-none
                  focus:border-brand transition-colors
                  ${mono ? 'font-mono' : ''}`}
    />
  );
}

function NumberInput({ value, onChange, min, max }) {
  return (
    <input
      type="number"
      value={value ?? ''}
      onChange={e => onChange(Number(e.target.value))}
      min={min} max={max}
      className="w-full bg-surface border border-surface-border rounded-lg px-2.5 py-1.5
                 text-xs text-text-primary focus:outline-none focus:border-brand transition-colors"
    />
  );
}

function Textarea({ value, onChange, placeholder, rows = 3 }) {
  return (
    <textarea
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full bg-surface border border-surface-border rounded-lg px-2.5 py-1.5
                 text-xs text-text-primary placeholder:text-text-muted focus:outline-none
                 focus:border-brand transition-colors resize-none"
    />
  );
}

function Select({ value, onChange, options }) {
  return (
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      className="w-full bg-surface border border-surface-border rounded-lg px-2.5 py-1.5
                 text-xs text-text-primary focus:outline-none focus:border-brand"
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

// ── Per-type property panels ──────────────────────────────────────────────────

function PlayFields({ node, onChange }) {
  return (
    <>
      <Field label="Audio URL (local /media/ path)">
        <TextInput value={node.audio_url} onChange={v => onChange({ audio_url: v })} placeholder="/media/welcome.wav" mono />
      </Field>
      <Field label="Audio File ID (alternative)">
        <NumberInput value={node.audio_file_id} onChange={v => onChange({ audio_file_id: v })} min={1} />
      </Field>
      <Field label="Next Node ID">
        <TextInput value={node.next} onChange={v => onChange({ next: v })} placeholder="node_2" mono />
      </Field>
    </>
  );
}

function SayFields({ node, onChange }) {
  return (
    <>
      <Field label="Text to speak">
        <Textarea value={node.text} onChange={v => onChange({ text: v })} placeholder="Please press 1 for emergency…" />
      </Field>
      <Field label="Language">
        <Select
          value={node.language || 'en-US'}
          onChange={v => onChange({ language: v })}
          options={['en-US','en-AU','en-GB','es-ES','fr-FR','de-DE'].map(l => ({ value: l, label: l }))}
        />
      </Field>
      <Field label="Voice (optional)">
        <TextInput value={node.voice} onChange={v => onChange({ voice: v })} placeholder="Joanna" />
      </Field>
      <Field label="Next Node ID">
        <TextInput value={node.next} onChange={v => onChange({ next: v })} placeholder="node_2" mono />
      </Field>
    </>
  );
}

function GatherFields({ node, onChange }) {
  const branches = node.branches || {};
  const branchKeys = Object.keys(branches);

  const updateBranch = (k, v) => onChange({ branches: { ...branches, [k]: v } });
  const addBranch = () => {
    const next = String(branchKeys.filter(k => !['timeout','invalid','_default'].includes(k)).length + 1);
    onChange({ branches: { ...branches, [next]: '' } });
  };
  const removeBranch = (k) => {
    const { [k]: _, ...rest } = branches;
    onChange({ branches: rest });
  };

  return (
    <>
      <Field label="Variable Name" hint="Session variable that stores collected digits">
        <TextInput value={node.variable_name} onChange={v => onChange({ variable_name: v })} placeholder="gather_result" mono />
      </Field>
      <Field label="Max Digits">
        <NumberInput value={node.max_digits} onChange={v => onChange({ max_digits: v })} min={1} max={11} />
      </Field>
      <Field label="Timeout (seconds)">
        <NumberInput value={node.timeout_seconds} onChange={v => onChange({ timeout_seconds: v })} min={1} max={60} />
      </Field>
      <Field label="Terminators" hint="Keys that end collection (default #)">
        <TextInput value={node.terminators} onChange={v => onChange({ terminators: v })} placeholder="#" mono />
      </Field>
      <Field label="Prompt Audio URL">
        <TextInput value={node.prompt_audio_url} onChange={v => onChange({ prompt_audio_url: v })} placeholder="/media/menu.wav" mono />
      </Field>
      <Field label="Prompt Text (TTS fallback)">
        <TextInput value={node.prompt_text} onChange={v => onChange({ prompt_text: v })} placeholder="Please enter your PIN" />
      </Field>
      <Field label="Branches (key → node ID)" hint="Use _default to catch any input not matched above">
        <div className="space-y-1.5">
          {branchKeys.map(k => (
            <div key={k} className="flex gap-1.5 items-center">
              <span className="text-[10px] font-mono bg-surface-hover px-1.5 py-1 rounded border border-surface-border text-text-muted w-16 text-center shrink-0">
                {k}
              </span>
              <input
                type="text"
                value={branches[k] || ''}
                onChange={e => updateBranch(k, e.target.value)}
                placeholder="node_id"
                className="flex-1 bg-surface border border-surface-border rounded px-2 py-1
                           text-[11px] font-mono text-text-primary focus:outline-none focus:border-brand"
              />
              {!['timeout','invalid','_default'].includes(k) && (
                <button onClick={() => removeBranch(k)} className="text-text-muted hover:text-red-400 p-0.5">
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          ))}
          <button onClick={addBranch} className="text-[10px] text-brand hover:text-brand/80 mt-1">
            + Add digit branch
          </button>
          {!branches['_default'] && (
            <button
              onClick={() => onChange({ branches: { ...branches, _default: '' } })}
              className="text-[10px] text-text-muted hover:text-brand ml-3"
            >
              + Add _default (catch-all)
            </button>
          )}
        </div>
      </Field>
    </>
  );
}

function GotoFields({ node, onChange }) {
  return (
    <Field label="Target Node ID">
      <TextInput value={node.target_node_id} onChange={v => onChange({ target_node_id: v })} placeholder="node_3" mono />
    </Field>
  );
}

function EnsFields({ node, onChange }) {
  return (
    <>
      <Field label="ENS Configuration ID" hint="Leave blank if using ens_config_var">
        <NumberInput value={node.ens_configuration_id} onChange={v => onChange({ ens_configuration_id: v || undefined })} min={1} />
      </Field>
      <Field label="ENS Config Variable" hint="Session var holding config ID (set by condition ens_pin_valid)">
        <TextInput value={node.ens_config_var} onChange={v => onChange({ ens_config_var: v })} placeholder="ens_configuration_id" mono />
      </Field>
      <Field label="Recording File Variable" hint="Session var holding recorded file path (from record_message node)">
        <TextInput value={node.recording_file_var} onChange={v => onChange({ recording_file_var: v })} placeholder="recorded_file_path" mono />
      </Field>
      <Field label="Next Node ID (optional — post-blast)">
        <TextInput value={node.next} onChange={v => onChange({ next: v })} placeholder="node_hangup" mono />
      </Field>
    </>
  );
}

function ErsFields({ node, onChange }) {
  return (
    <Field label="ERS Configuration ID">
      <NumberInput value={node.ers_configuration_id} onChange={v => onChange({ ers_configuration_id: v })} min={1} />
    </Field>
  );
}

function HangupFields({ node, onChange }) {
  return (
    <Field label="Goodbye Audio URL (optional)">
      <TextInput value={node.play_audio_url} onChange={v => onChange({ play_audio_url: v })} placeholder="/media/goodbye.wav" mono />
    </Field>
  );
}

// ── NEW: ConditionFields ──────────────────────────────────────────────────────

const OPERATOR_OPTIONS = [
  { value: '==',           label: '== equals' },
  { value: '!=',           label: '!= not equals' },
  { value: 'contains',     label: 'contains' },
  { value: 'starts_with',  label: 'starts_with' },
  { value: 'ens_pin_valid',label: 'ENS PIN valid (lookup + validate)' },
];

function ConditionFields({ node, onChange }) {
  const isEnsPinOp = node.operator === 'ens_pin_valid';
  return (
    <>
      <Field label="Variable to check" hint="Session variable name (e.g. gather_result)">
        <TextInput value={node.variable} onChange={v => onChange({ variable: v })} placeholder="gather_result" mono />
      </Field>
      <Field label="Operator">
        <Select value={node.operator || '=='} onChange={v => onChange({ operator: v })} options={OPERATOR_OPTIONS} />
      </Field>
      <Field
        label={isEnsPinOp ? 'ENS access number' : 'Expected value'}
        hint={isEnsPinOp
          ? 'The ENS emergency number to look up PIN against. Use ${var} to read from session.'
          : 'Static value or ${var_name} to compare against'}
      >
        <TextInput
          value={node.expected_value}
          onChange={v => onChange({ expected_value: v })}
          placeholder={isEnsPinOp ? '${destination_number}' : 'expected value'}
          mono
        />
      </Field>
      {isEnsPinOp && (
        <div className="mb-3 px-2.5 py-2 rounded-lg bg-brand/5 border border-brand/20 text-[9px] text-brand/80 leading-relaxed">
          On PIN match: auto-stores <code className="font-mono">ens_configuration_id</code>,{' '}
          <code className="font-mono">ens_retry_count</code>, and{' '}
          <code className="font-mono">ens_blast_clid</code> as session variables for downstream ENS node.
        </div>
      )}
      <Field label="True → Node ID" hint="Route here when condition is met">
        <TextInput value={node.true_node} onChange={v => onChange({ true_node: v })} placeholder="node_success" mono />
      </Field>
      <Field label="False → Node ID" hint="Route here when condition fails">
        <TextInput value={node.false_node} onChange={v => onChange({ false_node: v })} placeholder="node_retry" mono />
      </Field>
    </>
  );
}

// ── NEW: RecordMessageFields ──────────────────────────────────────────────────

function RecordMessageFields({ node, onChange }) {
  return (
    <>
      <Field label="Variable name" hint="Session var that stores the recorded file path">
        <TextInput value={node.variable_name} onChange={v => onChange({ variable_name: v })} placeholder="recorded_file_path" mono />
      </Field>
      <Field label="Prompt text (TTS)" hint="Played before recording starts">
        <Textarea value={node.prompt_text} onChange={v => onChange({ prompt_text: v })} placeholder="Please record your message after the tone. Press # when done." rows={2} />
      </Field>
      <Field label="Prompt audio URL (overrides TTS)">
        <TextInput value={node.prompt_audio_url} onChange={v => onChange({ prompt_audio_url: v })} placeholder="/media/record_prompt.wav" mono />
      </Field>
      <Field label="Max seconds">
        <NumberInput value={node.max_seconds} onChange={v => onChange({ max_seconds: v })} min={1} max={300} />
      </Field>
      <Field label="Silence threshold (ms)" hint="Audio level below which is considered silence">
        <NumberInput value={node.silence_threshold} onChange={v => onChange({ silence_threshold: v })} min={10} max={2000} />
      </Field>
      <Field label="Silence hits" hint="How many silence chunks before stopping">
        <NumberInput value={node.silence_hits} onChange={v => onChange({ silence_hits: v })} min={1} max={10} />
      </Field>
      <Field label="Record directory" hint="Default: /var/enrs/recordings">
        <TextInput value={node.record_dir} onChange={v => onChange({ record_dir: v })} placeholder="/var/enrs/recordings" mono />
      </Field>
      <Field label="Next Node ID">
        <TextInput value={node.next} onChange={v => onChange({ next: v })} placeholder="node_blast" mono />
      </Field>
    </>
  );
}

// ── NEW: SetVariableFields ────────────────────────────────────────────────────

function SetVariableFields({ node, onChange }) {
  return (
    <>
      <Field label="Variable name" hint="FreeSWITCH channel variable to set">
        <TextInput value={node.variable} onChange={v => onChange({ variable: v })} placeholder="my_variable" mono />
      </Field>
      <Field label="Value" hint="Static text or ${other_var} interpolation">
        <TextInput value={node.value} onChange={v => onChange({ value: v })} placeholder="${destination_number}" mono />
      </Field>
      <Field label="Next Node ID">
        <TextInput value={node.next} onChange={v => onChange({ next: v })} placeholder="node_next" mono />
      </Field>
    </>
  );
}

// ── NEW: TransferFields ───────────────────────────────────────────────────────

function TransferFields({ node, onChange }) {
  return (
    <>
      <Field label="Destination" hint="Extension number, or ${var} for dynamic destination">
        <TextInput value={node.destination} onChange={v => onChange({ destination: v })} placeholder="1001" mono />
      </Field>
      <Field label="Dialplan">
        <Select
          value={node.dialplan || 'XML'}
          onChange={v => onChange({ dialplan: v })}
          options={[
            { value: 'XML',       label: 'XML (default)' },
            { value: 'inline',    label: 'inline' },
            { value: 'enum',      label: 'enum' },
          ]}
        />
      </Field>
      <Field label="Context">
        <TextInput value={node.context} onChange={v => onChange({ context: v })} placeholder="default" mono />
      </Field>
      <div className="mb-3 px-2.5 py-2 rounded-lg bg-surface-hover border border-surface-border text-[9px] text-text-muted leading-relaxed">
        Transfer hands off call control. No next node — the transferred dialplan takes over.
      </div>
    </>
  );
}

// ── Registry ──────────────────────────────────────────────────────────────────

const FIELD_COMPONENTS = {
  play:           PlayFields,
  say:            SayFields,
  gather:         GatherFields,
  goto:           GotoFields,
  ens:            EnsFields,
  ers:            ErsFields,
  hangup:         HangupFields,
  condition:      ConditionFields,
  record_message: RecordMessageFields,
  set_variable:   SetVariableFields,
  transfer:       TransferFields,
};

// ── PropertyPanel ─────────────────────────────────────────────────────────────

export default function PropertyPanel({ node, errors, isEntry, onUpdate, onDelete, onSetEntry }) {
  if (!node) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-6">
        <p className="text-xs text-text-muted">Select a node to edit its properties</p>
        <p className="text-[10px] text-text-muted mt-2 opacity-60">Click any node on the canvas</p>
      </div>
    );
  }

  const cfg        = NODE_CONFIG[node.type] || NODE_CONFIG.play;
  const FieldsComp = FIELD_COMPONENTS[node.type] || (() => null);
  const nodeErrors = errors[node.id] || [];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-surface-border shrink-0"
           style={{ background: cfg.bg, borderBottomColor: cfg.border + '40' }}>
        <div className="flex items-center gap-2">
          <span className="text-lg">{cfg.icon}</span>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold" style={{ color: cfg.color }}>{cfg.label}</p>
            <p className="text-[9px] text-text-muted font-mono truncate">{node.id}</p>
          </div>
        </div>
      </div>

      {/* Errors */}
      {nodeErrors.length > 0 && (
        <div className="mx-3 mt-3 px-2.5 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
          {nodeErrors.map((e, i) => (
            <p key={i} className="text-[10px] text-red-400">{e}</p>
          ))}
        </div>
      )}

      {/* Fields */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <FieldsComp node={node} onChange={patch => onUpdate(node.id, patch)} />
      </div>

      {/* Actions */}
      <div className="px-4 py-3 border-t border-surface-border space-y-2 shrink-0">
        {!isEntry && (
          <button
            onClick={() => onSetEntry(node.id)}
            className="w-full flex items-center justify-center gap-1.5 text-xs py-1.5
                       rounded-lg bg-brand/10 text-brand border border-brand/20 hover:bg-brand/20 transition-colors"
          >
            <Star size={11} /> Set as Entry Node
          </button>
        )}
        {isEntry && (
          <div className="flex items-center justify-center gap-1.5 text-[10px] text-brand opacity-70">
            <Star size={10} /> Entry node
          </div>
        )}
        <button
          onClick={() => { if (window.confirm('Delete this node?')) onDelete(node.id); }}
          className="w-full flex items-center justify-center gap-1.5 text-xs py-1.5
                     rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
        >
          <Trash2 size={11} /> Delete Node
        </button>
      </div>
    </div>
  );
}
