/**
 * Monitoring — Conference Operations Center page.
 *
 * Thin page wrapper: owns KPI strip + sparkline charts.
 * All socket state lives in useConferenceState().
 * All layout logic lives in MonitoringCenter.
 */
import { memo, useMemo } from 'react';
import {
  Activity, Wifi, WifiOff, Users, Radio, Signal,
  PhoneCall, Shield, RefreshCw, BarChart2, Monitor,
} from 'lucide-react';
import { useConferenceState } from '../features/monitoring/hooks/useConferenceState.js';
import { MonitoringCenter }   from '../features/monitoring/layout/MonitoringCenter.jsx';
import { fmtTime }            from '../features/monitoring/utils/time.js';

// ─── Sparkline ────────────────────────────────────────────────────────────────

const Sparkline = memo(function Sparkline({ data = [], color = '#22c55e', height = 40 }) {
  if (data.length < 2) return <svg width="100%" height={height} />;
  const W = 200, H = height;
  const mx   = Math.max(...data, 1);
  const step = W / (data.length - 1);
  const pts  = data.map((v, i) => [i * step, H - (v / mx) * H * 0.85 - H * 0.05]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const area = `${line}L${pts.at(-1)[0]},${H}L0,${H}Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={height}>
      <path d={area} fill={color} fillOpacity="0.10" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts.at(-1)[0]} cy={pts.at(-1)[1]} r="2.5" fill={color} />
    </svg>
  );
});

// ─── KPI tile ─────────────────────────────────────────────────────────────────

const KpiCard = memo(function KpiCard({
  icon: Icon, label, value, sub,
  valueClass = 'text-text-primary',
  sparkData, sparkColor,
  pulse = false, danger = false,
}) {
  const isDanger = danger && value > 0;
  return (
    <div className={`card !p-3 relative overflow-hidden flex flex-col gap-0.5
      ${isDanger ? 'border-red-500/30 bg-red-500/5' : ''}`}>
      <div className="flex items-center justify-between">
        <span className={`text-[10px] uppercase tracking-widest font-semibold
          ${isDanger ? 'text-red-400' : 'text-text-muted'}`}>
          <Icon size={10} className="inline mr-1 -mt-px" />
          {label}
        </span>
        {pulse && value > 0 && (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        )}
      </div>
      <div className={`text-2xl font-bold tabular-nums leading-none mt-0.5
        ${isDanger ? 'text-red-500' : valueClass}`}>
        {value ?? '—'}
      </div>
      {sub && <p className="text-[10px] text-text-muted leading-none">{sub}</p>}
      {sparkData && sparkData.length > 1 && (
        <div className="absolute bottom-0 left-0 right-0 opacity-40 pointer-events-none">
          <Sparkline data={sparkData} color={sparkColor || '#22c55e'} height={26} />
        </div>
      )}
    </div>
  );
});

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Monitoring() {
  const {
    conferences, esl, eslLatency, loading, now, lastSync,
    selectedConf, setSelectedConf, selectedConference,
    reload, talkTracker, events,
    partHist, confHist, evHist,
    totalMembers, totalModerators, recordingCount,
    chartIntervalMs,
  } = useConferenceState();

  const clockStr = useMemo(() => new Date(now).toLocaleTimeString(), [now]);

  return (
    <div className="space-y-3 pb-10">

      {/* Page header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center shrink-0">
            <Monitor size={17} className="text-emerald-500" />
          </div>
          <div>
            <h1 className="page-title leading-tight">Conference Operations Center</h1>
            <p className="text-[10px] text-text-muted">
              Real-time FreeSWITCH monitoring &amp; control
              {lastSync && ` · synced ${fmtTime(lastSync)}`}
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2.5 flex-wrap">
          <div className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border font-semibold
              ${esl?.connected
                ? 'border-emerald-500/30 bg-emerald-500/8 text-emerald-500'
                : 'border-red-500/30 bg-red-500/8 text-red-500'}`}>
            {esl?.connected ? <Wifi size={10} /> : <WifiOff size={10} />}
            {esl?.connected ? `ESL · ${esl.host}:${esl.port}` : 'ESL Offline'}
            <span className={`w-1.5 h-1.5 rounded-full shrink-0
              ${esl?.connected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
          </div>
          {eslLatency != null && (
            <span className="text-[11px] text-text-muted flex items-center gap-1">
              <Signal size={10} className={eslLatency < 80 ? 'text-emerald-500' : 'text-amber-500'} />
              <span className="tabular-nums">{eslLatency}ms</span>
            </span>
          )}
          <span className="text-[11px] font-mono tabular-nums text-text-muted">{clockStr}</span>
          <button
            onClick={reload}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg text-text-muted
                       hover:text-text-primary hover:bg-surface-hover transition-colors">
            <RefreshCw size={10} /> Refresh
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <KpiCard icon={PhoneCall} label="Conferences"  value={conferences.length}
          sub="Live"             valueClass="text-emerald-500"
          sparkData={confHist}   sparkColor="#10b981"  pulse={conferences.length > 0} />
        <KpiCard icon={Users}    label="Participants"  value={totalMembers}
          sub="Across all rooms" valueClass="text-blue-400"
          sparkData={partHist}   sparkColor="#60a5fa" />
        <KpiCard icon={Shield}   label="Moderators"   value={totalModerators}
          sub="Active"           valueClass="text-amber-400" />
        <KpiCard icon={Radio}    label="Recording"    value={recordingCount}
          sub="Active sessions"  danger               pulse={recordingCount > 0} />
        <KpiCard icon={Activity} label="Event Rate"   value={evHist.at(-1) ?? 0}
          sub={`Per ${chartIntervalMs / 1000}s`}      valueClass="text-purple-400"
          sparkData={evHist}     sparkColor="#c084fc" />
        <KpiCard icon={Signal}   label="ESL Latency"  value={eslLatency != null ? `${eslLatency}ms` : '—'}
          sub="Round-trip"
          valueClass={eslLatency != null && eslLatency < 80 ? 'text-emerald-500' : 'text-amber-400'} />
      </div>

      {/* Main monitoring layout */}
      <MonitoringCenter
        conferences={conferences}
        selectedConf={selectedConf}
        setSelectedConf={setSelectedConf}
        selectedConference={selectedConference}
        now={now}
        talkTracker={talkTracker}
        events={events}
        loading={loading}
      />

      {/* Sparkline charts */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: 'Participants Over Time', data: partHist, color: '#60a5fa', current: totalMembers },
          { label: 'Active Conferences',     data: confHist, color: '#10b981', current: conferences.length },
          { label: 'Events / Interval',      data: evHist,   color: '#c084fc', current: evHist.at(-1) ?? 0 },
        ].map(({ label, data, color, current }) => (
          <div key={label} className="card !pb-2">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted flex items-center gap-1">
                <BarChart2 size={9} /> {label}
              </span>
              <span className="text-sm font-bold tabular-nums" style={{ color }}>{current}</span>
            </div>
            <Sparkline data={data} color={color} height={44} />
            <p className="text-[9px] text-text-muted mt-0.5 tabular-nums">
              {data.length} samples · {data.length * (chartIntervalMs / 1000)}s window
            </p>
          </div>
        ))}
      </div>

    </div>
  );
}
