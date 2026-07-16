import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Headphones, Play, Pause, Download, Search, RefreshCw, X,
  SkipBack, SkipForward, Volume2, VolumeX,
  Archive, Trash2, Calendar, Building2, Radio,
  Clock, CheckCircle, AlertCircle, Info,
  FileAudio, Users, Hash, Mic
} from 'lucide-react';
import { api } from '../../api/client.js';
import { useAuthStore } from '../../store/authStore.js';

function fmtSize(bytes) {
  const n = Number(bytes);
  if (!isFinite(n) || n < 0) return '—';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function fmtDuration(sec) {
  const n = Number(sec);
  if (!isFinite(n) || n < 0) return '—';
  const m = Math.floor(n / 60), s = String(Math.round(n % 60)).padStart(2, '0');
  return `${m}:${s}`;
}
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtRelative(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const STATUS = {
  RECORDING: { label: 'Recording',  cls: 'bg-red-500/15 text-red-400 border-red-500/20',     Icon: Radio     },
  COMPLETED: { label: 'Completed',  cls: 'bg-green-500/15 text-green-500 border-green-500/20', Icon: CheckCircle },
  ARCHIVED:  { label: 'Archived',   cls: 'bg-surface-hover text-text-muted border-surface-border', Icon: Archive },
  FAILED:    { label: 'Failed',     cls: 'bg-amber-500/15 text-amber-500 border-amber-500/20', Icon: AlertCircle },
};

// ── Waveform Canvas ───────────────────────────────────────────────────────────

function WaveformCanvas({ peaks, progress = 0, duration = 0, onSeek, height = 64 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx  = canvas.getContext('2d');
    const W    = canvas.width;
    const H    = canvas.height;
    const midY = H / 2;

    ctx.clearRect(0, 0, W, H);

    if (!peaks?.length) {
      ctx.fillStyle = 'rgba(100,100,120,0.15)';
      ctx.fillRect(0, midY - 1, W, 2);
      return;
    }

    const barW   = W / peaks.length;
    const played = Math.floor(progress * peaks.length);

    peaks.forEach((p, i) => {
      const x    = i * barW;
      const barH = Math.max(2, p * (H - 6));
      ctx.fillStyle = i < played ? 'rgba(79,70,229,0.9)' : 'rgba(79,70,229,0.22)';
      ctx.fillRect(x, midY - barH / 2, Math.max(1, barW - 1), barH);
    });

    if (progress > 0 && progress < 1) {
      const px = progress * W;
      ctx.fillStyle = 'rgba(79,70,229,0.8)';
      ctx.fillRect(px - 1, 2, 2, H - 4);
    }
  }, [peaks, progress]);

  return (
    <canvas
      ref={canvasRef}
      width={700}
      height={height}
      onClick={e => {
        if (!onSeek || !duration) return;
        const rect = canvasRef.current.getBoundingClientRect();
        onSeek(((e.clientX - rect.left) / rect.width) * duration);
      }}
      className="w-full rounded cursor-pointer"
      style={{ height }}
    />
  );
}

// ── Recording Player + Detail Panel ──────────────────────────────────────────

function RecordingDetail({ rec, onClose, onArchive, onDelete, canEdit }) {
  const [playing,    setPlaying]    = useState(false);
  const [progress,   setProgress]   = useState(0);
  const [currentT,   setCurrentT]   = useState(0);
  const [duration,   setDuration]   = useState(Number(rec.duration_sec) || 0);
  const [volume,     setVolume]     = useState(1);
  const [muted,      setMuted]      = useState(false);
  const [speed,      setSpeed]      = useState(1);
  const [peaks,      setPeaks]      = useState(null);
  const [loadErr,    setLoadErr]    = useState(null);
  const [archiving,  setArchiving]  = useState(false);
  const audioRef = useRef(null);

  useEffect(() => {
    if (rec.status === 'COMPLETED' || rec.status === 'ARCHIVED') {
      api.recordings.waveform(rec.id)
        .then(r => setPeaks(r.peaks?.length ? r.peaks : null))
        .catch(() => {});
    }
  }, [rec.id, rec.status]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause(); setPlaying(false);
    } else {
      setLoadErr(null);
      a.play()
        .then(() => setPlaying(true))
        .catch(err => { setPlaying(false); setLoadErr(err.message); });
    }
  };

  const skip = (s) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(0, Math.min(duration, audioRef.current.currentTime + s));
  };

  const fmtT = (s) => {
    if (!s) return '0:00';
    return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  };

  const canPlay = rec.status === 'COMPLETED' || rec.status === 'ARCHIVED';

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-96 bg-surface border-l border-surface-border
                    shadow-2xl flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-surface-border shrink-0">
        <Headphones size={14} className="text-brand" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-text-primary truncate">
            {rec.recording_file || rec.conference_room}
          </p>
          <p className="text-[10px] text-text-muted">{rec.conference_room}</p>
        </div>
        <button onClick={onClose}
          className="p-1 rounded text-text-muted hover:text-text-primary transition-colors">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Player section */}
        {canPlay && (
          <div className="p-4 border-b border-surface-border space-y-3">
            {/* Waveform */}
            <div className="bg-surface-panel rounded-xl px-3 py-3 border border-surface-border/40">
              <WaveformCanvas
                peaks={peaks}
                progress={progress}
                duration={duration}
                onSeek={t => {
                  if (!audioRef.current) return;
                  audioRef.current.currentTime = t;
                  setCurrentT(t);
                  setProgress(duration ? t / duration : 0);
                }}
                height={64}
              />
            </div>

            {/* Time */}
            <div className="flex justify-between text-[10px] text-text-muted tabular-nums px-1">
              <span>{fmtT(currentT)}</span>
              <span>{fmtT(duration)}</span>
            </div>

            {/* Error */}
            {loadErr && (
              <div className="text-[10px] text-red-400 bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2">
                {loadErr}
              </div>
            )}

            {/* Controls */}
            <div className="flex items-center justify-center gap-5">
              <button onClick={() => skip(-10)}
                className="p-2 text-text-muted hover:text-text-primary transition-colors rounded-lg hover:bg-surface-hover">
                <SkipBack size={14} />
              </button>
              <button onClick={toggle}
                className="w-12 h-12 rounded-full bg-brand flex items-center justify-center
                           text-white hover:bg-brand/90 active:scale-95 transition-all shadow-lg shadow-brand/20">
                {playing ? <Pause size={20} /> : <Play size={20} className="translate-x-0.5" />}
              </button>
              <button onClick={() => skip(10)}
                className="p-2 text-text-muted hover:text-text-primary transition-colors rounded-lg hover:bg-surface-hover">
                <SkipForward size={14} />
              </button>
            </div>

            {/* Speed + Volume */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-0.5">
                {[0.5, 0.75, 1, 1.5, 2].map(s => (
                  <button key={s}
                    onClick={() => { setSpeed(s); if (audioRef.current) audioRef.current.playbackRate = s; }}
                    className={`text-[9px] px-1.5 py-0.5 rounded font-mono transition-colors
                      ${speed === s ? 'bg-brand text-white' : 'text-text-muted hover:text-text-primary hover:bg-surface-hover'}`}>
                    {s}×
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5 ml-auto">
                <button onClick={() => setMuted(m => !m)}
                  className="text-text-muted hover:text-text-primary transition-colors">
                  {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                </button>
                <input type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume}
                  onChange={e => {
                    setVolume(+e.target.value);
                    setMuted(false);
                    if (audioRef.current) audioRef.current.volume = +e.target.value;
                  }}
                  className="w-20 accent-brand" />
              </div>
            </div>

            <audio
              ref={audioRef}
              src={api.recordings.streamUrl(rec.id)}
              preload="metadata"
              onEnded={() => { setPlaying(false); setProgress(0); setCurrentT(0); }}
              onTimeUpdate={e => {
                const t = e.target.currentTime;
                setCurrentT(t);
                setProgress(duration ? t / duration : 0);
              }}
              onLoadedMetadata={e => {
                const d = e.target.duration;
                if (d && isFinite(d)) setDuration(d);
              }}
              onError={() => setLoadErr('Could not load recording file')}
              muted={muted}
            />
          </div>
        )}

        {rec.status === 'RECORDING' && (
          <div className="m-4 flex items-center gap-2 text-[11px] text-red-400
                          bg-red-500/5 border border-red-500/20 rounded-xl px-4 py-3">
            <Radio size={12} className="animate-pulse shrink-0" />
            Recording in progress — playback available after completion
          </div>
        )}

        {/* Metadata */}
        <div className="p-4 space-y-3">
          {/* Timeline */}
          <div className="card !p-3 space-y-2">
            <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Timeline</p>
            {[
              ['Started',  fmtTime(rec.started_at)],
              ['Ended',    rec.ended_at ? fmtTime(rec.ended_at) : '—'],
              ['Duration', fmtDuration(rec.duration_sec)],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between">
                <span className="text-[10px] text-text-muted">{k}</span>
                <span className="text-[10px] font-medium text-text-primary tabular-nums">{v}</span>
              </div>
            ))}
          </div>

          {/* Conference */}
          <div className="card !p-3 space-y-2">
            <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Conference</p>
            {[
              ['Room',     rec.conference_room],
              ['ERS Config', rec.ers_name || '—'],
              ['Org',      rec.organization_name || '—'],
              ['Caller',   rec.caller_number || '—'],
              ['Started by', rec.created_by || '—'],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-text-muted shrink-0">{k}</span>
                <span className="text-[10px] font-medium text-text-primary text-right truncate">{v}</span>
              </div>
            ))}
          </div>

          {/* File info */}
          <div className="card !p-3 space-y-2">
            <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted">File</p>
            {[
              ['Size',        fmtSize(rec.file_size_bytes)],
              ['Codec',       rec.codec || '—'],
              ['Sample Rate', rec.sample_rate ? `${(rec.sample_rate/1000).toFixed(1)} kHz` : '—'],
              ['Channels',    rec.channels ? (rec.channels === 1 ? 'Mono' : 'Stereo') : '—'],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between">
                <span className="text-[10px] text-text-muted">{k}</span>
                <span className="text-[10px] font-mono font-medium text-text-primary">{v}</span>
              </div>
            ))}
            {rec.recording_path && (
              <div className="pt-1 border-t border-surface-border/30">
                <p className="text-[9px] font-mono text-text-muted break-all opacity-60">{rec.recording_path}</p>
              </div>
            )}
          </div>

          {/* Incident link */}
          {rec.incident_uuid && (
            <div className="card !p-3">
              <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted mb-2">Linked Incident</p>
              <div className="space-y-1">
                <div className="text-[10px] font-mono text-brand break-all">{rec.incident_uuid}</div>
                {rec.incident_status && (
                  <div className="text-[10px] text-text-muted">Status: {rec.incident_status}</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer actions */}
      <div className="border-t border-surface-border p-3 flex gap-2 shrink-0">
        <a
          href={api.recordings.downloadUrl(rec.id)}
          download={rec.recording_file || 'recording.wav'}
          className="flex-1 flex items-center justify-center gap-1.5 text-xs py-2 rounded-lg
                     bg-brand text-white hover:bg-brand/90 font-medium transition-colors">
          <Download size={12} /> Download
        </a>
        {canEdit && rec.status === 'COMPLETED' && (
          <button
            onClick={async () => {
              setArchiving(true);
              try { await onArchive(); } finally { setArchiving(false); }
            }}
            disabled={archiving}
            className="flex items-center gap-1 text-xs px-3 py-2 rounded-lg
                       border border-surface-border text-text-muted hover:text-text-primary
                       disabled:opacity-50 transition-colors">
            <Archive size={12} /> Archive
          </button>
        )}
        {canEdit && (
          <button
            onClick={onDelete}
            className="flex items-center gap-1 text-xs px-3 py-2 rounded-lg
                       border border-red-500/20 text-red-500 hover:bg-red-500/10 transition-colors">
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Recordings() {
  const [recordings,  setRecordings]  = useState([]);
  const [total,       setTotal]       = useState(0);
  const [loading,     setLoading]     = useState(true);
  const [search,      setSearch]      = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selected,    setSelected]    = useState(null);
  const [detail,      setDetail]      = useState(null);

  const user    = useAuthStore(s => s.user);
  const canEdit = user?.role === 'ADMIN' || user?.role === 'SUPERVISOR';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.recordings.list({
        search:         search         || undefined,
        status:         statusFilter   || undefined,
        limit: 100,
      });
      setRecordings(res.recordings || []);
      setTotal(res.total || 0);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => { load(); }, [load]);

  // Open detail panel — load full record
  const openDetail = async (rec) => {
    if (selected === rec.id) {
      setSelected(null);
      setDetail(null);
      return;
    }
    setSelected(rec.id);
    setDetail(rec);
    try {
      const full = await api.recordings.get(rec.id);
      setDetail(full.recording);
    } catch {}
  };

  const handleArchive = async () => {
    if (!detail) return;
    await api.recordings.archive(detail.id);
    load();
    const updated = { ...detail, status: 'ARCHIVED', archived_at: new Date().toISOString() };
    setDetail(updated);
  };

  const handleDelete = async () => {
    if (!detail || !window.confirm('Delete this recording?')) return;
    await api.recordings.remove(detail.id);
    setSelected(null);
    setDetail(null);
    load();
  };

  // Summary stats
  const active    = recordings.filter(r => r.status === 'RECORDING').length;
  const completed = recordings.filter(r => r.status === 'COMPLETED').length;
  const archived  = recordings.filter(r => r.status === 'ARCHIVED').length;

  return (
    <div className="space-y-5 relative">
      {detail && (
        <RecordingDetail
          rec={detail}
          canEdit={canEdit}
          onClose={() => { setSelected(null); setDetail(null); }}
          onArchive={handleArchive}
          onDelete={handleDelete}
        />
      )}

      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20
                        flex items-center justify-center shrink-0">
          <Headphones size={18} className="text-red-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-text-primary">Conference Recordings</h1>
          <p className="text-xs text-text-muted">{total} recording{total !== 1 ? 's' : ''} total</p>
        </div>
        <button onClick={load}
          className="p-2 rounded-lg text-text-muted hover:text-brand hover:bg-surface-hover transition-colors"
          title="Refresh">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Stats */}
      {!loading && total > 0 && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Total',     value: total,     icon: Headphones, color: 'text-text-primary' },
            { label: 'Recording', value: active,    icon: Radio,      color: 'text-red-400' },
            { label: 'Completed', value: completed, icon: CheckCircle, color: 'text-green-500' },
            { label: 'Archived',  value: archived,  icon: Archive,    color: 'text-text-muted' },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label} className="card !p-3 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-surface-hover flex items-center justify-center shrink-0">
                <Icon size={13} className={color} />
              </div>
              <div>
                <div className={`text-lg font-bold tabular-nums ${color}`}>{value}</div>
                <div className="text-[9px] text-text-muted uppercase tracking-wide">{label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search room, file, notes…"
            className="w-full pl-8 pr-3 py-2 bg-surface border border-surface-border rounded-lg
                       text-xs text-text-primary placeholder:text-text-muted focus:outline-none
                       focus:border-brand transition-colors"
          />
        </div>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="bg-surface border border-surface-border rounded-lg px-2.5 py-2 text-xs
                     text-text-primary focus:outline-none focus:border-brand transition-colors">
          <option value="">All statuses</option>
          {Object.entries(STATUS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-16 rounded-xl bg-surface-hover animate-pulse" />
          ))}
        </div>
      ) : recordings.length === 0 ? (
        <div className="card py-16 text-center">
          <Headphones size={36} className="mx-auto text-text-muted/20 mb-3" />
          <p className="text-sm font-semibold text-text-secondary">No recordings</p>
          <p className="text-xs text-text-muted mt-1">
            {search || statusFilter ? 'No results match your filter' : 'Conference recordings will appear here automatically'}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {recordings.map(r => {
            const s   = STATUS[r.status] || STATUS.COMPLETED;
            const isActive = selected === r.id;
            return (
              <div
                key={r.id}
                onClick={() => openDetail(r)}
                className={[
                  'group flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-all',
                  isActive
                    ? 'border-brand/40 bg-brand/5 shadow-sm'
                    : 'border-surface-border bg-surface hover:bg-surface-hover/50',
                ].join(' ')}
              >
                {/* Icon */}
                <div className={[
                  'w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border',
                  r.status === 'RECORDING'
                    ? 'bg-red-500/10 border-red-500/20'
                    : 'bg-surface-hover border-surface-border',
                ].join(' ')}>
                  {r.status === 'RECORDING'
                    ? <Radio size={14} className="text-red-400 animate-pulse" />
                    : <FileAudio size={14} className="text-text-muted" />}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-text-primary truncate max-w-xs font-mono">
                      {r.recording_file || r.conference_room}
                    </span>
                    <span className={`text-[9px] px-1.5 py-px rounded border font-bold flex items-center gap-0.5 ${s.cls}`}>
                      <s.Icon size={7} /> {s.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-[10px] text-text-muted tabular-nums flex-wrap">
                    {r.organization_name && (
                      <span className="flex items-center gap-1">
                        <Building2 size={9} /> {r.organization_name}
                      </span>
                    )}
                    {r.ers_name && (
                      <span className="text-brand/70">{r.ers_name}</span>
                    )}
                    {r.duration_sec != null && <span>{fmtDuration(r.duration_sec)}</span>}
                    {r.file_size_bytes != null && <span>{fmtSize(r.file_size_bytes)}</span>}
                    {r.codec && <span className="font-mono uppercase">{r.codec}</span>}
                    <span className="flex items-center gap-1">
                      <Clock size={9} /> {fmtRelative(r.started_at)}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  {(r.status === 'COMPLETED' || r.status === 'ARCHIVED') && (
                    <a
                      href={api.recordings.downloadUrl(r.id)}
                      download={r.recording_file || 'recording.wav'}
                      onClick={e => e.stopPropagation()}
                      title="Download"
                      className="p-1.5 rounded-lg bg-surface-hover border border-surface-border
                                 text-text-muted hover:text-brand transition-colors">
                      <Download size={11} />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
