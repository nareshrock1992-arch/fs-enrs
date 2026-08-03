/**
 * StatisticsWidget — STANDARD conference quick stats.
 *
 * Rendered in the right-details panel for STANDARD conferences.
 * Shows participant breakdown and per-member talk-time distribution.
 */
import { memo } from 'react';
import { BarChart2, Mic, MicOff, Shield, Users } from 'lucide-react';

export const StatisticsWidget = memo(function StatisticsWidget({ conf, talkTracker }) {
  if (!conf) return null;

  const members   = conf.members || [];
  const total     = members.length;
  const mods      = members.filter(m => m.moderator).length;
  const live      = members.filter(m => m.talking).length;
  const muted     = members.filter(m => m.muted).length;
  const connected = total - muted;

  // Total accumulated talk time across all members
  const totalTalkMs = members.reduce((sum, m) => {
    const key   = `${conf.name}:${m.id}`;
    const entry = talkTracker?.current?.get(key);
    if (!entry) return sum;
    const live  = (m.talking && entry.startMs) ? (Date.now() - entry.startMs) : 0;
    return sum + entry.totalMs + live;
  }, 0);
  const totalTalkMin = Math.floor(totalTalkMs / 60_000);

  const stats = [
    { Icon: Users,   label: 'Total',     value: total,     color: 'text-blue-400'    },
    { Icon: Mic,     label: 'Speaking',  value: live,      color: 'text-emerald-500' },
    { Icon: MicOff,  label: 'Muted',     value: muted,     color: 'text-text-muted'  },
    { Icon: Shield,  label: 'Moderators',value: mods,      color: 'text-amber-400'   },
  ];

  return (
    <div>
      <p className="text-[9px] uppercase tracking-widest text-text-muted font-bold mb-2 flex items-center gap-1">
        <BarChart2 size={9} /> Statistics
      </p>
      <div className="grid grid-cols-2 gap-1.5 mb-2">
        {stats.map(({ Icon, label, value, color }) => (
          <div key={label}
               className="card !p-2 flex items-center gap-2">
            <Icon size={11} className={`${color} shrink-0`} />
            <div>
              <div className={`text-base font-bold tabular-nums leading-none ${color}`}>{value}</div>
              <div className="text-[8px] text-text-muted mt-0.5">{label}</div>
            </div>
          </div>
        ))}
      </div>
      {totalTalkMin > 0 && (
        <div className="text-[9px] text-text-muted flex items-center gap-1">
          <Mic size={8} />
          <span>{totalTalkMin}m total talk time this session</span>
        </div>
      )}
    </div>
  );
});
