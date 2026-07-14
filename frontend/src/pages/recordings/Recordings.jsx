import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Headphones, Play, Pause, Download, Search, RefreshCw, X,
  SkipBack, SkipForward, Volume2, VolumeX,
  Archive, Trash2, Calendar, Phone, Building2, User
} from 'lucide-react';
import { api } from '../../api/client.js';
import { useAuthStore } from '../../store/authStore.js';

function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function fmtDuration(sec) {
  if (!sec && sec !== 0) return '—';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const STATUS_STYLES = {
  RECORDING: 'bg-red-500/15 text-red-400 border-red-500/20',
  COMPLETED: 'bg-green-500/15 text-green-500 border-green-500/20',
  ARCHIVED:  'bg-surface-hover text-text-muted border-surface-border',
  FAILED:    'bg-amber-500/15 text-amber-500 border-amber-500/20',
};

// ── Waveform Canvas ───────────────────────────────────────────────────────────

function WaveformCanvas({ peaks, progress = 0, duration = 0, onSeek, height = 56 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks?.length) return;
    const ctx    = canvas.getContext('2d');
    const W      = canvas.width;
    const H      = canvas.height;
    const midY   = H / 2;
    const barW   = Math.max(1, W / peaks.length);
    const played = Math.floor(progress * peaks.length);

    ctx.clearRect(0, 0, W, H);
    peaks.forEach((p, i) => {
      const x    = i * barW;
      const barH = Math.max(2, p * (H - 4));
      ctx.fillStyle = i < played
        ? 'rgba(79,70,229,0.9)'
        : 'rgba(79,70,229,0.28)';
      ctx.fillRect(x, midY - barH / 2, Math.max(1, barW - 1), barH);
    });
  }, [peaks, progress]);

  const handleClick = (e) => {
    if (!onSeek || !duration) return;
    const rect = canvasRef.current.getBoundingClientRect();
    onSeek(((e.clientX - rect.left) / rect.width) * duration);
  };

  return (
    <canvas ref={canvasRef} width={600} height={height}
      onClick={handleClick}
      className="w-full rounded cursor-pointer" style={{ height }} />
  );
}

// ── Detail + Player Panel ─────────────────────────────────────────────────────

