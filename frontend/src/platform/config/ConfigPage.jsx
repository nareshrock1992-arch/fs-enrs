import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Search, RotateCcw, History, ShieldCheck,
  ChevronDown, ChevronRight, Loader2, AlertCircle
} from 'lucide-react';
import { useConfigProvider } from './hooks/useConfigProvider.js';
import { useDeployment } from './hooks/useDeployment.js';
import ConfigCard from './ConfigCard.jsx';
import ConfigHistory from './ConfigHistory.jsx';
import ConfigAudit from './ConfigAudit.jsx';
import DeployModal from './DeployModal.jsx';

/**
 * ConfigPage — shared template for all configuration provider pages.
 *
 * Usage:
 *   <ConfigPage
 *     providerId="vars"
 *     title="System Variables"
 *     subtitle="vars.xml — Global FreeSWITCH variables"
 *   />
 *
 * Handles: read, search, category filter, change tracking,
 * dirty indicator, preview, deploy, history, audit, rollback.
 */
export default function ConfigPage({ providerId, title, subtitle }) {
  const { entries, loading, error, load, filePath, parsedAt } = useConfigProvider(providerId);
  const { preview, previewing, deploying, result, error: deployError,
          fetchPreview, deploy, clearResult } = useDeployment(providerId);

  // ── Local change tracking ───────────────────────────────────────────────────
  // Map<key → change object> for O(1) dirty check and change building.
  const [pending, setPending]     = useState(new Map());
  const [search,  setSearch]      = useState('');
  const [category, setCategory]   = useState('All');
  const [panel,   setPanel]       = useState(null); // 'history' | 'audit' | null
  const [showDeploy, setShowDeploy] = useState(false);

  useEffect(() => { load(); }, [load]);

  // Reset pending changes when we reload from server (e.g. after rollback).
  const reload = useCallback(async () => {
    setPending(new Map());
    clearResult();
    await load();
  }, [load, clearResult]);

  // ── Change handler ──────────────────────────────────────────────────────────
  const handleChange = useCallback((change) => {
    setPending(prev => {
      const next = new Map(prev);
      next.set(change.key, change);
      return next;
    });
  }, []);

  const revertKey = useCallback((key) => {
    setPending(prev => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const categories = useMemo(() => {
    const cats = ['All', ...new Set(entries.map(e => e.category).filter(Boolean))];
    return cats;
  }, [entries]);

  const filtered = useMemo(() => {
    return entries.filter(e => {
      const matchCat  = category === 'All' || e.category === category;
      const q         = search.toLowerCase();
      const matchText = !q ||
        e.key.toLowerCase().includes(q) ||
        (e.label ?? '').toLowerCase().includes(q) ||
        (e.description ?? '').toLowerCase().includes(q);
      return matchCat && matchText;
    });
  }, [entries, search, category]);

  const changes = useMemo(() => [...pending.values()], [pending]);
  const isDirty = changes.length > 0;

  // ── Deploy flow ─────────────────────────────────────────────────────────────
  const handlePreviewDeploy = async () => {
    const p = await fetchPreview(changes);
    if (p) setShowDeploy(true);
  };

  const handleDeployConfirm = async (reason) => {
    const res = await deploy(changes, reason);
    if (res?.success) await reload();
  };

  const handleDeployClose = () => {
    setShowDeploy(false);
    clearResult();
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-text-muted gap-2">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Loading configuration…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800
                      bg-red-50 dark:bg-red-950 p-6 flex gap-3 items-start">
        <AlertCircle size={18} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-red-700 dark:text-red-300">
            Could not load configuration
          </p>
          <p className="text-xs text-red-600 dark:text-red-400 mt-1">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-start gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-text-primary">{title}</h1>
          <p className="text-xs text-text-muted mt-0.5">{subtitle ?? filePath}</p>
          {parsedAt && (
            <p className="text-[11px] text-text-muted mt-0.5">
              Read at {new Date(parsedAt).toLocaleTimeString()}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Unsaved indicator */}
          {isDirty && (
            <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400
                           bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800
                           rounded-lg px-3 py-1.5 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              {changes.length} unsaved {changes.length === 1 ? 'change' : 'changes'}
            </div>
          )}

          <button onClick={() => setPanel(p => p === 'audit' ? null : 'audit')}
            className={`btn-ghost flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg
              ${panel === 'audit' ? 'bg-surface-border' : ''}`}>
            <ShieldCheck size={14} />
            Audit
          </button>

          <button onClick={() => setPanel(p => p === 'history' ? null : 'history')}
            className={`btn-ghost flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg
              ${panel === 'history' ? 'bg-surface-border' : ''}`}>
            <History size={14} />
            History
          </button>

          <button
            onClick={handlePreviewDeploy}
            disabled={!isDirty || previewing || deploying}
            className="bg-brand text-white text-sm font-semibold px-4 py-1.5 rounded-lg
                       hover:bg-brand/90 transition-colors disabled:opacity-40
                       disabled:cursor-not-allowed flex items-center gap-2">
            {previewing && <Loader2 size={13} className="animate-spin" />}
            Deploy
          </button>
        </div>
      </div>

      {/* Preview / deploy error banner — shown when the modal is not open */}
      {deployError && !showDeploy && (
        <div className="rounded-xl border border-red-200 dark:border-red-800
                        bg-red-50 dark:bg-red-950 p-4 flex gap-3 items-start">
          <AlertCircle size={16} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-700 dark:text-red-300">
              Deploy failed
            </p>
            <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">{deployError}</p>
          </div>
        </div>
      )}

      {/* Side panels */}
      {panel === 'history' && (
        <div className="card">
          <h2 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
            <History size={14} />
            Version History
          </h2>
          <ConfigHistory
            providerId={providerId}
            onRollbackSuccess={reload}
          />
        </div>
      )}

      {panel === 'audit' && (
        <div className="card">
          <h2 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
            <ShieldCheck size={14} />
            Audit Log
          </h2>
          <ConfigAudit providerId={providerId} />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            placeholder="Search variables…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full rounded-lg border border-surface-border bg-surface-panel
                       pl-8 pr-3 py-2 text-sm text-text-primary placeholder-text-muted
                       focus:outline-none focus:ring-2 focus:ring-brand/50"
          />
        </div>
        <select
          value={category}
          onChange={e => setCategory(e.target.value)}
          className="rounded-lg border border-surface-border bg-surface-panel
                     px-3 py-2 text-sm text-text-primary
                     focus:outline-none focus:ring-2 focus:ring-brand/50">
          {categories.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        {isDirty && (
          <button onClick={() => setPending(new Map())}
            className="btn-ghost flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg text-red-600 dark:text-red-400">
            <RotateCcw size={13} />
            Discard
          </button>
        )}
      </div>

      {/* Variable list */}
      {filtered.length === 0 ? (
        <p className="text-sm text-text-muted italic py-8 text-center">
          No variables match your filter.
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map(entry => {
            const pendingChange = pending.get(entry.key);
            return (
              <div key={entry.key} className="group relative">
                <ConfigCard
                  entry={entry}
                  pendingChange={pendingChange}
                  onChange={handleChange}
                  disabled={deploying}
                />
                {pendingChange && (
                  <button
                    onClick={() => revertKey(entry.key)}
                    className="absolute right-2 top-2 hidden group-hover:block
                               text-text-muted hover:text-text-primary text-xs px-1">
                    ↩ revert
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Deploy modal */}
      {showDeploy && (
        <DeployModal
          preview={preview}
          deploying={deploying}
          result={result}
          error={deployError}
          onConfirm={handleDeployConfirm}
          onClose={handleDeployClose}
        />
      )}
    </div>
  );
}
