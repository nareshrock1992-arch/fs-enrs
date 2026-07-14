import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Music, Upload, Trash2, Play, Square, CheckCircle, AlertCircle,
  Clock, Search, Tag, RefreshCw, HardDrive, X
} from 'lucide-react';
import { api } from '../../api/client.js';
import { useAuthStore } from '../../store/authStore.js';

const CATEGORIES = ['general', 'greeting', 'menu', 'instruction', 'confirmation', 'error', 'music', 'other'];

function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Audio Player ──────────────────────────────────────────────────────────────

function AudioPlayer({ fileId, name }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);

  const toggle = () => {
    if (!audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setPlaying(false);
    } else {
      audioRef.current.play().catch(() => setPlaying(false));
      setPlaying(true);
    }
  };

  return (
    <>
      <audio
        ref={audioRef}
        src={`/api/v1/deployment/audio/${fileId}/stream`}
        onEnded={() => setPlaying(false)}
        preload="none"
      />
      <button
        onClick={toggle}
        title={playing ? 'Stop' : 'Preview'}
        className={`p-1.5 rounded-lg text-xs transition-colors ${
          playing
            ? 'bg-green-500/20 text-green-400 border border-green-500/30'
            : 'bg-surface-hover text-text-muted hover:text-brand border border-surface-border'
        }`}
      >
        {playing ? <Square size={12} /> : <Play size={12} />}
      </button>
    </>
  );
}

// ── Deployment Badge ──────────────────────────────────────────────────────────

