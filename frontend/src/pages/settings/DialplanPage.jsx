import { useState, useEffect, useMemo } from 'react';
import {
  BookOpen, ChevronDown, ChevronRight,
  Loader2, AlertCircle, FileX, FileCode,
} from 'lucide-react';
import { api } from '../../api/client.js';
import ConfigPage from '../../platform/config/ConfigPage.jsx';

/**
 * DialplanPage — dynamic dialplan context browser.
 *
 * Fetches all registered providers, filters to those with id prefix 'dialplan:',
 * and groups them by context name (the second segment of the provider ID).
 *
 *   dialplan:default       → top-level context file  default.xml
 *   dialplan:public        → top-level context file  public.xml
 *   dialplan:default:cc    → fragment file           default/cc.xml
 *
 * Selecting a provider renders it via ConfigPage with docType="hierarchical",
 * which dispatches to HierarchicalRenderer for the full Extension editor.
 *
 * No context names, filenames, or paths are hardcoded here.
 * The tree is completely data-driven from /api/v1/platform/config/providers.
 */
export default function DialplanPage() {
  const [providers,          setProviders]          = useState([]);
  const [loading,            setLoading]            = useState(true);
  const [error,              setError]              = useState(null);
  const [selectedProviderId, setSelectedProviderId] = useState(null);
  const [collapsed,          setCollapsed]          = useState({});

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.platformConfig.providers()
      .then(data => {
        if (!alive) return;
        const dp = (data.providers ?? []).filter(p => p.id.startsWith('dialplan:'));
        setProviders(dp);
        if (dp.length > 0) setSelectedProviderId(dp[0].id);
        setLoading(false);
      })
      .catch(err => {
        if (!alive) return;
        setError(err.message ?? 'Failed to load providers');
        setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  // Build context groups.
  const groups = useMemo(() => {
    const topLevel  = providers.filter(p => p.id.split(':').length === 2);
    const fragments = providers.filter(p => p.id.split(':').length === 3);

    const grouped = topLevel.map(ctx => {
      const contextName = ctx.id.split(':')[1];
      const children    = fragments
        .filter(f => f.id.split(':')[1] === contextName)
        .sort((a, b) => a.id.localeCompare(b.id));
      return { ...ctx, contextName, children };
    }).sort((a, b) => a.contextName.localeCompare(b.contextName));

    const parentNames = new Set(topLevel.map(p => p.id.split(':')[1]));
    const orphans = fragments
      .filter(f => !parentNames.has(f.id.split(':')[1]))
      .map(f => ({ ...f, contextName: f.id.split(':')[1], children: [] }));

    return [...grouped, ...orphans];
  }, [providers]);

  const toggleCollapse = id =>
    setCollapsed(prev => ({ ...prev, [id]: !prev[id] }));

  const selectedProvider = useMemo(
    () => providers.find(p => p.id === selectedProviderId) ?? null,
    [providers, selectedProviderId]
  );

  // Derive human-readable title for ConfigPage header.
  const pageTitle = useMemo(() => {
    if (!selectedProvider) return '';
    const segs = selectedProvider.id.split(':');
    return segs.length === 3 ? `${segs[1]} / ${segs[2]}` : segs[1];
  }, [selectedProvider]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div
      className="flex gap-0 -mx-4 md:-mx-6 -my-4 md:-my-6"
      style={{ minHeight: 'calc(100vh - 56px - 48px)' }}>

      {/* Left: context tree */}
      <aside className="w-52 shrink-0 border-r border-surface-border bg-surface-panel
                        py-4 px-2 overflow-y-auto flex-shrink-0">

        <div className="px-2 mb-4">
          <div className="flex items-center gap-2">
            <BookOpen size={14} className="text-brand shrink-0" />
            <span className="text-xs font-bold text-text-primary">Dialplan Contexts</span>
          </div>
        </div>

        {loading && (
          <div className="flex items-center gap-2 px-3 py-2 text-text-muted">
            <Loader2 size={12} className="animate-spin" />
            <span className="text-xs">Loading…</span>
          </div>
        )}

        {!loading && error && (
          <div className="px-3 py-2">
            <div className="flex gap-1.5 items-start text-red-500">
              <AlertCircle size={12} className="shrink-0 mt-0.5" />
              <span className="text-[11px]">{error}</span>
            </div>
          </div>
        )}

        {!loading && !error && groups.length === 0 && (
          <div className="px-3 py-2 flex gap-1.5 items-start text-text-muted">
            <FileX size={12} className="shrink-0 mt-0.5" />
            <span className="text-[11px]">
              No dialplan files found.<br />
              Check FS_DIALPLAN_DIR.
            </span>
          </div>
        )}

        {!loading && !error && groups.map(group => {
          const hasChildren = group.children.length > 0;
          const isOpen      = !collapsed[group.id];
          return (
            <div key={group.id} className="mb-0.5">
              <div className="flex items-center">
                {hasChildren ? (
                  <button
                    onClick={() => toggleCollapse(group.id)}
                    className="p-1 text-text-muted hover:text-text-primary shrink-0">
                    {isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  </button>
                ) : (
                  <span className="w-[22px] shrink-0" />
                )}

                <button
                  onClick={() => setSelectedProviderId(group.id)}
                  className={`flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left
                              text-xs transition-colors truncate
                              ${selectedProviderId === group.id
                                ? 'bg-brand/10 text-brand font-medium'
                                : 'text-text-muted hover:text-text-primary hover:bg-surface-border'
                              }`}>
                  <BookOpen size={11} className="shrink-0" />
                  <span className="truncate">{group.contextName}</span>
                  {hasChildren && (
                    <span className="ml-auto text-[9px] opacity-50 shrink-0">
                      +{group.children.length}
                    </span>
                  )}
                </button>
              </div>

              {hasChildren && isOpen && (
                <div className="ml-5 space-y-0.5 mt-0.5">
                  {group.children.map(child => {
                    const basename = child.id.split(':')[2];
                    return (
                      <button
                        key={child.id}
                        onClick={() => setSelectedProviderId(child.id)}
                        className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg
                                   text-left text-xs transition-colors truncate
                                   ${selectedProviderId === child.id
                                     ? 'bg-brand/10 text-brand font-medium'
                                     : 'text-text-muted hover:text-text-primary hover:bg-surface-border'
                                   }`}>
                        <FileCode size={10} className="shrink-0" />
                        <span className="truncate">{basename}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </aside>

      {/* Right: ConfigPage with hierarchical renderer */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {selectedProvider ? (
          <ConfigPage
            key={selectedProvider.id}
            providerId={selectedProvider.id}
            docType={selectedProvider.docType ?? 'hierarchical'}
            title={pageTitle}
            subtitle={selectedProvider.filePath}
          />
        ) : (
          <EmptyState count={providers.length} loading={loading} />
        )}
      </div>
    </div>
  );
}

function EmptyState({ count, loading }) {
  if (loading) return null;
  return (
    <div className="h-full flex flex-col items-center justify-center text-center py-24 gap-4">
      <div className="w-12 h-12 rounded-full bg-surface-border flex items-center justify-center">
        <BookOpen size={22} className="text-text-muted" />
      </div>
      <div>
        <p className="text-sm font-semibold text-text-primary">No context selected</p>
        <p className="text-xs text-text-muted mt-1">
          {count > 0
            ? 'Select a context file from the tree to view its extensions.'
            : 'No dialplan files were discovered. Ensure FS_DIALPLAN_DIR points to your FreeSWITCH dialplan directory.'}
        </p>
      </div>
    </div>
  );
}
