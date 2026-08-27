import { X, AlertTriangle, Info } from 'lucide-react';

/**
 * Extract nodeId from a backend error string.
 * Backend formats:
 *   node <id>.<field>: message   (per-node Zod)
 *   node <id>: message            (graph integrity / FK)
 */
function extractNodeId(err) {
  const m = err.match(/^node ([^.\s:]+)/);
  return m?.[1] || null;
}

/**
 * Strip the "node <id>." or "node <id>:" prefix from an error string,
 * leaving just the human-readable part.
 */
function humanise(err) {
  // "node node_abc.audio_url: must start with /media/" → "audio_url: must start with /media/"
  // "node node_abc: can never reach..." → "can never reach..."
  return err.replace(/^node [^\s:]+[.:]?\s*/, '').trim();
}

export default function ValidationErrorPanel({ errors, warnings, nodes, onGoToNode, onClose }) {
  // Build flat list of { nodeId, nodeLabel, nodeType, message, raw }
  const allErrors = [];

  for (const [nodeId, errs] of Object.entries(errors)) {
    if (nodeId === '__global') {
      for (const e of errs) {
        allErrors.push({ nodeId: null, nodeLabel: 'Global', nodeType: null, message: humanise(e), raw: e });
      }
    } else {
      const node = nodes?.[nodeId];
      const label = node?.label || node?.type || nodeId;
      for (const e of errs) {
        allErrors.push({ nodeId, nodeLabel: label, nodeType: node?.type, message: humanise(e), raw: e });
      }
    }
  }

  if (allErrors.length === 0) return null;

  return (
    <div className="border-b border-red-500/20 bg-red-500/5 shrink-0">
      <div className="px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <AlertTriangle size={11} className="text-red-400 shrink-0" />
          <span className="text-[11px] font-medium text-red-400">
            {allErrors.length} validation error{allErrors.length !== 1 ? 's' : ''}
          </span>
          {warnings.length > 0 && (
            <span className="text-[10px] text-yellow-500 ml-2">
              · {warnings.length} warning{warnings.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-text-muted hover:text-text-primary transition-colors"
          title="Dismiss"
        >
          <X size={12} />
        </button>
      </div>

      <div className="max-h-40 overflow-y-auto px-3 pb-2 space-y-1">
        {allErrors.map((item, i) => (
          <div key={i} className="flex items-start gap-2 text-[10px]">
            <span className="text-red-400/60 mt-0.5 shrink-0">•</span>
            <div className="flex-1 min-w-0">
              {item.nodeId && (
                <button
                  onClick={() => onGoToNode(item.nodeId)}
                  className="text-brand hover:underline font-medium mr-1 shrink-0"
                  title="Select this node"
                >
                  [{item.nodeLabel}]
                </button>
              )}
              {!item.nodeId && (
                <span className="text-text-muted font-medium mr-1">[Global]</span>
              )}
              <span className="text-red-300">{item.message}</span>
            </div>
          </div>
        ))}

        {warnings.length > 0 && (
          <div className="pt-1 border-t border-yellow-500/20 mt-1 space-y-1">
            {warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-2 text-[10px]">
                <span className="text-yellow-500/60 mt-0.5 shrink-0">△</span>
                <span className="text-yellow-500/80">{w.replace(/^Node "[^"]+"(?:\s*\([^)]*\))?\s*:?\s*/, '')}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
