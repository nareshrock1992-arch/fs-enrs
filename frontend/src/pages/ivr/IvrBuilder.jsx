import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, Star, X } from 'lucide-react';

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
const PROPERTY_WIDTH = 220;

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

      {/* Top bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-border bg-surface-panel shrink-0">
        <button onClick={() => navigate('/ivr')}
                className="btn-ghost p-1.5 text-text-muted hover:text-text-primary">
          <ArrowLeft size={15} />
        </button>
        <span className="text-xs text-text-muted">/</span>
        <span className="text-xs text-text-muted">IVR Flows</span>
      </div>

      {/* Toolbar */}
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

      {/* Main 3-column layout */}
      <div className="flex flex-1 min-h-0">

        {/* Left — Node Palette */}
        <div style={{ width: PALETTE_WIDTH, minWidth: PALETTE_WIDTH }}
             className="flex flex-col border-r border-surface-border bg-surface-panel overflow-hidden">
          <NodePalette onAdd={handlePaletteAdd} />
        </div>

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

          {/* Zoom controls and stats are rendered by FlowCanvas */}
        </div>

        {/* Right — Property Panel */}
        <div style={{ width: PROPERTY_WIDTH, minWidth: PROPERTY_WIDTH }}
             className="flex flex-col border-l border-surface-border bg-surface-panel overflow-hidden">
          <PropertyPanel
            node={selectedNode}
            errors={graph.errors}
            isEntry={selectedNode?.id === graph.entryNodeId}
            onUpdate={graph.updateNode}
            onDelete={graph.deleteNode}
            onSetEntry={graph.setEntry}
            nodes={graph.nodes}
          />
        </div>
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
