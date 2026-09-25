import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AlertTriangle, Star, X, PanelLeftOpen, PanelRightOpen } from 'lucide-react';

import { useIvrGraph } from '../../hooks/useIvrGraph.js';
import { api } from '../../api/client.js';

import FlowCanvas        from '../../components/ivr/canvas/FlowCanvas.jsx';
import NodePalette       from '../../components/ivr/panels/NodePalette.jsx';
import PropertyPanel     from '../../components/ivr/panels/PropertyPanel.jsx';
import BuilderToolbar    from '../../components/ivr/toolbar/BuilderToolbar.jsx';
import VersionDrawer     from '../../components/ivr/panels/VersionDrawer.jsx';
import BindNumbersModal  from '../../components/ivr/panels/BindNumbersModal.jsx';
import ValidationErrorPanel from '../../components/ivr/panels/ValidationErrorPanel.jsx';

const PALETTE_WIDTH  = 188;
// Property panel width. Default is sized for the most field-heavy node type
// (rest_api: long labels like "invalid_response", auth fields, JSON textareas)
// so it never starts truncated; simpler nodes (gather/say/hangup) just get a
// little more whitespace. User-resizable within [MIN, MAX], persisted per-viewer.
const PROPERTY_WIDTH_DEFAULT = 320;
const PROPERTY_WIDTH_MIN     = 240;
const PROPERTY_WIDTH_MAX     = 600;
const PROPERTY_WIDTH_KEY     = 'ivr.propertyPanelWidth';