function RecordingDetail({ rec, onClose }) {
  const [playing,  setPlaying]  = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentT, setCurrentT] = useState(0);
  const [duration, setDuration] = useState(rec.duration_sec || 0);
  const [volume,   setVolume]   = useState(1);
  const [muted,    setMuted]    = useState(false);
  const [speed,    setSpeed]    = useState(1);
  const [peaks,    setPeaks]    = useState(null);
  const audioRef = useRef(null);

  useEffect(() => {
    api.recordings.waveform(rec.id)
      .then(r => setPeaks(r.peaks || null))
      .catch(() => {});
  }, [rec.id]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) { a.pause(); setPlaying(false); }
    else         { a.play().catch(() => setPlaying(false)); setPlaying(true); }
  };

  const skip = (s) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(0, Math.min(duration, audioRef.current.currentTime + s));
  };

  const handleSeek = (t) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = t;
    setCurrentT(t); setProgress(duration ? t / duration : 0);
  };

  const Meta = ({ icon: Icon, label, value }) => value ? (
    <div className="flex items-start gap-2">
      <Icon size={12} className="text-text-muted mt-0.5 shrink-0" />
      <div>
        <p className="text-[9px] text-text-muted uppercase tracking-wide">{label}</p>
        <p className="text-xs text-text-primary">{value}</p>
      </div>
    </div>
  ) : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-surface border border-surface-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border shrink-0">
          <div className="flex items-center gap-2">
            <Headphones size={16} className="text-brand" />
            <h2 className="text-sm font-bold text-text-primary">Conference Recording</h2>
            <span className={`text-[9px] px-2 py-0.5 rounded-full border font-medium ${STATUS_STYLES[rec.status] || STATUS_STYLES.COMPLETED}`}>
              {rec.status}
            </span>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
        </div>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Player column */}
          <div className="flex-1 p-5 space-y-4 overflow-y-auto">
            {/* Waveform */}
            <div className="bg-surface-panel rounded-lg px-3 py-2">
              {peaks ? (
                <WaveformCanvas peaks={peaks} progress={progress} duration={duration} onSeek={handleSeek} height={64} />
              ) : rec.status === 'COMPLETED' ? (
                <div className="h-16 flex items-center justify-center text-[10px] text-text-muted opacity-50">
                  No waveform — WAV PCM required
                </div>
              ) : (
                <div className="h-16 flex items-center justify-center text-[10px] text-red-400 opacity-70">
                  Recording in progress
                </div>
              )}
            </div>

            {/* Time */}
            <div className="flex justify-between text-[10px] text-text-muted tabular-nums">
              <span>{fmtDuration(currentT)}</span>
              <span>–{fmtDuration(duration - currentT)}</span>
            </div>

            {/* Playback controls */}
            <div className="flex items-center justify-center gap-4">
              <button onClick={() => skip(-10)} className="text-text-muted hover:text-text-primary transition-colors">
                <SkipBack size={16} />
              </button>
              <button onClick={toggle} disabled={rec.status !== 'COMPLETED'}
                className="w-10 h-10 rounded-full bg-brand flex items-center justify-center text-white
                           hover:bg-brand/90 disabled:opacity-40 transition-colors">
                {playing ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button onClick={() => skip(10)} className="text-text-muted hover:text-text-primary transition-colors">
                <SkipForward size={16} />
              </button>
            </div>

            {/* Speed + volume */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-text-muted">Speed</span>
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map(s => (
                  <button key={s}
                    onClick={() => { setSpeed(s); if (audioRef.current) audioRef.current.playbackRate = s; }}
                    className={`text-[10px] px-1.5 py-0.5 rounded font-mono transition-colors
                      ${speed === s ? 'bg-brand text-white' : 'text-text-muted hover:text-text-primary'}`}>
                    {s}x
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 ml-auto">
                <button onClick={() => setMuted(m => !m)} className="text-text-muted hover:text-text-primary">
                  {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                </button>
                <input type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume}
                  onChange={e => { setVolume(+e.target.value); setMuted(false); if (audioRef.current) audioRef.current.volume = +e.target.value; }}
                  className="w-20 accent-brand" />
              </div>
              <a href={api.recordings.downloadUrl(rec.id)} download
                className="flex items-center gap-1 text-[10px] px-3 py-1.5 rounded-lg
                           bg-surface-panel border border-surface-border text-text-muted hover:text-brand transition-colors">
                <Download size={11} /> Download
              </a>
            </div>

            {/* File info */}
            <div className="grid grid-cols-3 gap-3 text-[10px] text-text-muted pt-2 border-t border-surface-border">
              <div><span className="text-text-muted/60 uppercase tracking-wide block">Duration</span>{fmtDuration(rec.duration_sec)}</div>
              <div><span className="text-text-muted/60 uppercase tracking-wide block">Size</span>{fmtSize(rec.file_size_bytes)}</div>
              <div><span className="text-text-muted/60 uppercase tracking-wide block">Format</span>{rec.codec || 'WAV'} {rec.sample_rate ? `${(rec.sample_rate/1000).toFixed(1)}kHz` : ''}</div>
            </div>

            <audio ref={audioRef} src={api.recordings.streamUrl(rec.id)} preload="none" muted={muted}
              onEnded={() => { setPlaying(false); setProgress(0); setCurrentT(0); }}
              onTimeUpdate={e => { const t = e.target.currentTime; setCurrentT(t); setProgress(duration ? t / duration : 0); }}
              onLoadedMetadata={e => setDuration(e.target.duration || rec.duration_sec || 0)} />
          </div>

          {/* Metadata panel */}
          <div className="w-64 shrink-0 border-l border-surface-border p-4 space-y-4 overflow-y-auto bg-surface-panel">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wide">Incident Details</p>
            <div className="space-y-3">
              <Meta icon={Phone}     label="Conference"  value={rec.conf_name} />
              <Meta icon={Calendar}  label="Started"     value={fmtTime(rec.started_at)} />
              <Meta icon={Calendar}  label="Ended"       value={fmtTime(rec.ended_at)} />
              <Meta icon={Building2} label="ERS Config"  value={rec.ers_config_name} />
              <Meta icon={Building2} label="Organization" value={rec.org_name} />
              <Meta icon={Phone}     label="Caller"      value={rec.incident_caller} />
              <Meta icon={User}      label="Call Result" value={rec.call_result} />
            </div>

            {rec.participants?.length > 0 && (
              <>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wide pt-2 border-t border-surface-border">
                  Participants ({rec.participants.length})
                </p>
                <div className="space-y-1.5">
                  {rec.participants.map((p, i) => (
                    <div key={i} className="text-[10px]">
                      <p className="text-text-primary font-medium">{p.caller_id_name || p.caller_id_number || p.member_id}</p>
                      {p.joined_at && <p className="text-text-muted">Joined {fmtTime(p.joined_at)}</p>}
                    </div>
                  ))}
                </div>
              </>
            )}

            {rec.notes && (
              <>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wide pt-2 border-t border-surface-border">Notes</p>
                <p className="text-[10px] text-text-muted">{rec.notes}</p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Recordings() {
  const [rows,      setRows]      = useState([]);
  const [total,     setTotal]     = useState(0);
  const [loading,   setLoading]   = useState(true);
  const [detail,    setDetail]    = useState(null);
  const [search,    setSearch]    = useState('');
  const [status,    setStatus]    = useState('');
  const [dateFrom,  setDateFrom]  = useState('');
  const [dateTo,    setDateTo]    = useState('');
  const [archiving, setArchiving] = useState({});
  const [deleting,  setDeleting]  = useState({});

  const user    = useAuthStore(s => s.user);
  const canEdit = user?.role === 'ADMIN' || user?.role === 'SUPERVISOR';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = {};
      if (search)   q.search   = search;
      if (status)   q.status   = status;
      if (dateFrom) q.dateFrom = dateFrom;
      if (dateTo)   q.dateTo   = dateTo;
      q.limit = 200;
      const res = await api.recordings.list(q);
      setRows(res.recordings || []);
      setTotal(res.total || 0);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [search, status, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  const handleArchive = async (id) => {
    setArchiving(a => ({ ...a, [id]: true }));
    try { await api.recordings.archive(id); load(); }
    catch (e) { alert('Archive failed: ' + e.message); }
    finally { setArchiving(a => ({ ...a, [id]: false })); }
  };

  const handleDelete = async (rec) => {
    if (!window.confirm(`Delete recording from conference "${rec.conf_name}"?`)) return;
    setDeleting(d => ({ ...d, [rec.id]: true }));
    try { await api.recordings.remove(rec.id); load(); }
    catch (e) { alert('Delete failed: ' + e.message); }
    finally { setDeleting(d => ({ ...d, [rec.id]: false })); }
  };

  return (
    <div className="space-y-5">
      {detail && <RecordingDetail rec={detail} onClose={() => setDetail(null)} />}

      {/* Header */}
      <div className="flex items-center gap-3">
        <Headphones size={20} className="text-brand" />
        <div className="flex-1">
          <h1 className="text-xl font-bold text-text-primary">Conference Recordings</h1>
          <p className="text-xs text-text-muted">{total} recording{total !== 1 ? 's' : ''} — auto-captured from ERS conferences</p>
        </div>
        <button onClick={load} className="p-2 text-text-muted hover:text-brand transition-colors" title="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Conference, caller, ERS config…"
            className="w-full pl-8 pr-3 py-2 bg-surface border border-surface-border rounded-lg
                       text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand" />
        </div>
        <select value={status} onChange={e => setStatus(e.target.value)}
          className="bg-surface border border-surface-border rounded-lg px-2.5 py-2 text-xs text-text-primary focus:outline-none focus:border-brand">
          <option value="">All statuses</option>
          <option value="RECORDING">Recording</option>
          <option value="COMPLETED">Completed</option>
          <option value="ARCHIVED">Archived</option>
          <option value="FAILED">Failed</option>
        </select>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
          className="bg-surface border border-surface-border rounded-lg px-2.5 py-2 text-xs text-text-primary focus:outline-none focus:border-brand" />
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
          className="bg-surface border border-surface-border rounded-lg px-2.5 py-2 text-xs text-text-primary focus:outline-none focus:border-brand" />
        {(search || status || dateFrom || dateTo) && (
          <button onClick={() => { setSearch(''); setStatus(''); setDateFrom(''); setDateTo(''); }}
            className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors">
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center py-12 text-text-muted text-sm">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card text-center py-12">
          <Headphones size={32} className="mx-auto text-text-muted mb-3" />
          <p className="text-sm text-text-muted">No recordings found</p>
          <p className="text-[11px] text-text-muted mt-1 opacity-60">
            Recordings appear automatically when a conference starts with recording enabled
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map(r => (
            <div key={r.id}
                 className="card flex items-center gap-4 hover:bg-surface-hover transition-colors cursor-pointer"
                 onClick={() => setDetail(r)}>
              {/* Status dot */}
              <div className={`w-2 h-2 rounded-full shrink-0 ${
                r.status === 'RECORDING' ? 'bg-red-400 animate-pulse' :
                r.status === 'COMPLETED' ? 'bg-green-500' :
                r.status === 'ARCHIVED'  ? 'bg-text-muted' : 'bg-amber-500'
              }`} />

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-text-primary truncate">{r.conf_name}</p>
                  <span className={`text-[9px] px-2 py-0.5 rounded-full border font-medium ${STATUS_STYLES[r.status] || ''}`}>
                    {r.status}
                  </span>
                  {r.ers_config_name && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-surface-hover border border-surface-border text-text-muted">
                      {r.ers_config_name}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-[10px] text-text-muted tabular-nums">
                  <span>{fmtTime(r.started_at)}</span>
                  {r.duration_sec != null && <span>{fmtDuration(r.duration_sec)}</span>}
                  {r.file_size_bytes && <span>{fmtSize(r.file_size_bytes)}</span>}
                  {r.org_name && <span>{r.org_name}</span>}
                  {r.incident_caller && (
                    <span className="flex items-center gap-0.5"><Phone size={8} /> {r.incident_caller}</span>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                {r.status === 'COMPLETED' && (
                  <button onClick={() => setDetail(r)}
                    title="Play" className="p-1.5 rounded-lg bg-surface-hover text-text-muted hover:text-brand border border-surface-border transition-colors">
                    <Play size={12} />
                  </button>
                )}
                {r.status === 'COMPLETED' && (
                  <a href={api.recordings.downloadUrl(r.id)} download title="Download"
                    className="p-1.5 rounded-lg bg-surface-hover text-text-muted hover:text-brand border border-surface-border transition-colors">
                    <Download size={12} />
                  </a>
                )}
                {canEdit && r.status === 'COMPLETED' && (
                  <button onClick={() => handleArchive(r.id)} disabled={archiving[r.id]}
                    title="Archive" className="p-1.5 text-text-muted hover:text-amber-400 transition-colors">
                    {archiving[r.id] ? <RefreshCw size={12} className="animate-spin" /> : <Archive size={12} />}
                  </button>
                )}
                {canEdit && (
                  <button onClick={() => handleDelete(r)} disabled={deleting[r.id]}
                    title="Delete" className="p-1.5 text-text-muted hover:text-red-400 transition-colors">
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
