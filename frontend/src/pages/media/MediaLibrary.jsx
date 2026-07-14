import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Library, Upload, Trash2, Play, Pause, Square, CheckCircle,
  AlertCircle, Clock, Search, Tag, RefreshCw, HardDrive, X,
  Download, Info, Waveform, Layers, SkipBack, SkipForward,
  Volume2, VolumeX
} from 'lucide-react';
import { api } from '../../api/client.js';
import { useAuthStore } from '../../store/authStore.js';

const CATEGORIES = [
  'system_prompt','emergency_prompt','ivr_prompt','tts_generated',
  'music_on_hold','announcement','conference_prompt','campaign_prompt','general'
];
const CAT_LABELS = {
  system_prompt: 'System Prompt', emergency_prompt: 'Emergency Prompt',
  ivr_prompt: 'IVR Prompt', tts_generated: 'TTS Generated',
  music_on_hold: 'Music on Hold', announcement: 'Announcement',
  conference_prompt: 'Conference Prompt', campaign_prompt: 'Campaign Prompt',
  general: 'General',
};

function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function fmtDuration(sec) {
  if (!sec) return '—';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Waveform Canvas ───────────────────────────────────────────────────────────

function WaveformCanvas({ peaks, progress = 0, duration = 0, onSeek, height = 48 }) {
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
      ctx.fillStyle = i < played ? 'rgba(var(--brand-rgb,79 70 229)/0.9)' : 'rgba(var(--brand-rgb,79 70 229)/0.3)';
      ctx.fillRect(x, midY - barH / 2, Math.max(1, barW - 1), barH);
    });
  }, [peaks, progress]);

  const handleClick = (e) => {
    if (!onSeek || !duration) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    onSeek(ratio * duration);
  };

  return (
    <canvas
      ref={canvasRef}
      width={400}
      height={height}
      onClick={handleClick}
      className="w-full rounded cursor-pointer"
      style={{ height }}
    />
  );
}

// ── Enterprise Audio Player ───────────────────────────────────────────────────

