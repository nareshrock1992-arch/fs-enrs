import { useEffect, useState, useCallback, useRef, Component } from 'react';
import {
  Library, Upload, Trash2, Play, Pause, CheckCircle,
  AlertCircle, Clock, Search, Tag, RefreshCw, HardDrive, X,
  Download, SkipBack, SkipForward, Volume2, VolumeX,
  Info, Radio, FileAudio, Layers, BarChart2, Eye
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

// ── Enterprise Audio Player ───────────────────────────────────────────────────

function AudioPlayer({ file, onClose }) {
  const [playing,  setPlaying]  = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentT, setCurrentT] = useState(0);
  const [duration, setDuration] = useState(Number(file.duration_sec) || 0);
  const [volume,   setVolume]   = useState(1);
  const [muted,    setMuted]    = useState(false);
  const [speed,    setSpeed]    = useState(1);
  const [peaks,    setPeaks]    = useState(file.waveform_peaks || null);
  const [loadErr,  setLoadErr]  = useState(null);
  const audioRef = useRef(null);

  // Load waveform if not already cached on the record
  useEffect(() => {
    if (!peaks) {
      api.mediaLibrary.waveform(file.id)
        .then(r => setPeaks(r.peaks?.length ? r.peaks : null))
        .catch(() => {});
    }
  }, [file.id]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      setLoadErr(null);
      a.play()
        .then(() => setPlaying(true))
        .catch(err => {
          setPlaying(false);
          setLoadErr('Playback failed — ' + (err.message || 'check browser permissions'));
        });
    }
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

  const fmtT = (s) => {
    if (!s && s !== 0) return '0:00';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-end sm:items-center justify-center p-4">
      <div className="bg-surface border border-surface-border rounded-2xl shadow-2xl w-full max-w-xl">
        {/* Header */}
        <div className="flex items-start gap-3 px-5 pt-5 pb-4 border-b border-surface-border/50">
          <div className="w-10 h-10 rounded-xl bg-brand/10 border border-brand/20
                          flex items-center justify-center shrink-0">
            <FileAudio size={16} className="text-brand" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-text-primary truncate">{file.name}</p>
            <div className="flex flex-wrap items-center gap-2 mt-0.5">
              <span className={`text-[9px] px-1.5 py-px rounded border font-medium
                ${CAT_COLORS[file.category] || CAT_COLORS.general}`}>
                {CAT_LABELS[file.category] || file.category}
              </span>
              {file.codec && <span className="text-[10px] text-text-muted font-mono">{file.codec}</span>}
              {file.sample_rate && <span className="text-[10px] text-text-muted">{(Number(file.sample_rate)/1000).toFixed(1)} kHz</span>}
              {file.channels && <span className="text-[10px] text-text-muted">{Number(file.channels) === 1 ? 'Mono' : 'Stereo'}</span>}
              {file.bitrate_kbps && <span className="text-[10px] text-text-muted">{file.bitrate_kbps} kbps</span>}
              <span className="text-[10px] text-text-muted">{fmtSize(file.size_bytes)}</span>
            </div>
          </div>
          <button onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors">
            <X size={15} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Waveform */}
          <div className="bg-surface-panel rounded-xl px-3 py-3 border border-surface-border/40">
            <WaveformCanvas
              peaks={peaks}
              progress={progress}
              duration={duration}
              onSeek={handleSeek}
              height={64}
            />
          </div>

          {/* Time + progress */}
          <div className="flex justify-between text-[10px] text-text-muted tabular-nums px-1">
            <span>{fmtT(currentT)}</span>
            <span className="text-text-muted/50">
              {duration ? fmtDuration(duration) : '—'}
            </span>
          </div>

          {/* Error */}
          {loadErr && (
            <div className="flex items-center gap-2 text-[10px] text-red-400 bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2">
              <AlertCircle size={11} className="shrink-0" />
              {loadErr}
            </div>
          )}

          {/* Playback controls */}
          <div className="flex items-center justify-center gap-5">
            <button onClick={() => skip(-10)}
              className="p-2 text-text-muted hover:text-text-primary transition-colors rounded-lg hover:bg-surface-hover">
              <SkipBack size={15} />
            </button>
            <button
              onClick={toggle}
              className="w-12 h-12 rounded-full bg-brand flex items-center justify-center
                         text-white hover:bg-brand/90 active:scale-95 transition-all shadow-lg shadow-brand/20">
              {playing ? <Pause size={20} /> : <Play size={20} className="translate-x-0.5" />}
            </button>
            <button onClick={() => skip(10)}
              className="p-2 text-text-muted hover:text-text-primary transition-colors rounded-lg hover:bg-surface-hover">
              <SkipForward size={15} />
            </button>
          </div>

          {/* Speed + Volume + Download */}
          <div className="flex items-center gap-3 flex-wrap">
            {/* Speed */}
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-text-muted uppercase tracking-wide mr-1">Speed</span>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map(s => (
                <button
                  key={s}
                  onClick={() => { setSpeed(s); if (audioRef.current) audioRef.current.playbackRate = s; }}
                  className={`text-[9px] px-1.5 py-0.5 rounded font-mono transition-colors
                    ${speed === s ? 'bg-brand text-white' : 'text-text-muted hover:text-text-primary hover:bg-surface-hover'}`}
                >
                  {s}×
                </button>
              ))}
            </div>

            {/* Volume */}
            <div className="flex items-center gap-1.5 ml-auto">
              <button
                onClick={() => setMuted(m => !m)}
                className="text-text-muted hover:text-text-primary transition-colors">
                {muted || volume === 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
              </button>
              <input
                type="range" min="0" max="1" step="0.05"
                value={muted ? 0 : volume}
                onChange={e => {
                  const v = +e.target.value;
                  setVolume(v);
                  setMuted(v === 0);
                  if (audioRef.current) audioRef.current.volume = v;
                }}
                className="w-20 accent-brand cursor-pointer"
              />
            </div>

            {/* Download */}
            <a
              href={api.mediaLibrary.downloadUrl(file.id)}
              download={file.name}
              className="flex items-center gap-1 text-[10px] px-3 py-1.5 rounded-lg
                         bg-surface-panel border border-surface-border text-text-muted
                         hover:text-brand hover:border-brand/30 transition-colors">
              <Download size={11} /> Download
            </a>
          </div>
        </div>

        {/* Description */}
        {file.description && (
          <div className="px-5 pb-4">
            <p className="text-[10px] text-text-muted bg-surface-panel rounded-lg px-3 py-2 border border-surface-border/30">
              {file.description}
            </p>
          </div>
        )}

        <audio
          ref={audioRef}
          src={api.mediaLibrary.streamUrl(file.id)}
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
            else if (file.duration_sec) setDuration(Number(file.duration_sec) || 0);
          }}
          onError={() => setLoadErr('Could not load audio file')}
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
  const [progress,    setProgress]    = useState(0);
  const dropRef = useRef(null);

  const handleFile = f => {
    if (!f) return;
    setFile(f);
    setName(f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
  };

  const handleDrop = (e) => {
    e.preventDefault();
    dropRef.current?.classList.remove('border-brand/50', 'bg-brand/5');
    handleFile(e.dataTransfer.files[0]);
  };

  const handleSubmit = async () => {
    if (!file) return setError('Select an audio file first');
    setUploading(true); setError(''); setWarn(''); setProgress(10);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', name.trim() || file.name);
      fd.append('category', category);
      if (description.trim()) fd.append('description', description.trim());
      setProgress(40);
      const result = await api.mediaLibrary.upload(fd);
      setProgress(100);
      if (result?.deployError) {
        setWarn(`Saved, but FreeSWITCH deploy failed: ${result.deployError}. Use Deploy button to retry.`);
        onSuccess();
        return;
      }
      onSuccess();
      onClose();
    } catch (e) {
      if (e.status === 409) setError('Duplicate file — identical content already exists in the library.');
      else setError(e.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-surface border border-surface-border rounded-2xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border">
          <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <Upload size={14} className="text-brand" /> Upload Media File
          </h2>
          <button onClick={onClose}
            className="p-1 rounded text-text-muted hover:text-text-primary transition-colors">
            <X size={15} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Drop zone */}
          <div
            ref={dropRef}
            onDrop={handleDrop}
            onDragOver={e => { e.preventDefault(); dropRef.current?.classList.add('border-brand/50', 'bg-brand/5'); }}
            onDragLeave={() => dropRef.current?.classList.remove('border-brand/50', 'bg-brand/5')}
            onClick={() => document.getElementById('ml-file-input').click()}
            className="border-2 border-dashed border-surface-border rounded-xl p-6 text-center
                       hover:border-brand/40 hover:bg-brand/3 transition-all cursor-pointer"
          >
            {file ? (
              <div className="flex items-center justify-center gap-3">
                <FileAudio size={20} className="text-brand" />
                <div className="text-left">
                  <p className="text-xs font-semibold text-brand">{file.name}</p>
                  <p className="text-[10px] text-text-muted">{fmtSize(file.size)}</p>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); setFile(null); setName(''); }}
                  className="ml-2 text-text-muted hover:text-red-400 transition-colors">
                  <X size={12} />
                </button>
              </div>
            ) : (
              <div>
                <FileAudio size={24} className="mx-auto text-text-muted mb-2" />
                <p className="text-xs text-text-muted font-medium">Drop audio file or click to browse</p>
                <p className="text-[10px] text-text-muted mt-1 opacity-60">WAV · MP3 · GSM · OGG · FLAC · ulaw</p>
              </div>
            )}
            <input id="ml-file-input" type="file"
              accept=".wav,.mp3,.ogg,.gsm,.flac,.ul,.alaw,.ulaw"
              className="hidden"
              onChange={e => handleFile(e.target.files[0])} />
          </div>

          {/* Name */}
          <div>
            <label className="block text-[10px] font-semibold text-text-muted uppercase tracking-wide mb-1">
              Display Name
            </label>
            <input value={name} onChange={e => setName(e.target.value)}
              placeholder="welcome_message"
              className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2
                         text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand transition-colors" />
          </div>

          {/* Category */}
          <div>
            <label className="block text-[10px] font-semibold text-text-muted uppercase tracking-wide mb-1">
              Category
            </label>
            <select value={category} onChange={e => setCategory(e.target.value)}
              className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2
                         text-xs text-text-primary focus:outline-none focus:border-brand transition-colors">
              {CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABELS[c]}</option>)}
            </select>
          </div>

          {/* Description */}
          <div>
            <label className="block text-[10px] font-semibold text-text-muted uppercase tracking-wide mb-1">
              Description <span className="font-normal text-text-muted/60">(optional)</span>
            </label>
            <textarea value={description} onChange={e => setDescription(e.target.value)}
              placeholder="What does this audio file say or do?" rows={2}
              className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2
                         text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand
                         resize-none transition-colors" />
          </div>

          {/* Progress */}
          {uploading && progress > 0 && (
            <div className="h-1.5 bg-surface-hover rounded-full overflow-hidden">
              <div className="h-full bg-brand rounded-full transition-all duration-300"
                   style={{ width: `${progress}%` }} />
            </div>
          )}

          {warn && (
            <div className="flex items-start gap-2 text-[10px] text-amber-500 bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2">
              <AlertCircle size={11} className="mt-0.5 shrink-0" /> {warn}
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 text-[10px] text-red-400 bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2">
              <AlertCircle size={11} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-surface-border flex gap-2 justify-end">
          <button onClick={onClose}
            className="text-xs px-4 py-2 rounded-lg border border-surface-border text-text-muted
                       hover:text-text-primary hover:bg-surface-hover transition-colors">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={!file || uploading}
            className="text-xs px-5 py-2 rounded-lg bg-brand text-white hover:bg-brand/90
                       disabled:opacity-50 transition-colors flex items-center gap-1.5 font-medium">
            {uploading
              ? <><RefreshCw size={11} className="animate-spin" /> Uploading…</>
              : <><Upload size={11} /> Upload File</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── File Detail Sidebar ───────────────────────────────────────────────────────

function FileDetail({ file, onClose, onDeploy, onDelete, onPlay, deploying, deleting, canEdit }) {
  return (
    <div className="fixed inset-y-0 right-0 z-40 w-80 bg-surface border-l border-surface-border shadow-2xl flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-surface-border shrink-0">
        <FileAudio size={14} className="text-brand" />
        <span className="text-sm font-bold text-text-primary flex-1 truncate">{file.name}</span>
        <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Actions */}
        <div className="flex gap-2 flex-wrap">
          <button onClick={onPlay}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-brand text-white
                       hover:bg-brand/90 transition-colors font-medium">
            <Play size={11} /> Play
          </button>
          <a href={api.mediaLibrary.downloadUrl(file.id)} download={file.name}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-surface-hover
                       border border-surface-border text-text-muted hover:text-brand transition-colors">
            <Download size={11} /> Download
          </a>
          {canEdit && !file.is_deployed && (
            <button onClick={onDeploy} disabled={deploying}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg
                         bg-green-500/10 text-green-500 border border-green-500/20
                         hover:bg-green-500/20 disabled:opacity-50 transition-colors">
              {deploying ? <RefreshCw size={10} className="animate-spin" /> : <HardDrive size={10} />}
              Deploy
            </button>
          )}
          {canEdit && file.is_deployed && (
            <button onClick={onDeploy} disabled={deploying}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg
                         bg-surface-hover border border-surface-border text-text-muted
                         hover:text-green-500 disabled:opacity-50 transition-colors">
              <RefreshCw size={10} className={deploying ? 'animate-spin' : ''} /> Re-deploy
            </button>
          )}
          {canEdit && (
            <button onClick={onDelete} disabled={deleting}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg
                         border border-red-500/20 text-red-500 hover:bg-red-500/10
                         disabled:opacity-50 transition-colors ml-auto">
              <Trash2 size={10} /> Delete
            </button>
          )}
        </div>

        {/* Deployment Status */}
        <div className="card !p-3 space-y-2">
          <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Deployment</p>
          <div className="flex items-center gap-2">
            {file.is_deployed ? (
              <>
                <span className="w-2 h-2 rounded-full bg-green-500" />
                <span className="text-[11px] text-green-500 font-semibold">Deployed to FreeSWITCH</span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                <span className="text-[11px] text-amber-500 font-semibold">Pending deployment</span>
              </>
            )}
          </div>
          {file.deployed_at && (
            <p className="text-[10px] text-text-muted">
              Deployed: {fmtTime(file.deployed_at)}
            </p>
          )}
          {file.fs_path && (
            <p className="text-[9px] font-mono text-text-muted break-all opacity-70">{file.fs_path}</p>
          )}
        </div>

        {/* Metadata */}
        <div className="card !p-3 space-y-2">
          <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Audio Metadata</p>
          {[
            ['Codec',       file.codec || '—'],
            ['Sample Rate', file.sample_rate ? `${(Number(file.sample_rate)/1000).toFixed(1)} kHz` : '—'],
            ['Channels',    file.channels ? (Number(file.channels) === 1 ? 'Mono' : 'Stereo') : '—'],
            ['Bitrate',     file.bitrate_kbps ? `${file.bitrate_kbps} kbps` : '—'],
            ['Duration',    fmtDuration(file.duration_sec) || '—'],
            ['File Size',   fmtSize(file.size_bytes)],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between">
              <span className="text-[10px] text-text-muted">{k}</span>
              <span className="text-[10px] font-medium text-text-primary font-mono">{v}</span>
            </div>
          ))}
        </div>

        {/* Library info */}
        <div className="card !p-3 space-y-2">
          <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Library Info</p>
          {[
            ['Uploaded',   fmtTime(file.created_at)],
            ['Modified',   fmtTime(file.updated_at)],
            ['By',         file.uploaded_by_email || '—'],
            ['Org',        file.organization_name || '—'],
            ['Uses',       file.usage_count ?? 0],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between">
              <span className="text-[10px] text-text-muted">{k}</span>
              <span className="text-[10px] font-medium text-text-primary">{v}</span>
            </div>
          ))}
        </div>

        {/* Description */}
        {file.description && (
          <div className="card !p-3">
            <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted mb-1.5">Description</p>
            <p className="text-[10px] text-text-secondary leading-relaxed">{file.description}</p>
          </div>
        )}

        {/* Checksum */}
        {file.checksum && (
          <div className="card !p-3">
            <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted mb-1">SHA-256</p>
            <p className="text-[9px] font-mono text-text-muted break-all opacity-60">{file.checksum}</p>
          </div>
        )}
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

function MediaLibraryInner() {
  const [files,      setFiles]      = useState([]);
  const [total,      setTotal]      = useState(0);
  const [categories, setCategories] = useState([]);
  const [search,     setSearch]     = useState('');
  const [catFilter,  setCatFilter]  = useState('');
  const [loading,    setLoading]    = useState(true);
  const [loadError,  setLoadError]  = useState(null);
  const [scanning,   setScanning]   = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [player,     setPlayer]     = useState(null);
  const [detail,     setDetail]     = useState(null);
  const [deploying,  setDeploying]  = useState({});
  const [deleting,   setDeleting]   = useState({});

  const user    = useAuthStore(s => s.user);
  const canEdit = user?.role === 'ADMIN' || user?.role === 'SUPERVISOR';

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [filesRes, catRes] = await Promise.all([
        api.mediaLibrary.list({
          search:   search   || undefined,
          category: catFilter || undefined,
          limit: 200,
        }),
        api.mediaLibrary.categories(),
      ]);
      setFiles(filesRes.files || []);
      setTotal(filesRes.total || 0);
      setCategories(catRes.categories || []);
    } catch (e) {
      console.error(e);
      setLoadError(e.message || 'Failed to load media library');
    } finally {
      setLoading(false);
    }
  }, [search, catFilter]);

  useEffect(() => { load(); }, [load]);

  const handleScan = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const result = await api.mediaLibrary.scan();
      setScanResult(result);
      if (result.imported > 0) load();
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
      alert('Deploy failed: ' + e.message);
    } finally {
      setDeploying(d => ({ ...d, [id]: false }));
    }
  };

  const handleDelete = async (file) => {
    if (!window.confirm(`Delete "${file.name}"? This cannot be undone.`)) return;
    setDeleting(d => ({ ...d, [file.id]: true }));
    try {
      await api.mediaLibrary.remove(file.id);
      if (detail?.id === file.id) setDetail(null);
      load();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    } finally {
      setDeleting(d => ({ ...d, [file.id]: false }));
    }
  };

  // Stats
  const deployed = files.filter(f => f.is_deployed).length;
  const pending  = files.filter(f => !f.is_deployed).length;

  return (
    <div className="space-y-5 relative">
      {player && <AudioPlayer file={player} onClose={() => setPlayer(null)} />}
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} onSuccess={load} />}
      {detail && (
        <FileDetail
          file={detail}
          canEdit={canEdit}
          deploying={!!deploying[detail.id]}
          deleting={!!deleting[detail.id]}
          onClose={() => setDetail(null)}
          onPlay={() => { setPlayer(detail); }}
          onDeploy={() => handleDeploy(detail.id)}
          onDelete={() => handleDelete(detail)}
        />
      )}

      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-brand/10 border border-brand/20
                        flex items-center justify-center shrink-0">
          <Library size={18} className="text-brand" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-text-primary">Media Library</h1>
          <p className="text-xs text-text-muted">
            {total} file{total !== 1 ? 's' : ''} · {deployed} deployed · {pending} pending
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <button onClick={handleScan} disabled={scanning}
              className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg
                         bg-surface border border-surface-border text-text-muted
                         hover:text-text-primary hover:border-primary/30 font-medium
                         transition-colors disabled:opacity-50">
              <HardDrive size={13} className={scanning ? 'animate-pulse text-brand' : ''} />
              {scanning ? 'Scanning…' : 'Scan FS'}
            </button>
          )}
          {canEdit && (
            <button onClick={() => setShowUpload(true)}
              className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg
                         bg-brand text-white hover:bg-brand/90 font-medium transition-colors">
              <Upload size={13} /> Upload
            </button>
          )}
        </div>
      </div>

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
          <button onClick={() => setScanResult(null)} className="opacity-50 hover:opacity-100 transition-opacity">
            <X size={12} />
          </button>
        </div>
      )}

      {/* API error banner */}
      {loadError && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-xl border text-[11px]
                        bg-red-500/5 border-red-500/20 text-red-400">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span className="flex-1">Failed to load: {loadError}</span>
          <button onClick={load} className="underline opacity-70 hover:opacity-100 transition-opacity">
            Retry
          </button>
        </div>
      )}

      {/* Stats row */}
      {!loading && total > 0 && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Total Files', value: total,    icon: Library,   color: 'text-brand' },
            { label: 'Deployed',    value: deployed,  icon: CheckCircle, color: 'text-green-500' },
            { label: 'Pending',     value: pending,   icon: Clock,     color: 'text-amber-500' },
            { label: 'Categories',  value: categories.length, icon: Tag, color: 'text-purple-400' },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label} className="card !p-3 flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg bg-surface-hover flex items-center justify-center shrink-0`}>
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

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, description or tag…"
            className="w-full pl-8 pr-3 py-2 bg-surface border border-surface-border rounded-lg
                       text-xs text-text-primary placeholder:text-text-muted focus:outline-none
                       focus:border-brand transition-colors"
          />
        </div>
        <select
          value={catFilter}
          onChange={e => setCatFilter(e.target.value)}
          className="bg-surface border border-surface-border rounded-lg px-2.5 py-2 text-xs
                     text-text-primary focus:outline-none focus:border-brand transition-colors">
          <option value="">All categories</option>
          {categories.map(c => <option key={c} value={c}>{CAT_LABELS[c] || c}</option>)}
        </select>
        <button onClick={load}
          className="p-2 text-text-muted hover:text-brand transition-colors rounded-lg hover:bg-surface-hover"
          title="Refresh">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* File list */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-16 rounded-xl bg-surface-hover animate-pulse" />
          ))}
        </div>
      ) : files.length === 0 ? (
        <div className="card text-center py-16">
          <Library size={36} className="mx-auto text-text-muted/20 mb-3" />
          <p className="text-sm font-semibold text-text-secondary">No media files</p>
          <p className="text-xs text-text-muted mt-1">
            {search || catFilter ? 'No results match your filter' : 'Upload or scan FreeSWITCH to import files'}
          </p>
          {canEdit && !search && !catFilter && (
            <div className="mt-4 flex items-center justify-center gap-3">
              <button onClick={handleScan} disabled={scanning}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg
                           bg-surface border border-surface-border text-text-muted
                           hover:text-brand hover:border-brand/30 transition-colors">
                <HardDrive size={12} /> {scanning ? 'Scanning…' : 'Scan FreeSWITCH'}
              </button>
              <button onClick={() => setShowUpload(true)}
                className="text-xs text-brand hover:underline font-medium">
                Upload a file
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-1.5">
          {files.map(f => {
            const isActive = detail?.id === f.id;
            return (
              <div
                key={f.id}
                onClick={() => setDetail(isActive ? null : f)}
                className={[
                  'group flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-all',
                  isActive
                    ? 'border-brand/40 bg-brand/5 shadow-sm'
                    : 'border-surface-border bg-surface hover:border-surface-hover hover:bg-surface-hover/50',
                ].join(' ')}
              >
                {/* Icon */}
                <div className="w-9 h-9 rounded-xl bg-brand/10 border border-brand/15
                                flex items-center justify-center shrink-0">
                  <FileAudio size={14} className="text-brand" />
                </div>

                {/* Main info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-text-primary truncate max-w-xs">
                      {f.name}
                    </span>
                    {f.is_deployed ? (
                      <span className="flex items-center gap-1 text-[9px] px-1.5 py-px rounded-full
                                       bg-green-500/12 text-green-500 border border-green-500/20 font-bold">
                        <CheckCircle size={7} /> Deployed
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-[9px] px-1.5 py-px rounded-full
                                       bg-amber-500/12 text-amber-500 border border-amber-500/20 font-bold">
                        <Clock size={7} /> Pending
                      </span>
                    )}
                    {f.category && (
                      <span className={`text-[9px] px-1.5 py-px rounded border font-medium
                        ${CAT_COLORS[f.category] || CAT_COLORS.general}`}>
                        {CAT_LABELS[f.category] || f.category}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-[10px] text-text-muted tabular-nums flex-wrap">
                    {f.codec && <span className="uppercase font-mono">{f.codec}</span>}
                    {f.sample_rate && <span>{(Number(f.sample_rate)/1000).toFixed(1)}kHz</span>}
                    {f.channels ? <span>{Number(f.channels) === 1 ? 'Mono' : 'Stereo'}</span> : null}
                    {f.duration_sec ? <span>{fmtDuration(f.duration_sec)}</span> : null}
                    <span>{fmtSize(f.size_bytes)}</span>
                    <span className="hidden sm:inline">{fmtTime(f.created_at)}</span>
                  </div>
                </div>

                {/* Quick actions */}
                <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={e => { e.stopPropagation(); setPlayer(f); }}
                    title="Play"
                    className="p-1.5 rounded-lg bg-surface-hover border border-surface-border
                               text-text-muted hover:text-brand transition-colors">
                    <Play size={11} />
                  </button>
                  <a
                    href={api.mediaLibrary.downloadUrl(f.id)}
                    download={f.name}
                    onClick={e => e.stopPropagation()}
                    title="Download"
                    className="p-1.5 rounded-lg bg-surface-hover border border-surface-border
                               text-text-muted hover:text-brand transition-colors">
                    <Download size={11} />
                  </a>
                  {canEdit && !f.is_deployed && (
                    <button
                      onClick={e => { e.stopPropagation(); handleDeploy(f.id); }}
                      disabled={deploying[f.id]}
                      title="Deploy to FreeSWITCH"
                      className="p-1.5 rounded-lg bg-green-500/10 border border-green-500/20
                                 text-green-500 hover:bg-green-500/20 disabled:opacity-50 transition-colors">
                      {deploying[f.id]
                        ? <RefreshCw size={11} className="animate-spin" />
                        : <HardDrive size={11} />}
                    </button>
                  )}
                  {canEdit && (
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(f); }}
                      disabled={deleting[f.id]}
                      title="Delete"
                      className="p-1.5 rounded-lg text-text-muted hover:text-red-400
                                 hover:bg-red-500/10 disabled:opacity-50 transition-colors">
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>

                {/* Detail chevron */}
                <Eye size={12} className={`shrink-0 transition-colors ${isActive ? 'text-brand' : 'text-text-muted/30 group-hover:text-text-muted'}`} />
              </div>
            );
          })}
        </div>
      )}

      {/* Sidebar spacer when detail panel is open */}
      {detail && <div className="h-1" />}
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
