import { useRef, useState, useCallback, useEffect } from 'react';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { useZoomPan } from '../../../hooks/useZoomPan.js';
import { useNodeTypes } from '../../../hooks/useNodeTypes.js';
import { getPortKeysForNode } from './nodePorts.js';
import FlowNode, { NODE_WIDTH, NODE_HEIGHT } from './FlowNode.jsx';
import FlowEdge, { DraftEdge } from './FlowEdge.jsx';

// Phase 3: port keys come from the same shared nodePorts.js the node cards
// themselves use (via the registry's `ports` strategy field) — this used
// to be an independently hand-maintained copy of FlowNode.jsx's switch
// statement, with a comment literally warning "must match getPorts in
// FlowNode.jsx." That's exactly the kind of duplication that drifts
// silently; there is now exactly one place this logic lives.

// ── Port position relative to node top-left (canvas coords) ──────────────────

function portPosition(node, portKey, allPorts) {
  const portIndex = allPorts.indexOf(portKey);
  const portCount = allPorts.length;
  const x = node.x + NODE_WIDTH;
  const bodyStart = 52;
  const portSpacing = portCount > 0 ? Math.min(22, (NODE_HEIGHT - bodyStart) / portCount) : 0;
  const y = node.y + bodyStart + Math.max(0, portIndex) * portSpacing + 10;
  return { x, y };
}

// Input port: left-centre of node
function inputPosition(node) {
  return { x: node.x, y: node.y + NODE_HEIGHT / 2 };
}

// Arrow marker colours — keyed by port key
const EDGE_COLORS = {
  next:      '#4f46e5',
  goto:      '#a78bfa',
  '1':       '#22c55e',
  '2':       '#3b82f6',
  '3':       '#f59e0b',
  timeout:   '#f59e0b',
  invalid:   '#ef4444',
  true:      '#22c55e',
  false:     '#ef4444',
  _default:  '#64748b',
  default:   '#64748b',
};

function edgeColor(portKey) {
  return EDGE_COLORS[portKey] || EDGE_COLORS.default;
}

