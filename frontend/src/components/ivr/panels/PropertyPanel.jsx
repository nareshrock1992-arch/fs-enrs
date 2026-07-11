import { Trash2, Star } from 'lucide-react';
import { useNodeTypes } from '../../../hooks/useNodeTypes.js';
import { useConfigOptions } from '../../../hooks/useConfigOptions.js';

// Phase 3: this used to be one hand-built <XyzFields> component per node
// type (11 of them) — every new node type meant a new component here,
// and it's exactly how the "field exists in state but nothing renders it"
// bug class kept happening (ServiceRegistry.jsx, ContactList.jsx,
// LocationList.jsx all hit variants of this earlier in the project).
// A schema-driven form can't have that bug: every key in configSchema
// gets a field, structurally, or it doesn't render at all.

// ── Field components (presentational, type-agnostic) ─────────────────────────

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
      onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
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

// NodePicker — dropdown to pick a target node instead of typing a raw ID.
function NodePicker({ value, onChange, nodes = {}, excludeId, placeholder = 'None (end here)', byType }) {
  const nodeList = Object.values(nodes).filter(n => n.id !== excludeId);
  return (
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      className="w-full bg-surface border border-surface-border rounded-lg px-2.5 py-1.5
                 text-xs text-text-primary focus:outline-none focus:border-brand"
    >
      <option value="">{placeholder}</option>
      {nodeList.map(n => {
        const cfg = byType[n.type] || {};
        const label = n.label || (n.text?.slice(0, 24)) || (n.audio_url?.split('/').pop()) || n.type;
        return (
          <option key={n.id} value={n.id}>
            {cfg.icon || ''} {cfg.label || n.type} — {String(label).slice(0, 30)}
          </option>
        );
      })}
    </select>
  );
}

