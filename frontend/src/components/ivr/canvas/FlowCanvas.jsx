import { useRef, useState, useCallback, useEffect } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Grid } from 'lucide-react';
import { useZoomPan } from '../../../hooks/useZoomPan.js';
import { useNodeTypes } from '../../../hooks/useNodeTypes.js';
import { getPortKeysForNode } from './nodePorts.js';
import FlowNode, { NODE_WIDTH, NODE_HEIGHT } from './FlowNode.jsx';
import FlowEdge, { DraftEdge } from './FlowEdge.jsx';

// ── Port position relative to node top-left (canvas coords) ──────────────────

function portPosition(node, portKey, allPorts) {
  const portIndex = allPorts.indexOf(portKey);
  const portCount = allPorts.length;
  const x = node.x + NODE_WIDTH;
  const bodyStart  = 52;
  const portSpacing = portCount > 0 ? Math.min(22, (NODE_HEIGHT - bodyStart) / portCount) : 0;
  const y = node.y + bodyStart + Math.max(0, portIndex) * portSpacing + 10;
  return { x, y };
}

function inputPosition(node) {
  return { x: node.x, y: node.y + NODE_HEIGHT / 2 };
}

// ── Edge colours keyed by port ────────────────────────────────────────────────

const EDGE_COLORS = {
  next:     '#4f46e5',
  goto:     '#a78bfa',
  '1':      '#22c55e',
  '2':      '#3b82f6',
  '3':      '#f59e0b',
  timeout:  '#f59e0b',
  invalid:  '#ef4444',
  true:     '#22c55e',
  false:    '#ef4444',
  _default: '#64748b',
  default:  '#64748b',
};

function edgeColor(portKey) {
  return EDGE_COLORS[portKey] || EDGE_COLORS.default;
}

// ── Alignment guide helpers ───────────────────────────────────────────────────

const SNAP_GRID   = 20;
const GUIDE_SNAP  = 8; // canvas units — within this distance, snap + show guide

// Returns the 6 anchor points of a node bounding box
function nodeAnchors(node) {
  const cx = node.x + NODE_WIDTH / 2;
  const cy = node.y + NODE_HEIGHT / 2;
  const r  = node.x + NODE_WIDTH;
  const b  = node.y + NODE_HEIGHT;
  return {
    left: node.x, right: r, centerX: cx,
    top: node.y, bottom: b, centerY: cy,
  };
}

// Given candidate canvas position, compute snapped position + guide lines
function computeAlignment(dragX, dragY, nodeList, dragId, snapGrid) {
  const guides = [];
  let snapX = dragX;
  let snapY = dragY;

  const dragAnchors = nodeAnchors({ x: dragX, y: dragY });

  // Check alignment against each static node
  for (const node of nodeList) {
    if (node.id === dragId) continue;
    const sa = nodeAnchors(node);

    // Horizontal alignment (X axes)
    const xPairs = [
      [dragAnchors.left,    sa.left],
      [dragAnchors.left,    sa.right],
      [dragAnchors.left,    sa.centerX],
      [dragAnchors.right,   sa.left],
      [dragAnchors.right,   sa.right],
      [dragAnchors.right,   sa.centerX],
      [dragAnchors.centerX, sa.left],
      [dragAnchors.centerX, sa.right],
      [dragAnchors.centerX, sa.centerX],
    ];
    for (const [da, ta] of xPairs) {
      if (Math.abs(da - ta) < GUIDE_SNAP) {
        const offset = ta - da;
        snapX = dragX + offset;
        guides.push({ type: 'v', pos: ta });
        break;
      }
    }

    // Vertical alignment (Y axes)
    const yPairs = [
      [dragAnchors.top,     sa.top],
      [dragAnchors.top,     sa.bottom],
      [dragAnchors.top,     sa.centerY],
      [dragAnchors.bottom,  sa.top],
      [dragAnchors.bottom,  sa.bottom],
      [dragAnchors.bottom,  sa.centerY],
      [dragAnchors.centerY, sa.top],
      [dragAnchors.centerY, sa.bottom],
      [dragAnchors.centerY, sa.centerY],
    ];
    for (const [da, ta] of yPairs) {
      if (Math.abs(da - ta) < GUIDE_SNAP) {
        const offset = ta - da;
        snapY = dragY + offset;
        guides.push({ type: 'h', pos: ta });
        break;
      }
    }
  }

  // Grid snap (only if no alignment guide won)
  if (snapGrid && guides.length === 0) {
    snapX = Math.round(dragX / SNAP_GRID) * SNAP_GRID;
    snapY = Math.round(dragY / SNAP_GRID) * SNAP_GRID;
  }

  return { snapX, snapY, guides };
}

