/**
 * ConferenceHeader — compact two-row conference identity bar.
 *
 * Row 1: conference name + status chips + icon-only action toolbar.
 * Row 2: live metadata strip (duration · participants · moderators).
 * Inline forms for Broadcast and Invite expand beneath on demand.
 */
import { useState, memo } from 'react';
import {
  Lock, Unlock, Radio, Square, Mic, MicOff,
  PhoneIncoming, Trash2, RefreshCw, AlertCircle, X,
  Users, Shield,
} from 'lucide-react';
import { api }           from '../../../api/client.js';
import { elapsedSec, fmtDur } from '../utils/time.js';

// ─── Icon-only action button (32 × 32) ───────────────────────────────────────

function IconBtn({ title, onClick, active = false, danger = false, disabled = false, children }) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={[
        'w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 transition-colors',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        danger
          ? 'border-red-500/30 text-red-400 hover:bg-red-500/10'
          : active
            ? 'border-primary/40 bg-primary/8 text-primary'
            : 'border-surface-border text-text-secondary hover:bg-surface-hover hover:text-text-primary',
      ].join(' ')}>
      {children}
    </button>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export const ConferenceHeader = memo(function ConferenceHeader({ conf, now }) {
  const [sayText,    setSayText]    = useState('');
  const [dialStr,    setDialStr]    = useState('');
  const [showSay,    setShowSay]    = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [busy,       setBusy]       = useState({});

  if (!conf) return null;

  const name       = conf.name;
  const members    = conf.members || [];
  const recState   = conf.recordingState || 'OFF';
  const isRec      = recState === 'ACTIVE';
  const isStarting = recState === 'STARTING';
  const isStopping = recState === 'STOPPING';
  const isFailed   = recState === 'FAILED';
  const recBusy    = isStarting || isStopping;
  const allMuted   = members.length > 0 && members.every(m => m.muted);
  const modCount   = members.filter(m => m.moderator).length;
  const liveCount  = members.filter(m => m.talking).length;
  const durSecs    = conf.createdAt ? elapsedSec(conf.createdAt, now) : null;

  async function act(key, fn, ...args) {
    setBusy(b => ({ ...b, [key]: true }));
    try { await fn(name, ...args); }
    catch (e) { alert('Command failed: ' + (e.message || 'Unknown error')); }
    finally   { setBusy(b => ({ ...b, [key]: false })); }
  }

  return (
    <div className="shrink-0 border-b border-surface-border px-4 py-2.5 bg-surface-card">

      {/* ── Row 1: name + status + toolbar ──────────────────────────────── */}
      <div className="flex items-center gap-2">

        {/* Conference name */}
        <h2 className="text-[13px] font-bold text-text-primary truncate flex-1 min-w-0 leading-tight">
          {name}
        </h2>

        {/* Status chips */}
        {isRec && (
          <span className="shrink-0 flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-px rounded-full
                           bg-red-500/15 text-red-500 border border-red-500/20 animate-pulse">
            <Radio size={7} /> REC
          </span>
        )}
        {(isStarting || isStopping) && (
          <span className="shrink-0 flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-px rounded-full
                           bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <RefreshCw size={7} className="animate-spin" />
            {isStarting ? 'STARTING' : 'STOPPING'}
          </span>
        )}
        {isFailed && (
          <span className="shrink-0 flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-px rounded-full
                           bg-red-900/15 text-red-400 border border-red-500/20">
            <AlertCircle size={7} /> FAILED
          </span>
        )}
        {conf.locked && (
          <span className="shrink-0 flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-px rounded-full
                           bg-amber-500/10 text-amber-500 border border-amber-500/20">
            <Lock size={7} /> LOCKED
          </span>
        )}

        {/* Toolbar separator */}
        <div className="w-px h-5 bg-surface-border shrink-0" />

        {/* Icon-only toolbar */}
        <div className="flex items-center gap-1 shrink-0">
          <IconBtn
            title={conf.locked ? 'Unlock conference' : 'Lock conference'}
            onClick={() => act('lock', conf.locked ? api.monitoring.unlock : api.monitoring.lock)}
            disabled={!!busy.lock}
            active={conf.locked}>
            {conf.locked ? <Unlock size={14} /> : <Lock size={14} />}
          </IconBtn>

          <IconBtn
            title={isRec ? 'Stop recording' : recBusy ? (isStarting ? 'Starting…' : 'Stopping…') : 'Start recording'}
            onClick={recBusy ? undefined : () => act('record', isRec ? api.monitoring.recordStop : api.monitoring.recordStart)}
            disabled={recBusy}
            active={isRec}>
            {recBusy ? <RefreshCw size={14} className="animate-spin" /> : isRec ? <Square size={14} /> : <Radio size={14} />}
          </IconBtn>

          <IconBtn
            title={allMuted ? 'Unmute all participants' : 'Mute all participants'}
            onClick={() => members.forEach(m => (allMuted ? api.monitoring.unmute : api.monitoring.mute)(name, m.id))}
            active={allMuted}>
            {allMuted ? <Mic size={14} /> : <MicOff size={14} />}
          </IconBtn>

          <IconBtn
            title="Broadcast TTS announcement"
            onClick={() => { setShowSay(s => !s); setShowInvite(false); }}
            active={showSay}>
            <Radio size={14} />
          </IconBtn>

          <IconBtn
            title="Invite participant"
            onClick={() => { setShowInvite(s => !s); setShowSay(false); }}
            active={showInvite}>
            <PhoneIncoming size={14} />
          </IconBtn>

          <IconBtn
            title="Terminate conference — disconnects all participants"
            danger
            onClick={() => {
              if (window.confirm(`Terminate "${name}"?\n\nAll ${members.length} participant(s) will be disconnected.`))
                act('terminate', api.monitoring.terminate);
            }}>
            <Trash2 size={14} />
          </IconBtn>
        </div>
      </div>

      {/* ── Row 2: live metadata strip ───────────────────────────────────── */}
      <div className="flex items-center gap-3 mt-1.5 text-[10px] text-text-muted">
        {durSecs != null && (
          <span className="flex items-center gap-1 tabular-nums">
            <span className="text-text-muted/50">Duration</span>
            <span className="font-mono font-semibold text-text-secondary">{fmtDur(durSecs)}</span>
          </span>
        )}
        <span className="text-surface-border">·</span>
        <span className="flex items-center gap-1">
          <Users size={9} className="text-text-muted/50" />
          <span className="font-semibold text-text-secondary">{members.length}</span>
          <span className="text-text-muted/50">participants</span>
        </span>
        {modCount > 0 && (
          <>
            <span className="text-surface-border">·</span>
            <span className="flex items-center gap-1">
              <Shield size={9} className="text-amber-500/60" />
              <span className="font-semibold text-amber-500">{modCount}</span>
              <span className="text-text-muted/50">{modCount === 1 ? 'moderator' : 'moderators'}</span>
            </span>
          </>
        )}
        {liveCount > 0 && (
          <>
            <span className="text-surface-border">·</span>
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              <span className="font-semibold text-green-500">{liveCount}</span>
              <span className="text-text-muted/50">speaking</span>
            </span>
          </>
        )}
      </div>

      {/* ── Inline Broadcast TTS form ────────────────────────────────────── */}
      {showSay && (
        <form
          className="flex gap-1.5 mt-2"
          onSubmit={async e => {
            e.preventDefault();
            if (!sayText.trim()) return;
            await act('say', api.monitoring.say, sayText.trim());
            setSayText(''); setShowSay(false);
          }}>
          <input autoFocus value={sayText} onChange={e => setSayText(e.target.value)}
            placeholder="Announcement text…"
            className="flex-1 input text-xs py-1.5 px-2.5" />
          <button type="submit" className="btn-primary text-xs px-3">Say</button>
          <button type="button" onClick={() => setShowSay(false)}
            className="p-1.5 text-text-muted hover:text-text-primary transition-colors">
            <X size={13} />
          </button>
        </form>
      )}

      {/* ── Inline Invite form ───────────────────────────────────────────── */}
      {showInvite && (
        <form
          className="flex gap-1.5 mt-2"
          onSubmit={async e => {
            e.preventDefault();
            if (!dialStr.trim()) return;
            await act('invite', api.monitoring.invite, dialStr.trim());
            setDialStr(''); setShowInvite(false);
          }}>
          <input autoFocus value={dialStr} onChange={e => setDialStr(e.target.value)}
            placeholder="Extension or sip:user@domain"
            className="flex-1 input text-xs py-1.5 px-2.5" />
          <button type="submit" className="btn-primary text-xs px-3">Dial</button>
          <button type="button" onClick={() => setShowInvite(false)}
            className="p-1.5 text-text-muted hover:text-text-primary transition-colors">
            <X size={13} />
          </button>
        </form>
      )}
    </div>
  );
});
