/**
 * RightDetailsPanel — true accordion controls panel.
 *
 * Sections: Quick Controls · Recording · Details · Danger Zone
 * Only one section can be open at a time (accordion behaviour).
 * Panel is always visible; width is set by MonitoringCenter grid.
 */
import { useState, lazy, Suspense, memo } from 'react';
import {
  Radio, Square, AlertCircle, RefreshCw,
  Lock, Unlock, Mic, MicOff, PhoneIncoming, Trash2,
  ChevronDown, ChevronRight, Settings2,
} from 'lucide-react';
import { api }            from '../../../api/client.js';
import { getConferenceType } from '../config/widgetRegistry.js';

const StatisticsWidget = lazy(() => import('../widgets/standard/StatisticsWidget.jsx')
  .then(m => ({ default: m.StatisticsWidget })));

// ─── Accordion section ────────────────────────────────────────────────────────

function AccordionSection({ id, title, open, onToggle, children }) {
  return (
    <div className="border-b border-surface-border/60 last:border-0">
      <button
        type="button"
        onClick={() => onToggle(id)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-surface-hover/60
                   transition-colors select-none">
        <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
          {title}
        </span>
        {open
          ? <ChevronDown size={12} className="text-text-muted shrink-0" />
          : <ChevronRight size={12} className="text-text-muted/40 shrink-0" />
        }
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Compact control button ───────────────────────────────────────────────────

function ControlBtn({ onClick, disabled, active, danger, children }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        'w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-[11px] font-medium transition-colors',
        'disabled:opacity-35 disabled:cursor-not-allowed',
        danger
          ? 'border-red-500/30 text-red-400 hover:bg-red-500/8'
          : active
            ? 'border-primary/40 bg-primary/8 text-primary'
            : 'border-surface-border text-text-secondary hover:bg-surface-hover hover:text-text-primary',
      ].join(' ')}>
      {children}
    </button>
  );
}

// ─── ERS incident details section ─────────────────────────────────────────────

