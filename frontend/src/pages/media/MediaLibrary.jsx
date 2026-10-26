import { useEffect, useState, useCallback, useRef, Component, forwardRef, useImperativeHandle } from 'react';
import {
  Library, Upload, Trash2, Play, Pause, CheckCircle,
  AlertCircle, Clock, Search, Tag, RefreshCw, HardDrive, X,
  Download, SkipBack, SkipForward, Volume2, VolumeX, Rewind, FastForward,
  Info, FileAudio, BarChart2, Pencil, Save,
  ArrowUp, ArrowDown, ArrowUpDown, Lock
} from 'lucide-react';
import { api } from '../../api/client.js';
import { useAuthStore } from '../../store/authStore.js';
import { can } from '../../auth/permissions.js';
import { useMediaUrl, downloadMedia } from '../../api/mediaAccess.js';
import PageHeader from '../../components/ui/PageHeader.jsx';
import ConfirmDialog from '../../components/ui/ConfirmDialog.jsx';
import { Table, Th, Td, Tr } from '../../components/ui/Table.jsx';
import { SkeletonTable } from '../../components/ui/Skeleton.jsx';
import Pagination from '../../components/ui/Pagination.jsx';
import {
  initialListState, buildListQuery, applyListChange, toggleSort, totalPages, clampPage,
  pageAfterDelete, summaryToKpis, describeLoadError, emptyStateKind, createRequestGate,
  clearFilters, refreshDetail, activeFilterChips,
  fmtBytes, fmtTotalDuration, DEPLOY_FILTERS, SEARCH_DEBOUNCE_MS,
} from './mediaLibraryState.js';
import {
  emptySelection, selectedFiles, selectedCount, isSelected, toggleRow, togglePage,
  pageSelectionState, refreshSelection, withoutIds, bulkActions, runSequential, summarizeBulk,
  describeDependency, adjacentFile, parseTags, leafName, MAX_BULK, MAX_BULK_DOWNLOAD,
} from './mediaSelection.js';

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
const CAT_COLORS = {
  system_prompt:     'bg-slate-500/15 text-slate-400 border-slate-500/20',
  emergency_prompt:  'bg-red-500/15 text-red-400 border-red-500/20',
  ivr_prompt:        'bg-blue-500/15 text-blue-400 border-blue-500/20',
  tts_generated:     'bg-purple-500/15 text-purple-400 border-purple-500/20',
  music_on_hold:     'bg-emerald-500/15 text-emerald-500 border-emerald-500/20',
  announcement:      'bg-amber-500/15 text-amber-500 border-amber-500/20',
  conference_prompt: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/20',
  campaign_prompt:   'bg-orange-500/15 text-orange-400 border-orange-500/20',
  general:           'bg-surface-hover text-text-muted border-surface-border',
};