function DeployBadge({ isDeployed, deployedAt }) {
  if (isDeployed) {
    return (
      <span className="flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-full
                       bg-green-500/15 text-green-500 border border-green-500/20 font-medium">
        <CheckCircle size={9} /> Deployed
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-full
                     bg-amber-500/15 text-amber-500 border border-amber-500/20 font-medium">
      <Clock size={9} /> Pending
    </span>
  );
}

// ── Upload Modal ──────────────────────────────────────────────────────────────

function UploadModal({ onClose, onSuccess }) {
  const [file,       setFile]       = useState(null);
  const [name,       setName]       = useState('');
  const [category,   setCategory]   = useState('general');
  const [description,setDescription]= useState('');
  const [uploading,  setUploading]  = useState(false);
  const [error,      setError]      = useState('');
  const dropRef = useRef(null);

  const handleDrop = e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) { setFile(f); setName(f.name); }
  };

  const handleSubmit = async () => {
    if (!file) return setError('Please select an audio file');
    setUploading(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', name || file.name);
      fd.append('category', category);
      fd.append('description', description);
      const result = await api.deployment.uploadAudio(fd);
      // 207 = file saved but FS copy failed — surface the deploy error
      if (result?.deployError) {
        setError(`Saved to database, but FreeSWITCH deploy failed: ${result.deployError}. Use the Deploy button to retry.`);
        onSuccess(); // still refresh the list
        // keep modal open so user sees the warning
        return;
      }
      onSuccess();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-surface border border-surface-border rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border">
          <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <Upload size={15} className="text-brand" /> Upload Audio File
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Drop zone */}
          <div
            ref={dropRef}
            onDrop={handleDrop}
            onDragOver={e => e.preventDefault()}
            className="border-2 border-dashed border-surface-border rounded-lg p-6 text-center
                       hover:border-brand/50 transition-colors cursor-pointer"
            onClick={() => document.getElementById('audio-file-input').click()}
          >
            <Music size={24} className="mx-auto text-text-muted mb-2" />
            {file ? (
              <p className="text-xs font-medium text-brand">{file.name} ({fmtSize(file.size)})</p>
            ) : (
              <>
                <p className="text-xs text-text-muted">Drop audio file here or click to browse</p>
                <p className="text-[10px] text-text-muted mt-1 opacity-60">WAV · MP3 · OGG · GSM · UL</p>
              </>
            )}
            <input
              id="audio-file-input"
              type="file"
              accept=".wav,.mp3,.ogg,.gsm,.ul"
              className="hidden"
              onChange={e => {
                const f = e.target.files[0];
                if (f) { setFile(f); setName(f.name); }
              }}
            />
          </div>

          <div>
            <label className="block text-[10px] font-medium text-text-muted uppercase tracking-wide mb-1">
              Display Name
            </label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="welcome_message.wav"
              className="w-full bg-surface border border-surface-border rounded-lg px-3 py-1.5
                         text-xs text-text-primary focus:outline-none focus:border-brand"
            />
          </div>

          <div>
            <label className="block text-[10px] font-medium text-text-muted uppercase tracking-wide mb-1">
              Category
            </label>
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              className="w-full bg-surface border border-surface-border rounded-lg px-3 py-1.5
                         text-xs text-text-primary focus:outline-none focus:border-brand"
            >
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-medium text-text-muted uppercase tracking-wide mb-1">
              Description (optional)
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What does this audio prompt say?"
              rows={2}
              className="w-full bg-surface border border-surface-border rounded-lg px-3 py-1.5
                         text-xs text-text-primary focus:outline-none focus:border-brand resize-none"
            />
          </div>

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
          <button
            onClick={handleSubmit}
            disabled={!file || uploading}
            className="text-xs px-5 py-2 rounded-lg bg-brand text-white hover:bg-brand/90 disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {uploading ? <><RefreshCw size={11} className="animate-spin" /> Uploading…</> : <><Upload size={11} /> Upload</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AudioLibrary() {
  const [files,      setFiles]      = useState([]);
  const [total,      setTotal]      = useState(0);
  const [categories, setCategories] = useState([]);
  const [search,     setSearch]     = useState('');
  const [catFilter,  setCatFilter]  = useState('');
  const [loading,    setLoading]    = useState(true);
  const [scanning,   setScanning]   = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [deploying,  setDeploying]  = useState({});
  const [deleting,   setDeleting]   = useState({});

  const user    = useAuthStore(s => s.user);
  const canEdit = user?.role === 'ADMIN' || user?.role === 'SUPERVISOR';

  const load = useCallback(async (triggerScanIfEmpty = false) => {
    setLoading(true);
    try {
      const [filesRes, catRes] = await Promise.all([
        api.deployment.listAudio({ search: search || undefined, category: catFilter || undefined }),
        api.deployment.listCategories(),
      ]);
      const fetched = filesRes.files || [];
      setFiles(fetched);
      setTotal(filesRes.total || 0);
      setCategories(catRes.categories || []);

      // Auto-scan when there are no files on first load
      if (triggerScanIfEmpty && fetched.length === 0 && canEdit) {
        handleScan(true);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, catFilter, canEdit]);

  useEffect(() => { load(true); }, [load]);

  const handleScan = useCallback(async (silent = false) => {
    setScanning(true);
    if (!silent) setScanResult(null);
    try {
      const result = await api.deployment.scanAudio();
      setScanResult(result);
      if (result.imported > 0) {
        // Reload the list to show newly imported files
        const filesRes = await api.deployment.listAudio({ search: search || undefined, category: catFilter || undefined });
        setFiles(filesRes.files || []);
        setTotal(filesRes.total || 0);
      }
    } catch (e) {
      if (!silent) setScanResult({ message: 'Scan failed: ' + e.message, imported: 0, skipped: 0, errors: 1 });
    } finally {
      setScanning(false);
    }
  }, [search, catFilter]);

  const handleDeploy = async (id) => {
    setDeploying(d => ({ ...d, [id]: true }));
    try {
      await api.deployment.deployAudio(id);
      load();
    } catch (e) {
      alert('Deploy failed: ' + e.message);
    } finally {
      setDeploying(d => ({ ...d, [id]: false }));
    }
  };

  const handleDelete = async (file) => {
    if (!window.confirm(`Delete "${file.name}"?`)) return;
    setDeleting(d => ({ ...d, [file.id]: true }));
    try {
      await api.deployment.deleteAudio(file.id);
      load();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    } finally {
      setDeleting(d => ({ ...d, [file.id]: false }));
    }
  };

  return (
    <div className="space-y-5">
      {showUpload && (
        <UploadModal onClose={() => setShowUpload(false)} onSuccess={load} />
      )}

      {/* Header */}
      <div className="flex items-center gap-3">
        <Music size={20} className="text-brand" />
        <div className="flex-1">
          <h1 className="text-xl font-bold text-text-primary">Audio Library</h1>
          <p className="text-xs text-text-muted">{total} file{total !== 1 ? 's' : ''} — audio deployed to FreeSWITCH sound directory</p>
        </div>
        {canEdit && (
          <button
            onClick={() => handleScan()}
            disabled={scanning}
            title="Scan FreeSWITCH sound directory for existing files"
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg
                       bg-surface border border-surface-border text-text-muted
                       hover:text-brand hover:border-brand/50 font-medium transition-colors disabled:opacity-50"
          >
            <HardDrive size={14} className={scanning ? 'animate-pulse' : ''} />
            {scanning ? 'Scanning…' : 'Scan FS'}
          </button>
        )}
        {canEdit && (
          <button
            onClick={() => setShowUpload(true)}
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg
                       bg-brand text-white hover:bg-brand/90 font-medium transition-colors"
          >
            <Upload size={14} /> Upload
          </button>
        )}
      </div>

      {/* Scan result banner */}
      {scanResult && (
        <div className={`px-4 py-3 rounded-lg border text-[11px] flex items-start gap-2
          ${scanResult.errors > 0 || scanResult.imported === 0
            ? 'bg-amber-500/5 border-amber-500/20 text-amber-600 dark:text-amber-400'
            : 'bg-green-500/5 border-green-500/20 text-green-600 dark:text-green-400'}`}>
          {scanResult.errors > 0
            ? <AlertCircle size={13} className="mt-0.5 shrink-0" />
            : <CheckCircle size={13} className="mt-0.5 shrink-0" />}
          <span className="flex-1">{scanResult.message}</span>
          <button onClick={() => setScanResult(null)} className="opacity-50 hover:opacity-100">
            <X size={12} />
          </button>
        </div>
      )}

      {/* Info banner */}
      <div className="px-4 py-3 rounded-lg bg-brand/5 border border-brand/20 text-[11px] text-text-muted leading-relaxed">
        Audio files uploaded here are automatically copied to{' '}
        <code className="font-mono text-brand">$FS_SOUND_DIR/enrs/</code> on FreeSWITCH.
        Reference them in IVR nodes as{' '}
        <code className="font-mono text-brand">/media/filename.wav</code>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search files…"
            className="w-full pl-8 pr-3 py-2 bg-surface border border-surface-border rounded-lg
                       text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand"
          />
        </div>
        <div className="flex items-center gap-2">
          <Tag size={12} className="text-text-muted" />
          <select
            value={catFilter}
            onChange={e => setCatFilter(e.target.value)}
            className="bg-surface border border-surface-border rounded-lg px-2.5 py-2 text-xs text-text-primary focus:outline-none focus:border-brand"
          >
            <option value="">All categories</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
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
          <Music size={32} className="mx-auto text-text-muted mb-3" />
          <p className="text-sm text-text-muted">No audio files found in database</p>
          {canEdit && (
            <div className="mt-4 flex items-center justify-center gap-3">
              <button
                onClick={() => handleScan()}
                disabled={scanning}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg
                           bg-surface border border-surface-border text-text-muted
                           hover:text-brand hover:border-brand/50 transition-colors"
              >
                <HardDrive size={12} /> {scanning ? 'Scanning…' : 'Scan FreeSWITCH sound dir'}
              </button>
              <button onClick={() => setShowUpload(true)}
                      className="text-xs text-brand hover:underline">
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
              {/* Icon */}
              <div className="w-9 h-9 rounded-lg bg-brand/10 border border-brand/20
                              flex items-center justify-center shrink-0">
                <Music size={15} className="text-brand" />
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-text-primary truncate">{f.name}</p>
                  <DeployBadge isDeployed={f.is_deployed} deployedAt={f.deployed_at} />
                  {f.category && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-surface-hover border border-surface-border text-text-muted">
                      {f.category}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-[10px] text-text-muted">
                  <span>{fmtSize(f.size_bytes)}</span>
                  {f.fs_path ? (
                    <span className="flex items-center gap-1">
                      <HardDrive size={9} />
                      <code className="font-mono text-[9px] opacity-70">
                        /media/{f.fs_path.split('/').pop()}
                      </code>
                    </span>
                  ) : null}
                  <span>Uploaded {fmtTime(f.created_at)}</span>
                </div>
                {f.description && (
                  <p className="text-[10px] text-text-muted mt-0.5 truncate">{f.description}</p>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 shrink-0">
                <AudioPlayer fileId={f.id} name={f.name} />

                {canEdit && !f.is_deployed && (
                  <button
                    onClick={() => handleDeploy(f.id)}
                    disabled={deploying[f.id]}
                    title="Deploy to FreeSWITCH"
                    className="flex items-center gap-1 text-[10px] px-2 py-1.5 rounded-lg
                               bg-green-500/10 text-green-500 border border-green-500/20
                               hover:bg-green-500/20 disabled:opacity-50 transition-colors"
                  >
                    {deploying[f.id]
                      ? <RefreshCw size={10} className="animate-spin" />
                      : <HardDrive size={10} />}
                    Deploy
                  </button>
                )}
                {canEdit && f.is_deployed && (
                  <button
                    onClick={() => handleDeploy(f.id)}
                    disabled={deploying[f.id]}
                    title="Re-deploy to FreeSWITCH"
                    className="p-1.5 text-text-muted hover:text-green-500 transition-colors"
                  >
                    <RefreshCw size={12} />
                  </button>
                )}
                {canEdit && (
                  <button
                    onClick={() => handleDelete(f)}
                    disabled={deleting[f.id]}
                    className="p-1.5 text-text-muted hover:text-red-400 transition-colors"
                    title="Delete"
                  >
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
