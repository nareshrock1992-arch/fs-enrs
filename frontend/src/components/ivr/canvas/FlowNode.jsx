import { useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { useDrag } from '../../../hooks/useDrag.js';
import ConnectionDot from './ConnectionDot.jsx';

// ── Node visual config by type ────────────────────────────────────────────────

export const NODE_CONFIG = {
  play:           { label: 'Play Audio',    icon: '▶',  bg: '#1e3a5f', border: '#3b6ca8', color: '#93c5fd' },
  say:            { label: 'Say (TTS)',      icon: '💬', bg: '#1e3a2f', border: '#2d6a4f', color: '#6ee7b7' },
  gather:         { label: 'Gather DTMF',   icon: '⌨',  bg: '#3b2f1e', border: '#7c5c2a', color: '#fbbf24' },
  goto:           { label: 'Go To Node',    icon: '↩',  bg: '#2a1e3b', border: '#5b3a8a', color: '#c4b5fd' },
  ens:            { label: 'Trigger ENS',   icon: '📢', bg: '#1e2f3b', border: '#2a6080', color: '#7dd3fc' },
  ers:            { label: 'Trigger ERS',   icon: '🚨', bg: '#3b1e1e', border: '#8a2a2a', color: '#fca5a5' },
  hangup:         { label: 'Hangup',        icon: '✕',  bg: '#1e2a1e', border: '#2a4a2a', color: '#86efac' },
  condition:      { label: 'Condition',     icon: '⑂',  bg: '#2a2a1e', border: '#6a6a2a', color: '#fde68a' },
  record_message: { label: 'Record',        icon: '⏺',  bg: '#2a1e2a', border: '#6a2a6a', color: '#e9d5ff' },
  set_variable:   { label: 'Set Variable',  icon: '📌', bg: '#1e2a3b', border: '#2a4a6a', color: '#bae6fd' },
  transfer:       { label: 'Transfer',      icon: '↗',  bg: '#1e3b2a', border: '#2a6a4a', color: '#a7f3d0' },
};

// ── Ports per node type ───────────────────────────────────────────────────────

function getPorts(node) {
  switch (node.type) {
    case 'play':
    case 'say':
    case 'record_message':
    case 'set_variable':
      return [{ key: 'next', label: 'next' }];
    case 'ens':
      return node.next ? [{ key: 'next', label: 'next' }] : [];
    case 'gather': {
      const branches = node.branches || {};
      return Object.keys(branches).map(k => ({ key: k, label: k }));
    }
    case 'goto':
      return [{ key: 'goto', label: 'target' }];
    case 'condition':
      return [
        { key: 'true',  label: 'true'  },
        { key: 'false', label: 'false' },
      ];
    case 'ers':
    case 'hangup':
    case 'transfer':
      return [];
    default:
      return [];
  }
}

// ── FlowNode ──────────────────────────────────────────────────────────────────

const NODE_WIDTH  = 148;
const NODE_HEIGHT = 80; // approximate — used for port position calculation

export { NODE_WIDTH, NODE_HEIGHT };

export default function FlowNode({
  node,
  isSelected,
  isEntry,
  hasErrors,
  edges,
  scale,
  onSelect,
  onMove,
  onDelete,
  onPortDragStart,
  onPortClick,
}) {
  const cfg   = NODE_CONFIG[node.type] || NODE_CONFIG.play;
  const ports = getPorts(node);
  const nodeRef = useRef(null);

  const startPos = useRef({ x: node.x, y: node.y });
  const { onPointerDown } = useDrag({
    onStart: () => { startPos.current = { x: node.x, y: node.y }; },
    onMove:  (dx, dy) => onMove(node.id, startPos.current.x + dx / scale, startPos.current.y + dy / scale),
    onEnd:   (dx, dy, _e, moved) => {
      if (!moved) onSelect(node.id);
      else        onMove(node.id, startPos.current.x + dx / scale, startPos.current.y + dy / scale);
    },
  });

  const connectedPorts = new Set(edges.filter(e => e.from === node.id).map(e => e.fromPort));

  return (
    <div
      ref={nodeRef}
      data-node-id={node.id}
      style={{
        position:    'absolute',
        left:        node.x,
        top:         node.y,
        width:       NODE_WIDTH,
        cursor:      'grab',
        zIndex:      isSelected ? 10 : 1,
      }}
      onPointerDown={onPointerDown}
      onClick={e => { e.stopPropagation(); }}
      onPointerUp={e => { e.stopPropagation(); onPortClick?.(node.id); }}
    >
      {/* Entry badge */}
      {isEntry && (
        <div className="absolute -top-5 left-0 text-[9px] text-brand font-bold uppercase tracking-widest">
          ▼ Entry
        </div>
      )}

      <div
        style={{
          background:   cfg.bg,
          border:       `1.5px solid ${
            hasErrors ? '#ef4444'
            : isSelected ? '#f1f5f9'
            : cfg.border
          }`,
          borderRadius: 10,
          boxShadow: isSelected
            ? `0 0 0 2px #f1f5f960, 0 4px 20px #00000060`
            : hasErrors
            ? `0 0 0 2px #ef444440`
            : '0 2px 8px #00000040',
          overflow:     'hidden',
          userSelect:   'none',
        }}
      >
        {/* Header */}
        <div style={{ borderBottom: `1px solid ${cfg.border}30` }}
             className="px-2.5 py-1.5 flex items-center gap-1.5">
          <span className="text-sm leading-none">{cfg.icon}</span>
          <span style={{ color: cfg.color }} className="text-[10px] font-bold uppercase tracking-wide truncate flex-1">
            {cfg.label}
          </span>
          {isSelected && (
            <button
              className="ml-auto opacity-60 hover:opacity-100 hover:text-red-400 transition-opacity"
              style={{ color: cfg.color }}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onDelete(node.id); }}
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>

        {/* Body — key field summary */}
        <div className="px-2.5 py-1.5 text-[10px] text-text-muted space-y-0.5">
          {node.type === 'play'           && <span className="truncate block">{node.audio_url || node.audio_file_id || '—'}</span>}
          {node.type === 'say'            && <span className="truncate block italic">"{node.text?.slice(0,28) || '…'}"</span>}
          {node.type === 'gather'         && <span>max {node.max_digits || 1} digit · {node.timeout_seconds || 5}s</span>}
          {node.type === 'goto'           && <span>→ {node.target_node_id || '?'}</span>}
          {node.type === 'ens'            && <span>Config {node.ens_configuration_id || node.ens_config_var || '?'}</span>}
          {node.type === 'ers'            && <span>Config {node.ers_configuration_id || '?'}</span>}
          {node.type === 'hangup'         && <span className="text-green-400">End of call</span>}
          {node.type === 'condition'      && (
            <span className="truncate block font-mono">
              {node.variable || '?'} {node.operator || '=='} {(node.expected_value || '?').slice(0,14)}
            </span>
          )}
          {node.type === 'record_message' && (
            <span className="truncate block">
              → {node.variable_name || '?'} · max {node.max_seconds || 60}s
            </span>
          )}
          {node.type === 'set_variable'   && (
            <span className="truncate block font-mono">
              {node.variable || '?'} = {(node.value || '').slice(0,16)}
            </span>
          )}
          {node.type === 'transfer'       && (
            <span className="truncate block">→ {node.destination || '?'}</span>
          )}
        </div>

        {/* Output ports */}
        {ports.length > 0 && (
          <div className="px-2 pb-2 pt-0.5">
            {ports.map(p => (
              <ConnectionDot
                key={p.key}
                portKey={p.key}
                label={p.label}
                color={cfg.border}
                connected={connectedPorts.has(p.key)}
                onDragStart={(portKey) => onPortDragStart?.(node.id, portKey)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
