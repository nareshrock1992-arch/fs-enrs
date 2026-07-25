import { useEffect, useMemo, useCallback, useState, Component } from 'react';
import { History, ShieldCheck, Loader2, AlertCircle } from 'lucide-react';
import { useConfigProvider }     from './hooks/useConfigProvider.js';
import { useDeployment }         from './hooks/useDeployment.js';
import { useConfigChangesStore } from './stores/configChangesStore.js';
import ConfigSection  from './ConfigSection.jsx';
import ConfigFilters  from './ConfigFilters.jsx';
import DetailsPanel   from './DetailsPanel.jsx';
import ConfigHistory  from './ConfigHistory.jsx';
import ConfigAudit    from './ConfigAudit.jsx';
import DeployModal    from './DeployModal.jsx';
import ChangesBar     from './ChangesBar.jsx';
import {
  isVisible,
  shouldShow,
  getSearchText,
  describeChange,
} from './utils/metadataUtils.js';
import { diagL1Entries, diagL2Filtered, diagL8BoundaryCatch } from './__configDiag.js';

/** DIAG: temporary error boundary around ConfigSection — remove with __configDiag.js */
class ConfigDiagBoundary extends Component {
  state = { caught: null };
  componentDidCatch(error, info) { diagL8BoundaryCatch(error, info); this.setState({ caught: error }); }
  render() {
    if (this.state.caught) {
      return (
        <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8 }}>
          <strong style={{ color: '#dc2626' }}>[DIAG L8] ConfigSection render error:</strong>
          <pre style={{ color: '#dc2626', marginTop: 8, fontSize: 12 }}>{this.state.caught.message}</pre>
          <small style={{ color: '#9ca3af' }}>Full details in browser console under [DIAG L8]</small>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * ConfigPage — shared template for all configuration provider pages.
 *
 * Phase 7.3B refactor: 3-pane layout (filters sidebar | entry list | detail panel),
 * metadata-driven visibility filtering (Basic/Advanced/Expert), grouped accordion
 * view via ConfigSection, and DetailsPanel for the selected entry.
 *
 * Usage:
 *   <ConfigPage
 *     providerId="vars"
 *     title="System Variables"
 *     subtitle="vars.xml — Global FreeSWITCH variables"
 *   />
 */
export default function ConfigPage({ providerId, title, subtitle }) {
  const { entries, loading, error, load, filePath, parsedAt, checksum } = useConfigProvider(providerId);
  const {
    preview, previewing, deploying, result, error: deployError, isDrift,
    fetchPreview, deploy, clearResult,
  } = useDeployment(providerId);

  const { getChanges, setChange, revertKey, clearProvider } = useConfigChangesStore();
  const pending = getChanges(providerId);

  const [search,         setSearch]         = useState('');
  // Default 'advanced' matches the old flat-list behaviour where all variables
  // were visible immediately. 'basic' hides the ~68 custom/ring-tone vars that
  // have no catalog entry, which the user never sees without manually switching.
  const [visibilityLevel, setVisibilityLevel] = useState('advanced');
  const [category,       setCategory]       = useState('All');
  const [selectedKey,    setSelectedKey]    = useState(null);
  const [panel,          setPanel]          = useState(null); // 'history' | 'audit' | null
  const [showDeploy,     setShowDeploy]     = useState(false);

  useEffect(() => { load(); }, [load]);

  const reload = useCallback(async () => {
    clearProvider(providerId);
    await load();
  }, [load, clearProvider, providerId]);

  const handleChange = useCallback((change) => {
    setChange(providerId, change);
  }, [setChange, providerId]);

  const handleRevertKey = useCallback((key) => {
    revertKey(providerId, key);
  }, [revertKey, providerId]);

  const handleSelect = useCallback((key) => {
    setSelectedKey(k => k === key ? null : key);
  }, []);

  // Current values map used for shouldShow() conditional visibility
  const currentValues = useMemo(() => {
    const map = {};
    for (const entry of entries) {
      const pc = pending.get(entry.key);
      map[entry.key] = pc?.value !== undefined ? pc.value : (entry.value ?? '');
    }
    return map;
  }, [entries, pending]);

  // Category list for filter nav — derived from all entries (not filtered ones)
  const categories = useMemo(() => {
    const cats = new Set(entries.map(e => (e.metadata ?? e).category).filter(Boolean));
    return ['All', ...cats];
  }, [entries]);

  // Filtered entries — visibility + showIf + category + search
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return entries.filter(e => {
      if (!isVisible(e, visibilityLevel))    return false;
      if (!shouldShow(e, currentValues))     return false;
      const meta = e.metadata ?? e;
      if (category !== 'All' && meta.category !== category) return false;
      if (q && !getSearchText(e).includes(q)) return false;
      return true;
    });
  }, [entries, visibilityLevel, category, search, currentValues]);

  // DIAG L1 — after entries load from API
  useEffect(() => { diagL1Entries(entries); }, [entries]);
  // DIAG L2 — after filtered set changes (filter, visibility, search, category)
  useEffect(() => { diagL2Filtered(filtered, visibilityLevel, category); }, [filtered, visibilityLevel, category]);

  const changes = useMemo(() => [...pending.values()], [pending]);