export default function FlowCanvas({
  nodes, edges, entryNodeId, errors,
  selected, onSelect,
  onMoveNode, onDeleteNode,
  onConnect, onDisconnect,
  onAddNode,
}) {
  const canvasRef  = useRef(null);
  const { transform, setTransform, cssTransform, onWheel, pan, reset, toCanvas } = useZoomPan();
  const { byType } = useNodeTypes();
  const portKeysFor = useCallback(
    (node) => getPortKeysForNode(node, byType[node.type]?.ports),
    [byType]
  );

  // Draft edge state (while dragging a connection)
  const [draft, setDraft] = useState(null);

  // Pan-via-left-drag tracking
  const panOrigin  = useRef(null);
  const didPanRef  = useRef(false);

  // ── Canvas left-drag to pan ───────────────────────────────────────────────

  const handleCanvasPointerDown = useCallback((e) => {
    // Only left-click on the canvas background itself
    if (e.button !== 0) return;
    const el = e.target;
    if (el !== canvasRef.current && !el.classList.contains('canvas-bg')) return;

    didPanRef.current = false;
    panOrigin.current = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);

    const handleMove = (me) => {
      if (!panOrigin.current) return;
      const dx = me.clientX - panOrigin.current.lastX;
      const dy = me.clientY - panOrigin.current.lastY;
      const totalDist = Math.abs(me.clientX - panOrigin.current.x) + Math.abs(me.clientY - panOrigin.current.y);
      if (totalDist > 4) didPanRef.current = true;
      if (didPanRef.current) {
        pan(dx, dy);
        panOrigin.current.lastX = me.clientX;
        panOrigin.current.lastY = me.clientY;
      }
    };

    const handleUp = () => {
      panOrigin.current = null;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup',   handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup',   handleUp);
  }, [pan]);

  // Middle-mouse / shift+left pan (legacy — kept for ergonomics)
  const handleMiddleDown = useCallback((e) => {
    if (e.button !== 1 && !(e.button === 0 && e.shiftKey)) return;
    e.preventDefault();
    let lastX = e.clientX;
    let lastY = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);

    const handleMove = (me) => {
      pan(me.clientX - lastX, me.clientY - lastY);
      lastX = me.clientX;
      lastY = me.clientY;
    };
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup',   handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup',   handleUp);
  }, [pan]);

  // Click on canvas background to deselect (only if we didn't pan)
  const handleCanvasClick = useCallback((e) => {
    if (didPanRef.current) { didPanRef.current = false; return; }
    if (e.target === canvasRef.current || e.target.classList.contains('canvas-bg')) {
      onSelect(null);
    }
  }, [onSelect]);

  // Double-click on canvas background to add a play node at cursor
  const handleCanvasDblClick = useCallback((e) => {
    if (e.target === canvasRef.current || e.target.classList.contains('canvas-bg')) {
      const rect = canvasRef.current.getBoundingClientRect();
      const { x, y } = toCanvas(e.clientX, e.clientY, rect);
      onAddNode('play', x - NODE_WIDTH / 2, y - NODE_HEIGHT / 2);
    }
  }, [toCanvas, onAddNode]);

  // Delete key removes selected node
  useEffect(() => {
    const onKey = (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        const tag = document.activeElement?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
          onDeleteNode(selected);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, onDeleteNode]);

  // ── Port drag to create connection ────────────────────────────────────────

  const handlePortDragStart = useCallback((nodeId, portKey) => {
    const node = nodes[nodeId];
    if (!node) return;
    const allPorts = portKeysFor(node);
    const { x, y } = portPosition(node, portKey, allPorts);
    setDraft({ fromNode: nodeId, fromPort: portKey, x, y });

    const onMove = (e) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const pos  = toCanvas(e.clientX, e.clientY, rect);
      setDraft(d => d ? { ...d, toX: pos.x, toY: pos.y } : d);
    };

    const onUp = (e) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup',   onUp);
      const els      = document.elementsFromPoint(e.clientX, e.clientY);
      const targetEl = els.find(el => el.dataset?.nodeId && el.dataset.nodeId !== nodeId);
      if (targetEl?.dataset?.nodeId) {
        onConnect(nodeId, portKey, targetEl.dataset.nodeId);
      }
      setDraft(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup',   onUp);
  }, [nodes, toCanvas, onConnect, portKeysFor]);

  // ── Port position helpers (shared for edges + drag) ──────────────────────

  function getPortPos(nodeId, portKey) {
    const node = nodes[nodeId];
    if (!node) return { x: 0, y: 0 };
    const allPorts = portKeysFor(node);
    return portPosition(node, portKey, allPorts);
  }

  const nodeList = Object.values(nodes);

  // ── Zoom controls ─────────────────────────────────────────────────────────

  const handleZoomIn  = useCallback(() => {
    // Zoom in around canvas centre
    const el = canvasRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const syntheticWheel = new WheelEvent('wheel', { deltaY: -120, clientX: width / 2, clientY: height / 2, bubbles: true });
    el.dispatchEvent(syntheticWheel);
  }, []);

  const handleZoomOut = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const syntheticWheel = new WheelEvent('wheel', { deltaY: 120, clientX: width / 2, clientY: height / 2, bubbles: true });
    el.dispatchEvent(syntheticWheel);
  }, []);

  const handleFitView = useCallback(() => {
    if (nodeList.length === 0) { reset(); return; }
    const xs    = nodeList.map(n => n.x);
    const ys    = nodeList.map(n => n.y);
    const minX  = Math.min(...xs) - 40;
    const minY  = Math.min(...ys) - 40;
    const maxX  = Math.max(...xs) + NODE_WIDTH  + 40;
    const maxY  = Math.max(...ys) + NODE_HEIGHT + 40;
    const el    = canvasRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const scale = Math.min(2, Math.max(0.3, Math.min(width / (maxX - minX), height / (maxY - minY))));
    const x     = (width  - (maxX - minX) * scale) / 2 - minX * scale;
    const y     = (height - (maxY - minY) * scale) / 2 - minY * scale;
    setTransform({ x, y, scale });
  }, [nodeList, setTransform, reset]);

  return (
    <div
      ref={canvasRef}
      className="canvas-bg relative overflow-hidden"
      style={{ width: '100%', height: '100%', background: '#0d1117', cursor: 'default' }}
      onWheel={onWheel}
      onPointerDown={(e) => { handleCanvasPointerDown(e); handleMiddleDown(e); }}
      onClick={handleCanvasClick}
      onDoubleClick={handleCanvasDblClick}
    >
      {/* Dot grid background */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <defs>
          <pattern id="grid"
            x={transform.x % (20 * transform.scale)}
            y={transform.y % (20 * transform.scale)}
            width={20 * transform.scale}
            height={20 * transform.scale}
            patternUnits="userSpaceOnUse">
            <circle cx={1} cy={1} r={0.8} fill="#1e2a3a" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>

      {/* Transform container */}
      <div style={{ transform: cssTransform, transformOrigin: '0 0', position: 'absolute', inset: 0 }}>

        {/* SVG edge layer — behind nodes */}
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}>
          <defs>
            {Object.entries(EDGE_COLORS).map(([k, c]) => (
              <marker key={k} id={`arrow-${c.replace('#', '')}`}
                markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L0,6 L8,3 z" fill={c} opacity="0.85" />
              </marker>
            ))}
          </defs>

          {edges.map(edge => {
            if (!nodes[edge.from] || !nodes[edge.to]) return null;
            const from = getPortPos(edge.from, edge.fromPort);
            const to   = inputPosition(nodes[edge.to]);
            return (
              <FlowEdge
                key={edge.id}
                fromX={from.x} fromY={from.y}
                toX={to.x}    toY={to.y}
                label={edge.fromPort !== 'next' && edge.fromPort !== 'goto' ? edge.fromPort : undefined}
                color={edgeColor(edge.fromPort)}
                onDoubleClick={() => onDisconnect(edge.from, edge.fromPort)}
              />
            );
          })}

          {/* Draft edge while dragging */}
          {draft?.toX !== undefined && (
            <DraftEdge
              fromX={draft.x} fromY={draft.y}
              toX={draft.toX} toY={draft.toY}
            />
          )}
        </svg>

        {/* Node divs */}
        {nodeList.map(node => (
          <FlowNode
            key={node.id}
            node={node}
            isSelected={selected === node.id}
            isEntry={entryNodeId === node.id}
            hasErrors={!!(errors[node.id]?.length)}
            edges={edges}
            scale={transform.scale}
            onSelect={onSelect}
            onMove={onMoveNode}
            onDelete={onDeleteNode}
            onPortDragStart={handlePortDragStart}
            onPortClick={(targetId) => {
              if (draft) {
                onConnect(draft.fromNode, draft.fromPort, targetId);
                setDraft(null);
              }
            }}
          />
        ))}

        {/* Empty state hint */}
        {nodeList.length === 0 && (
          <div style={{
            position: 'absolute', top: '45%', left: '50%',
            transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none',
          }}>
            <p className="text-text-muted text-sm">Drag to pan · Scroll to zoom</p>
            <p className="text-text-muted text-xs mt-1">Double-click canvas or click a node type in the palette →</p>
          </div>
        )}
      </div>

      {/* Zoom controls — wired to zoom state */}
      <div className="absolute bottom-4 left-4 flex flex-col gap-1 z-10" style={{ pointerEvents: 'all' }}>
        <button
          className="btn-ghost p-2 bg-surface-panel border border-surface-border rounded-lg shadow"
          title="Zoom in"
          onClick={handleZoomIn}
        >
          <ZoomIn size={13} />
        </button>
        <button
          className="btn-ghost p-2 bg-surface-panel border border-surface-border rounded-lg shadow"
          title="Zoom out"
          onClick={handleZoomOut}
        >
          <ZoomOut size={13} />
        </button>
        <button
          className="btn-ghost p-2 bg-surface-panel border border-surface-border rounded-lg shadow"
          title="Fit all nodes in view"
          onClick={handleFitView}
        >
          <Maximize2 size={13} />
        </button>
      </div>

      {/* Node count / scale badge */}
      <div className="absolute bottom-4 right-4 text-[10px] text-text-muted
                      bg-surface-panel border border-surface-border rounded-lg px-2.5 py-1.5 z-10">
        {nodeList.length} node{nodeList.length !== 1 ? 's' : ''} · {edges.length} edge{edges.length !== 1 ? 's' : ''} · {Math.round(transform.scale * 100)}%
      </div>

      {/* Pan hint */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 text-[9px] text-text-muted
                      bg-surface-panel/80 border border-surface-border rounded-full px-3 py-1 z-10
                      pointer-events-none opacity-50">
        Drag canvas to pan · Scroll to zoom · Double-click to add node
      </div>
    </div>
  );
}
