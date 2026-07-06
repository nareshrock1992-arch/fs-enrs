import { useRef, useState, useCallback, useEffect } from 'react';
import { useZoomPan } from '../../../hooks/useZoomPan.js';
import { useCanvasDrag } from '../../../hooks/useDrag.js';
import FlowNode, { NODE_WIDTH, NODE_HEIGHT } from './FlowNode.jsx';
import FlowEdge, { DraftEdge } from './FlowEdge.jsx';

// Port position relative to node top-left (canvas coords)
function portPosition(node, portKey, allPorts) {
  const portIndex = allPorts.indexOf(portKey);
  const portCount = allPorts.length;
  // Output port: right side of node, vertically distributed
  const x = node.x + NODE_WIDTH;
  const bodyStart = 52; // px below node top (below header)
  const portSpacing = portCount > 0 ? Math.min(22, (NODE_HEIGHT - bodyStart) / portCount) : 0;
  const y = node.y + bodyStart + portIndex * portSpacing + 10;
  return { x, y };
}

// Input port: left centre of node
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
  true:      '#22c55e',   // condition true branch
  false:     '#ef4444',   // condition false branch
  _default:  '#64748b',   // gather catch-all
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
  const canvasRef = useRef(null);
  const { transform, cssTransform, onWheel, pan, toCanvas } = useZoomPan();
  const { onPointerDown: canvasPanDown } = useCanvasDrag({ onPan: pan });

  // Draft edge state (while dragging a connection)
  const [draft, setDraft] = useState(null); // { fromNode, fromPort, x, y }
  const draftRef = useRef(null);
  draftRef.current = draft;

  // Start connection drag from a port
  const handlePortDragStart = useCallback((nodeId, portKey) => {
    const node = nodes[nodeId];
    if (!node) return;

    const allPorts = Object.keys(nodes[nodeId]?.branches || {});
    if (portKey === 'next' || portKey === 'goto') allPorts.push(portKey);
    const { x, y } = portPosition(node, portKey, portKey === 'next' || portKey === 'goto'
      ? [portKey] : Object.keys(node.branches || {}));

    setDraft({ fromNode: nodeId, fromPort: portKey, x, y });

    const onMove = (e) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const pos  = toCanvas(e.clientX, e.clientY, rect);
      setDraft(d => d ? { ...d, toX: pos.x, toY: pos.y } : d);
    };

    const onUp = (e) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup',   onUp);
      // Check if pointer is over a node
      const els = document.elementsFromPoint(e.clientX, e.clientY);
      const targetEl = els.find(el => el.dataset?.nodeId && el.dataset.nodeId !== nodeId);
      if (targetEl?.dataset?.nodeId) {
        onConnect(nodeId, portKey, targetEl.dataset.nodeId);
      }
      setDraft(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup',   onUp);
  }, [nodes, toCanvas, onConnect]);

  // Click on canvas background to deselect
  const handleCanvasClick = useCallback((e) => {
    if (e.target === canvasRef.current || e.target.classList.contains('canvas-bg')) {
      onSelect(null);
    }
  }, [onSelect]);

  // Double-click on canvas background to add a node
  const handleCanvasDblClick = useCallback((e) => {
    if (e.target === canvasRef.current || e.target.classList.contains('canvas-bg')) {
      const rect = canvasRef.current.getBoundingClientRect();
      const { x, y } = toCanvas(e.clientX, e.clientY, rect);
      onAddNode('play', x - NODE_WIDTH / 2, y - NODE_HEIGHT / 2);
    }
  }, [toCanvas, onAddNode]);

  // Delete key
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selected && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
          onDeleteNode(selected);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, onDeleteNode]);

  // Build port position lookup for edges
  const nodeList = Object.values(nodes);

  function getPortPos(nodeId, portKey) {
    const node = nodes[nodeId];
    if (!node) return { x: 0, y: 0 };
    if (portKey === 'next' || portKey === 'goto') {
      return portPosition(node, portKey, [portKey]);
    }
    const branchKeys = Object.keys(node.branches || {});
    return portPosition(node, portKey, branchKeys);
  }

  return (
    <div
      ref={canvasRef}
      className="canvas-bg relative overflow-hidden"
      style={{ width: '100%', height: '100%', background: '#0d1117', cursor: 'default' }}
      onWheel={onWheel}
      onPointerDown={canvasPanDown}
      onClick={handleCanvasClick}
      onDoubleClick={handleCanvasDblClick}
    >
      {/* Dot grid background */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <defs>
          <pattern id="grid" x={transform.x % (20 * transform.scale)} y={transform.y % (20 * transform.scale)}
            width={20 * transform.scale} height={20 * transform.scale} patternUnits="userSpaceOnUse">
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
            const from = getPortPos(edge.from, edge.fromPort);
            const to   = inputPosition(nodes[edge.to]);
            if (!nodes[edge.from] || !nodes[edge.to]) return null;
            return (
              <FlowEdge
                key={edge.id}
                fromX={from.x} fromY={from.y}
                toX={to.x}   toY={to.y}
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
          <div style={{ position: 'absolute', top: '45%', left: '50%', transform: 'translate(-50%,-50%)',
                        textAlign: 'center', pointerEvents: 'none' }}>
            <p className="text-text-muted text-sm">Double-click to add a node</p>
            <p className="text-text-muted text-xs mt-1">or drag a type from the palette →</p>
          </div>
        )}
      </div>
    </div>
  );
}
