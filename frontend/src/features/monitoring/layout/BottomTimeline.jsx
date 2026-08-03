/**
 * BottomTimeline — collapsible live event log.
 *
 * Extracted from Monitoring.jsx. Now supports collapse/expand and
 * retains its scroll position correctly via an effect.
 */
import { useEffect, useRef, memo, useState } from 'react';
import {
  Activity, Bell, PhoneCall, PhoneOff, PhoneIncoming,
  MicOff, EarOff, Mic, Shield, Lock, Unlock, Radio, Signal,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import { fmtTime } from '../utils/time.js';

// ─── Event type config — mirrors original Monitoring.jsx EV map ───────────────

const EV = {
  'conference.created':          { label: 'Conference Created',  color: 'text-emerald-500', Icon: PhoneCall     },
  'conference.ended':            { label: 'Conference Ended',    color: 'text-slate-400',   Icon: PhoneOff      },
  'conference.member.joined':    { label: 'Member Joined',       color: 'text-blue-500',    Icon: PhoneIncoming },
  'conference.member.left':      { label: 'Member Left',         color: 'text-orange-400',  Icon: PhoneOff      },
  'conference.member.muted':     { label: 'Mute Changed',        color: 'text-yellow-500',  Icon: MicOff        },
  'conference.member.deaf':      { label: 'Deaf Changed',        color: 'text-orange-500',  Icon: EarOff        },
  'conference.member.talking':   { label: 'Speaking',            color: 'text-green-400',   Icon: Mic           },
  'conference.member.moderator': { label: 'Moderator Changed',   color: 'text-amber-400',   Icon: Shield        },
  'conference.floor.granted':    { label: 'Floor Granted',       color: 'text-purple-400',  Icon: Shield        },
  'conference.floor.released':   { label: 'Floor Released',      color: 'text-purple-300',  Icon: Shield        },
  'conference.locked':           { label: 'Conference Locked',   color: 'text-amber-500',   Icon: Lock          },
  'conference.unlocked':         { label: 'Conference Unlocked', color: 'text-emerald-400', Icon: Unlock        },
  'conference.recording':        { label: 'Recording',           color: 'text-red-400',     Icon: Radio         },
  'conference.member.energy':    { label: 'Energy Level',        color: 'text-cyan-400',    Icon: Signal        },
};

// ─── Row ──────────────────────────────────────────────────────────────────────

const TimelineRow = memo(function TimelineRow({ ev }) {
  const cfg  = EV[ev.type] || { label: ev.type, color: 'text-text-muted', Icon: Bell };
  const { Icon } = cfg;
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-surface-border/20 last:border-0">
      <span className="text-[9px] font-mono text-text-muted/50 shrink-0 tabular-nums w-16">
        {fmtTime(ev.ts)}
      </span>
      <Icon size={10} className={`${cfg.color} shrink-0`} />
      <span className={`text-[10px] font-semibold shrink-0 w-32 ${cfg.color}`}>{cfg.label}</span>
      <span className="text-[10px] text-text-muted truncate">{ev.detail}</span>
    </div>
  );
});

// ─── Main component ───────────────────────────────────────────────────────────

export function BottomTimeline({ events, collapsed, onCollapse }) {
  const listRef = useRef(null);
  const prevLen = useRef(0);

  // Scroll to top (newest-first) when new events arrive
  useEffect(() => {
    if (!collapsed && events.length !== prevLen.current && listRef.current) {
      listRef.current.scrollTop = 0;
      prevLen.current = events.length;
    }
  }, [events.length, collapsed]);

  return (
    <div className="card !p-0 shrink-0">
      {/* Header — always visible, acts as collapse trigger */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-surface-border">
        <Activity size={12} className="text-emerald-500 shrink-0" />
        <span className="text-xs font-bold text-text-primary">Live Event Timeline</span>
        {events.length > 0 && (
          <span className="ml-2 text-[10px] px-1.5 py-px rounded-full bg-surface-hover text-text-muted font-mono">
            {events.length}
          </span>
        )}
        <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        <button
          onClick={onCollapse}
          title={collapsed ? 'Expand timeline' : 'Collapse timeline'}
          className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors ml-1">
          {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>

      {/* Event list — hidden when collapsed */}
      {!collapsed && (
        <div ref={listRef} className="overflow-y-auto px-4 py-1" style={{ maxHeight: '160px' }}>
          {events.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-5">
              <Bell size={12} className="text-text-muted/25" />
              <p className="text-xs text-text-muted">Subscribed — waiting for events…</p>
            </div>
          ) : (
            events.map(e => <TimelineRow key={e.id} ev={e} />)
          )}
        </div>
      )}
    </div>
  );
}
