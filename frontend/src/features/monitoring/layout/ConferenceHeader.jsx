/**
 * ConferenceHeader — sticky toolbar above the main workspace.
 *
 * Shows the selected conference name + room number and provides
 * one-click action buttons for all core conference operations.
 * Visible only when a conference is selected.
 */
import { useState, memo } from 'react';
import {
  Lock, Unlock, Radio, Square, Mic, MicOff,
  PhoneIncoming, Trash2, RefreshCw, AlertCircle,
  Hash, ChevronDown,
} from 'lucide-react';
import { api } from '../../../api/client.js';

function ActionBtn({ title, onClick, children, danger = false, active = false, disabled = false }) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={[
        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[10px] font-semibold transition-colors',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        danger
          ? 'border-red-500/30 text-red-400 hover:bg-red-500/10 hover:border-red-500/50'
          : active
            ? 'border-primary/40 bg-primary/8 text-primary'
            : 'border-surface-border text-text-secondary hover:bg-surface-hover hover:text-text-primary',
      ].join(' ')}>
      {children}
    </button>
  );
}

export const ConferenceHeader = memo(function ConferenceHeader({ conf }) {
  const [sayText,    setSayText]    = useState('');
  const [dialStr,    setDialStr]    = useState('');
  const [showSay,    setShowSay]    = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [busy,       setBusy]       = useState({});

  if (!conf) return null;

  const name      = conf.name;
  const recState  = conf.recordingState || 'OFF';
  const isRec     = recState === 'ACTIVE';
  const isStarting = recState === 'STARTING';
  const isStopping = recState === 'STOPPING';
  const isFailed   = recState === 'FAILED';
  const recBusy    = isStarting || isStopping;

  async function act(key, fn, ...args) {
    setBusy(b => ({ ...b, [key]: true }));
    try { await fn(name, ...args); }
    catch (e) { alert('Command failed: ' + (e.message || 'Unknown error')); }
    finally { setBusy(b => ({ ...b, [key]: false })); }
  }

  function muteAll() {
    const members = conf.members || [];
    const allMuted = members.length > 0 && members.every(m => m.muted);
    members.forEach(m => (allMuted ? api.monitoring.unmute : api.monitoring.mute)(name, m.id));
  }

  function terminate() {
    if (window.confirm(
      `Terminate "${name}"?\n\n` +
      `All ${conf.members?.length ?? 0} participant(s) will be disconnected immediately.`
    )) act('terminate', api.monitoring.terminate);
  }

  const allMuted = (conf.members || []).every(m => m.muted) && (conf.members || []).length > 0;

  return (
    <div className="flex items-center gap-2 flex-wrap shrink-0 pb-3 border-b border-surface-border mb-3">
      {/* Conference identity */}
      <div className="flex items-center gap-1.5 mr-2">
        <Hash size={11} className="text-primary" />
        <span className="text-xs font-bold text-text-primary font-mono">{name}</span>
        {isRec && (
          <span className="text-[8px] px-1.5 py-px rounded-full bg-red-500/15 text-red-500
                           font-bold flex items-center gap-0.5 animate-pulse">
            <Radio size={7} /> REC
          </span>
        )}
        {isFailed && (
          <span className="text-[8px] px-1.5 py-px rounded-full bg-red-900/20 text-red-400 font-bold flex items-center gap-0.5">
            <AlertCircle size={7} /> FAILED
          </span>
        )}
        {conf.locked && (
          <span className="text-[8px] px-1.5 py-px rounded-full bg-amber-500/15 text-amber-500 font-bold flex items-center gap-0.5">
            <Lock size={7} /> LOCKED
          </span>
        )}
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-surface-border" />

      {/* Lock */}
      <ActionBtn
        title={conf.locked ? 'Unlock conference' : 'Lock conference'}
        onClick={() => act('lock', conf.locked ? api.monitoring.unlock : api.monitoring.lock)}
        disabled={!!busy.lock}
        active={conf.locked}>
        {conf.locked ? <Unlock size={11} /> : <Lock size={11} />}
        {conf.locked ? 'Unlock' : 'Lock'}
      </ActionBtn>

      {/* Record */}
      {recBusy ? (
        <ActionBtn title="" disabled>
          <RefreshCw size={11} className="animate-spin" />
          {isStarting ? 'Starting…' : 'Stopping…'}
        </ActionBtn>
      ) : (
        <ActionBtn
          title={isRec ? 'Stop recording' : 'Start recording'}
          onClick={() => act('record', isRec ? api.monitoring.recordStop : api.monitoring.recordStart)}
          active={isRec}>
          {isRec ? <Square size={11} /> : <Radio size={11} />}
          {isRec ? 'Stop Rec' : 'Record'}
        </ActionBtn>
      )}

      {/* Mute All */}
      <ActionBtn
        title={allMuted ? 'Unmute all' : 'Mute all participants'}
        onClick={muteAll}
        active={allMuted}>
        {allMuted ? <Mic size={11} /> : <MicOff size={11} />}
        {allMuted ? 'Unmute All' : 'Mute All'}
      </ActionBtn>

      {/* Broadcast TTS */}
      <ActionBtn
        title="Broadcast TTS announcement"
        onClick={() => { setShowSay(s => !s); setShowInvite(false); }}
        active={showSay}>
        <Radio size={11} />
        Broadcast
        <ChevronDown size={9} className={`transition-transform ${showSay ? 'rotate-180' : ''}`} />
      </ActionBtn>

      {/* Invite */}
      <ActionBtn
        title="Invite participant"
        onClick={() => { setShowInvite(s => !s); setShowSay(false); }}
        active={showInvite}>
        <PhoneIncoming size={11} />
        Invite
        <ChevronDown size={9} className={`transition-transform ${showInvite ? 'rotate-180' : ''}`} />
      </ActionBtn>

      {/* Terminate */}
      <ActionBtn title="Terminate conference" onClick={terminate} danger>
        <Trash2 size={11} />
        Terminate
      </ActionBtn>

      {/* Inline TTS form */}
      {showSay && (
        <form
          className="w-full flex gap-1.5 mt-1"
          onSubmit={async e => {
            e.preventDefault();
            if (!sayText.trim()) return;
            await act('say', api.monitoring.say, sayText.trim());
            setSayText(''); setShowSay(false);
          }}>
          <input
            autoFocus value={sayText} onChange={e => setSayText(e.target.value)}
            placeholder="Announcement text…"
            className="flex-1 input text-xs py-1.5 px-2.5" />
          <button type="submit" className="btn-primary text-xs px-3">Say</button>
          <button type="button" onClick={() => setShowSay(false)}
            className="text-xs px-2 text-text-muted hover:text-text-primary">✕</button>
        </form>
      )}

      {/* Inline invite form */}
      {showInvite && (
        <form
          className="w-full flex gap-1.5 mt-1"
          onSubmit={async e => {
            e.preventDefault();
            if (!dialStr.trim()) return;
            await act('invite', api.monitoring.invite, dialStr.trim());
            setDialStr(''); setShowInvite(false);
          }}>
          <input
            autoFocus value={dialStr} onChange={e => setDialStr(e.target.value)}
            placeholder="Extension or sip:user@domain"
            className="flex-1 input text-xs py-1.5 px-2.5" />
          <button type="submit" className="btn-primary text-xs px-3">Dial</button>
          <button type="button" onClick={() => setShowInvite(false)}
            className="text-xs px-2 text-text-muted hover:text-text-primary">✕</button>
        </form>
      )}
    </div>
  );
});
