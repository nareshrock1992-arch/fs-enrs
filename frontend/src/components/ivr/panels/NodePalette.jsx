import { NODE_CONFIG } from '../canvas/FlowNode.jsx';

const TYPES = [
  'play', 'say', 'gather', 'condition',
  'record_message', 'set_variable',
  'ens', 'ers',
  'goto', 'transfer', 'hangup',
];

const DESCRIPTIONS = {
  play:           'Play an audio file',
  say:            'Text-to-speech message',
  gather:         'Collect DTMF digits',
  condition:      'Branch on variable value',
  record_message: 'Record caller audio',
  set_variable:   'Set session variable',
  ens:            'Trigger ENS blast',
  ers:            'Start ERS conference',
  goto:           'Jump to another node',
  transfer:       'Transfer call to extension',
  hangup:         'End the call',
};

// Group node types visually
const GROUPS = [
  { label: 'Audio',     types: ['play', 'say'] },
  { label: 'Input',     types: ['gather', 'condition'] },
  { label: 'Recording', types: ['record_message', 'set_variable'] },
  { label: 'Emergency', types: ['ens', 'ers'] },
  { label: 'Flow',      types: ['goto', 'transfer', 'hangup'] },
];

export default function NodePalette({ onAdd }) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-surface-border">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Node Types</p>
        <p className="text-[10px] text-text-muted mt-0.5">Click to add to canvas</p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {GROUPS.map(group => (
          <div key={group.label}>
            <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest mb-1.5 px-1">
              {group.label}
            </p>
            <div className="space-y-1">
              {group.types.map(type => {
                const cfg = NODE_CONFIG[type];
                return (
                  <button
                    key={type}
                    onClick={() => onAdd(type)}
                    className="w-full text-left px-3 py-2 rounded-lg border transition-all
                               hover:brightness-110 hover:translate-x-0.5 active:scale-95"
                    style={{ background: cfg.bg, borderColor: cfg.border, color: cfg.color }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm leading-none shrink-0">{cfg.icon}</span>
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold truncate">{cfg.label}</p>
                        <p className="text-[9px] opacity-60 truncate">{DESCRIPTIONS[type]}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="px-4 py-3 border-t border-surface-border">
        <p className="text-[10px] text-text-muted leading-relaxed">
          <span className="text-brand font-medium">Tip:</span> Drag output dots to connect.
          Double-click edge to disconnect. Delete key removes selected node.
        </p>
      </div>
    </div>
  );
}
