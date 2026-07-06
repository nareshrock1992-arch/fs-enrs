import { Clock } from 'lucide-react';
import { useLiveDuration } from '../../hooks/useLiveDuration.js';
import Badge from '../ui/Badge.jsx';

function QueueRow({ entry }) {
  const { position, caller_number, queued_at, ers_name } = entry;
  const wait = useLiveDuration(queued_at);

  const digits = String(caller_number || '').replace(/\D/g, '');
  const masked = digits.length > 4
    ? digits.slice(0, -4).replace(/./g, 'x') + '-' + digits.slice(-4)
    : caller_number || '—';

  return (
    <div className="flex items-center gap-3 py-2 border-b border-surface-border last:border-0 text-xs">
      <span className="w-6 h-6 rounded-full bg-yellow-500/15 text-yellow-600 dark:text-yellow-400
                       flex items-center justify-center font-bold text-[11px] shrink-0">
        {position}
      </span>
      <span className="font-mono text-text-primary flex-1 truncate">{masked}</span>
      <span className="text-text-muted truncate max-w-[90px]">{ers_name || '—'}</span>
      <span className="flex items-center gap-1 text-text-muted shrink-0">
        <Clock size={10} /> {wait}
      </span>
      <Badge variant="warning">Queued</Badge>
    </div>
  );
}

export default function ErsQueuePanel({ queue }) {
  if (!queue || queue.length === 0) return null;

  return (
    <div className="card">
      <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-3">
        <Clock size={14} className="text-yellow-500" />
        ERS Queue
        <span className="ml-auto badge bg-yellow-500/15 text-yellow-600 dark:text-yellow-400">
          {queue.length}
        </span>
      </h2>
      <div>
        {queue.map((q, i) => <QueueRow key={q.id ?? i} entry={q} />)}
      </div>
    </div>
  );
}
