import { useState, useEffect } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, ToggleLeft, ToggleRight } from 'lucide-react';
import { useConfigChangesStore } from '../stores/configChangesStore.js';

/**
 * ExtensionPanel — right-hand editor for a single dialplan extension.
 *
 * Shows and edits:
 *  - Extension properties: name, continue, enabled
 *  - Conditions: field, expression, break, enabled
 *  - Actions per condition: application, data, enabled
 *  - Anti-actions per condition: application, data, enabled
 *
 * All edits are dispatched as ordered ops into configChangesStore (hierarchical
 * slice). The parent HierarchicalRenderer re-derives display state via applyOps.
 */
export default function ExtensionPanel({ extension, providerId, deploying }) {
  const { appendOp } = useConfigChangesStore();
  const [expanded, setExpanded] = useState({});

  // Auto-expand first condition when extension changes.
  useEffect(() => {
    if (!extension) return;
    const firstCond = extension.conditions?.[0];
    if (firstCond) setExpanded({ [firstCond.id]: true });
    else setExpanded({});
  }, [extension?.id]);

  if (!extension) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted text-sm p-8 text-center">
        Select an extension from the list to edit its properties.
      </div>
    );
  }

  const dispatch = (op) => appendOp(providerId, op);
  const toggleExpand = (id) => setExpanded(s => ({ ...s, [id]: !s[id] }));

  const isDisabled = deploying;

  return (
    <div className="overflow-y-auto h-full p-4 space-y-5">

      {/* ── Extension properties ─────────────────────────────────────── */}
      <section>
        <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-muted mb-3">
          Extension
        </h3>

        <div className="space-y-3">
          {/* Name */}
          <FieldRow label="Name">
            <input
              type="text"
              value={extension.name ?? ''}
              disabled={isDisabled}
              onChange={e => dispatch({
                op: 'update_extension', id: extension.id, name: e.target.value,
              })}
              className="input-sm w-full"
            />
          </FieldRow>

          {/* Continue */}
          <FieldRow label="Continue">
            <select
              value={extension.continue ?? 'false'}
              disabled={isDisabled}
              onChange={e => dispatch({
                op: 'update_extension', id: extension.id, continue: e.target.value,
              })}
              className="input-sm w-full"
            >
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
          </FieldRow>

          {/* Enabled */}
          <FieldRow label="Enabled">
            <ToggleButton
              value={extension.enabled !== false}
              disabled={isDisabled}
              onChange={v => dispatch({
                op: 'update_extension', id: extension.id, enabled: v,
              })}
            />
          </FieldRow>

          {/* ID (read-only reference) */}
          <FieldRow label="ID">
            <span className="font-mono text-[11px] text-text-muted select-all">
              {extension.id}
            </span>
          </FieldRow>
        </div>
      </section>

      {/* ── Conditions ───────────────────────────────────────────────── */}
      <section>
        <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-muted mb-3">
          Conditions ({extension.conditions?.length ?? 0})
        </h3>

        {(!extension.conditions || extension.conditions.length === 0) && (
          <p className="text-xs text-text-muted italic">No conditions defined.</p>
        )}

        <div className="space-y-2">
          {(extension.conditions ?? []).map((cond, ci) => (
            <ConditionBlock
              key={cond.id}
              cond={cond}
              index={ci}
              extensionId={extension.id}
              expanded={!!expanded[cond.id]}
              onToggle={() => toggleExpand(cond.id)}
              onDispatch={dispatch}
              disabled={isDisabled}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

// ── ConditionBlock ────────────────────────────────────────────────────────────

function ConditionBlock({ cond, index, extensionId, expanded, onToggle, onDispatch, disabled }) {
  return (
    <div className="rounded-lg border border-surface-border bg-surface-panel overflow-hidden">

      {/* Condition header */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-border
                   transition-colors select-none"
        onClick={onToggle}>
        {expanded
          ? <ChevronDown  size={12} className="text-text-muted shrink-0" />
          : <ChevronRight size={12} className="text-text-muted shrink-0" />
        }
        <span className="text-xs font-medium text-text-primary flex-1 truncate">
          <span className="text-text-muted">#{index + 1}</span>
          {' '}
          <span className="font-mono">{cond.field || 'destination_number'}</span>
          {cond.expression ? (
            <span className="text-text-muted"> = <span className="text-brand">{cond.expression}</span></span>
          ) : null}
        </span>
        <ToggleButton
          value={cond.enabled !== false}
          disabled={disabled}
          onChange={v => onDispatch({ op: 'update_condition', id: cond.id, extensionId, enabled: v })}
          small
        />
      </div>

      {expanded && (
        <div className="border-t border-surface-border p-3 space-y-4">

          {/* Condition fields */}
          <div className="space-y-2">
            <FieldRow label="Field">
              <input
                type="text"
                value={cond.field ?? ''}
                disabled={disabled}
                onChange={e => onDispatch({
                  op: 'update_condition', id: cond.id, extensionId, field: e.target.value,
                })}
                className="input-sm w-full"
                placeholder="destination_number"
              />
            </FieldRow>
            <FieldRow label="Expression">
              <input
                type="text"
                value={cond.expression ?? ''}
                disabled={disabled}
                onChange={e => onDispatch({
                  op: 'update_condition', id: cond.id, extensionId, expression: e.target.value,
                })}
                className="input-sm w-full font-mono"
                placeholder="^1234$"
              />
            </FieldRow>
            <FieldRow label="Break">
              <select
                value={cond.break ?? 'on-false'}
                disabled={disabled}
                onChange={e => onDispatch({
                  op: 'update_condition', id: cond.id, extensionId, break: e.target.value,
                })}
                className="input-sm w-full"
              >
                <option value="on-false">on-false</option>
                <option value="on-true">on-true</option>
                <option value="always">always</option>
                <option value="never">never</option>
              </select>
            </FieldRow>
          </div>

          {/* Actions */}
          <ActionList
            label="Actions"
            items={cond.actions ?? []}
            conditionId={cond.id}
            extensionId={extensionId}
            opType="action"
            onDispatch={onDispatch}
            disabled={disabled}
          />

          {/* Anti-actions */}
          <ActionList
            label="Anti-Actions"
            items={cond.antiActions ?? []}
            conditionId={cond.id}
            extensionId={extensionId}
            opType="anti_action"
            onDispatch={onDispatch}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}

// ── ActionList ────────────────────────────────────────────────────────────────

function ActionList({ label, items, conditionId, extensionId, opType, onDispatch, disabled }) {
  const addOp     = opType === 'action' ? 'add_action'     : 'add_anti_action';
  const updateOp  = opType === 'action' ? 'update_action'  : 'update_anti_action';
  const deleteOp  = opType === 'action' ? 'delete_action'  : 'delete_anti_action';

  const tempId = () => `temp_${opType}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wide text-text-muted">
          {label} ({items.length})
        </span>
        <button
          disabled={disabled}
          onClick={() => onDispatch({
            op: addOp, conditionId, extensionId, application: '', data: '', _tempId: tempId(),
          })}
          className="p-0.5 rounded text-text-muted hover:text-brand hover:bg-brand/10
                     disabled:opacity-40 transition-colors">
          <Plus size={12} />
        </button>
      </div>

      {items.length === 0 && (
        <p className="text-[11px] text-text-muted italic">None</p>
      )}

      <div className="space-y-1.5">
        {items.map(action => (
          <div key={action.id}
               className="flex items-start gap-1.5 group">
            <div className="flex-1 grid grid-cols-2 gap-1 min-w-0">
              <input
                type="text"
                value={action.application ?? ''}
                disabled={disabled}
                onChange={e => onDispatch({
                  op: updateOp, id: action.id, conditionId, extensionId,
                  application: e.target.value,
                })}
                className="input-sm w-full font-mono text-[11px]"
                placeholder="application"
              />
              <input
                type="text"
                value={action.data ?? ''}
                disabled={disabled}
                onChange={e => onDispatch({
                  op: updateOp, id: action.id, conditionId, extensionId, data: e.target.value,
                })}
                className="input-sm w-full font-mono text-[11px]"
                placeholder="data"
              />
            </div>
            <ToggleButton
              value={action.enabled !== false}
              disabled={disabled}
              onChange={v => onDispatch({
                op: updateOp, id: action.id, conditionId, extensionId, enabled: v,
              })}
              small
            />
            <button
              disabled={disabled}
              onClick={() => onDispatch({ op: deleteOp, id: action.id, conditionId, extensionId })}
              className="p-1 rounded text-text-muted opacity-0 group-hover:opacity-100
                         hover:text-red-500 hover:bg-red-500/10 disabled:opacity-40
                         transition-all shrink-0">
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Shared micro-components ───────────────────────────────────────────────────

function FieldRow({ label, children }) {
  return (
    <div className="flex items-center gap-3">
      <label className="text-[11px] text-text-muted w-20 shrink-0 font-medium">{label}</label>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function ToggleButton({ value, onChange, disabled, small }) {
  const size = small ? 14 : 16;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`shrink-0 transition-colors disabled:opacity-40
                  ${value ? 'text-green-500' : 'text-text-muted'}`}
      title={value ? 'Enabled — click to disable' : 'Disabled — click to enable'}>
      {value
        ? <ToggleRight size={size} />
        : <ToggleLeft  size={size} />
      }
    </button>
  );
}
