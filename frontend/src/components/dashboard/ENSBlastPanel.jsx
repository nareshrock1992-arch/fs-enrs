import { Bell, CheckCircle2, XCircle, PhoneMissed, Repeat2 } from 'lucide-react';
import { useLiveDuration } from '../../hooks/useLiveDuration.js';
import ProgressRing from '../ui/ProgressRing.jsx';

function BlastCard({ blast }) {
  const { name, total_targets, answered, no_answer, failed, replayed, started_at } = blast;
  const duration = useLiveDuration(started_at);
  const done = answered + no_answer + failed;
  const pct = total_targets > 0 ? Math.round((done / total_targets) * 100) : 0;

  const ringColor = failed > 0
    ? 'rgb(239 68 68)'
    : answered > 0
    ? 'rgb(34 197 94)'
    : 'rgb(99 102 241)';

  return (
    <div className="border border-surface-border rounded-xl p-4 flex gap-4 items-start
                    bg-surface hover:bg-surface-hover transition-colors">
      <ProgressRing value={pct} size={56} stroke={5} color={ringColor}>
        <span className="text-[10px] font-bold text-text-primary">{pct}%</span>
      </ProgressRing>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <Bell size={12} className="text-brand shrink-0" />
          <p className="text-sm font-semibold text-text-primary truncate">{name || 'ENS Blast'}</p>
          <span className="text-xs text-text-muted ml-auto shrink-0">{duration}</span>
        </div>

        <div className="flex flex-wrap gap-3 text-xs mt-2">
          <span className="flex items-center gap-1 text-text-muted">
            Total <strong className="text-text-primary">{total_targets}</strong>
          </span>
          <span className="flex items-center gap-1 text-green-500">
            <CheckCircle2 size={11} /> {answered}
          </span>
          <span className="flex items-center gap-1 text-yellow-500">
            <PhoneMissed size={11} /> {no_answer}
          </span>
          {failed > 0 && (
            <span className="flex items-center gap-1 text-red-500">
              <XCircle size={11} /> {failed}
            </span>
          )}
          {replayed > 0 && (
            <span className="flex items-center gap-1 text-blue-500">
              <Repeat2 size={11} /> {replayed}
            </span>
          )}
        </div>

        {/* Progress bar */}
        <div className="mt-2.5 h-1.5 rounded-full bg-surface-border overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${pct}%`,
              background: ringColor,
            }}
          />
        </div>
        <p className="text-[10px] text-text-muted mt-1">{done} of {total_targets} contacts reached</p>
      </div>
    </div>
  );
}

export default function ENSBlastPanel({ blasts }) {
  const active = Object.values(blasts);
  if (active.length === 0) return null;

  return (
    <div className="card space-y-3">
      <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
        <Bell size={14} className="text-brand" />
        Active ENS Blasts
        <span className="ml-auto badge bg-brand/15 text-brand">{active.length}</span>
      </h2>
      {active.map(b => <BlastCard key={b.notification_uuid} blast={b} />)}
    </div>
  );
}
