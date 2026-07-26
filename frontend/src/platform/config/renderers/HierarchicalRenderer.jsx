import { useState, useMemo } from 'react';
import { Undo2, Redo2, Plus, GitBranch, MessageSquare, Code2 } from 'lucide-react';
import { useConfigChangesStore } from '../stores/configChangesStore.js';
import { applyOps } from './applyHierarchicalOps.js';
import ExtensionPanel from './ExtensionPanel.jsx';

/**
 * HierarchicalRenderer — two-pane editor for hierarchical XML providers.
 *
 * Left pane:  Extension list (all nodes with type icons; extensions selectable).
 * Right pane: ExtensionPanel for the selected extension.
 *
 * Undo/redo toolbar driven by configChangesStore ordered-ops slice.
 * Display state is server nodes + active ops replayed via applyOps (pure,
 * client-side preview — no extra API call needed until deploy).
 *
 * Used by ConfigPage when docType === 'hierarchical'.
 * Will be reused by Directory, IVR script contexts, and Call Center routing
 * tables without modification.
 */
export default function HierarchicalRenderer({ providerId, entries, deploying }) {
  const [selectedId, setSelectedId] = useState(null);

  // Reactive selector — pointer change triggers re-render when ops change.
  const opPointer = useConfigChangesStore(s => s._ops?.get(providerId)?.pointer ?? -1);
  // Method references are stable; read via getState() so we don't subscribe to
  // every flat-provider change in the store (those would cause needless re-renders).
  const { getOps, appendOp, undoLast, redoNext, canUndo, canRedo } =
    useConfigChangesStore.getState();

  const activeOps = useMemo(
    () => getOps(providerId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getOps, providerId, opPointer]
  );

  const nodes = useMemo(
    () => applyOps(entries, activeOps),
    [entries, activeOps]
  );

  const extensions = useMemo(() => nodes.filter(n => n.type === 'extension'), [nodes]);
  const comments   = useMemo(() => nodes.filter(n => n.type === 'comment'),   [nodes]);
  const directives = useMemo(() => nodes.filter(n => n.type === 'directive'), [nodes]);

  const selectedExtension = useMemo(
    () => extensions.find(e => e.id === selectedId) ?? null,
    [extensions, selectedId]
  );

  const handleAddExtension = () => {
    const tempId = `temp_ext_${Date.now()}`;
    appendOp(providerId, { op: 'add_extension', name: 'new_extension', _tempId: tempId });
    setSelectedId(tempId);
  };

  return (
    <div className="flex gap-0 border border-surface-border rounded-xl overflow-hidden"
         style={{ minHeight: '520px' }}>

      {/* ── Left: node list ────────────────────────────────────────────── */}
      <div className="w-64 shrink-0 border-r border-surface-border flex flex-col bg-surface-panel">

        {/* Toolbar */}
        <div className="flex items-center gap-1 px-3 py-2 border-b border-surface-border">
          <button
            disabled={!canUndo(providerId) || deploying}
            onClick={() => undoLast(providerId)}
            title="Undo"
            className="p-1.5 rounded hover:bg-surface-border text-text-muted
                       hover:text-text-primary disabled:opacity-30 transition-colors">
            <Undo2 size={13} />
          </button>
          <button
            disabled={!canRedo(providerId) || deploying}
            onClick={() => redoNext(providerId)}
            title="Redo"
            className="p-1.5 rounded hover:bg-surface-border text-text-muted
                       hover:text-text-primary disabled:opacity-30 transition-colors">
            <Redo2 size={13} />
          </button>
          <span className="flex-1" />
          <button
            disabled={deploying}
            onClick={handleAddExtension}
            title="Add extension"
            className="flex items-center gap-1 px-2 py-1 rounded bg-brand/10 text-brand
                       text-[11px] font-medium hover:bg-brand/20 disabled:opacity-40
                       transition-colors">
            <Plus size={11} /> Add
          </button>
        </div>

        {/* Stats strip */}
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-surface-border
                        text-[10px] text-text-muted">
          <span className="flex items-center gap-1">
            <GitBranch size={10} /> {extensions.length}
          </span>
          {comments.length > 0 && (
            <span className="flex items-center gap-1">
              <MessageSquare size={10} /> {comments.length}
            </span>
          )}
          {directives.length > 0 && (
            <span className="flex items-center gap-1">
              <Code2 size={10} /> {directives.length}
            </span>
          )}
        </div>

        {/* Node list */}
        <div className="flex-1 overflow-y-auto py-1">
          {nodes.length === 0 && (
            <p className="text-[11px] text-text-muted italic px-3 py-4 text-center">
              No entries in this context.
            </p>
          )}

          {nodes.map(node => (
            <NodeRow
              key={node.id}
              node={node}
              selected={selectedId === node.id}
              onSelect={node.type === 'extension' ? () => setSelectedId(node.id) : undefined}
            />
          ))}
        </div>
      </div>

      {/* ── Right: extension editor ─────────────────────────────────────── */}
      <div className="flex-1 min-w-0">
        <ExtensionPanel
          extension={selectedExtension}
          providerId={providerId}
          deploying={deploying}
        />
      </div>
    </div>
  );
}

// ── NodeRow ───────────────────────────────────────────────────────────────────

const NODE_ICONS = {
  extension: <GitBranch  size={12} className="text-brand shrink-0" />,
  comment:   <MessageSquare size={12} className="text-text-muted shrink-0" />,
  directive: <Code2 size={12} className="text-violet-500 shrink-0" />,
};

function NodeRow({ node, selected, onSelect }) {
  const isClickable = !!onSelect;
  const enabled     = node.enabled !== false;

  return (
    <div
      onClick={onSelect}
      className={`flex items-center gap-2 px-3 py-1.5 text-xs transition-colors
                  ${isClickable ? 'cursor-pointer' : 'cursor-default'}
                  ${selected
                    ? 'bg-brand/10 text-brand'
                    : isClickable
                      ? 'text-text-muted hover:text-text-primary hover:bg-surface-border'
                      : 'text-text-muted'
                  }`}>
      {NODE_ICONS[node.type] ?? <span className="w-3 shrink-0" />}
      <span className={`flex-1 truncate font-mono text-[11px]
                        ${!enabled && node.type === 'extension' ? 'line-through opacity-50' : ''}`}>
        {node.type === 'extension' && (node.name || <em className="not-italic opacity-60">unnamed</em>)}
        {node.type === 'comment'   && <em className="not-italic opacity-60">{(node.text ?? '').slice(0, 40)}</em>}
        {node.type === 'directive' && <em className="not-italic opacity-60">{(node.raw ?? '').slice(0, 40)}</em>}
      </span>
      {node.type === 'extension' && (
        <span className={`text-[9px] px-1 py-0.5 rounded font-medium
          ${enabled
            ? 'bg-green-500/10 text-green-600 dark:text-green-400'
            : 'bg-surface-border text-text-muted'
          }`}>
          {enabled ? 'on' : 'off'}
        </span>
      )}
    </div>
  );
}
