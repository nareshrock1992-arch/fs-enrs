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
  PhoneCall, Shield, RefreshCw, Monitor,
} from 'lucide-react';
import { useConferenceState } from '../features/monitoring/hooks/useConferenceState.js';
import { MonitoringCenter }   from '../features/monitoring/layout/MonitoringCenter.jsx';
import { fmtTime }            from '../features/monitoring/utils/time.js';

// ─── KPI tile — compact single-row format ─────────────────────────────────────

const KpiCard = memo(function KpiCard({
  icon: Icon, label, value,
  valueClass = 'text-text-primary',
  pulse = false, danger = false,
}) {
  const isDanger = danger && value > 0;
  return (
    <div className={`card !py-2 !px-3 flex items-center gap-2
      ${isDanger ? 'border-red-500/30 bg-red-500/5' : ''}`}>
      <Icon size={12} className={isDanger ? 'text-red-400 shrink-0' : 'text-text-muted shrink-0'} />
      <span className={`text-[9px] uppercase tracking-widest font-semibold flex-1
        ${isDanger ? 'text-red-400' : 'text-text-muted'}`}>
        {label}
      </span>
      <span className={`text-sm font-bold tabular-nums ${isDanger ? 'text-red-500' : valueClass}`}>
        {value ?? '—'}
      </span>
      {pulse && value > 0 && (
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
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
    <div className="flex flex-col gap-2 pb-2">

      {/* Page header — compact single row */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
            <Monitor size={14} className="text-emerald-500" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-text-primary leading-tight">
              Conference Operations Center
            </h1>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <div className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full border font-semibold
              ${esl?.connected
                ? 'border-emerald-500/30 bg-emerald-500/8 text-emerald-500'
                : 'border-red-500/30 bg-red-500/8 text-red-500'}`}>
            {esl?.connected ? <Wifi size={9} /> : <WifiOff size={9} />}
            {esl?.connected ? `ESL ${esl.host}:${esl.port}` : 'ESL Offline'}
            <span className={`w-1.5 h-1.5 rounded-full shrink-0
              ${esl?.connected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
          </div>
          {eslLatency != null && (
            <span className="text-[10px] text-text-muted flex items-center gap-1">
              <Signal size={9} className={eslLatency < 80 ? 'text-emerald-500' : 'text-amber-500'} />
              <span className="tabular-nums">{eslLatency}ms</span>
            </span>
          )}
          <span className="text-[10px] font-mono tabular-nums text-text-muted">{clockStr}</span>
          {lastSync && (
            <span className="text-[9px] text-text-muted/50 tabular-nums hidden sm:block">
              sync {fmtTime(lastSync)}
            </span>
          )}
          <button
            onClick={reload}
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded text-text-muted
                       hover:text-text-primary hover:bg-surface-hover transition-colors">
            <RefreshCw size={9} /> Refresh
          </button>
        </div>
      </div>

      {/* KPI strip — compact horizontal bar */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
        <KpiCard icon={PhoneCall} label="Conferences" value={conferences.length}
          valueClass="text-emerald-500" pulse={conferences.length > 0} />
        <KpiCard icon={Users}    label="Participants" value={totalMembers}
          valueClass="text-blue-400" />
        <KpiCard icon={Shield}   label="Moderators"  value={totalModerators}
          valueClass="text-amber-400" />
        <KpiCard icon={Radio}    label="Recording"   value={recordingCount}
          danger pulse={recordingCount > 0} />
        <KpiCard icon={Activity} label="Events/s"    value={evHist.at(-1) ?? 0}
          valueClass="text-purple-400" />
        <KpiCard icon={Signal}   label="ESL lat"     value={eslLatency != null ? `${eslLatency}ms` : '—'}
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

    </div>
  );
}