  // Change descriptions for ChangeSummary inside DeployModal
  const changeDescriptions = useMemo(() => {
    const entryMap = new Map(entries.map(e => [e.key, e]));
    return changes.map(c => {
      const entry = entryMap.get(c.key);
      if (!entry) {
        return { key: c.key, label: c.key, from: '(unknown)', to: c.value ?? '(unset)',
                 restartRequired: false, riskLevel: 'low', sensitive: false };
      }
      const oldValue = !entry.enabled ? '(disabled)' : (entry.value ?? '(unset)');
      const newValue = c.enabled === false ? '(disabled)' : (c.value ?? '(unset)');
      return describeChange(entry, oldValue, newValue);
    });
  }, [changes, entries]);

  // Entry object for DetailsPanel
  const selectedEntry = useMemo(
    () => entries.find(e => e.key === selectedKey) ?? null,
    [entries, selectedKey]
  );

  // ── Deploy flow ──────────────────────────────────────────────────────────────
  const handlePreviewDeploy = async () => {
    const p = await fetchPreview(changes, checksum);
    if (p) setShowDeploy(true);
  };

  const handleDeployConfirm = async (reason) => {
    const res = await deploy(changes, reason, checksum);
    if (res?.success) {
      // Refresh config and clear pending changes in the background so the
      // success screen remains visible until the user clicks Close.
      // clearResult() only runs in handleDeployClose to avoid flashing
      // the modal back to 'confirm' before the user reads the success state.
      clearProvider(providerId);
      load(); // fire-and-forget — intentional
    }
  };

  const handleDeployClose = () => {
    setShowDeploy(false);
    clearResult();
  };

  // ── Render ───────────────────────────────────────────────────────────────────
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

      {/* Sticky changes bar */}
      <ChangesBar
        count={changes.length}
        previewing={previewing}
        deploying={deploying}
        onDeploy={handlePreviewDeploy}
        onDiscard={() => clearProvider(providerId)}
      />

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
          <button
            onClick={() => setPanel(p => p === 'audit' ? null : 'audit')}
            className={`btn-ghost flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg
              ${panel === 'audit' ? 'bg-surface-border' : ''}`}>
            <ShieldCheck size={14} />
            Audit
          </button>
          <button
            onClick={() => setPanel(p => p === 'history' ? null : 'history')}
            className={`btn-ghost flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg
              ${panel === 'history' ? 'bg-surface-border' : ''}`}>
            <History size={14} />
            History
          </button>
        </div>
      </div>

      {/* Drift banner — file changed on disk since page load */}
      {isDrift && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-800
                        bg-amber-50 dark:bg-amber-950 p-4 flex gap-3 items-start">
          <AlertCircle size={16} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
              Configuration changed outside the UI
            </p>
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
              The file was edited directly on disk since you loaded this page. Reload to fetch the latest version.
            </p>
          </div>
          <button
            onClick={reload}
            className="shrink-0 text-xs font-medium text-amber-700 dark:text-amber-300
                       underline hover:no-underline">
            Reload
          </button>
        </div>
      )}

      {/* Deploy error banner — shown when modal is closed */}
      {deployError && !isDrift && !showDeploy && (
        <div className="rounded-xl border border-red-200 dark:border-red-800
                        bg-red-50 dark:bg-red-950 p-4 flex gap-3 items-start">
          <AlertCircle size={16} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-700 dark:text-red-300">Deploy failed</p>
            <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">{deployError}</p>
          </div>
        </div>
      )}

      {/* History / Audit panels */}
      {panel === 'history' && (
        <div className="card">
          <h2 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
            <History size={14} /> Version History
          </h2>
          <ConfigHistory providerId={providerId} onRollbackSuccess={reload} />
        </div>
      )}
      {panel === 'audit' && (
        <div className="card">
          <h2 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
            <ShieldCheck size={14} /> Audit Log
          </h2>
          <ConfigAudit providerId={providerId} />
        </div>
      )}

      {/* 3-pane layout: [filter sidebar] [entry list] [detail panel] */}
      <div className="flex gap-4 items-start">

        {/* Left: filter sidebar — hidden on mobile, visible xl+ */}
        <div className="hidden xl:block w-48 shrink-0">
          <ConfigFilters
            search={search}
            onSearchChange={setSearch}
            visibilityLevel={visibilityLevel}
            onVisibilityChange={setVisibilityLevel}
            category={category}
            onCategoryChange={setCategory}
            categories={categories}
          />
        </div>

        {/* Center: mobile filters + grouped entry list */}
        <div className="flex-1 min-w-0 space-y-3">
          {/* Compact filter row for mobile / non-xl viewports */}
          <div className="xl:hidden">
            <ConfigFilters
              search={search}
              onSearchChange={setSearch}
              visibilityLevel={visibilityLevel}
              onVisibilityChange={setVisibilityLevel}
              category={category}
              onCategoryChange={setCategory}
              categories={categories}
              compact
            />
          </div>

          <ConfigDiagBoundary>
            <ConfigSection
              entries={filtered}
              pending={pending}
              onChange={handleChange}
              onRevert={handleRevertKey}
              selectedKey={selectedKey}
              onSelect={handleSelect}
              disabled={deploying}
            />
          </ConfigDiagBoundary>
        </div>

        {/* Right: detail panel — only when an entry is selected, xl+ only */}
        {selectedKey && (
          <div className="hidden xl:block w-72 shrink-0">
            <DetailsPanel entry={selectedEntry} />
          </div>
        )}
      </div>

      {/* Deploy modal */}
      {showDeploy && (
        <DeployModal
          preview={preview}
          deploying={deploying}
          result={result}
          error={deployError}
          changeDescriptions={changeDescriptions}
          onConfirm={handleDeployConfirm}
          onClose={handleDeployClose}
        />
      )}
    </div>
  );
}
