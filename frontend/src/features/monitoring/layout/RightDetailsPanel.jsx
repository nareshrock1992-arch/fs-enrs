/**
 * RightDetailsPanel — collapsible right panel.
 *
 * Always shows: core conference controls (lock, mute-all, record, broadcast, invite, terminate).
 * ERS conferences additionally show: Incident Meta section.
 * STANDARD conferences additionally show: Statistics section.
 * Both types show: Recording section.
 */
import { useState, lazy, Suspense, memo } from 'react';
import {
  ChevronRight, Zap, Radio, Square, AlertCircle,
  RefreshCw, Lock, Unlock, Mic, MicOff,
  PhoneIncoming, Trash2, ChevronDown,
} from 'lucide-react';
import { api } from '../../../api/client.js';
import { getConferenceType } from '../config/widgetRegistry.js';

const StatisticsWidget = lazy(() => import('../widgets/standard/StatisticsWidget.jsx')
  .then(m => ({ default: m.StatisticsWidget })));

// ─── Collapsible section ──────────────────────────────────────────────────────

function Section({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 py-1.5 text-[9px] uppercase tracking-widest
                   text-text-muted font-bold hover:text-text-secondary transition-colors select-none">
        <ChevronDown
          size={10}
          className={`transition-transform shrink-0 ${open ? 'rotate-0' : '-rotate-90'}`} />
        {title}
      </button>
      {open && <div className="pb-3 space-y-2">{children}</div>}
    </div>
  );
}

// ─── Toggle switch (same as original Monitoring.jsx) ─────────────────────────

function ToggleSwitch({ checked, onChange, disabled, labelOn, labelOff, colorOn = 'bg-brand', Icon }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={[
        'group flex items-center gap-2.5 w-full px-3 py-2.5 rounded-xl border text-xs font-medium',
        'transition-all duration-150 select-none',
        disabled
          ? 'opacity-35 cursor-not-allowed border-surface-border text-text-muted'
          : checked
            ? 'border-brand/40 bg-brand/8 text-brand'
            : 'border-surface-border text-text-secondary hover:border-primary/20 hover:bg-surface-hover',
      ].join(' ')}>
      {Icon && <Icon size={13} className="shrink-0" />}
      <span className="flex-1 text-left">{checked ? labelOn : labelOff}</span>
      <span
        className={[
          'relative inline-flex h-4 w-7 shrink-0 rounded-full border-2 border-transparent',
          'transition-colors duration-200',
          disabled ? 'bg-surface-border' : checked ? colorOn : 'bg-surface-border',
        ].join(' ')}>
        <span
          className={[
            'pointer-events-none h-3 w-3 rounded-full bg-white shadow-sm',
            'transition-transform duration-200',
            checked ? 'translate-x-3' : 'translate-x-0',
          ].join(' ')} />
      </span>
    </button>
  );
}

// ─── ERS incident meta section ────────────────────────────────────────────────

function IncidentMetaSection({ conf }) {
  const inc = conf?.incident;
  if (!inc) return null;

  function row(label, value, mono = false) {
    if (!value) return null;
    return (
      <div className="flex items-start gap-2 py-1 border-b border-surface-border/30 last:border-0">
        <span className="text-[9px] text-text-muted w-20 shrink-0 pt-px">{label}</span>
        <span className={`text-[10px] font-medium text-text-primary flex-1 break-all ${mono ? 'font-mono' : ''}`}>
          {value}
        </span>
      </div>
    );
  }

  return (
    <Section title="Incident Details" defaultOpen>
      <div className="card !p-2.5 space-y-px">
        {row('ERS Name',     inc.ers_name)}
        {row('Organization', inc.organization_name)}
        {row('Caller',       inc.caller_number, true)}
        {row('UUID',         inc.incident_uuid, true)}
        {row('Bridge',       inc.primary_bridge_number, true)}
        {row('Group Type',   inc.group_type)}
      </div>
    </Section>
  );
}

// ─── Recording section ────────────────────────────────────────────────────────