function IncidentDetails({ conf }) {
  const inc = conf?.incident;
  if (!inc) return <p className="text-[10px] text-text-muted italic">No incident data</p>;

  const rows = [
    ['ERS Name',     inc.ers_name,               false],
    ['Organisation', inc.organization_name,        false],
    ['Caller',       inc.caller_number,            true],
    ['UUID',         inc.incident_uuid,            true],
    ['Bridge',       inc.primary_bridge_number,    true],
    ['Group Type',   inc.group_type,               false],
  ].filter(r => r[1]);

  return (
    <div className="space-y-px">
      {rows.map(([label, value, mono]) => (
        <div key={label} className="flex items-start gap-2 py-1 border-b border-surface-border/20 last:border-0">
          <span className="text-[9px] text-text-muted w-20 shrink-0 pt-px">{label}</span>
          <span className={`text-[10px] text-text-primary flex-1 break-all leading-tight ${mono ? 'font-mono' : ''}`}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export const RightDetailsPanel = memo(function RightDetailsPanel({
  conf, talkTracker, onCollapse,
}) {
  const [openSection, setOpenSection] = useState('controls');
  const [busy, setBusy] = useState({});
  const confType = getConferenceType(conf);

  function toggle(id) {
    setOpenSection(s => s === id ? null : id);
  }

  async function act(key, fn, ...args) {
    if (!conf?.name) return;
    setBusy(b => ({ ...b, [key]: true }));
    try { await fn(conf.name, ...args); }
    catch (e) { alert('Command failed: ' + (e.message || 'Unknown error')); }
    finally   { setBusy(b => ({ ...b, [key]: false })); }
  }

  const members    = conf?.members || [];
  const allMuted   = members.length > 0 && members.every(m => m.muted);
  const recState   = conf?.recordingState || 'OFF';
  const isRec      = recState === 'ACTIVE';
  const isStarting = recState === 'STARTING';
  const isStopping = recState === 'STOPPING';
  const isFailed   = recState === 'FAILED';
  const recBusy    = isStarting || isStopping;

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* Panel header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-surface-border shrink-0">
        <Settings2 size={12} className="text-text-muted/60" />
        <span className="text-[11px] font-bold text-text-primary flex-1">Controls</span>
        {onCollapse && (
          <button onClick={onCollapse} title="Collapse"
            className="p-1 rounded text-text-muted/40 hover:text-text-primary hover:bg-surface-hover transition-colors">
            <ChevronRight size={13} />
          </button>
        )}
      </div>

      {/* Accordion body */}
      <div className="flex-1 overflow-y-auto">

        {/* ── Quick Controls ───────────────────────────────────────────── */}
        <AccordionSection id="controls" title="Quick Controls"
          open={openSection === 'controls'} onToggle={toggle}>

          <ControlBtn
            active={conf?.locked}
            disabled={!conf || !!busy.lock}
            onClick={() => act('lock', conf?.locked ? api.monitoring.unlock : api.monitoring.lock)}>
            {conf?.locked ? <Unlock size={13} /> : <Lock size={13} />}
            {conf?.locked ? 'Unlock Conference' : 'Lock Conference'}
          </ControlBtn>

          <ControlBtn
            active={allMuted}
            disabled={!conf || members.length === 0}
            onClick={() => members.forEach(m =>
              (allMuted ? api.monitoring.unmute : api.monitoring.mute)(conf.name, m.id)
            )}>
            {allMuted ? <Mic size={13} /> : <MicOff size={13} />}
            {allMuted ? 'Unmute All' : 'Mute All'}
          </ControlBtn>

          <ControlBtn
            disabled={!conf}
            onClick={() => {
              const dest = window.prompt('Invite extension or SIP URI:');
              if (dest?.trim()) act('invite', api.monitoring.invite, dest.trim());
            }}>
            <PhoneIncoming size={13} />
            Invite Participant
          </ControlBtn>

          <ControlBtn
            disabled={!conf}
            onClick={() => {
              const text = window.prompt('Announcement text:');
              if (text?.trim()) act('say', api.monitoring.say, text.trim());
            }}>
            <Radio size={13} />
            Broadcast Announcement
          </ControlBtn>

        </AccordionSection>

        {/* ── Recording ───────────────────────────────────────────────── */}
        <AccordionSection id="recording" title="Recording"
          open={openSection === 'recording'} onToggle={toggle}>

          {/* Status line */}
          <div className="text-[10px] text-text-muted flex items-center gap-1.5 pb-1">
            {isRec      && <><Radio size={9} className="text-red-400 animate-pulse" /><span className="text-red-400">Recording active</span></>}
            {isStarting && <><RefreshCw size={9} className="text-amber-400 animate-spin" /><span className="text-amber-400">Starting…</span></>}
            {isStopping && <><RefreshCw size={9} className="text-slate-400 animate-spin" /><span className="text-slate-400">Stopping…</span></>}
            {isFailed   && <><AlertCircle size={9} className="text-red-400" /><span className="text-red-400">Recording failed</span></>}
            {recState === 'OFF' && <span className="text-text-muted/40">Not recording</span>}
          </div>

          {conf?.recordingPath && isRec && (
            <p className="text-[9px] font-mono text-text-muted/60 truncate pb-1" title={conf.recordingPath}>
              {conf.recordingPath.split('/').pop()}
            </p>
          )}

          <ControlBtn
            disabled={!conf || recBusy}
            active={isRec}
            onClick={() => act('record', isRec ? api.monitoring.recordStop : api.monitoring.recordStart)}>
            {recBusy
              ? <RefreshCw size={13} className="animate-spin" />
              : isRec ? <Square size={13} /> : <Radio size={13} />
            }
            {isRec ? 'Stop Recording' : 'Start Recording'}
          </ControlBtn>

        </AccordionSection>

        {/* ── Details — ERS incident or STANDARD stats ─────────────────── */}
        <AccordionSection id="details"
          title={confType === 'ERS' ? 'Incident Details' : 'Statistics'}
          open={openSection === 'details'} onToggle={toggle}>

          {confType === 'ERS'
            ? <IncidentDetails conf={conf} />
            : (
              <Suspense fallback={<div className="text-[10px] text-text-muted">Loading…</div>}>
                <StatisticsWidget conf={conf} talkTracker={talkTracker} />
              </Suspense>
            )
          }
        </AccordionSection>

        {/* ── Danger Zone ─────────────────────────────────────────────── */}
        <AccordionSection id="danger" title="Danger Zone"
          open={openSection === 'danger'} onToggle={toggle}>

          <ControlBtn
            danger
            disabled={!conf}
            onClick={() => {
              if (window.confirm(
                `Terminate "${conf?.name}"?\n\nAll ${members.length} participant(s) will be disconnected immediately.`
              )) act('terminate', api.monitoring.terminate);
            }}>
            <Trash2 size={13} />
            Terminate Conference
          </ControlBtn>

        </AccordionSection>

      </div>
    </div>
  );
});
