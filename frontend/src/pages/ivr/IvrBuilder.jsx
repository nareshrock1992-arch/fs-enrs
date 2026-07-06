import { useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';

import { useIvrGraph } from '../../hooks/useIvrGraph.js';
import { api } from '../../api/client.js';

import FlowCanvas     from '../../components/ivr/canvas/FlowCanvas.jsx';
import NodePalette    from '../../components/ivr/panels/NodePalette.jsx';
import PropertyPanel  from '../../components/ivr/panels/PropertyPanel.jsx';
import BuilderToolbar from '../../components/ivr/toolbar/BuilderToolbar.jsx';
import VersionDrawer  from '../../components/ivr/panels/VersionDrawer.jsx';
import BindNumbersModal from '../../components/ivr/panels/BindNumbersModal.jsx';

const PALETTE_WIDTH  = 188;
const PROPERTY_WIDTH = 220;

export default function IvrBuilder() {
  const { uuid }   = useParams();
  const navigate   = useNavigate();

  const graph = useIvrGraph(uuid);

  const [showHistory, setShowHistory] = useState(false);
  const [showBind,    setShowBind]    = useState(false);

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
        errors={graph.errors}
        warnings={graph.warnings}
        onValidate={graph.validate}
        onPublished={handlePublished}
        onShowHistory={() => setShowHistory(true)}
        onShowBind={() => setShowBind(true)}
      />

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
            selected={graph.selected}
            onSelect={graph.setSelected}
            onMoveNode={graph.moveNode}
            onDeleteNode={graph.deleteNode}
            onConnect={graph.connect}
            onDisconnect={graph.disconnect}
            onAddNode={graph.addNode}
          />

          {/* Zoom controls */}
          <div className="absolute bottom-4 left-4 flex flex-col gap-1 z-10">
            <button className="btn-ghost p-2 bg-surface-panel border border-surface-border rounded-lg shadow"
                    title="Zoom in (scroll up)">
              <ZoomIn size={13} />
            </button>
            <button className="btn-ghost p-2 bg-surface-panel border border-surface-border rounded-lg shadow"
                    title="Zoom out (scroll down)">
              <ZoomOut size={13} />
            </button>
            <button className="btn-ghost p-2 bg-surface-panel border border-surface-border rounded-lg shadow"
                    title="Fit view">
              <Maximize2 size={13} />
            </button>
          </div>

          {/* Node count badge */}
          <div className="absolute bottom-4 right-4 text-[10px] text-text-muted
                          bg-surface-panel border border-surface-border rounded-lg px-2.5 py-1.5 z-10">
            {Object.keys(graph.nodes).length} nodes · {graph.edges.length} edges
          </div>
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
          />
        </div>
      </div>

      {/* Version history drawer */}
      {showHistory && (
        <VersionDrawer
          flowUuid={uuid}
          currentVersion={graph.flowMeta?.latest_version?.version_number}
          onClose={() => setShowHistory(false)}
          onRestore={(v) => {
            if (window.confirm(`Restore v${v.version_number}? This will overwrite the current draft.`)) {
              graph.dispatch({ type: 'SEED', flow: { ...graph.flowMeta, graph: v.graph } });
              setShowHistory(false);
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
