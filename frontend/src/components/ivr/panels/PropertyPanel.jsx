import { Trash2, Star, Search, X, Play, Check } from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useNodeTypes } from '../../../hooks/useNodeTypes.js';
import { useConfigOptions } from '../../../hooks/useConfigOptions.js';
import { api } from '../../../api/client.js';
import { IVR_VARIABLES, insertAtCursor } from '../ivrVariables.js';

// Phase 3: this used to be one hand-built <XyzFields> component per node
// type (11 of them) — every new node type meant a new component here,
// and it's exactly how the "field exists in state but nothing renders it"
// bug class kept happening (ServiceRegistry.jsx, ContactList.jsx,
// LocationList.jsx all hit variants of this earlier in the project).
// A schema-driven form can't have that bug: every key in configSchema
// gets a field, structurally, or it doesn't render at all.

// ── Field components (presentational, type-agnostic) ─────────────────────────

function Field({ label, hint, example, children }) {
  const [showExample, setShowExample] = useState(false);
  return (
    <div className="mb-3">
      <div className="flex items-center gap-1 mb-1">
        <label className="block text-[10px] font-medium text-text-muted uppercase tracking-wide">
          {label}
        </label>
        {example && (
          <button
            type="button"
            onClick={() => setShowExample(s => !s)}
            title="Show example"
            aria-label="Show example"
            className={`shrink-0 w-3.5 h-3.5 flex items-center justify-center rounded-full border text-[8px] leading-none transition-colors
                        ${showExample ? 'border-brand text-brand' : 'border-surface-border text-text-muted hover:text-brand hover:border-brand'}`}
          >
            ?
          </button>
        )}
      </div>
      {children}
      {hint && <p className="text-[9px] text-text-muted mt-1 opacity-70">{hint}</p>}
      {example && showExample && (
        <pre className="mt-1 px-2 py-1.5 rounded bg-surface-hover border border-surface-border text-[9px] text-text-muted leading-relaxed whitespace-pre-wrap break-words font-mono">
{example}
        </pre>
      )}
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

// ── Variable picker — generic to any interpolation field ─────────────────────
// A searchable catalog (ivrVariables.js) whose entries insert the correct
// ${name} syntax at the cursor, with a human-readable label, description, and a
// live example so authors need no external docs.
function VariableInserter({ onInsert }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const list = needle
    ? IVR_VARIABLES.filter(v =>
        `${v.label} ${v.name} ${v.description} ${v.category}`.toLowerCase().includes(needle))
    : IVR_VARIABLES;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px]
                   bg-brand/10 text-brand border border-brand/20 hover:bg-brand/20 transition-colors"
      >
        <Search size={10} /> Insert variable ▾
      </button>
      <p className="text-[9px] text-text-muted mt-1 opacity-70">
        Inserts a <code>{'${variable}'}</code> — e.g. <code>Welcome {'${caller_id_name}'}</code> → “Welcome John Smith”.
      </p>
      {open && (
        // Anchored directly below this field's picker button (top-full/left-0),
        // solid opaque background (bg-surface-panel — bg-surface has no DEFAULT
        // and renders transparent), and z-30 so it sits above the field below
        // instead of bleeding into it. Each VariableInserter has its own
        // relative parent + open state, so instances never overlap each other.
        <div className="absolute left-0 top-full z-30 mt-1 w-full border border-surface-border rounded-lg bg-surface-panel shadow-lg overflow-hidden">
          <div className="flex items-center gap-2 px-2.5 py-2 border-b border-surface-border bg-surface-panel">
            <Search size={12} className="text-text-muted shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search variables…"
              className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-muted outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto bg-surface-panel">
            {list.length === 0 && (
              <div className="px-3 py-4 text-center text-[10px] text-text-muted">No variables match.</div>
            )}
            {list.map(v => (
              <button
                key={v.name}
                type="button"
                onClick={() => { onInsert('${' + v.name + '}'); setOpen(false); setQ(''); }}
                className="w-full text-left px-2.5 py-2 border-b border-surface-border/50 hover:bg-brand/10 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-text-primary">{v.label}</span>
                  <code className="text-[9px] text-brand">{'${' + v.name + '}'}</code>
                  <span className="ml-auto text-[8px] uppercase tracking-wide text-text-muted">{v.category}</span>
                </div>
                <div className="text-[9px] text-text-muted mt-0.5 leading-relaxed">{v.description}</div>
                <div className="text-[9px] text-text-muted mt-0.5 opacity-70">Example: {v.example}</div>
                <div className="text-[9px] text-amber-500/80 mt-0.5">Availability: {v.availability}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Textarea + variable picker, with cursor-aware ${var} insertion. Used for all
// interpolation-capable (textarea) fields so personalization is available
// everywhere, not just on one node.
function InterpolableTextarea({ value, onChange, placeholder, rows = 3 }) {
  const ref = useRef(null);
  const insert = token => {
    const el = ref.current;
    const start = el && typeof el.selectionStart === 'number' ? el.selectionStart : null;
    const end   = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : null;
    const { text, caret } = insertAtCursor(value || '', start, end, token);
    onChange(text);
    if (el) requestAnimationFrame(() => { try { el.focus(); el.selectionStart = el.selectionEnd = caret; } catch { /* noop */ } });
  };
  return (
    <div className="space-y-1.5">
      <textarea
        ref={ref}
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full bg-surface border border-surface-border rounded-lg px-2.5 py-1.5
                   text-xs text-text-primary placeholder:text-text-muted focus:outline-none
                   focus:border-brand transition-colors resize-none"
      />
      <VariableInserter onInsert={insert} />
    </div>
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

// MediaPickerField — search and select from the Media Library.
// The selected file's /media/<filename> path is stored in the node's audio_url field.
// This replaces the manual-path text-input for audio_url fields.
function MediaPickerField({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [previewId, setPreviewId] = useState(null);
  const audioRef = useRef(null);
  const timerRef = useRef(null);

  // Derive the display name from the stored /media/... path
  const displayName = value ? value.replace(/^\/media\//, '') : '';

  const search = useCallback(async (q) => {
    setLoading(true);
    try {
      const r = await api.mediaLibrary.list({ search: q || undefined, limit: 30, deployed: 'true' });
      setResults(r.files || []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced search on query change
  useEffect(() => {
    if (!open) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(query), 250);
    return () => clearTimeout(timerRef.current);
  }, [query, open, search]);

  // Load initial results when picker opens
  useEffect(() => {
    if (open) search(query);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function selectFile(file) {
    // Construct /media/<filename> path expected by validate and Lua resolve_audio().
    // resolve_audio() maps /media/<x> → SOUNDS_DIR/enrs/<x>, so the leaf of the
    // deployed FS path is the canonical identifier. Fall back to display name.
    const leaf = file.fs_path
      ? file.fs_path.split('/').pop()
      : file.path_or_uri
        ? file.path_or_uri.split('/').pop()
        : file.name || String(file.id);
    onChange('/media/' + leaf);
    setOpen(false);
    setPreviewId(null);
  }

  function togglePreview(fileId, e) {
    e.stopPropagation();
    if (previewId === fileId) {
      audioRef.current?.pause();
      setPreviewId(null);
    } else {
      setPreviewId(fileId);
    }
  }

  return (
    <div className="space-y-1">
      {/* Current value display + Browse button */}
      <div className="flex gap-1.5 items-center">
        <div className="flex-1 bg-surface border border-surface-border rounded-lg px-2.5 py-1.5
                        text-xs font-mono text-text-primary truncate min-w-0">
          {displayName || <span className="text-text-muted">No file selected</span>}
        </div>
        {value && (
          <button
            onClick={() => onChange('')}
            title="Clear"
            className="text-text-muted hover:text-red-400 p-1 shrink-0"
          >
            <X size={12} />
          </button>
        )}
        <button
          onClick={() => setOpen(o => !o)}
          className="shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs
                     bg-brand/10 text-brand border border-brand/20 hover:bg-brand/20 transition-colors"
        >
          <Search size={11} /> Browse
        </button>
      </div>

      {/* Dropdown picker */}
      {open && (
        <div className="border border-surface-border rounded-lg bg-surface shadow-lg overflow-hidden">
          {/* Search bar */}
          <div className="flex items-center gap-2 px-2.5 py-2 border-b border-surface-border">
            <Search size={12} className="text-text-muted shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search media…"
              className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-muted outline-none"
            />
            {loading && <span className="text-[9px] text-text-muted">Loading…</span>}
          </div>

          {/* Results */}
          <div className="max-h-48 overflow-y-auto">
            {results.length === 0 && !loading && (
              <div className="px-3 py-4 text-center text-[10px] text-text-muted">
                {query ? 'No files match your search' : 'No deployed media files found'}
              </div>
            )}
            {results.map(file => {
              const leaf     = file.fs_path ? file.fs_path.split('/').pop() : file.name;
              const mediaUrl = '/media/' + leaf;
              const selected = value === mediaUrl;
              // duration_sec comes from a PostgreSQL NUMERIC column — node-postgres
              // returns NUMERIC as a string ("18.234"), not a JS Number. Normalize
              // to Number first; guard NaN so we never call .toFixed() on a non-number.
              const durRaw   = file.duration_sec;
              const durNum   = durRaw == null ? null : Number(durRaw);
              const dur      = (durNum != null && !isNaN(durNum) && durNum > 0)
                ? (durNum < 60
                    ? `${durNum.toFixed(0)}s`
                    : `${(durNum / 60).toFixed(1)}m`)
                : null;
              return (
                <div
                  key={file.id}
                  onClick={() => selectFile(file)}
                  className={`flex items-center gap-2 px-2.5 py-2 cursor-pointer hover:bg-surface-hover border-b border-surface-border/50 last:border-0 ${selected ? 'bg-brand/5' : ''}`}
                >
                  {/* Preview button */}
                  <button
                    onClick={e => togglePreview(file.id, e)}
                    className="shrink-0 text-text-muted hover:text-brand p-0.5"
                    title="Preview"
                  >
                    <Play size={10} className={previewId === file.id ? 'text-brand' : ''} />
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-text-primary truncate">{file.name}</p>
                    <p className="text-[9px] text-text-muted truncate">
                      {[file.category, dur].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  {selected && <Check size={11} className="text-brand shrink-0" />}
                </div>
              );
            })}
          </div>

          {/* Hidden audio element for preview */}
          {previewId && (
            <audio
              ref={audioRef}
              autoPlay
              src={api.mediaLibrary.streamUrl(previewId)}
              onEnded={() => setPreviewId(null)}
              className="hidden"
            />
          )}
        </div>
      )}
    </div>
  );
}

// One branch/outcome row: a labeled key + a target-node <select>. Defined at
// MODULE SCOPE (not inside BranchesMapField) so React reconciles the native
// <select> in place across renders. When this was declared inside the parent's
// render body its function identity changed every render, so React remounted
// the <select> on each render — which, combined with the autosave re-renders,
// tore down the control mid-selection and made branch/route target dropdowns
// snap back to the placeholder (the "can't select a route" regression).
function BranchRow({ branchKey, removable, value, nodes, excludeId, byType, onChange, onRemove }) {
  return (
    <div className="flex gap-1.5 items-center">
      <span className="text-[10px] font-mono bg-surface-hover px-1.5 py-1 rounded border border-surface-border text-text-muted w-28 text-center shrink-0 truncate" title={branchKey}>
        {branchKey}
      </span>
      <div className="flex-1">
        <NodePicker
          value={value}
          onChange={onChange}
          nodes={nodes}
          excludeId={excludeId}
          placeholder="Select target node…"
          byType={byType}
        />
      </div>
      {removable && (
        <button onClick={onRemove} className="text-text-muted hover:text-red-400 p-0.5">
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
}

// Gather's branch key→target editor — the one genuinely bespoke widget
// (dynamic add/remove keys, not a fixed field), driven by fieldType
// 'branches_map' rather than a per-type component.
function BranchesMapField({ node, onUpdate, nodes, byType }) {
  const branches = node.branches || {};
  // Node types can declare fixed outcome keys (e.g. rest_api). When present, the
  // editor offers those keys BY NAME instead of gather's numeric digit keys.
  const declared = Array.isArray(byType?.[node.type]?.branchKeys) ? byType[node.type].branchKeys : [];
  const fixedMode = declared.length > 0;

  const updateBranch = (k, v) => onUpdate(node.id, { branches: { ...branches, [k]: v } });
  const removeBranch = (k) => {
    const { [k]: _removed, ...rest } = branches;
    onUpdate(node.id, { branches: rest });
  };
  // BranchRow is a stable, module-scope component (see below) so its native
  // <select> reconciles in place instead of remounting every render.
  const row = (k, removable) => (
    <BranchRow
      key={k}
      branchKey={k}
      removable={removable}
      value={branches[k] || ''}
      nodes={nodes}
      excludeId={node.id}
      byType={byType}
      onChange={v => updateBranch(k, v)}
      onRemove={() => removeBranch(k)}
    />
  );

  if (fixedMode) {
    // Extra keys present in the data but not declared and not _default (e.g. a
    // stray "1" left over from before this node had named ports) — show them so
    // the author can see and remove them.
    const extraKeys = Object.keys(branches).filter(k => !declared.includes(k) && k !== '_default');
    return (
      <div className="space-y-1.5">
        {declared.map(k => row(k, false))}
        {extraKeys.map(k => row(k, true))}
        {row('_default', false)}
        <p className="text-[9px] text-text-muted opacity-70 mt-1">
          Wire each outcome to the node it should route to. Unwired outcomes fall back to
          <span className="font-mono"> _default</span>; if that is also unwired the call ends.
        </p>
      </div>
    );
  }

  // Free-form (gather) mode — numeric digit keys + gather's reserved keys.
  const branchKeys = Object.keys(branches);
  const addBranch = () => {
    const next = String(branchKeys.filter(k => !['timeout','invalid','_default'].includes(k)).length + 1);
    onUpdate(node.id, { branches: { ...branches, [next]: '' } });
  };
  return (
    <div className="space-y-1.5">
      {branchKeys.map(k => row(k, !['timeout','invalid','_default'].includes(k)))}
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
  // showWhen: { field, value } — hide this field when the named sibling field
  // does not equal the specified value. Used to show/hide audio_url or text fields
  // based on an explicit source_type selector on the same node.
  if (fieldDef.showWhen && node[fieldDef.showWhen.field] !== fieldDef.showWhen.value) return null;

  // conditionalOn: the field's label/hint/placeholder swap based on another
  // field's current value (e.g. condition node's expected_value field
  // means something different when operator === 'ens_pin_valid').
  const cond = fieldDef.conditionalOn;
  const active = cond && node[cond.field] === cond.value;
  const label = active ? cond.label : fieldDef.label;
  const hint = active ? cond.hint : fieldDef.hint;
  const example = active ? (cond.example ?? fieldDef.example) : fieldDef.example;
  const placeholder = active ? cond.placeholder : fieldDef.placeholder;

  const value = node[fieldDef.key];
  const set = v => onChange({ [fieldDef.key]: v });

  let control;
  switch (fieldDef.fieldType) {
    case 'textarea':
      // Textarea fields are the interpolation-capable prompt fields (say text,
      // fallback_text, gather/hold prompts, goodbye, webhook body). Render the
      // variable picker alongside them, generically.
      control = <InterpolableTextarea value={value} onChange={set} placeholder={placeholder} />;
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
      // For play node: hide the audio_url field when source type is 'variable'.
      // (showWhen handles per-source_type visibility for other nodes at the top of this function.)
      if (node.audio_source_type === 'variable') return null;
      // MediaPickerField: search + select from Media Library instead of manual path entry.
      control = <MediaPickerField value={value} onChange={set} />;
      break;
    case 'mono_text':
      // For play node: hide audio_variable when source type is 'url' (not dynamic).
      if (fieldDef.key === 'audio_variable' && node.audio_source_type !== 'variable') return null;
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
      <Field label={label} hint={hint} example={example}>{control}</Field>
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
        {/* Optional worked example shown at the top of the panel for field-heavy
            node types (registry `panelIntro`) — a realistic end-to-end example
            so a first-time author understands the whole pattern up front. */}
        {cfg.panelIntro && (
          <div className="mb-3 px-2.5 py-2 rounded-lg bg-brand/5 border border-brand/20 text-[9px] text-brand/80 leading-relaxed whitespace-pre-wrap">
            {cfg.panelIntro}
          </div>
        )}
        {/* Generic base field: Description — cosmetic authoring note shown as the
            node's canvas subtitle (beneath its summary). Available on every node
            type; never read by the Lua/XML generator. */}
        <label className="block mb-3">
          <span className="block text-[10px] font-semibold text-text-muted mb-1 uppercase tracking-wide">Description</span>
          <textarea
            value={node.description || ''}
            onChange={e => onChange({ description: e.target.value || undefined })}
            placeholder="Optional note shown on the node (e.g. Escalate unresolved billing calls to Tier 2)"
            rows={2}
            maxLength={500}
            className="w-full bg-surface border border-surface-border rounded-lg px-2.5 py-1.5
                       text-xs text-text-primary placeholder:text-text-muted focus:outline-none
                       focus:border-brand transition-colors resize-none"
          />
        </label>
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
        {isEntry && (
          <div
            title="This node executes first when a call arrives. Select another node to reassign the Start."
            className="flex items-center justify-center gap-1.5 text-[10px] font-semibold
                       text-brand bg-brand/10 border border-brand/25 rounded-lg py-1.5 cursor-default select-none"
          >
            <Star size={10} fill="currentColor" /> Start node — executes first
          </div>
        )}
        {!isEntry && (
          <button
            onClick={() => onSetEntry(node.id)}
            title="Make this node the first to execute when a call arrives"
            className="w-full flex items-center justify-center gap-1.5 text-xs py-1.5
                       rounded-lg bg-brand/10 text-brand border border-brand/20 hover:bg-brand/20 transition-colors"
          >
            <Star size={11} /> Set as Entry Node
          </button>
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