export default function IvrBuilder() {
  const { uuid }   = useParams();
  const navigate   = useNavigate();

  const graph = useIvrGraph(uuid);

  // Warn on browser tab close / reload while there are unsaved changes.
  useEffect(() => {
    const handler = (e) => {
      if (!graph.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [graph.dirty]);

  // Resizable property-panel width (persisted per-viewer; safe defaults).
  const [propWidth, setPropWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(PROPERTY_WIDTH_KEY));
      if (Number.isFinite(v) && v >= PROPERTY_WIDTH_MIN && v <= PROPERTY_WIDTH_MAX) return v;
    } catch { /* ignore */ }
    return PROPERTY_WIDTH_DEFAULT;
  });
  useEffect(() => {
    try { localStorage.setItem(PROPERTY_WIDTH_KEY, String(propWidth)); } catch { /* ignore */ }
  }, [propWidth]);
  const startPropResize = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = propWidth;
    const onMove = (ev) => {
      // Panel is right-anchored: dragging LEFT (smaller clientX) widens it.
      const next = Math.min(PROPERTY_WIDTH_MAX, Math.max(PROPERTY_WIDTH_MIN, startW + (startX - ev.clientX)));
      setPropWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [propWidth]);

  // Collapsible panels — canvas-first layout. Persisted per-viewer.
  const [paletteOpen, setPaletteOpen] = useState(() => {
    try { return localStorage.getItem('ivr.paletteOpen') !== '0'; } catch { return true; }
  });
  const [inspectorOpen, setInspectorOpen] = useState(() => {
    try { return localStorage.getItem('ivr.inspectorOpen') !== '0'; } catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem('ivr.paletteOpen', paletteOpen ? '1' : '0'); } catch {} }, [paletteOpen]);
  useEffect(() => { try { localStorage.setItem('ivr.inspectorOpen', inspectorOpen ? '1' : '0'); } catch {} }, [inspectorOpen]);
  // Selecting a node re-opens the inspector (drawer behaviour).
  useEffect(() => { if (graph.selected) setInspectorOpen(true); }, [graph.selected]);

  // Responsive: auto-collapse the palette on medium/narrow viewports so the
  // canvas stays dominant. One-way nudge — the user can always re-open it, and
  // we never auto-reopen (avoids layout jumps / fighting the user).
  useEffect(() => {
    const onResize = () => { if (window.innerWidth < 1180) setPaletteOpen(false); };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const [showHistory,   setShowHistory]   = useState(false);
  const [showBind,      setShowBind]      = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [showStartHint, setShowStartHint] = useState(false);
  const [showErrorPanel, setShowErrorPanel] = useState(false);

  // First-node onboarding: show a one-time dismissible hint when the first node
  // is added to an empty flow. Dismissed state is stored per-flow in localStorage
  // so it never re-appears for flows the user has already worked with.
  const prevNodeCountRef = useRef(0);
  const nodeCount = Object.keys(graph.nodes).length;
  const hintStorageKey = `ivr_start_hint_${uuid}`;
  useEffect(() => {
    if (nodeCount === 1 && prevNodeCountRef.current === 0 && graph.entryNodeId) {
      if (!localStorage.getItem(hintStorageKey)) {
        setShowStartHint(true);
      }
    }
    prevNodeCountRef.current = nodeCount;
  }, [nodeCount, graph.entryNodeId, hintStorageKey]);

  const dismissStartHint = useCallback(() => {
    localStorage.setItem(hintStorageKey, '1');
    setShowStartHint(false);
  }, [hintStorageKey]);

  // Derived: entry was lost (nodes exist but no entry is assigned).
  const entryLost = nodeCount > 0 && !graph.entryNodeId;

  // Add node at canvas centre when clicking palette chip
  const handlePaletteAdd = useCallback((nodeType) => {
    graph.addNode(nodeType, 200 + Math.random() * 200, 100 + Math.random() * 200);
  }, [graph]);

  // Publish callback — update flowMeta with new version
  const handlePublished = useCallback((version) => {
    graph.updateMeta({
      latest_version: {
        version_number: version.version_number,
        published_at:   version.published_at,
        published_by_email: version.published_by_email,
      },
    });
  }, [graph]);

  // Reload bound numbers after bind/unbind modal changes
  const handleBindChanged = useCallback(async () => {
    try {
      const { flow } = await api.ivr.get(uuid);
      graph.updateMeta({ bound_numbers: flow.bound_numbers });
    } catch {}
  }, [uuid, graph]);

  const selectedNode = graph.selected ? graph.nodes[graph.selected] : null;

  const totalErrors = Object.values(graph.errors).flat().length;

  const handleValidateAndShow = useCallback(async () => {
    const result = await graph.validate();
    if (result && !result.valid) setShowErrorPanel(true);
    return result;
  }, [graph]);

  const handleGoToNode = useCallback((nodeId) => {
    graph.setSelected(nodeId);
    setShowErrorPanel(false);
  }, [graph]);

  if (!graph.flowMeta && Object.keys(graph.nodes).length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        Loading flow…
      </div>
    );
  }

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 56px)' }}>

      {/* Compact header + toolbar (merged into one row) */}
      <BuilderToolbar
        flow={graph.flowMeta}
        dirty={graph.dirty}
        saving={graph.saving}
        saveError={graph.saveError}
        errors={graph.errors}
        warnings={graph.warnings}
        onValidate={handleValidateAndShow}
        onPublished={handlePublished}
        onShowHistory={() => setShowHistory(true)}
        onShowBind={() => setShowBind(true)}
        onFlowChange={flow => graph.dispatch({ type: 'UPDATE_META', patch: flow })}
        onSaveNow={graph.saveNow}
        onToggleErrors={() => setShowErrorPanel(v => !v)}
        showErrors={showErrorPanel}
        onBack={() => navigate('/ivr')}
      />

      {/* Entry loss warning — persistent until a new Start node is assigned */}
      {entryLost && (
        <div className="px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2 shrink-0">
          <AlertTriangle size={12} className="text-amber-500 shrink-0" />
          <p className="text-[11px] text-amber-500 flex-1">
            <strong>No Start node assigned.</strong>{' '}
            Select another node and choose "Set as Entry Node" in the Properties panel to continue.
          </p>
        </div>
      )}

      {/* First-node hint — one-time dismissible, suppressed if entry was just lost */}
      {showStartHint && !entryLost && (
        <div className="px-4 py-2.5 bg-brand/10 border-b border-brand/20 flex items-center gap-2 shrink-0">
          <Star size={12} className="text-brand shrink-0" />
          <p className="text-[11px] text-brand/90 flex-1">
            This node is now your <strong>Start node</strong> — it executes first when a call arrives.
            To change it, select any other node and choose "Set as Entry Node" in the Properties panel.
          </p>
          <button
            onClick={dismissStartHint}
            className="text-brand/50 hover:text-brand ml-1 shrink-0 transition-colors"
            title="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Validation error panel — shown when error badge is clicked or validate fails */}
      {showErrorPanel && totalErrors > 0 && (
        <ValidationErrorPanel
          errors={graph.errors}
          warnings={graph.warnings}
          nodes={graph.nodes}
          onGoToNode={handleGoToNode}
          onClose={() => setShowErrorPanel(false)}
        />
      )}

      {/* Main canvas-first layout — side panels collapse; canvas expands */}
      <div className="flex flex-1 min-h-0 relative">

        {/* Left — Node Palette (collapsible) */}
        {paletteOpen && (
          <div style={{ width: PALETTE_WIDTH, minWidth: PALETTE_WIDTH }}
               className="flex flex-col border-r border-surface-border bg-surface-panel overflow-hidden">
            <NodePalette onAdd={handlePaletteAdd} onCollapse={() => setPaletteOpen(false)} />
          </div>
        )}

        {/* Centre — Canvas */}
        <div className="flex-1 relative overflow-hidden">
          <FlowCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            entryNodeId={graph.entryNodeId}
            errors={graph.errors}
            warnings={graph.nodeWarnings}
            selected={graph.selected}
            onSelect={graph.setSelected}
            onMoveNode={graph.moveNode}
            onDeleteNode={graph.deleteNode}
            onConnect={graph.connect}
            onDisconnect={graph.disconnect}
            onAddNode={graph.addNode}
            onDuplicateNode={graph.duplicateNode}
            onSetEntry={graph.setEntry}
            onUndo={graph.undo}
            onRedo={graph.redo}
            savedViewport={graph.viewport}
            onViewportChange={graph.moveViewport}
          />

          {/* Floating re-open toggle: palette */}
          {!paletteOpen && (
            <button
              onClick={() => setPaletteOpen(true)}
              title="Show node library"
              aria-label="Show node library"
              className="absolute left-2 top-2 z-20 flex items-center gap-1.5 px-2 py-1.5 rounded-md
                         bg-surface-panel border border-surface-border shadow-sm text-text-secondary
                         hover:text-text-primary hover:border-primary/40 transition-colors"
            >
              <PanelLeftOpen size={15} /> <span className="text-[11px] font-medium">Nodes</span>
            </button>
          )}

          {/* Floating re-open toggle: inspector (only when a node is selected) */}
          {selectedNode && !inspectorOpen && (
            <button
              onClick={() => setInspectorOpen(true)}
              title="Show inspector"
              aria-label="Show inspector"
              className="absolute right-2 top-2 z-20 flex items-center gap-1.5 px-2 py-1.5 rounded-md
                         bg-surface-panel border border-surface-border shadow-sm text-text-secondary
                         hover:text-text-primary hover:border-primary/40 transition-colors"
            >
              <PanelRightOpen size={15} /> <span className="text-[11px] font-medium">Inspector</span>
            </button>
          )}
        </div>

        {/* Right — Node Inspector (drawer: only when a node is selected AND open) */}
        {selectedNode && inspectorOpen && (
          <div style={{ width: propWidth, minWidth: propWidth }}
               className="relative flex flex-col border-l border-surface-border bg-surface-panel overflow-hidden">
            {/* Drag handle on the left edge — drag left to widen */}
            <div
              onPointerDown={startPropResize}
              title="Drag to resize"
              className="absolute left-0 top-0 h-full w-1.5 z-10 cursor-col-resize hover:bg-primary/40 active:bg-primary/60"
            />
            <PropertyPanel
              node={selectedNode}
              errors={graph.errors}
              isEntry={selectedNode?.id === graph.entryNodeId}
              onUpdate={graph.updateNode}
              onDelete={graph.deleteNode}
              onSetEntry={graph.setEntry}
              onClose={() => setInspectorOpen(false)}
              nodes={graph.nodes}
            />
          </div>
        )}
      </div>

      {/* Version history drawer */}
      {showHistory && (
        <VersionDrawer
          flowUuid={uuid}
          currentVersion={graph.flowMeta?.latest_version?.version_number}
          restoreLoading={restoreLoading}
          onClose={() => setShowHistory(false)}
          onRestore={async (v) => {
            if (!window.confirm(`Restore v${v.version_number}? This will overwrite the current draft.`)) return;
            setRestoreLoading(true);
            try {
              const { version: full } = await api.ivr.getVersion(uuid, v.version_number);
              graph.dispatch({ type: 'SEED', flow: { ...graph.flowMeta, graph: full.graph } });
              setShowHistory(false);
            } catch (e) {
              alert('Failed to load version ' + v.version_number + ': ' + (e.message || 'Unknown error'));
            } finally {
              setRestoreLoading(false);
            }
          }}
        />
      )}

      {/* Bind numbers modal */}
      {showBind && (
        <BindNumbersModal
          flowUuid={uuid}
          flowName={graph.flowMeta?.name || ''}
          boundNumbers={graph.flowMeta?.bound_numbers || []}
          onClose={() => setShowBind(false)}
          onChanged={handleBindChanged}
        />
      )}
    </div>
  );
}