// ── FlowCanvas ────────────────────────────────────────────────────────────────

export default function FlowCanvas({
  nodes, edges, entryNodeId, errors, warnings,
  selected, onSelect,
  onMoveNode, onDeleteNode,
  onConnect, onDisconnect,
  onAddNode,
  onDuplicateNode,
  onUndo,
  onRedo,
}) {
  const canvasRef  = useRef(null);
  const { transform, setTransform, transformRef, cssTransform, onWheel, pan, zoomTo, reset, toCanvas } = useZoomPan();
  const { byType } = useNodeTypes();
  const portKeysFor = useCallback(
    (node) => getPortKeysForNode(node, byType[node.type]?.ports),
    [byType]
  );

  const [draft,     setDraft]     = useState(null);
  const [guides,    setGuides]    = useState([]);
  const [snapGrid,  setSnapGrid]  = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);

  // Clipboard for copy/paste
  const clipboardRef = useRef(null);

  // Current dragging node id (for alignment guides)
  const draggingIdRef  = useRef(null);
  const draggingInitRef = useRef(null); // { baseX, baseY } at drag start

  // RAF batching for pointermove → onMoveNode
  const pendingMoveRef = useRef(null);
  const rafRef         = useRef(null);

  function flushMove() {
    if (pendingMoveRef.current) {
      const { id, x, y } = pendingMoveRef.current;
      pendingMoveRef.current = null;
      onMoveNode(id, x, y);
    }
    rafRef.current = null;
  }

  const scheduledMove = useCallback((id, x, y) => {
    pendingMoveRef.current = { id, x, y };
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushMove);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onMoveNode]);

  // Wrap onMoveNode with alignment + grid snap
  const handleMoveNode = useCallback((id, rawX, rawY) => {
    const nodeList = Object.values(nodes);
    const { snapX, snapY, guides: newGuides } = computeAlignment(rawX, rawY, nodeList, id, snapGrid);
    setGuides(newGuides);
    scheduledMove(id, snapX, snapY);
  }, [nodes, snapGrid, scheduledMove]);

  // Pan via left-drag on canvas background
  const panOrigin  = useRef(null);
  const didPanRef  = useRef(false);

  const handleCanvasPointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    const el = e.target;
    if (el !== canvasRef.current && !el.classList.contains('canvas-bg')) return;
    if (e.shiftKey || spaceDown) {
      // Space+drag or shift+drag = pan
      e.preventDefault();
      let lastX = e.clientX, lastY = e.clientY;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const move = (me) => { pan(me.clientX - lastX, me.clientY - lastY); lastX = me.clientX; lastY = me.clientY; };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }
    didPanRef.current = false;
    panOrigin.current = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const handleMove = (me) => {
      if (!panOrigin.current) return;
      const dx = me.clientX - panOrigin.current.lastX;
      const dy = me.clientY - panOrigin.current.lastY;
      const totalDist = Math.hypot(me.clientX - panOrigin.current.x, me.clientY - panOrigin.current.y);
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
  }, [pan, spaceDown]);

  const handleMiddleDown = useCallback((e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    let lastX = e.clientX, lastY = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const move = (me) => { pan(me.clientX - lastX, me.clientY - lastY); lastX = me.clientX; lastY = me.clientY; };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [pan]);

  const handleCanvasClick = useCallback((e) => {
    if (didPanRef.current) { didPanRef.current = false; return; }
    if (e.target === canvasRef.current || e.target.classList.contains('canvas-bg')) {
      onSelect(null);
    }
  }, [onSelect]);

  const handleCanvasDblClick = useCallback((e) => {
    if (e.target === canvasRef.current || e.target.classList.contains('canvas-bg')) {
      const rect = canvasRef.current.getBoundingClientRect();
      const { x, y } = toCanvas(e.clientX, e.clientY, rect);
      onAddNode('play', x - NODE_WIDTH / 2, y - NODE_HEIGHT / 2);
    }
  }, [toCanvas, onAddNode]);

  // Drag start/end callbacks for FlowNode
  const handleNodeDragStart = useCallback((id) => {
    draggingIdRef.current = id;
    const node = nodes[id];
    if (node) draggingInitRef.current = { baseX: node.x, baseY: node.y };
  }, [nodes]);

  const handleNodeDragEnd = useCallback(() => {
    draggingIdRef.current = null;
    draggingInitRef.current = null;
    setGuides([]);
  }, []);

  // ── Attach wheel natively with { passive: false } ─────────────────────────
  // React 17+ attaches synthetic onWheel passively → e.preventDefault() is a no-op.
  // We must use a native listener to prevent the browser's own scroll/zoom.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheel]);

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

  function getPortPos(nodeId, portKey) {
    const node = nodes[nodeId];
    if (!node) return { x: 0, y: 0 };
    return portPosition(node, portKey, portKeysFor(node));
  }

  // ── Fit view ──────────────────────────────────────────────────────────────

  const nodeList = Object.values(nodes);

  const handleFitView = useCallback(() => {
    if (nodeList.length === 0) { reset(); return; }
    const xs   = nodeList.map(n => n.x);
    const ys   = nodeList.map(n => n.y);
    const minX = Math.min(...xs) - 40;
    const minY = Math.min(...ys) - 40;
    const maxX = Math.max(...xs) + NODE_WIDTH  + 40;
    const maxY = Math.max(...ys) + NODE_HEIGHT + 40;
    const el   = canvasRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const scale = Math.min(2, Math.max(0.15, Math.min(width / (maxX - minX), height / (maxY - minY))));
    const x = (width  - (maxX - minX) * scale) / 2 - minX * scale;
    const y = (height - (maxY - minY) * scale) / 2 - minY * scale;
    setTransform({ x, y, scale });
  }, [nodeList, setTransform, reset]);

  // ── Zoom buttons ──────────────────────────────────────────────────────────

  const handleZoomIn = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    zoomTo(transformRef.current.scale * 1.25, width / 2, height / 2);
  }, [zoomTo, transformRef]);

  const handleZoomOut = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    zoomTo(transformRef.current.scale / 1.25, width / 2, height / 2);
  }, [zoomTo, transformRef]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === ' ') setSpaceDown(true);

      const tag = document.activeElement?.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      // Delete / Backspace — remove selected node
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !inInput) {
        e.preventDefault();
        onDeleteNode(selected);
        return;
      }

      // Ctrl/Cmd shortcuts
      if (e.ctrlKey || e.metaKey) {
        switch (e.key) {
          case 'z':
            e.preventDefault();
            if (e.shiftKey) onRedo?.(); else onUndo?.();
            break;
          case 'y':
            e.preventDefault();
            onRedo?.();
            break;
          case 'c':
            if (!inInput && selected && nodes[selected]) {
              e.preventDefault();
              clipboardRef.current = { ...nodes[selected] };
            }
            break;
          case 'v':
            if (!inInput && clipboardRef.current) {
              e.preventDefault();
              const src = clipboardRef.current;
              onDuplicateNode?.(src, src.x + 24, src.y + 24);
            }
            break;
          case 'd':
            if (!inInput && selected && nodes[selected]) {
              e.preventDefault();
              const src = nodes[selected];
              onDuplicateNode?.(src, src.x + 24, src.y + 24);
            }
            break;
          case 'a':
            if (!inInput) e.preventDefault(); // no multi-select yet; just block browser select-all
            break;
          default: break;
        }
        return;
      }

      // Arrow key nudge
      if (!inInput && selected && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const node = nodes[selected];
        if (!node) return;
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp'   ? -step : e.key === 'ArrowDown'  ? step : 0;
        onMoveNode(selected, node.x + dx, node.y + dy);
        return;
      }

      // G — toggle snap-to-grid
      if (!inInput && e.key === 'g') {
        e.preventDefault();
        setSnapGrid(prev => !prev);
        return;
      }

      // F — fit view
      if (!inInput && e.key === 'f') {
        e.preventDefault();
        handleFitView();
        return;
      }
    };

    const onKeyUp = (e) => {
      if (e.key === ' ') setSpaceDown(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [selected, nodes, onDeleteNode, onUndo, onRedo, onDuplicateNode, onMoveNode, handleFitView]);

  // Cursor: grabbing when space is held (pan mode)
  const canvasCursor = spaceDown ? 'grab' : 'default';

  // Guide line extent (large canvas-space value for full-viewport lines)
  const GUIDE_EXTENT = 20000;

  return (
    <div
      ref={canvasRef}
      className="canvas-bg relative overflow-hidden"
      style={{ width: '100%', height: '100%', background: '#0d1117', cursor: canvasCursor }}
      onPointerDown={(e) => { handleCanvasPointerDown(e); handleMiddleDown(e); }}
      onClick={handleCanvasClick}
      onDoubleClick={handleCanvasDblClick}
    >
      {/* Dual dot-grid background */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <defs>
          {/* Minor grid — 20px dots */}
          <pattern id="grid-minor"
            x={transform.x % (20 * transform.scale)}
            y={transform.y % (20 * transform.scale)}
            width={20 * transform.scale}
            height={20 * transform.scale}
            patternUnits="userSpaceOnUse">
            <circle cx={1} cy={1} r={0.7} fill="#1a2535" />
          </pattern>
          {/* Major grid — 100px dots (every 5 minor) */}
          <pattern id="grid-major"
            x={transform.x % (100 * transform.scale)}
            y={transform.y % (100 * transform.scale)}
            width={100 * transform.scale}
            height={100 * transform.scale}
            patternUnits="userSpaceOnUse">
            <circle cx={1} cy={1} r={1.3} fill="#243045" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid-minor)" />
        <rect width="100%" height="100%" fill="url(#grid-major)" />
      </svg>

      {/* Snap-to-grid indicator */}
      {snapGrid && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
          <span className="text-[9px] bg-indigo-900/80 border border-indigo-700 text-indigo-300
                           rounded-full px-2.5 py-1 font-mono">
            Snap G
          </span>
        </div>
      )}

      {/* Transform container */}
      <div style={{ transform: cssTransform, transformOrigin: '0 0', position: 'absolute', inset: 0 }}>

        {/* SVG layer — edges + alignment guides */}
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}>
          <defs>
            {Object.entries(EDGE_COLORS).map(([k, c]) => (
              <marker key={k} id={`arrow-${c.replace('#', '')}`}
                markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L0,6 L8,3 z" fill={c} opacity="0.85" />
              </marker>
            ))}
          </defs>

          {/* Edges */}
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

          {/* Draft edge while dragging a port */}
          {draft?.toX !== undefined && (
            <DraftEdge
              fromX={draft.x} fromY={draft.y}
              toX={draft.toX} toY={draft.toY}
            />
          )}

          {/* Alignment guide lines */}
          {guides.map((g, i) => (
            g.type === 'v'
              ? <line key={i} x1={g.pos} y1={-GUIDE_EXTENT} x2={g.pos} y2={GUIDE_EXTENT}
                  stroke="#6366f1" strokeWidth={1 / transform.scale} strokeDasharray={`${4 / transform.scale},${4 / transform.scale}`} />
              : <line key={i} x1={-GUIDE_EXTENT} y1={g.pos} x2={GUIDE_EXTENT} y2={g.pos}
                  stroke="#6366f1" strokeWidth={1 / transform.scale} strokeDasharray={`${4 / transform.scale},${4 / transform.scale}`} />
          ))}
        </svg>

        {/* Node divs */}
        {nodeList.map(node => (
          <FlowNode
            key={node.id}
            node={node}
            isSelected={selected === node.id}
            isEntry={entryNodeId === node.id}
            hasErrors={!!(errors[node.id]?.length)}
            hasWarnings={!!(warnings?.[node.id]?.length)}
            edges={edges}
            scale={transform.scale}
            onSelect={onSelect}
            onMove={handleMoveNode}
            onDelete={onDeleteNode}
            onPortDragStart={handlePortDragStart}
            onDragStart={handleNodeDragStart}
            onDragEnd={handleNodeDragEnd}
            onPortClick={(targetId) => {
              if (draft) {
                onConnect(draft.fromNode, draft.fromPort, targetId);
                setDraft(null);
              }
            }}
          />
        ))}

        {/* Empty state */}
        {nodeList.length === 0 && (
          <div style={{
            position: 'absolute', top: '45%', left: '50%',
            transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none',
          }}>
            <p className="text-text-muted text-sm">Drag to pan · Ctrl+Scroll to zoom</p>
            <p className="text-text-muted text-xs mt-1">Double-click canvas or click a node type in the palette →</p>
          </div>
        )}
      </div>

      {/* Zoom controls */}
      <div className="absolute bottom-4 left-4 flex flex-col gap-1 z-10" style={{ pointerEvents: 'all' }}>
        <button
          className="btn-ghost p-2 bg-surface-panel border border-surface-border rounded-lg shadow"
          title="Zoom in (Ctrl++)"
          onClick={handleZoomIn}
        >
          <ZoomIn size={13} />
        </button>
        <button
          className="btn-ghost p-2 bg-surface-panel border border-surface-border rounded-lg shadow"
          title="Zoom out (Ctrl+-)"
          onClick={handleZoomOut}
        >
          <ZoomOut size={13} />
        </button>
        <button
          className="btn-ghost p-2 bg-surface-panel border border-surface-border rounded-lg shadow"
          title="Fit view (F)"
          onClick={handleFitView}
        >
          <Maximize2 size={13} />
        </button>
        <button
          className={`btn-ghost p-2 border rounded-lg shadow ${snapGrid ? 'bg-indigo-900 border-indigo-600 text-indigo-300' : 'bg-surface-panel border-surface-border'}`}
          title="Snap to grid (G)"
          onClick={() => setSnapGrid(prev => !prev)}
        >
          <Grid size={13} />
        </button>
      </div>

      {/* Status badge */}
      <div className="absolute bottom-4 right-4 text-[10px] text-text-muted
                      bg-surface-panel border border-surface-border rounded-lg px-2.5 py-1.5 z-10">
        {nodeList.length} node{nodeList.length !== 1 ? 's' : ''} · {edges.length} edge{edges.length !== 1 ? 's' : ''} · {Math.round(transform.scale * 100)}%
      </div>

      {/* Keyboard hint */}
      <div className="absolute top-3 right-4 text-[9px] text-text-muted
                      bg-surface-panel/80 border border-surface-border rounded-lg px-2.5 py-1.5 z-10
                      pointer-events-none opacity-50 leading-relaxed">
        <span>Del · Ctrl+Z/Y · Ctrl+C/V/D · Arrows · G snap · F fit</span>
      </div>
    </div>
  );
}