function fmtSize(bytes) {
  const n = Number(bytes);
  if (!isFinite(n) || n < 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function fmtDuration(sec) {
  const n = Number(sec);
  if (!isFinite(n) || n < 0) return '—';
  if (n < 60) return n.toFixed(1) + 's';
  const m = Math.floor(n / 60), s = (n % 60).toFixed(0);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
const fmtClock = (s) => {
  const n = Math.max(0, Number(s) || 0);
  return `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
};

function CategoryBadge({ category }) {
  if (!category) return null;
  return (
    <span className={`inline-block text-[9px] px-1.5 py-px rounded border font-medium whitespace-nowrap
      ${CAT_COLORS[category] || CAT_COLORS.general}`}>
      {CAT_LABELS[category] || category}
    </span>
  );
}

function StatusBadge({ deployed }) {
  return deployed ? (
    <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-px rounded-full whitespace-nowrap
                     bg-green-500/12 text-green-500 border border-green-500/20 font-bold">
      <CheckCircle size={7} /> Deployed
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-px rounded-full whitespace-nowrap
                     bg-amber-500/12 text-amber-500 border border-amber-500/20 font-bold">
      <Clock size={7} /> Pending
    </span>
  );
}

// ── Waveform Canvas ───────────────────────────────────────────────────────────

function WaveformCanvas({ peaks, progress = 0, duration = 0, onSeek, height = 56 }) {
  const canvasRef = useRef(null);
  const animRef   = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    cancelAnimationFrame(animRef.current);
    animRef.current = requestAnimationFrame(() => {
      const ctx  = canvas.getContext('2d');
      const W    = canvas.width;
      const H    = canvas.height;
      const midY = H / 2;

      ctx.clearRect(0, 0, W, H);

      if (!peaks?.length) {
        ctx.fillStyle = 'rgba(100,100,120,0.15)';
        ctx.fillRect(0, midY - 1, W, 2);
        if (progress > 0) {
          ctx.fillStyle = 'rgba(79,70,229,0.8)';
          ctx.fillRect(0, midY - 1, progress * W, 2);
        }
        return;
      }

      const barW  = W / peaks.length;
      const played = Math.floor(progress * peaks.length);

      peaks.forEach((p, i) => {
        const x    = i * barW;
        const barH = Math.max(2, p * (H - 6));
        ctx.fillStyle = i < played
          ? 'rgba(79,70,229,0.95)'
          : 'rgba(79,70,229,0.22)';
        ctx.fillRect(x, midY - barH / 2, Math.max(1, barW - 1), barH);
      });

      // Playhead
      if (progress > 0 && progress < 1) {
        const px = progress * W;
        ctx.fillStyle = 'rgba(79,70,229,0.8)';
        ctx.fillRect(px - 1, 2, 2, H - 4);
      }
    });
    return () => cancelAnimationFrame(animRef.current);
  }, [peaks, progress]);

  const handleClick = (e) => {
    if (!onSeek || !duration) return;
    const rect = canvasRef.current.getBoundingClientRect();
    onSeek(((e.clientX - rect.left) / rect.width) * duration);
  };

  return (
    <canvas
      ref={canvasRef}
      width={600}
      height={height}
      onClick={handleClick}
      className="w-full rounded cursor-pointer"
      style={{ height }}
    />
  );
}

// ── Docked Audio Player ───────────────────────────────────────────────────────
// Stays docked at the bottom of the page while the user pages, sorts and filters.
// One <audio> element for the whole page; rows toggle it through the ref handle.

const DockedPlayer = forwardRef(function DockedPlayer(
  { file, hasPrev, hasNext, onPrev, onNext, onClose, onPlayingChange }, ref,
) {
  const [playing,  setPlaying]  = useState(false);
  const [currentT, setCurrentT] = useState(0);
  const [duration, setDuration] = useState(Number(file.duration_sec) || 0);
  const [volume,   setVolume]   = useState(1);
  const [muted,    setMuted]    = useState(false);
  const [speed,    setSpeed]    = useState(1);
  const [peaks,    setPeaks]    = useState(file.waveform_peaks || null);
  const [loadErr,  setLoadErr]  = useState(null);
  const audioRef  = useRef(null);
  const autoStart = useRef(true);
  // Latest props/handlers for effects that must run only when the FILE changes.
  const latest = useRef({});
  latest.current = { file, onPlayingChange };
  const { url: streamUrl, error: linkErr, refresh: refreshStreamUrl } = useMediaUrl('media', file.id, 'stream');

  // New file: reset position, fetch its waveform, start playing once the signed link is ready.
  useEffect(() => {
    const f = latest.current.file;
    setPlaying(false); setCurrentT(0); setLoadErr(null);
    setDuration(Number(f.duration_sec) || 0);
    setPeaks(f.waveform_peaks || null);
    autoStart.current = true;
    let cancelled = false;
    if (!f.waveform_peaks) {
      api.mediaLibrary.waveform(f.id)
        .then(r => { if (!cancelled) setPeaks(r.peaks?.length ? r.peaks : null); })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [file.id]);

  useEffect(() => { latest.current.onPlayingChange?.(playing); }, [playing]);
  useEffect(() => () => latest.current.onPlayingChange?.(false), []);
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = speed; }, [speed, streamUrl]);
  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);

  const diagnose = async () => {
    try {
      const url = await refreshStreamUrl();     // the old link may simply have expired
      if (!url) throw new Error('no link');
      const probe = await fetch(url, { method: 'HEAD' });
      if (!probe.ok) {
        const body = await fetch(url).then(r => r.json()).catch(() => null);
        setLoadErr(`Playback failed — HTTP ${probe.status}: ${body?.error || probe.statusText}`);
      } else {
        const ct = probe.headers.get('content-type') || 'unknown';
        setLoadErr(`Playback failed — server returned ${ct} (browser may not support this audio format)`);
      }
    } catch {
      setLoadErr('Playback failed — could not reach the audio stream endpoint');
    }
  };

  const play = () => {
    const a = audioRef.current;
    if (!a) return;
    setLoadErr(null);
    a.play().then(() => setPlaying(true)).catch(() => { setPlaying(false); diagnose(); });
  };
  const pause = () => { audioRef.current?.pause(); setPlaying(false); };
  const toggle = () => (playing ? pause() : play());
  useImperativeHandle(ref, () => ({ toggle }));
  latest.current.play = play;

  useEffect(() => {
    if (streamUrl && autoStart.current) { autoStart.current = false; latest.current.play(); }
  }, [streamUrl]);

  // Space toggles playback when focus is not in a form control.
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space' || e.repeat) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select', 'button'].includes(tag) || e.target?.isContentEditable) return;
      e.preventDefault(); toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const seek = (t) => {
    if (!audioRef.current) return;
    const v = Math.max(0, Math.min(duration || 0, t));
    audioRef.current.currentTime = v;
    setCurrentT(v);
  };
  const progress = duration ? currentT / duration : 0;

  const btn = 'p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover disabled:opacity-30 transition-colors';

  return (
    <div role="region" aria-label="Audio player"
      className="sticky bottom-0 z-30 -mx-4 md:-mx-6 -mb-4 md:-mb-6 mt-4 border-t border-surface-border
                 bg-surface-panel/95 backdrop-blur px-4 md:px-6 py-2 shadow-[0_-6px_18px_rgba(0,0,0,0.12)]">
      <div className="flex items-center gap-3 flex-wrap lg:flex-nowrap">
        {/* Now playing */}
        <div className="flex items-center gap-2 min-w-0 w-full lg:w-60 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-brand/10 border border-brand/20 flex items-center justify-center shrink-0">
            <FileAudio size={14} className="text-brand" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-text-primary truncate" title={file.name}>{file.name}</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <CategoryBadge category={file.category} />
              <span className="text-[10px] text-text-muted tabular-nums">{fmtSize(file.size_bytes)}</span>
            </div>
          </div>
        </div>

        {/* Transport */}
        <div className="flex items-center gap-1 shrink-0">
          <button type="button" className={btn} onClick={onPrev} disabled={!hasPrev} aria-label="Previous file" title="Previous file"><SkipBack size={14} /></button>
          <button type="button" className={btn} onClick={() => seek(currentT - 10)} aria-label="Back 10 seconds" title="Back 10 s"><Rewind size={14} /></button>
          <button type="button" onClick={toggle} aria-label={playing ? `Pause ${file.name}` : `Play ${file.name}`}
            className="w-9 h-9 rounded-full bg-brand flex items-center justify-center text-white hover:bg-brand/90 active:scale-95 transition-all shadow shadow-brand/20">
            {playing ? <Pause size={15} /> : <Play size={15} className="translate-x-px" />}
          </button>
          <button type="button" className={btn} onClick={() => seek(currentT + 10)} aria-label="Forward 10 seconds" title="Forward 10 s"><FastForward size={14} /></button>
          <button type="button" className={btn} onClick={onNext} disabled={!hasNext} aria-label="Next file" title="Next file"><SkipForward size={14} /></button>
        </div>

        {/* Seek */}
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <span className="text-[10px] text-text-muted tabular-nums w-9 text-right">{fmtClock(currentT)}</span>
          <div className="relative flex-1">
            <WaveformCanvas peaks={peaks} progress={progress} duration={duration} onSeek={seek} height={30} />
            <input type="range" min="0" max={duration || 0} step="0.1" value={Math.min(currentT, duration || 0)}
              onChange={e => seek(Number(e.target.value))} aria-label="Seek"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
          </div>
          <span className="text-[10px] text-text-muted tabular-nums w-9">{fmtClock(duration)}</span>
        </div>

        {/* Speed, volume, download, close */}
        <div className="flex items-center gap-2 shrink-0">
          <select value={speed} onChange={e => setSpeed(Number(e.target.value))} aria-label="Playback speed"
            className="input-sm !w-auto !py-0.5 !text-[10px]">
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map(s => <option key={s} value={s}>{s}×</option>)}
          </select>
          <button type="button" className={btn} onClick={() => setMuted(m => !m)} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted || volume === 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
          <input type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} aria-label="Volume"
            onChange={e => { const v = +e.target.value; setVolume(v); setMuted(v === 0); }}
            className="w-16 accent-brand cursor-pointer" />
          <button type="button" className={btn} title="Download" aria-label={`Download ${file.name}`}
            onClick={() => downloadMedia('media', file.id, file.name).catch(err => setLoadErr(`Download failed — ${err.message}`))}>
            <Download size={13} />
          </button>
          <button type="button" className={btn} onClick={onClose} aria-label="Close player" title="Close player"><X size={14} /></button>
        </div>
      </div>

      {(loadErr || linkErr) && (
        <div role="alert" className="mt-1.5 flex items-center gap-2 text-[10px] text-red-400 bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-1.5">
          <AlertCircle size={11} className="shrink-0" />
          {loadErr || `Could not prepare playback — ${linkErr.status === 404 ? 'file not found or no longer available' : linkErr.message}`}
        </div>
      )}

      <audio
        ref={audioRef}
        src={streamUrl || undefined}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={e => { setPlaying(false); e.target.currentTime = 0; setCurrentT(0); }}  // audition one file at a time — no auto-advance
        onTimeUpdate={e => setCurrentT(e.target.currentTime)}
        onLoadedMetadata={e => {
          const d = e.target.duration;
          if (d && isFinite(d)) setDuration(d);
          else if (file.duration_sec) setDuration(Number(file.duration_sec) || 0);
          e.target.playbackRate = speed;
        }}
        onError={e => {
          const code = e.target?.error?.code;
          const msgs = { 1: 'Loading aborted', 2: 'Network error', 3: 'Decoding error — unsupported format', 4: 'Audio source not found or not playable' };
          setLoadErr('Audio load failed — ' + (msgs[code] || 'unknown error'));
        }}
        muted={muted}
      />
    </div>
  );
});

// ── Upload Modal (multiple files) ─────────────────────────────────────────────

const MAX_UPLOAD_BATCH = 20;
const ACCEPT = '.wav,.mp3,.ogg,.gsm,.flac,.ul,.alaw,.ulaw';
const niceName = (filename) => filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');

function UploadModal({ onClose, onSuccess }) {
  const [items,       setItems]       = useState([]);   // { key, file, name, status, message }
  const [category,    setCategory]    = useState('general');
  const [description, setDescription] = useState('');
  const [running,     setRunning]     = useState(false);
  const [notice,      setNotice]      = useState('');
  const dropRef  = useRef(null);
  const inputRef = useRef(null);

  const addFiles = (list) => {
    const incoming = Array.from(list || []);
    setNotice('');
    setItems(prev => {
      const room = MAX_UPLOAD_BATCH - prev.length;
      if (incoming.length > room) setNotice(`Up to ${MAX_UPLOAD_BATCH} files per batch — ${incoming.length - Math.max(room, 0)} not added.`);
      return [...prev, ...incoming.slice(0, Math.max(room, 0)).map((f, i) => ({
        key: `${Date.now()}-${i}-${f.name}`, file: f, name: niceName(f.name), status: 'queued', message: '',
      }))];
    });
  };
  const setItem = (key, patch) => setItems(prev => prev.map(it => (it.key === key ? { ...it, ...patch } : it)));

  // Escape closes the dialog, like the other Media Library dialogs — but never mid-upload.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !running) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, onClose]);

  const handleDrop = (e) => {
    e.preventDefault();
    dropRef.current?.classList.remove('border-brand/50', 'bg-brand/5');
    addFiles(e.dataTransfer.files);
  };

  const pending = items.filter(it => it.status === 'queued' || it.status === 'error');
  const handleSubmit = async () => {
    if (!pending.length) return;
    setRunning(true);
    let anyUploaded = false, anyIssue = false;
    for (const it of pending) {
      setItem(it.key, { status: 'uploading', message: '' });
      try {
        const fd = new FormData();
        fd.append('file', it.file);
        fd.append('name', it.name.trim() || it.file.name);
        fd.append('category', category);
        if (description.trim()) fd.append('description', description.trim());
        const result = await api.mediaLibrary.upload(fd);
        anyUploaded = true;
        if (result?.deployError) {
          anyIssue = true;
          setItem(it.key, { status: 'warn', message: `Saved, but SIPCommunication deploy failed: ${result.deployError}. Use Deploy to retry.` });
        } else {
          setItem(it.key, { status: 'done' });
        }
      } catch (e) {
        anyIssue = true;
        setItem(it.key, e.status === 409
          ? { status: 'duplicate', message: 'Duplicate — identical content already exists in the library.' }
          : { status: 'error', message: e.message || 'Upload failed' });
      }
    }
    setRunning(false);
    if (anyUploaded) onSuccess();
    if (!anyIssue) onClose();
  };

  const statusIcon = {
    queued:    <FileAudio size={12} className="text-text-muted" />,
    uploading: <RefreshCw size={12} className="text-brand animate-spin" />,
    done:      <CheckCircle size={12} className="text-green-500" />,
    warn:      <AlertCircle size={12} className="text-amber-500" />,
    duplicate: <AlertCircle size={12} className="text-amber-500" />,
    error:     <AlertCircle size={12} className="text-red-400" />,
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Upload media files">
      <div className="bg-surface-panel border border-surface-border rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border">
          <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <Upload size={14} className="text-brand" /> Upload Media Files
          </h2>
          <button onClick={onClose} disabled={running} aria-label="Close"
            className="p-1 rounded text-text-muted hover:text-text-primary disabled:opacity-40 transition-colors">
            <X size={15} />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div
            ref={dropRef}
            onDrop={handleDrop}
            onDragOver={e => { e.preventDefault(); dropRef.current?.classList.add('border-brand/50', 'bg-brand/5'); }}
            onDragLeave={() => dropRef.current?.classList.remove('border-brand/50', 'bg-brand/5')}
            onClick={() => !running && inputRef.current?.click()}
            role="button" tabIndex={0}
            onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !running) { e.preventDefault(); inputRef.current?.click(); } }}
            aria-label="Add audio files: drop them here or press Enter to browse"
            className="border-2 border-dashed border-surface-border rounded-xl p-5 text-center
                       hover:border-brand/40 hover:bg-brand/3 transition-all cursor-pointer"
          >
            <FileAudio size={22} className="mx-auto text-text-muted mb-1.5" />
            <p className="text-xs text-text-muted font-medium">Drop audio files or click to browse</p>
            <p className="text-[10px] text-text-muted mt-1 opacity-60">WAV · MP3 · GSM · OGG · FLAC · ulaw — up to {MAX_UPLOAD_BATCH} files</p>
            <input ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden"
              onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
          </div>

          {notice && <p className="text-[10px] text-amber-500">{notice}</p>}

          {items.length > 0 && (
            <ul className="space-y-1.5" aria-label="Files to upload">
              {items.map(it => (
                <li key={it.key} className="flex items-start gap-2 rounded-lg border border-surface-border px-2.5 py-1.5">
                  <span className="mt-1.5" aria-label={it.status}>{statusIcon[it.status]}</span>
                  <div className="flex-1 min-w-0">
                    <input value={it.name} onChange={e => setItem(it.key, { name: e.target.value })}
                      disabled={running || ['done', 'warn'].includes(it.status)}
                      aria-label={`Display name for ${it.file.name}`}
                      className="w-full bg-transparent text-xs text-text-primary focus:outline-none border-b border-transparent focus:border-brand py-0.5" />
                    <p className="text-[10px] text-text-muted truncate">{it.file.name} · {fmtSize(it.file.size)}</p>
                    {it.message && (
                      <p className={`text-[10px] mt-0.5 ${it.status === 'error' ? 'text-red-400' : 'text-amber-500'}`}>{it.message}</p>
                    )}
                  </div>
                  {!running && !['done', 'warn'].includes(it.status) && (
                    <button type="button" onClick={() => setItems(prev => prev.filter(x => x.key !== it.key))}
                      aria-label={`Remove ${it.file.name}`} className="mt-1 text-text-muted hover:text-red-400 transition-colors">
                      <X size={12} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="ml-up-cat" className="block text-[10px] font-semibold text-text-muted uppercase tracking-wide mb-1">Category</label>
              <select id="ml-up-cat" value={category} onChange={e => setCategory(e.target.value)} disabled={running}
                className="w-full bg-surface-panel border border-surface-border rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-brand transition-colors">
                {CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABELS[c]}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="ml-up-desc" className="block text-[10px] font-semibold text-text-muted uppercase tracking-wide mb-1">
                Description <span className="font-normal text-text-muted/60">(optional, applies to all)</span>
              </label>
              <input id="ml-up-desc" value={description} onChange={e => setDescription(e.target.value)} disabled={running}
                placeholder="What do these files say or do?"
                className="w-full bg-surface-panel border border-surface-border rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand transition-colors" />
            </div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-surface-border flex items-center gap-2 justify-end">
          <span className="text-[10px] text-text-muted mr-auto">
            {items.length ? `${items.filter(i => ['done', 'warn'].includes(i.status)).length} of ${items.length} uploaded` : 'No files selected'}
          </span>
          <button onClick={onClose} disabled={running}
            className="text-xs px-4 py-2 rounded-lg border border-surface-border text-text-muted hover:text-text-primary hover:bg-surface-hover disabled:opacity-40 transition-colors">
            {items.some(i => ['done', 'warn'].includes(i.status)) ? 'Close' : 'Cancel'}
          </button>
          <button onClick={handleSubmit} disabled={!pending.length || running}
            className="text-xs px-5 py-2 rounded-lg bg-brand text-white hover:bg-brand/90 disabled:opacity-50 transition-colors flex items-center gap-1.5 font-medium">
            {running
              ? <><RefreshCw size={11} className="animate-spin" /> Uploading…</>
              : <><Upload size={11} /> Upload {pending.length > 1 ? `${pending.length} files` : 'file'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── File Detail Drawer (view + edit) ──────────────────────────────────────────

function FileDetail({ file, onClose, onDeploy, onDelete, onPlay, onSaved, deploying, canEdit }) {
  const [editing, setEditing] = useState(false);
  const [form,    setForm]    = useState(null);
  const [saving,  setSaving]  = useState(false);
  const [err,     setErr]     = useState('');

  useEffect(() => { setEditing(false); setErr(''); }, [file.id]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) (editing ? setEditing(false) : onClose()); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const startEdit = () => {
    setForm({
      name: file.name || '', category: file.category || 'general', description: file.description || '',
      notes: file.notes || '', tags: (file.tags || []).join(', '),
    });
    setErr(''); setEditing(true);
  };
  const save = async () => {
    if (!form.name.trim()) return setErr('Name is required');
    setSaving(true); setErr('');
    try {
      await api.mediaLibrary.update(file.id, {
        name: form.name.trim(), category: form.category, description: form.description,
        notes: form.notes, tags: parseTags(form.tags),
      });
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };
  const field = 'w-full bg-surface-panel border border-surface-border rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-brand transition-colors';

  return (
    <aside className="fixed inset-y-0 right-0 z-40 w-full sm:w-96 bg-surface-panel border-l border-surface-border shadow-2xl flex flex-col"
      role="dialog" aria-label={`Details for ${file.name}`}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-surface-border shrink-0">
        <FileAudio size={14} className="text-brand" />
        <span className="text-sm font-bold text-text-primary flex-1 truncate" title={file.name}>{file.name}</span>
        <button onClick={onClose} aria-label="Close details" className="text-text-muted hover:text-text-primary transition-colors">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Actions */}
        <div className="flex gap-2 flex-wrap">
          <button onClick={onPlay}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors font-medium">
            <Play size={11} /> Play
          </button>
          <button type="button"
            onClick={() => downloadMedia('media', file.id, file.name).catch(e => setErr('Download failed: ' + e.message))}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-surface-hover border border-surface-border text-text-muted hover:text-brand transition-colors">
            <Download size={11} /> Download
          </button>
          {canEdit && (
            <button onClick={onDeploy} disabled={deploying}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg disabled:opacity-50 transition-colors
                ${file.is_deployed
                  ? 'bg-surface-hover border border-surface-border text-text-muted hover:text-green-500'
                  : 'bg-green-500/10 text-green-500 border border-green-500/20 hover:bg-green-500/20'}`}>
              {deploying ? <RefreshCw size={10} className="animate-spin" /> : <HardDrive size={10} />}
              {file.is_deployed ? 'Re-deploy' : 'Deploy'}
            </button>
          )}
          {canEdit && !editing && (
            <button onClick={startEdit}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-surface-hover border border-surface-border text-text-muted hover:text-brand transition-colors">
              <Pencil size={10} /> Edit
            </button>
          )}
          {canEdit && (
            <button onClick={onDelete}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-red-500/20 text-red-500 hover:bg-red-500/10 transition-colors ml-auto">
              <Trash2 size={10} /> Delete
            </button>
          )}
        </div>

        {err && (
          <div role="alert" className="flex items-start gap-2 text-[10px] text-red-400 bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2">
            <AlertCircle size={11} className="mt-0.5 shrink-0" /> {err}
          </div>
        )}

        {editing ? (
          <form className="card !p-3 space-y-2.5" onSubmit={e => { e.preventDefault(); save(); }} aria-label="Edit media details">
            <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Edit details</p>
            <label className="block text-[10px] text-text-muted">Name
              <input className={field} value={form.name} maxLength={255} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </label>
            <label className="block text-[10px] text-text-muted">Category
              <select className={field} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                {CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABELS[c]}</option>)}
              </select>
            </label>
            <label className="block text-[10px] text-text-muted">Description
              <textarea className={`${field} resize-none`} rows={2} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </label>
            <label className="block text-[10px] text-text-muted">Tags <span className="opacity-60">(comma-separated)</span>
              <input className={field} value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} placeholder="e.g. fire, evacuation, en" />
            </label>
            <label className="block text-[10px] text-text-muted">Notes
              <textarea className={`${field} resize-none`} rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setEditing(false)} disabled={saving}
                className="text-xs px-3 py-1.5 rounded-lg border border-surface-border text-text-muted hover:text-text-primary">Cancel</button>
              <button type="submit" disabled={saving}
                className="text-xs px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand/90 disabled:opacity-50 flex items-center gap-1.5">
                {saving ? <RefreshCw size={10} className="animate-spin" /> : <Save size={10} />} Save
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="card !p-3 space-y-2">
              <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Overview</p>
              <div className="flex items-center gap-2 flex-wrap"><CategoryBadge category={file.category} /><StatusBadge deployed={file.is_deployed} /></div>
              {file.description && <p className="text-[11px] text-text-secondary leading-relaxed">{file.description}</p>}
              {(file.tags || []).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {file.tags.map(t => <span key={t} className="text-[9px] px-1.5 py-px rounded bg-surface-hover border border-surface-border text-text-muted">{t}</span>)}
                </div>
              )}
              {file.notes && <p className="text-[10px] text-text-muted whitespace-pre-wrap">{file.notes}</p>}
            </div>

            <div className="card !p-3 space-y-2">
              <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Deployment</p>
              <p className={`text-[11px] font-semibold ${file.is_deployed ? 'text-green-500' : 'text-amber-500'}`}>
                {file.is_deployed ? 'Deployed to SIPCommunication' : 'Pending deployment'}
              </p>
              {file.deployed_at && <p className="text-[10px] text-text-muted">Deployed: {fmtTime(file.deployed_at)}</p>}
              {file.fs_path && <p className="text-[10px] text-text-muted">Deployed file: <span className="font-mono">{leafName(file.fs_path)}</span></p>}
            </div>
          </>
        )}

        <div className="card !p-3 space-y-2">
          <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Audio</p>
          {[
            ['Codec',       file.codec || '—'],
            ['Sample rate', file.sample_rate ? `${(Number(file.sample_rate) / 1000).toFixed(1)} kHz` : '—'],
            ['Channels',    file.channels ? (Number(file.channels) === 1 ? 'Mono' : 'Stereo') : '—'],
            ['Bitrate',     file.bitrate_kbps ? `${file.bitrate_kbps} kbps` : '—'],
            ['Duration',    fmtDuration(file.duration_sec) || '—'],
            ['File size',   fmtSize(file.size_bytes)],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between">
              <span className="text-[10px] text-text-muted">{k}</span>
              <span className="text-[10px] font-medium text-text-primary font-mono">{v}</span>
            </div>
          ))}
        </div>

        <div className="card !p-3 space-y-2">
          <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Library</p>
          {[
            ['Uploaded', fmtTime(file.created_at)],
            ['Modified', fmtTime(file.updated_at)],
            ['By',       file.uploaded_by_email || '—'],
            ['Org',      file.organization_name || '—'],
            ['Version',  file.version ?? '—'],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-text-muted">{k}</span>
              <span className="text-[10px] font-medium text-text-primary truncate">{v}</span>
            </div>
          ))}
          {file.checksum && <p className="text-[9px] font-mono text-text-muted break-all opacity-60" title="SHA-256">SHA-256 {file.checksum}</p>}
        </div>
      </div>
    </aside>
  );
}