// ERS/ENS configuration picker — replaces "open PostgreSQL, find the ID,
// paste it" with a dropdown of the actual configurations. Stores the same
// numeric id the raw number field stored, so existing flows keep working
// and the backend contract is unchanged.
function ConfigPicker({ kind, value, onChange, required }) {
  const { options, loading } = useConfigOptions(kind);
  const known = options.some(o => o.id === value);
  return (
    <select
      value={value ?? ''}
      onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      className="w-full bg-surface border border-surface-border rounded-lg px-2.5 py-1.5
                 text-xs text-text-primary focus:outline-none focus:border-brand"
    >
      <option value="">{loading ? 'Loading configurations…' : (required ? 'Select a configuration…' : 'None')}</option>
      {/* A saved value not in the list (deleted config / other tenant) stays
          visible rather than silently vanishing from the form. */}
      {value != null && !known && !loading && (
        <option value={value}>Unknown configuration #{value}</option>
      )}
      {options.map(o => (
        <option key={o.id} value={o.id}>
          {o.name}{o.description ? ` — ${o.description.slice(0, 40)}` : ''} (#{o.id})
        </option>
      ))}
    </select>
  );
}

// Gather's branch key→target editor — the one genuinely bespoke widget
// (dynamic add/remove keys, not a fixed field), driven by fieldType
// 'branches_map' rather than a per-type component.
function BranchesMapField({ node, onUpdate, nodes, byType }) {
  const branches = node.branches || {};
  const branchKeys = Object.keys(branches);

  const updateBranch = (k, v) => onUpdate(node.id, { branches: { ...branches, [k]: v } });
  const addBranch = () => {
    const next = String(branchKeys.filter(k => !['timeout','invalid','_default'].includes(k)).length + 1);
    onUpdate(node.id, { branches: { ...branches, [next]: '' } });
  };
  const removeBranch = (k) => {
    const { [k]: _removed, ...rest } = branches;
    onUpdate(node.id, { branches: rest });
  };

  return (
    <div className="space-y-1.5">
      {branchKeys.map(k => (
        <div key={k} className="flex gap-1.5 items-center">
          <span className="text-[10px] font-mono bg-surface-hover px-1.5 py-1 rounded border border-surface-border text-text-muted w-16 text-center shrink-0">
            {k}
          </span>
          <div className="flex-1">
            <NodePicker
              value={branches[k]}
              onChange={v => updateBranch(k, v)}
              nodes={nodes}
              excludeId={node.id}
              placeholder="Select target node…"
              byType={byType}
            />
          </div>
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
          onClick={() => onUpdate(node.id, { branches: { ...branches, _default: '' } })}
          className="text-[10px] text-text-muted hover:text-brand ml-3"
        >
          + Add _default (catch-all)
        </button>
      )}
    </div>
  );
}

// ── Generic field renderer — dispatches on fieldType, not node.type ──────────

function GenericField({ fieldDef, node, nodes, byType, onChange, onUpdate }) {
  // conditionalOn: the field's label/hint/placeholder swap based on another
  // field's current value (e.g. condition node's expected_value field
  // means something different when operator === 'ens_pin_valid').
  const cond = fieldDef.conditionalOn;
  const active = cond && node[cond.field] === cond.value;
  const label = active ? cond.label : fieldDef.label;
  const hint = active ? cond.hint : fieldDef.hint;
  const placeholder = active ? cond.placeholder : fieldDef.placeholder;

  const value = node[fieldDef.key];
  const set = v => onChange({ [fieldDef.key]: v });

  let control;
  switch (fieldDef.fieldType) {
    case 'textarea':
      control = <Textarea value={value} onChange={set} placeholder={placeholder} />;
      break;
    case 'number':
      control = <NumberInput value={value} onChange={set} min={fieldDef.min} max={fieldDef.max} />;
      break;
    case 'select':
      control = <Select value={value} onChange={set} options={fieldDef.options || []} />;
      break;
    case 'node_ref':
      control = <NodePicker value={value} onChange={set} nodes={nodes} excludeId={node.id} placeholder={fieldDef.required ? 'Select target node…' : undefined} byType={byType} />;
      break;
    case 'ers_config_ref':
      control = <ConfigPicker kind="ers" value={value} onChange={set} required={fieldDef.required} />;
      break;
    case 'ens_config_ref':
      control = <ConfigPicker kind="ens" value={value} onChange={set} required={fieldDef.required} />;
      break;
    case 'audio_url':
    case 'mono_text':
      control = <TextInput value={value} onChange={set} placeholder={placeholder} mono />;
      break;
    case 'branches_map':
      control = <BranchesMapField node={node} onUpdate={onUpdate} nodes={nodes} byType={byType} />;
      break;
    case 'text':
    default:
      control = <TextInput value={value} onChange={set} placeholder={placeholder} />;
  }

  return (
    <>
      <Field label={label} hint={hint}>{control}</Field>
      {active && cond.infoBox && (
        <div className="mb-3 px-2.5 py-2 rounded-lg bg-brand/5 border border-brand/20 text-[9px] text-brand/80 leading-relaxed">
          {cond.infoBox}
        </div>
      )}
    </>
  );
}

// Transfer's static "call control ends here" note and similar per-type
// footnotes live as an optional `footnote` on the registry entry itself
// so this stays data-driven — see registry.js.

// ── PropertyPanel ─────────────────────────────────────────────────────────────

export default function PropertyPanel({ node, errors, isEntry, onUpdate, onDelete, onSetEntry, nodes = {} }) {
  const { byType } = useNodeTypes();

  if (!node) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-6">
        <p className="text-xs text-text-muted">Select a node to edit its properties</p>
        <p className="text-[10px] text-text-muted mt-2 opacity-60">Click any node on the canvas</p>
      </div>
    );
  }

  const cfg        = byType[node.type] || { label: node.type, icon: '?', bg: '#2a2a2a', border: '#555', color: '#ccc', configSchema: [] };
  const nodeErrors = errors[node.id] || [];
  const onChange   = patch => onUpdate(node.id, patch);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-surface-border shrink-0"
           style={{ background: cfg.bg, borderBottomColor: cfg.border + '40' }}>
        <div className="flex items-center gap-2">
          <span className="text-lg">{cfg.icon}</span>
          <div className="flex-1 min-w-0">
            <p className="text-[9px]" style={{ color: cfg.color + '99' }}>{cfg.label}</p>
            {/* Editable nickname — shown as the node title on the canvas card */}
            <input
              value={node.nickname || ''}
              onChange={e => onChange({ nickname: e.target.value || undefined })}
              placeholder={cfg.label}
              className="w-full bg-transparent text-xs font-bold outline-none border-b border-transparent
                         focus:border-current placeholder:opacity-40 truncate"
              style={{ color: cfg.color }}
            />
            <p className="text-[9px] text-text-muted font-mono truncate mt-0.5">{node.id}</p>
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

      {/* Fields — generated from configSchema */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {(cfg.configSchema || []).map(fieldDef => (
          <GenericField
            key={fieldDef.key}
            fieldDef={fieldDef}
            node={node}
            nodes={nodes}
            byType={byType}
            onChange={onChange}
            onUpdate={onUpdate}
          />
        ))}
        {cfg.footnote && (
          <div className="mb-3 px-2.5 py-2 rounded-lg bg-surface-hover border border-surface-border text-[9px] text-text-muted leading-relaxed">
            {cfg.footnote}
          </div>
        )}
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
