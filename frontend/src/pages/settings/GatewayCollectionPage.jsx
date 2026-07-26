import { useState, useEffect, useMemo } from 'react';
import { Network, ChevronDown, ChevronRight, Loader2, AlertCircle, FileX } from 'lucide-react';
import { api } from '../../api/client.js';
import ConfigPage from '../../platform/config/ConfigPage.jsx';

/**
 * GatewayCollectionPage — dynamic gateway browser.
 *
 * Fetches all registered providers and shows only those with id prefix
 * 'gateway:'.  Groups them by SIP profile name (the middle segment of
 * 'gateway:<profile>:<basename>') and renders a collapsible tree on the
 * left.  Selecting a gateway renders its ConfigPage on the right.
 *
 * No profile names, gateway names, or file paths are hardcoded here.
 * The tree is completely data-driven.
 */
export default function GatewayCollectionPage() {
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
        const gw = (data.providers ?? []).filter(p => p.id.startsWith('gateway:'));
        setProviders(gw);
        setLoading(false);
      })
      .catch(err => {
        if (!alive) return;
        setError(err.message ?? 'Failed to load providers');
        setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  // Group providers by profile name (middle segment of 'gateway:profile:basename').
  const groups = useMemo(() => {
    const map = new Map();
    for (const p of providers) {
      const parts       = p.id.split(':');
      const profileName = parts[1] ?? 'default';
      const basename    = parts[2] ?? p.id;
      if (!map.has(profileName)) map.set(profileName, []);
      map.get(profileName).push({ ...p, profileName, basename });
    }
    // Sort profiles alphabetically; gateways within each profile alphabetically.
    const sorted = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
    return sorted.map(([profileName, items]) => ({
      profileName,
      items: [...items].sort((a, b) => a.basename.localeCompare(b.basename)),
    }));
  }, [providers]);

  const toggleCollapse = (profileName) =>
    setCollapsed(prev => ({ ...prev, [profileName]: !prev[profileName] }));

  // Derive a human-readable title / subtitle for the selected ConfigPage.
  const selectedProvider = useMemo(
    () => providers.find(p => p.id === selectedProviderId) ?? null,
    [providers, selectedProviderId]
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex gap-0 -mx-4 md:-mx-6 -my-4 md:-my-6" style={{ minHeight: 'calc(100vh - 56px - 48px)' }}>

      {/* Left: gateway tree */}
      <aside className="w-52 shrink-0 border-r border-surface-border bg-surface-panel
                        py-4 px-2 overflow-y-auto flex-shrink-0">

        <div className="px-2 mb-4">
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand shrink-0" />
            <span className="text-xs font-bold text-text-primary">Gateway Collections</span>
          </div>
        </div>

        {/* Loading state */}
        {loading && (
          <div className="flex items-center gap-2 px-3 py-2 text-text-muted">
            <Loader2 size={12} className="animate-spin" />
            <span className="text-xs">Loading…</span>
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="px-3 py-2">
            <div className="flex gap-1.5 items-start text-red-500">
              <AlertCircle size={12} className="shrink-0 mt-0.5" />
              <span className="text-[11px]">{error}</span>
            </div>
          </div>
        )}

        {/* Empty — no gateway providers registered */}
        {!loading && !error && groups.length === 0 && (
          <div className="px-3 py-2 flex gap-1.5 items-start text-text-muted">
            <FileX size={12} className="shrink-0 mt-0.5" />
            <span className="text-[11px]">
              No gateway files found.<br />
              Check FS_SIP_PROFILE_DIR.
            </span>
          </div>
        )}

        {/* Profile groups */}
        {!loading && !error && groups.map(({ profileName, items }) => {
          const isOpen = !collapsed[profileName];
          return (
            <div key={profileName} className="mb-1">
              {/* Profile header — collapsible */}
              <button
                onClick={() => toggleCollapse(profileName)}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                           text-text-muted hover:text-text-primary hover:bg-surface-border
                           transition-colors text-left">
                {isOpen
                  ? <ChevronDown  size={11} className="shrink-0" />
                  : <ChevronRight size={11} className="shrink-0" />
                }
                <span className="text-[10px] font-bold uppercase tracking-[0.08em] truncate">
                  {profileName}
                </span>
                <span className="ml-auto text-[9px] opacity-50">{items.length}</span>
              </button>

              {/* Gateway entries */}
              {isOpen && (
                <div className="ml-3 space-y-0.5">
                  {items.map(item => {
                    const isSelected = item.id === selectedProviderId;
                    return (
                      <button
                        key={item.id}
                        onClick={() => setSelectedProviderId(item.id)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-left
                                   text-xs transition-colors truncate
                                   ${isSelected
                                     ? 'bg-brand/10 text-brand font-medium'
                                     : 'text-text-muted hover:text-text-primary hover:bg-surface-border'
                                   }`}>
                        <Network size={11} className="shrink-0" />
                        <span className="truncate">{item.basename}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </aside>

      {/* Right: detail panel */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {selectedProvider ? (
          <ConfigPage
            providerId={selectedProvider.id}
            title={selectedProvider.name ?? selectedProvider.basename}
            subtitle={
              `SIP profile: ${selectedProvider.id.split(':')[1]} — ` +
              `${selectedProvider.id.split(':')[2]}.xml`
            }
          />
        ) : (
          <Placeholder count={providers.length} loading={loading} />
        )}
      </div>
    </div>
  );
}

function Placeholder({ count, loading }) {
  if (loading) return null;
  return (
    <div className="h-full flex flex-col items-center justify-center text-center py-24 gap-4">
      <div className="w-12 h-12 rounded-full bg-surface-border flex items-center justify-center">
        <Network size={22} className="text-text-muted" />
      </div>
      <div>
        <p className="text-sm font-semibold text-text-primary">No gateway selected</p>
        <p className="text-xs text-text-muted mt-1">
          {count > 0
            ? 'Select a gateway from the tree to view and edit its configuration.'
            : 'No gateways were discovered. Ensure FS_SIP_PROFILE_DIR points to your FreeSWITCH sip_profiles directory.'}
        </p>
      </div>
    </div>
  );
}