function RecordingSection({ conf, act, busy }) {
  const recState   = conf?.recordingState || 'OFF';
  const isRec      = recState === 'ACTIVE';
  const isStarting = recState === 'STARTING';
  const isStopping = recState === 'STOPPING';
  const isFailed   = recState === 'FAILED';
  const recBusy    = isStarting || isStopping;

  return (
    <Section title="Recording" defaultOpen={isRec || isFailed}>
      {isStarting  && <div className="flex items-center gap-1.5 text-[10px] text-amber-400"><Radio size={9} className="animate-pulse" /> Starting…</div>}
      {isRec       && <div className="flex items-center gap-1.5 text-[10px] text-red-400"><Radio size={9} className="animate-pulse" /> Recording active</div>}
      {isStopping  && <div className="flex items-center gap-1.5 text-[10px] text-slate-400"><Square size={9} className="animate-pulse" /> Stopping…</div>}
      {isFailed    && <div className="text-[10px] text-red-400 flex items-start gap-1"><AlertCircle size={9} className="shrink-0 mt-px" /><span>Recording failed — check backend logs</span></div>}
      {conf?.recordingPath && isRec && (
        <p className="text-[9px] text-text-muted truncate font-mono" title={conf.recordingPath}>
          {conf.recordingPath.split('/').pop()}
        </p>
      )}
      {!recBusy && (
        <button
          disabled={!conf}
          onClick={() => act('record', isRec ? api.monitoring.recordStop : api.monitoring.recordStart)}
          className={[
            'w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl border',
            'text-xs font-medium transition-all disabled:opacity-35 disabled:cursor-not-allowed',
            (recState === 'OFF' || isFailed)
              ? 'border-red-500/30 bg-red-500/8 text-red-400 hover:bg-red-500/15 hover:border-red-500/50'
              : 'border-red-500/40 bg-red-500/15 text-red-400 hover:bg-red-500/25',
          ].join(' ')}>
          {(recState === 'OFF' || isFailed)
            ? <><Radio size={12} /> Start Recording</>
            : <><Square size={12} /> Stop Recording</>
          }
        </button>
      )}
      {recBusy && (
        <button disabled className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl border
                                   border-surface-border text-text-muted text-xs opacity-35 cursor-not-allowed">
          <RefreshCw size={12} className="animate-spin" />
          {isStarting ? 'Starting…' : 'Stopping…'}
        </button>
      )}
    </Section>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export const RightDetailsPanel = memo(function RightDetailsPanel({
  conf, talkTracker, collapsed, onCollapse,
}) {
  const [busy, setBusy] = useState({});
  const confType = getConferenceType(conf);

  async function act(key, fn, ...args) {
    if (!conf?.name) return;
    setBusy(b => ({ ...b, [key]: true }));
    try { await fn(conf.name, ...args); }
    catch (e) { alert('Command failed: ' + (e.message || 'Unknown error')); }
    finally { setBusy(b => ({ ...b, [key]: false })); }
  }

  const members  = conf?.members || [];
  const allMuted = members.length > 0 && members.every(m => m.muted);

  return (
    <div className="h-full flex flex-col">
      {/* Panel header with collapse control */}
      <div className="flex items-center gap-2 mb-3 shrink-0">
        <Zap size={12} className="text-amber-500" />
        <span className="text-xs font-bold text-text-primary flex-1">Controls</span>
        <button
          onClick={onCollapse}
          title="Collapse panel"
          className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors">
          <ChevronRight size={13} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 pr-0.5">

        {/* Core conference controls — always visible */}
        <Section title="Conference" defaultOpen>
          <ToggleSwitch
            checked={conf?.locked ?? false}
            disabled={!conf || !!busy.lock}
            labelOn="Conference Locked"
            labelOff="Lock Conference"
            Icon={conf?.locked ? Lock : Unlock}
            colorOn="bg-amber-500"
            onChange={() => act('lock', conf?.locked ? api.monitoring.unlock : api.monitoring.lock)}
          />
          <ToggleSwitch
            checked={allMuted}
            disabled={!conf || members.length === 0}
            labelOn="All Muted — Click to Unmute"
            labelOff="Mute All Participants"
            Icon={allMuted ? MicOff : Mic}
            colorOn="bg-red-500"
            onChange={() => {
              if (!conf?.name) return;
              members.forEach(m =>
                (allMuted ? api.monitoring.unmute : api.monitoring.mute)(conf.name, m.id)
              );
            }}
          />
        </Section>

        {/* Recording section */}
        <RecordingSection conf={conf} act={act} busy={busy} />

        {/* ERS-specific: incident metadata */}
        {confType === 'ERS' && <IncidentMetaSection conf={conf} />}

        {/* STANDARD-specific: statistics */}
        {confType === 'STANDARD' && (
          <Section title="Statistics">
            <Suspense fallback={null}>
              <StatisticsWidget conf={conf} talkTracker={talkTracker} />
            </Suspense>
          </Section>
        )}

        {/* Danger zone — always last */}
        <div className="pt-2 border-t border-surface-border">
          <p className="text-[9px] uppercase tracking-widest text-red-500/40 font-bold mb-2">
            Danger Zone
          </p>
          <button
            disabled={!conf}
            onClick={() => {
              if (window.confirm(
                `Terminate conference "${conf?.name}"?\n\n` +
                `All ${conf?.members?.length ?? 0} participant(s) will be disconnected immediately.`
              )) act('terminate', api.monitoring.terminate);
            }}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl border
                       border-red-500/30 text-red-500 text-xs font-medium
                       hover:bg-red-500/10 hover:border-red-500/50
                       disabled:opacity-35 disabled:cursor-not-allowed transition-colors">
            <Trash2 size={12} /> Terminate Conference
          </button>
        </div>

      </div>
    </div>
  );
});