function AudioPlayer({ file, onClose }) {
  const [playing,   setPlaying]   = useState(false);
  const [progress,  setProgress]  = useState(0);
  const [currentT,  setCurrentT]  = useState(0);
  const [duration,  setDuration]  = useState(file.duration_sec || 0);
  const [volume,    setVolume]    = useState(1);
  const [muted,     setMuted]     = useState(false);
  const [speed,     setSpeed]     = useState(1);
  const [peaks,     setPeaks]     = useState(null);
  const audioRef = useRef(null);

  useEffect(() => {
    api.mediaLibrary.waveform(file.id)
      .then(r => setPeaks(r.peaks || null))
      .catch(() => {});
  }, [file.id]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) { a.pause(); setPlaying(false); }
    else         { a.play().catch(() => setPlaying(false)); setPlaying(true); }
  };

  const skip = (sec) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(0, Math.min(duration, audioRef.current.currentTime + sec));
  };

  const handleSeek = (t) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = t;
    setCurrentT(t);
    setProgress(duration ? t / duration : 0);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end justify-center p-4">
      <div className="bg-surface border border-surface-border rounded-xl shadow-2xl w-full max-w-2xl p-5 space-y-4">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-brand/10 border border-brand/20
                          flex items-center justify-center shrink-0">
            <Library size={16} className="text-brand" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-text-primary truncate">{file.name}</p>
            <p className="text-[10px] text-text-muted">
              {CAT_LABELS[file.category] || file.category} · {fmtSize(file.size_bytes)} · {file.codec || 'WAV'}
              {file.sample_rate ? ` · ${(file.sample_rate / 1000).toFixed(1)}kHz` : ''}
              {file.channels ? ` · ${file.channels === 1 ? 'Mono' : 'Stereo'}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        {/* Waveform */}
        <div className="bg-surface-panel rounded-lg px-3 py-2">
          {peaks ? (
            <WaveformCanvas peaks={peaks} progress={progress} duration={duration} onSeek={handleSeek} height={56} />
          ) : (
            <div className="h-14 flex items-center justify-center text-[10px] text-text-muted opacity-50">
              No waveform available
            </div>
          )}
        </div>

        {/* Time */}
        <div className="flex justify-between text-[10px] text-text-muted tabular-nums">
          <span>{fmtDuration(currentT)}</span>
          <span>{fmtDuration(duration)}</span>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-center gap-4">
          <button onClick={() => skip(-10)} className="text-text-muted hover:text-text-primary transition-colors">
            <SkipBack size={16} />
          </button>
          <button
            onClick={toggle}
            className="w-10 h-10 rounded-full bg-brand flex items-center justify-center text-white hover:bg-brand/90 transition-colors"
          >
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button onClick={() => skip(10)} className="text-text-muted hover:text-text-primary transition-colors">
            <SkipForward size={16} />
          </button>
        </div>

        {/* Speed + Volume */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-text-muted">Speed</span>
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map(s => (
              <button
                key={s}
                onClick={() => { setSpeed(s); if (audioRef.current) audioRef.current.playbackRate = s; }}
                className={`text-[10px] px-1.5 py-0.5 rounded font-mono transition-colors
                  ${speed === s ? 'bg-brand text-white' : 'text-text-muted hover:text-text-primary'}`}
              >
                {s}x
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <button onClick={() => setMuted(m => !m)} className="text-text-muted hover:text-text-primary">
              {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </button>
            <input
              type="range" min="0" max="1" step="0.05"
              value={muted ? 0 : volume}
              onChange={e => { setVolume(+e.target.value); setMuted(false); if (audioRef.current) audioRef.current.volume = +e.target.value; }}
              className="w-20 accent-brand"
            />
          </div>
          <a
            href={api.mediaLibrary.downloadUrl(file.id)}
            download
            className="flex items-center gap-1 text-[10px] px-3 py-1.5 rounded-lg
                       bg-surface-panel border border-surface-border text-text-muted hover:text-brand transition-colors"
          >
            <Download size={11} /> Download
          </a>
        </div>

        <audio
          ref={audioRef}
          src={api.mediaLibrary.streamUrl(file.id)}
          preload="none"
          onEnded={() => { setPlaying(false); setProgress(0); setCurrentT(0); }}
          onTimeUpdate={e => {
            const t = e.target.currentTime;
            setCurrentT(t);
            setProgress(duration ? t / duration : 0);
          }}
          onLoadedMetadata={e => setDuration(e.target.duration || file.duration_sec || 0)}
          muted={muted}
        />
      </div>
    </div>
  );
}

// ── Upload Modal ──────────────────────────────────────────────────────────────

function UploadModal({ onClose, onSuccess }) {
  const [file,        setFile]        = useState(null);
  const [name,        setName]        = useState('');
  const [category,    setCategory]    = useState('general');
  const [description, setDescription] = useState('');
  const [uploading,   setUploading]   = useState(false);
  const [error,       setError]       = useState('');
  const [warn,        setWarn]        = useState('');

  const handleFile = f => { if (f) { setFile(f); setName(f.name); } };

  const handleSubmit = async () => {
    if (!file) return setError('Select an audio file first');
    setUploading(true); setError(''); setWarn('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', name || file.name);
      fd.append('category', category);
      if (description) fd.append('description', description);
      const result = await api.mediaLibrary.upload(fd);
      if (result?.deployError) {
        setWarn(`Saved, but FreeSWITCH deploy failed: ${result.deployError}. Use Deploy button to retry.`);
        onSuccess();
        return;
      }
      onSuccess();
      onClose();
    } catch (e) {
      if (e.status === 409) setError('Duplicate file — identical content already exists in the library.');
      else setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-surface border border-surface-border rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border">
          <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <Upload size={15} className="text-brand" /> Upload Media File
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
        </div>

        <div className="p-5 space-y-4">
          <div
            onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
            onDragOver={e => e.preventDefault()}
            onClick={() => document.getElementById('ml-file-input').click()}
            className="border-2 border-dashed border-surface-border rounded-lg p-6 text-center
                       hover:border-brand/50 transition-colors cursor-pointer"
          >
            <Library size={24} className="mx-auto text-text-muted mb-2" />
            {file ? (
              <p className="text-xs font-medium text-brand">{file.name} ({fmtSize(file.size)})</p>
            ) : (
              <>
                <p className="text-xs text-text-muted">Drop audio file or click to browse</p>
                <p className="text-[10px] text-text-muted mt-1 opacity-60">WAV · MP3 · OGG · GSM · FLAC · AAC</p>
              </>
            )}
            <input id="ml-file-input" type="file"
              accept=".wav,.mp3,.ogg,.gsm,.flac,.aac,.ul"
              className="hidden"
              onChange={e => handleFile(e.target.files[0])} />
          </div>

          <div>
            <label className="block text-[10px] font-medium text-text-muted uppercase tracking-wide mb-1">Display Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="welcome_message.wav"
              className="w-full bg-surface border border-surface-border rounded-lg px-3 py-1.5
                         text-xs text-text-primary focus:outline-none focus:border-brand" />
          </div>

          <div>
            <label className="block text-[10px] font-medium text-text-muted uppercase tracking-wide mb-1">Category</label>
            <select value={category} onChange={e => setCategory(e.target.value)}
              className="w-full bg-surface border border-surface-border rounded-lg px-3 py-1.5
                         text-xs text-text-primary focus:outline-none focus:border-brand">
              {CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABELS[c]}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-medium text-text-muted uppercase tracking-wide mb-1">Description (optional)</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)}
              placeholder="What does this audio say or do?" rows={2}
              className="w-full bg-surface border border-surface-border rounded-lg px-3 py-1.5
                         text-xs text-text-primary focus:outline-none focus:border-brand resize-none" />
          </div>

          {warn && (
            <p className="text-xs text-amber-400 flex items-start gap-1">
              <AlertCircle size={12} className="mt-0.5 shrink-0" /> {warn}
            </p>
          )}
          {error && (
            <p className="text-xs text-red-400 flex items-center gap-1">
              <AlertCircle size={12} /> {error}
            </p>
          )}
        </div>

        <div className="px-5 py-4 border-t border-surface-border flex gap-3 justify-end">
          <button onClick={onClose}
            className="text-xs px-4 py-2 rounded-lg border border-surface-border text-text-muted hover:text-text-primary transition-colors">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={!file || uploading}
            className="text-xs px-5 py-2 rounded-lg bg-brand text-white hover:bg-brand/90 disabled:opacity-50 transition-colors flex items-center gap-2">
            {uploading ? <><RefreshCw size={11} className="animate-spin" /> Uploading…</> : <><Upload size={11} /> Upload</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function MediaLibrary() {
  const [files,      setFiles]      = useState([]);
  const [total,      setTotal]      = useState(0);
  const [categories, setCategories] = useState([]);
  const [search,     setSearch]     = useState('');
  const [catFilter,  setCatFilter]  = useState('');
  const [loading,    setLoading]    = useState(true);
  const [scanning,   setScanning]   = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [player,     setPlayer]     = useState(null);
  const [deploying,  setDeploying]  = useState({});
  const [deleting,   setDeleting]   = useState({});

  const user    = useAuthStore(s => s.user);
  const canEdit = user?.role === 'ADMIN' || user?.role === 'SUPERVISOR';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [filesRes, catRes] = await Promise.all([
        api.mediaLibrary.list({ search: search || undefined, category: catFilter || undefined, limit: 500 }),
        api.mediaLibrary.categories(),
      ]);
      setFiles(filesRes.files || []);
      setTotal(filesRes.total || 0);
      setCategories(catRes.categories || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [search, catFilter]);

  useEffect(() => { load(); }, [load]);

  const handleScan = async (silent = false) => {
    setScanning(true);
    if (!silent) setScanResult(null);
    try {
      const result = await api.mediaLibrary.scan();
      setScanResult(result);
      if (result.imported > 0) load();
    } catch (e) {
      if (!silent) setScanResult({ message: 'Scan failed: ' + e.message, imported: 0, errors: 1 });
    } finally {
      setScanning(false);
    }
  };

  const handleDeploy = async (id) => {
    setDeploying(d => ({ ...d, [id]: true }));
    try { await api.mediaLibrary.deploy(id); load(); }
    catch (e) { alert('Deploy failed: ' + e.message); }
    finally { setDeploying(d => ({ ...d, [id]: false })); }
  };

  const handleDelete = async (file) => {
    if (!window.confirm(`Delete "${file.name}"?`)) return;
    setDeleting(d => ({ ...d, [file.id]: true }));
    try { await api.mediaLibrary.remove(file.id); load(); }
    catch (e) { alert('Delete failed: ' + e.message); }
    finally { setDeleting(d => ({ ...d, [file.id]: false })); }
  };

  return (
    <div className="space-y-5">
      {player && <AudioPlayer file={player} onClose={() => setPlayer(null)} />}
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} onSuccess={load} />}

      {/* Header */}
      <div className="flex items-center gap-3">
        <Library size={20} className="text-brand" />
        <div className="flex-1">
          <h1 className="text-xl font-bold text-text-primary">Media Library</h1>
          <p className="text-xs text-text-muted">{total} file{total !== 1 ? 's' : ''} — audio deployed to FreeSWITCH</p>
        </div>
        {canEdit && (
          <button onClick={() => handleScan()} disabled={scanning}
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg
                       bg-surface border border-surface-border text-text-muted
                       hover:text-brand hover:border-brand/50 font-medium transition-colors disabled:opacity-50">
            <HardDrive size={14} className={scanning ? 'animate-pulse' : ''} />
            {scanning ? 'Scanning…' : 'Scan FS'}
          </button>
        )}
        {canEdit && (
          <button onClick={() => setShowUpload(true)}
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg
                       bg-brand text-white hover:bg-brand/90 font-medium transition-colors">
            <Upload size={14} /> Upload
          </button>
        )}
      </div>

      {/* Scan result */}
      {scanResult && (
        <div className={`px-4 py-3 rounded-lg border text-[11px] flex items-start gap-2
          ${scanResult.errors > 0
            ? 'bg-amber-500/5 border-amber-500/20 text-amber-600 dark:text-amber-400'
            : 'bg-green-500/5 border-green-500/20 text-green-600 dark:text-green-400'}`}>
          {scanResult.errors > 0 ? <AlertCircle size={13} className="mt-0.5 shrink-0" /> : <CheckCircle size={13} className="mt-0.5 shrink-0" />}
          <span className="flex-1">{scanResult.message}</span>
          <button onClick={() => setScanResult(null)} className="opacity-50 hover:opacity-100"><X size={12} /></button>
        </div>
      )}

      {/* Info banner */}
      <div className="px-4 py-3 rounded-lg bg-brand/5 border border-brand/20 text-[11px] text-text-muted leading-relaxed">
        Uploaded files are copied to <code className="font-mono text-brand">$FS_SOUND_DIR/enrs/</code> on FreeSWITCH.
        Reference them in IVR nodes as <code className="font-mono text-brand">/media/filename.wav</code>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search files…"
            className="w-full pl-8 pr-3 py-2 bg-surface border border-surface-border rounded-lg
                       text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand" />
        </div>
        <div className="flex items-center gap-2">
          <Tag size={12} className="text-text-muted" />
          <select value={catFilter} onChange={e => setCatFilter(e.target.value)}
            className="bg-surface border border-surface-border rounded-lg px-2.5 py-2 text-xs text-text-primary focus:outline-none focus:border-brand">
            <option value="">All categories</option>
            {categories.map(c => <option key={c} value={c}>{CAT_LABELS[c] || c}</option>)}
          </select>
        </div>
        <button onClick={load} className="p-2 text-text-muted hover:text-brand transition-colors" title="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>

      {/* File list */}
      {loading ? (
        <div className="text-center py-12 text-text-muted text-sm">Loading…</div>
      ) : files.length === 0 ? (
        <div className="card text-center py-12">
          <Library size={32} className="mx-auto text-text-muted mb-3" />
          <p className="text-sm text-text-muted">No media files found</p>
          {canEdit && (
            <div className="mt-4 flex items-center justify-center gap-3">
              <button onClick={() => handleScan()} disabled={scanning}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg
                           bg-surface border border-surface-border text-text-muted
                           hover:text-brand hover:border-brand/50 transition-colors">
                <HardDrive size={12} /> {scanning ? 'Scanning…' : 'Scan FreeSWITCH sound dir'}
              </button>
              <button onClick={() => setShowUpload(true)} className="text-xs text-brand hover:underline">
                Upload a file
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {files.map(f => (
            <div key={f.id}
                 className="card flex items-center gap-4 hover:bg-surface-hover transition-colors">
              <div className="w-9 h-9 rounded-lg bg-brand/10 border border-brand/20
                              flex items-center justify-center shrink-0">
                <Library size={15} className="text-brand" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-text-primary truncate">{f.name}</p>
                  {f.is_deployed ? (
                    <span className="flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-full
                                     bg-green-500/15 text-green-500 border border-green-500/20 font-medium">
                      <CheckCircle size={9} /> Deployed
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-full
                                     bg-amber-500/15 text-amber-500 border border-amber-500/20 font-medium">
                      <Clock size={9} /> Pending
                    </span>
                  )}
                  {f.category && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-surface-hover border border-surface-border text-text-muted">
                      {CAT_LABELS[f.category] || f.category}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-[10px] text-text-muted tabular-nums">
                  <span>{fmtSize(f.size_bytes)}</span>
                  {f.duration_sec ? <span>{fmtDuration(f.duration_sec)}</span> : null}
                  {f.codec ? <span className="uppercase">{f.codec}</span> : null}
                  {f.sample_rate ? <span>{(f.sample_rate / 1000).toFixed(1)}kHz</span> : null}
                  {f.channels ? <span>{f.channels === 1 ? 'Mono' : 'Stereo'}</span> : null}
                  <span>Uploaded {fmtTime(f.created_at)}</span>
                </div>
                {f.description && (
                  <p className="text-[10px] text-text-muted mt-0.5 truncate">{f.description}</p>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => setPlayer(f)}
                  title="Play"
                  className="p-1.5 rounded-lg bg-surface-hover text-text-muted hover:text-brand border border-surface-border transition-colors"
                >
                  <Play size={12} />
                </button>

                <a href={api.mediaLibrary.downloadUrl(f.id)} download
                   title="Download"
                   className="p-1.5 rounded-lg bg-surface-hover text-text-muted hover:text-brand border border-surface-border transition-colors">
                  <Download size={12} />
                </a>

                {canEdit && !f.is_deployed && (
                  <button onClick={() => handleDeploy(f.id)} disabled={deploying[f.id]}
                    title="Deploy to FreeSWITCH"
                    className="flex items-center gap-1 text-[10px] px-2 py-1.5 rounded-lg
                               bg-green-500/10 text-green-500 border border-green-500/20
                               hover:bg-green-500/20 disabled:opacity-50 transition-colors">
                    {deploying[f.id] ? <RefreshCw size={10} className="animate-spin" /> : <HardDrive size={10} />}
                    Deploy
                  </button>
                )}
                {canEdit && f.is_deployed && (
                  <button onClick={() => handleDeploy(f.id)} disabled={deploying[f.id]}
                    title="Re-deploy" className="p-1.5 text-text-muted hover:text-green-500 transition-colors">
                    <RefreshCw size={12} />
                  </button>
                )}
                {canEdit && (
                  <button onClick={() => handleDelete(f)} disabled={deleting[f.id]}
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