// ── Bulk / delete result dialog ───────────────────────────────────────────────

function ResultDialog({ result, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const { label, done, inUse, failed } = result;
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`${label} results`}>
      <div className="bg-surface-panel border border-surface-border rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-surface-border">
          <h2 className="text-sm font-bold text-text-primary">{label}</h2>
          <button onClick={onClose} aria-label="Close" className="text-text-muted hover:text-text-primary"><X size={15} /></button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto text-xs">
          <p className="flex items-center gap-2">
            <CheckCircle size={13} className={done.length ? 'text-green-500' : 'text-text-muted'} />
            {done.length} completed{inUse.length || failed.length ? `, ${inUse.length + failed.length} not completed` : ''}.
          </p>
          {inUse.length > 0 && (
            <section aria-label="Files in use">
              <p className="font-semibold text-amber-500 mb-1.5 flex items-center gap-1.5">
                <AlertCircle size={12} /> In use — not deleted ({inUse.length})
              </p>
              <p className="text-[11px] text-text-muted mb-2">Remove or replace these references first, then delete again.</p>
              <ul className="space-y-2">
                {inUse.map(({ file, dependencies, hiddenCount }) => (
                  <li key={file.id} className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                    <p className="font-medium text-text-primary">{file.name}</p>
                    <ul className="mt-1 list-disc pl-4 text-[11px] text-text-secondary">
                      {dependencies.map((d, i) => <li key={i}>{describeDependency(d)}</li>)}
                      {hiddenCount > 0 && <li>{hiddenCount} more item{hiddenCount === 1 ? '' : 's'} you do not have access to</li>}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {failed.length > 0 && (
            <section aria-label="Failed">
              <p className="font-semibold text-red-400 mb-1.5">Failed ({failed.length})</p>
              <ul className="space-y-1">
                {failed.map(({ file, message }) => (
                  <li key={file.id} className="text-[11px]"><span className="text-text-primary">{file.name}</span> — <span className="text-text-muted">{message}</span></li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <div className="px-5 py-3 border-t border-surface-border flex justify-end">
          <button onClick={onClose} className="text-xs px-4 py-2 rounded-lg bg-brand text-white hover:bg-brand/90">Close</button>
        </div>
      </div>
    </div>
  );
}

// ── Error Boundary ────────────────────────────────────────────────────────────

class MediaLibraryBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <AlertCircle size={36} className="text-red-400" />
        <div className="text-center">
          <p className="text-sm font-bold text-text-primary mb-1">Unable to render Media Library</p>
          <p className="text-xs text-text-muted mb-4">A rendering error occurred.</p>
          <details className="text-left max-w-lg">
            <summary className="text-[10px] text-text-muted cursor-pointer hover:text-text-primary">
              Technical details
            </summary>
            <pre className="mt-2 text-[9px] font-mono text-red-400 bg-red-500/5 border border-red-500/20
                            rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
              {this.state.error?.message}
              {'\n\n'}
              {this.state.error?.stack}
            </pre>
          </details>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => this.setState({ error: null })}
            className="text-xs px-4 py-2 rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors">
            Reload
          </button>
          <button
            onClick={() => window.history.back()}
            className="text-xs px-4 py-2 rounded-lg border border-surface-border text-text-muted
                       hover:text-text-primary hover:bg-surface-hover transition-colors">
            Go Back
          </button>
        </div>
      </div>
    );
  }
}

// ── Main Page ─────────────────────────────────────────────────────────────────

// Sortable column header — only fields the server accepts in ?sort= (SORT_FIELDS).
function SortTh({ field, label, list, onSort, className = '' }) {
  const active = list.sort === field;
  const dirLabel = active ? (list.dir === 'asc' ? 'ascending' : 'descending') : 'not sorted';
  return (
    <Th className={className}
      aria-sort={active ? (list.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(field)}
        aria-label={`Sort by ${label} (${dirLabel})`}
        className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-brand transition-colors
          ${active ? 'text-brand' : ''}`}>
        {label}
        {active ? (list.dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)
                : <ArrowUpDown size={10} className="opacity-40" />}
      </button>
    </Th>
  );
}

function MediaLibraryInner() {
  // Server-side list state: filters, sort and page (see mediaLibraryState.js).
  const [list,        setList]        = useState(initialListState);
  const [searchInput, setSearchInput] = useState('');
  const [files,       setFiles]       = useState([]);
  const [total,       setTotal]       = useState(0);
  const [summary,     setSummary]     = useState(null);
  const [categories,  setCategories]  = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [loadError,   setLoadError]   = useState(null);   // { kind, message, retryable }
  const [scanning,    setScanning]    = useState(false);
  const [scanResult,  setScanResult]  = useState(null);
  const [showUpload,  setShowUpload]  = useState(false);
  const [detail,      setDetail]      = useState(null);
  const [deploying,   setDeploying]   = useState({});
  const [selected,    setSelected]    = useState(emptySelection);
  const [bulk,        setBulk]        = useState(null);   // { label, done, total } while running
  const [result,      setResult]      = useState(null);   // { label, done, inUse, failed }
  const [confirm,     setConfirm]     = useState(null);   // { kind, files, category? }
  const [notice,      setNotice]      = useState('');
  const [nowPlaying,  setNowPlaying]  = useState(null);   // file in the docked player
  const [isPlaying,   setIsPlaying]   = useState(false);
  const gate      = useRef(createRequestGate());
  const playerRef = useRef(null);

  const user           = useAuthStore(s => s.user);
  const activeTenantId = useAuthStore(s => s.activeTenantId);
  // Matches the server guards (auth/permissions.js): upload is ADMIN/SUPERVISOR,
  // scan/deploy/edit/delete are ADMIN only — no buttons that would only return 403.
  const canUpload = can(user, 'media.upload');
  const canEdit   = can(user, 'media.manage');

  // Load one page. Only the newest request may apply its response, so a slow
  // earlier response can never overwrite a newer search / filter / page / sort.
  const load = useCallback(async () => {
    const ticket = gate.current.next();
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.mediaLibrary.list(buildListQuery(list));
      if (!gate.current.isCurrent(ticket)) return;
      const t = Number(res.total) || 0;
      // The result set shrank under us (e.g. deleted elsewhere): go to the last valid page.
      const valid = clampPage(list.page, t, list.limit);
      if (valid !== list.page) { setList(s => ({ ...s, page: valid })); return; }
      setFiles(res.files || []);
      setTotal(t);
      setSummary(res.summary || null);
      // Keep an open detail panel and the selection in step with the reloaded rows (e.g. after deploy).
      setDetail(d => refreshDetail(d, res.files));
      setSelected(s => refreshSelection(s, res.files));
    } catch (e) {
      if (!gate.current.isCurrent(ticket)) return;
      console.error(e);
      setLoadError(describeLoadError(e));
    } finally {
      if (gate.current.isCurrent(ticket)) setLoading(false);
    }
  }, [list, activeTenantId]);

  useEffect(() => { load(); }, [load]);

  // A different tenant is a different result set: start again at page 1.
  useEffect(() => { setList(s => applyListChange(s, { page: 1 })); }, [activeTenantId]);

  // Selection belongs to one filter set: a different search / filter / tenant clears it.
  useEffect(() => { setSelected(emptySelection()); }, [list.search, list.category, list.deployed, activeTenantId]);

  // Category options are a static server list; failures just leave the filter empty.
  useEffect(() => {
    api.mediaLibrary.categories()
      .then(r => setCategories(r.categories || []))
      .catch(() => setCategories([]));
  }, [activeTenantId]);

  // Debounced search → list state (resets to page 1).
  useEffect(() => {
    const h = setTimeout(() => setList(s => applyListChange(s, { search: searchInput.trim() })), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [searchInput]);

  const change = (patch) => setList(s => applyListChange(s, patch));
  const clearAllFilters = () => { setSearchInput(''); setList(s => clearFilters(s)); };
  const removeChip = (key) => {
    if (key === 'search') setSearchInput('');
    change({ [key]: '' });
  };

  const handleScan = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const r = await api.mediaLibrary.scan();
      setScanResult(r);
      if (r.imported > 0) load();
    } catch (e) {
      setScanResult({ message: 'Scan failed: ' + e.message, imported: 0, errors: 1 });
    } finally {
      setScanning(false);
    }
  };

  const handleDeploy = async (id) => {
    setDeploying(d => ({ ...d, [id]: true }));
    try {
      await api.mediaLibrary.deploy(id);
      load();
    } catch (e) {
      setResult({ label: 'Deploy', done: [], inUse: [], failed: [{ file: files.find(f => f.id === id) || { id, name: `#${id}` }, message: e.message }] });
    } finally {
      setDeploying(d => ({ ...d, [id]: false }));
    }
  };

  // New uploads are newest — show page 1 so the file is visible (filters are kept).
  const handleUploaded = () => {
    if (list.page !== 1) setList(s => applyListChange(s, { page: 1 }));
    else load();
  };

  // ── Bulk actions: one request at a time through the existing per-file endpoints ──
  const runBulk = async (label, targets, worker) => {
    if (targets.length > MAX_BULK) { setNotice(`Bulk actions are limited to ${MAX_BULK} files at a time.`); return null; }
    setNotice('');
    setBulk({ label, done: 0, total: targets.length });
    const results = await runSequential(targets, worker, { onProgress: (d) => setBulk(b => (b ? { ...b, done: d } : b)) });
    setBulk(null);
    const s = summarizeBulk(results);
    setResult({ label, ...s });
    return s;
  };

  const doDelete = async (targets) => {
    const s = await runBulk(targets.length === 1 ? `Delete “${targets[0].name}”` : `Delete ${targets.length} files`,
      targets, f => api.mediaLibrary.remove(f.id));
    if (!s) return;
    const doneIds = s.done.map(f => f.id);
    setSelected(sel => withoutIds(sel, doneIds));
    if (detail && doneIds.includes(detail.id)) setDetail(null);
    if (nowPlaying && doneIds.includes(nowPlaying.id)) setNowPlaying(null);
    if (s.done.length === 1 && !s.inUse.length && !s.failed.length) setResult(null);   // a clean single delete needs no report
    // Deleting the last rows of a page steps back to the previous valid page. Files
    // deleted from the detail panel may not be on this page — then just reload
    // (load() still clamps the page if the result set shrank).
    const onPage = s.done.filter(f => files.some(r => r.id === f.id)).length;
    const next = onPage
      ? pageAfterDelete({ page: list.page, total: total - (s.done.length - onPage), limit: list.limit, rowsOnPage: files.length, deletedCount: onPage })
      : list.page;
    if (next !== list.page) setList(st => ({ ...st, page: next }));
    else load();
  };

  const doDeploy = async (targets) => {
    const pending = targets.filter(f => !f.is_deployed);
    const s = await runBulk(`Deploy ${pending.length} file${pending.length === 1 ? '' : 's'}`, pending, f => api.mediaLibrary.deploy(f.id));
    if (s) load();
  };

  const doCategory = async (targets, category) => {
    const s = await runBulk(`Move ${targets.length} file${targets.length === 1 ? '' : 's'} to ${CAT_LABELS[category] || category}`,
      targets, f => api.mediaLibrary.update(f.id, { category }));
    if (s) load();
  };

  const doDownload = async (targets) => {
    const s = await runBulk(`Download ${targets.length} file${targets.length === 1 ? '' : 's'}`, targets.slice(0, MAX_BULK_DOWNLOAD),
      f => downloadMedia('media', f.id, f.name));
    if (s && !s.failed.length) setResult(null);
  };

  const onConfirm = async () => {
    const c = confirm;
    setConfirm(null);
    if (c.kind === 'delete') await doDelete(c.files);
    if (c.kind === 'category') await doCategory(c.files, c.category);
  };

  // ── Player ──
  const playRow = (f) => {
    if (nowPlaying?.id === f.id) playerRef.current?.toggle();
    else setNowPlaying(f);
  };
  const prevFile = nowPlaying ? adjacentFile(files, nowPlaying.id, -1) : null;
  const nextFile = nowPlaying ? adjacentFile(files, nowPlaying.id, +1) : null;

  const kpi   = summaryToKpis(summary);
  const pages = totalPages(total, list.limit);
  const forbidden = loadError?.kind === 'forbidden';
  const firstLoad = loading && !summary && files.length === 0;
  const chips = activeFilterChips(list, CAT_LABELS);
  const sel = selectedFiles(selected);
  const nSel = selectedCount(selected);
  const actions = bulkActions(sel, { canEdit });
  const pageSel = pageSelectionState(selected, files);
  const busy = Boolean(bulk);
  const iconBtn = 'p-1.5 rounded-lg border border-surface-border text-text-muted transition-colors disabled:opacity-40';

  return (
    <div className="space-y-5 relative">
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} onSuccess={handleUploaded} />}
      {detail && (
        <FileDetail
          file={detail}
          canEdit={canEdit}
          deploying={!!deploying[detail.id]}
          onClose={() => setDetail(null)}
          onPlay={() => playRow(detail)}
          onDeploy={() => handleDeploy(detail.id)}
          onDelete={() => setConfirm({ kind: 'delete', files: [detail] })}
          onSaved={load}
        />
      )}
      {result && <ResultDialog result={result} onClose={() => setResult(null)} />}
      <ConfirmDialog
        open={Boolean(confirm)}
        variant={confirm?.kind === 'delete' ? 'danger' : 'info'}
        title={confirm?.kind === 'delete'
          ? (confirm.files.length === 1 ? `Delete “${confirm.files[0].name}”?` : `Delete ${confirm.files.length} files?`)
          : `Move ${confirm?.files.length} file${confirm?.files.length === 1 ? '' : 's'} to ${CAT_LABELS[confirm?.category] || confirm?.category}?`}
        message={confirm?.kind === 'delete'
          ? 'Files that are still used by an IVR flow, ENS/ERS configuration or active campaign are kept and listed. Deleted files are moved to quarantine on the server.'
          : 'Only the category changes; the audio files and their deployment are not affected.'}
        confirmLabel={confirm?.kind === 'delete' ? 'Delete' : 'Move'}
        onConfirm={onConfirm}
        onCancel={() => setConfirm(null)}
      />

      <PageHeader
        title="Media Library"
        description={summary
          ? `${kpi.total} file${kpi.total !== 1 ? 's' : ''} · ${kpi.deployed} deployed · ${kpi.pending} pending`
          : 'Audio prompts and recordings'}
        icon={Library}
      >
        {canEdit && (
          <button onClick={handleScan} disabled={scanning} className="btn-secondary">
            <HardDrive size={13} className={scanning ? 'animate-pulse text-brand' : ''} />
            {scanning ? 'Scanning…' : 'Scan FS'}
          </button>
        )}
        {canUpload && (
          <button onClick={() => setShowUpload(true)} className="btn-primary">
            <Upload size={13} /> Upload
          </button>
        )}
      </PageHeader>

      {/* Scan result */}
      {scanResult && (
        <div className={`flex items-start gap-2 px-4 py-3 rounded-xl border text-[11px]
          ${scanResult.errors > 0
            ? 'bg-amber-500/5 border-amber-500/20 text-amber-500'
            : 'bg-green-500/5 border-green-500/20 text-green-500'}`}>
          {scanResult.errors > 0
            ? <AlertCircle size={13} className="mt-0.5 shrink-0" />
            : <CheckCircle size={13} className="mt-0.5 shrink-0" />}
          <span className="flex-1">{scanResult.message}</span>
          <button onClick={() => setScanResult(null)} aria-label="Dismiss" className="opacity-50 hover:opacity-100 transition-opacity">
            <X size={12} />
          </button>
        </div>
      )}

      {/* Load errors: 403 (no retry — retrying cannot help) vs recoverable failures */}
      {loadError && (
        <div role="alert" className="flex items-start gap-2 px-4 py-3 rounded-xl border text-[11px]
                        bg-red-500/5 border-red-500/20 text-red-400">
          {forbidden ? <Lock size={13} className="mt-0.5 shrink-0" /> : <AlertCircle size={13} className="mt-0.5 shrink-0" />}
          <span className="flex-1">{forbidden ? loadError.message : `Failed to load: ${loadError.message}`}</span>
          {loadError.retryable && (
            <button onClick={load} className="underline opacity-70 hover:opacity-100 transition-opacity">
              Retry
            </button>
          )}
        </div>
      )}

      {/* KPIs — server summary for the current filters (never counted from the loaded page) */}
      {summary && !forbidden && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" aria-label="Media library totals for the current filters">
          {[
            { label: 'Files',             value: kpi.total,                         icon: Library,     color: 'text-brand' },
            { label: 'Deployed',          value: kpi.deployed,                      icon: CheckCircle, color: 'text-green-500' },
            { label: 'Pending',           value: kpi.pending,                       icon: Clock,       color: 'text-amber-500' },
            { label: 'Total size',        value: fmtBytes(kpi.sizeBytes),           icon: HardDrive,   color: 'text-blue-400' },
            { label: 'Total duration',    value: fmtTotalDuration(kpi.durationSec), icon: BarChart2,   color: 'text-cyan-400' },
            { label: 'Categories in use', value: kpi.categoriesInUse,               icon: Tag,         color: 'text-purple-400' },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label} className="card !p-3 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-surface-hover flex items-center justify-center shrink-0">
                <Icon size={14} className={color} />
              </div>
              <div className="min-w-0">
                <div className={`text-lg font-bold tabular-nums ${color}`}>{value}</div>
                <div className="text-[9px] text-text-muted uppercase tracking-wide">{label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search by name, description or tag…"
            aria-label="Search media by name, description or tag"
            className="input-sm pl-8 w-full"
          />
        </div>
        <select
          value={list.category}
          onChange={e => change({ category: e.target.value })}
          aria-label="Filter by category"
          className="input-sm !w-auto">
          <option value="">All categories{summary ? ` (${kpi.allCategoriesTotal})` : ''}</option>
          {categories.map(c => (
            <option key={c} value={c}>
              {CAT_LABELS[c] || c}{summary ? ` (${kpi.byCategory[c] || 0})` : ''}
            </option>
          ))}
        </select>
        <select
          value={list.deployed}
          onChange={e => change({ deployed: e.target.value })}
          aria-label="Filter by deployment status"
          className="input-sm !w-auto">
          {DEPLOY_FILTERS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          value={list.limit}
          onChange={e => change({ limit: Number(e.target.value) })}
          aria-label="Rows per page"
          className="input-sm !w-auto">
          {[25, 50, 100, 200].map(n => <option key={n} value={n}>{n} / page</option>)}
        </select>
        <button onClick={load} className="btn-icon" title="Refresh" aria-label="Refresh">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Active filters */}
      {chips.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap -mt-2" aria-label="Active filters">
          <span className="text-[10px] text-text-muted uppercase tracking-wide">Filters</span>
          {chips.map(c => (
            <span key={c.key} className="inline-flex items-center gap-1 text-[11px] pl-2 pr-1 py-0.5 rounded-full bg-brand/10 border border-brand/25 text-text-primary">
              <span className="text-text-muted">{c.label}:</span> {c.value}
              <button type="button" onClick={() => removeChip(c.key)} aria-label={`Remove filter ${c.label}`}
                className="ml-0.5 p-0.5 rounded-full hover:bg-brand/20 text-text-muted hover:text-text-primary">
                <X size={10} />
              </button>
            </span>
          ))}
          <button type="button" onClick={clearAllFilters} className="text-[11px] text-brand hover:underline font-medium">
            Clear all
          </button>
          <span className="text-[10px] text-text-muted ml-1">· totals above reflect these filters</span>
        </div>
      )}

      {/* Selection bar */}
      {nSel > 0 && (
        <div role="region" aria-label="Selected files"
          className="flex items-center gap-2 flex-wrap px-3 py-2 rounded-xl border border-brand/30 bg-brand/5 text-xs">
          <strong className="text-text-primary">{nSel} selected</strong>
          {nSel > files.filter(f => isSelected(selected, f.id)).length && (
            <span className="text-[10px] text-text-muted">(including other pages)</span>
          )}
          <button type="button" onClick={() => setSelected(emptySelection())} disabled={busy}
            className="text-[11px] text-brand hover:underline disabled:opacity-40">Clear selection</button>
          {bulk && (
            <span className="flex items-center gap-1.5 text-[11px] text-text-muted" role="status">
              <RefreshCw size={11} className="animate-spin text-brand" /> {bulk.label}: {bulk.done} / {bulk.total}
            </span>
          )}
          <div className="flex items-center gap-2 flex-wrap ml-auto">
            <button type="button" disabled={busy} onClick={() => doDownload(sel)}
              title={actions.download.capped ? `Downloads the first ${MAX_BULK_DOWNLOAD} selected files` : undefined}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-surface-border bg-surface-panel text-text-muted hover:text-brand disabled:opacity-40">
              <Download size={11} /> Download{actions.download.capped ? ` first ${MAX_BULK_DOWNLOAD}` : ''}
            </button>
            {actions.deploy.allowed && (
              <button type="button" disabled={busy || actions.tooMany} onClick={() => doDeploy(sel)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-green-500/25 bg-green-500/10 text-green-500 hover:bg-green-500/20 disabled:opacity-40">
                <HardDrive size={11} /> Deploy {actions.deploy.count} pending
              </button>
            )}
            {actions.category.allowed && (
              <select value="" disabled={busy || actions.tooMany} aria-label="Move selected files to category"
                onChange={e => e.target.value && setConfirm({ kind: 'category', files: sel, category: e.target.value })}
                className="input-sm !w-auto !py-1 !text-[11px]">
                <option value="">Move to category…</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABELS[c]}</option>)}
              </select>
            )}
            {actions.delete.allowed && (
              <button type="button" disabled={busy || actions.tooMany} onClick={() => setConfirm({ kind: 'delete', files: sel })}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-red-500/25 text-red-500 hover:bg-red-500/10 disabled:opacity-40">
                <Trash2 size={11} /> Delete {nSel}
              </button>
            )}
          </div>
          {(actions.tooMany || notice) && (
            <p className="w-full text-[10px] text-amber-500">{notice || `Bulk actions are limited to ${MAX_BULK} files at a time — narrow the selection.`}</p>
          )}
        </div>
      )}

      {/* File table */}
      {forbidden ? null : firstLoad ? (
        <SkeletonTable rows={6} cols={6} />
      ) : !loadError && files.length === 0 ? (
        <div className="card text-center py-16">
          <Library size={36} className="mx-auto text-text-muted/20 mb-3" />
          {emptyStateKind(list) === 'no-matches' ? (
            <>
              <p className="text-sm font-semibold text-text-secondary">No matching media</p>
              <p className="text-xs text-text-muted mt-1">No files match the current search or filters.</p>
              <button onClick={clearAllFilters} className="mt-4 text-xs text-brand hover:underline font-medium">
                Clear filters
              </button>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-text-secondary">No media files</p>
              <p className="text-xs text-text-muted mt-1">Upload or scan SIPCommunication to import files</p>
              {(canEdit || canUpload) && (
                <div className="mt-4 flex items-center justify-center gap-3">
                  {canEdit && (
                    <button onClick={handleScan} disabled={scanning}
                      className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg
                                 bg-surface-panel border border-surface-border text-text-muted
                                 hover:text-brand hover:border-brand/30 transition-colors">
                      <HardDrive size={12} /> {scanning ? 'Scanning…' : 'Scan SIPCommunication'}
                    </button>
                  )}
                  {canUpload && (
                    <button onClick={() => setShowUpload(true)}
                      className="text-xs text-brand hover:underline font-medium">
                      Upload files
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      ) : files.length > 0 ? (
        <div className={loading ? 'opacity-60 transition-opacity' : ''} aria-busy={loading}>
          <Table className="max-h-[62vh] overflow-y-auto">
            <thead>
              <tr>
                <Th className="w-8">
                  <input type="checkbox" className="accent-brand cursor-pointer align-middle"
                    ref={el => { if (el) el.indeterminate = pageSel === 'some'; }}
                    checked={pageSel === 'all'}
                    onChange={() => setSelected(s => togglePage(s, files))}
                    aria-label={pageSel === 'all' ? 'Unselect all files on this page' : 'Select all files on this page'} />
                </Th>
                <Th className="w-8"><span className="sr-only">Play</span></Th>
                <SortTh field="name"         label="Name"     list={list} onSort={f => setList(s => toggleSort(s, f))} />
                <SortTh field="category"     label="Category" list={list} onSort={f => setList(s => toggleSort(s, f))} className="max-md:hidden" />
                <Th>Status</Th>
                <SortTh field="duration_sec" label="Duration" list={list} onSort={f => setList(s => toggleSort(s, f))} className="max-sm:hidden" />
                <SortTh field="size_bytes"   label="Size"     list={list} onSort={f => setList(s => toggleSort(s, f))} className="max-sm:hidden" />
                <SortTh field="created_at"   label="Uploaded" list={list} onSort={f => setList(s => toggleSort(s, f))} className="max-lg:hidden" />
                <Th className="max-2xl:hidden">Uploaded by</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {files.map(f => {
                const isActive  = detail?.id === f.id;
                const isCurrent = nowPlaying?.id === f.id;
                const checked   = isSelected(selected, f.id);
                return (
                  <Tr key={f.id} onClick={() => setDetail(isActive ? null : f)}
                    className={checked ? 'bg-brand/5' : isCurrent ? 'bg-brand/[0.03]' : isActive ? 'bg-surface-hover/60' : ''}>
                    <Td className="w-8 !py-1.5">
                      <input type="checkbox" className="accent-brand cursor-pointer align-middle" checked={checked}
                        onClick={e => e.stopPropagation()} onChange={() => setSelected(s => toggleRow(s, f))}
                        aria-label={`Select ${f.name}`} />
                    </Td>
                    <Td className="w-8 !py-1.5">
                      <button type="button" onClick={e => { e.stopPropagation(); playRow(f); }}
                        aria-label={isCurrent && isPlaying ? `Pause ${f.name}` : `Play ${f.name}`}
                        aria-pressed={isCurrent && isPlaying}
                        className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors
                          ${isCurrent ? 'bg-brand text-white' : 'bg-surface-hover border border-surface-border text-text-muted hover:text-brand'}`}>
                        {isCurrent && isPlaying ? <Pause size={11} /> : <Play size={11} className="translate-x-px" />}
                      </button>
                    </Td>
                    <Td className="!py-1.5">
                      <button type="button"
                        onClick={e => { e.stopPropagation(); setDetail(isActive ? null : f); }}
                        aria-label={`Show details for ${f.name}`}
                        aria-expanded={isActive}
                        className="text-left min-w-0 max-w-xs block">
                        <span className={`block text-xs font-semibold truncate ${isCurrent ? 'text-brand' : 'text-text-primary'}`}>{f.name}</span>
                        <span className="block text-[10px] text-text-muted tabular-nums truncate">
                          {[f.codec && f.codec.toUpperCase(),
                            f.sample_rate && `${(Number(f.sample_rate) / 1000).toFixed(1)}kHz`,
                            f.channels ? (Number(f.channels) === 1 ? 'Mono' : 'Stereo') : null,
                            ...(f.tags || []).slice(0, 3).map(t => `#${t}`)]
                            .filter(Boolean).join(' · ')}
                        </span>
                      </button>
                    </Td>
                    <Td className="max-md:hidden !py-1.5"><CategoryBadge category={f.category} /></Td>
                    <Td className="!py-1.5"><StatusBadge deployed={f.is_deployed} /></Td>
                    <Td className="max-sm:hidden tabular-nums text-xs !py-1.5 whitespace-nowrap">{f.duration_sec ? fmtDuration(f.duration_sec) : '—'}</Td>
                    <Td className="max-sm:hidden tabular-nums text-xs !py-1.5 whitespace-nowrap">{fmtSize(f.size_bytes)}</Td>
                    <Td className="max-lg:hidden text-xs text-text-muted !py-1.5 whitespace-nowrap">{fmtTime(f.created_at)}</Td>
                    <Td className="max-2xl:hidden text-xs text-text-muted !py-1.5 truncate max-w-[10rem]">{f.uploaded_by_email || '—'}</Td>
                    <Td className="!py-1.5">
                      <div className="flex items-center justify-end gap-1">
                        <button type="button"
                          onClick={e => { e.stopPropagation(); downloadMedia('media', f.id, f.name).catch(err => setResult({ label: 'Download', done: [], inUse: [], failed: [{ file: f, message: err.message }] })); }}
                          title="Download" aria-label={`Download ${f.name}`}
                          className={`${iconBtn} bg-surface-hover hover:text-brand`}>
                          <Download size={11} />
                        </button>
                        {canEdit && !f.is_deployed && (
                          <button type="button"
                            onClick={e => { e.stopPropagation(); handleDeploy(f.id); }}
                            disabled={deploying[f.id] || busy}
                            title="Deploy to SIPCommunication" aria-label={`Deploy ${f.name}`}
                            className={`${iconBtn} !border-green-500/20 bg-green-500/10 !text-green-500 hover:bg-green-500/20`}>
                            {deploying[f.id] ? <RefreshCw size={11} className="animate-spin" /> : <HardDrive size={11} />}
                          </button>
                        )}
                        {canEdit && (
                          <button type="button"
                            onClick={e => { e.stopPropagation(); setConfirm({ kind: 'delete', files: [f] }); }}
                            disabled={busy}
                            title="Delete" aria-label={`Delete ${f.name}`}
                            className={`${iconBtn} hover:text-red-400 hover:bg-red-500/10`}>
                            <Trash2 size={11} />
                          </button>
                        )}
                        <button type="button" onClick={e => { e.stopPropagation(); setDetail(f); }}
                          title="Details" aria-label={`Open details for ${f.name}`}
                          className={`${iconBtn} hover:text-brand`}>
                          <Info size={11} />
                        </button>
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
          <Pagination page={list.page} totalPages={pages} total={total} limit={list.limit}
            disabled={loading || busy} onPage={p => change({ page: p })} />
        </div>
      ) : null}

      {/* Docked player — persists across paging, sorting and filtering */}
      {nowPlaying && (
        <DockedPlayer
          ref={playerRef}
          file={nowPlaying}
          hasPrev={Boolean(prevFile)}
          hasNext={Boolean(nextFile)}
          onPrev={() => prevFile && setNowPlaying(prevFile)}
          onNext={() => nextFile && setNowPlaying(nextFile)}
          onClose={() => { setNowPlaying(null); setIsPlaying(false); }}
          onPlayingChange={setIsPlaying}
        />
      )}
    </div>
  );
}

export default function MediaLibrary() {
  return (
    <MediaLibraryBoundary>
      <MediaLibraryInner />
    </MediaLibraryBoundary>
  );
}
