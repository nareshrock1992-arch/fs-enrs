import { useEffect, useMemo, useCallback, useState } from 'react'; // useCallback kept for reload
import { History, ShieldCheck, Loader2, AlertCircle, Settings2 } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader.jsx';
import { useConfigProvider }     from './hooks/useConfigProvider.js';
import { useDeployment }         from './hooks/useDeployment.js';
import { useConfigChangesStore } from './stores/configChangesStore.js';
import ConfigHistory  from './ConfigHistory.jsx';
import ConfigAudit    from './ConfigAudit.jsx';
import DeployModal    from './DeployModal.jsx';
import ChangesBar     from './ChangesBar.jsx';
import FlatRenderer        from './renderers/FlatRenderer.jsx';
import HierarchicalRenderer from './renderers/HierarchicalRenderer.jsx';
import { describeChange }   from './utils/metadataUtils.js';
import { describeOp }       from './renderers/applyHierarchicalOps.js';

/**
 * ConfigPage — single entry point for all configuration provider pages.
 *
 * Dispatches to FlatRenderer (docType='flat', default) or HierarchicalRenderer
 * (docType='hierarchical') based on the docType prop. All cross-cutting concerns
 * — loading/error, header, drift banner, deploy flow, history/audit panels — live
 * here. Renderer-specific layout and state live in each renderer.
 *
 * Usage:
 *   <ConfigPage providerId="vars"      title="System Variables" />
 *   <ConfigPage providerId="dialplan:default" docType="hierarchical" title="default" />
 */
export default function ConfigPage({ providerId, title, subtitle, docType = 'flat' }) {
  const { entries, loading, error, load, filePath, parsedAt, checksum } = useConfigProvider(providerId);
  const {
    preview, previewing, deploying, result, error: deployError, isDrift,
    fetchPreview, deploy, clearResult,
  } = useDeployment(providerId);

  const { getChanges, clearProvider, getOps } = useConfigChangesStore();

  // Reactive pointer for hierarchical mode — triggers re-render when ops change.
  const opPointer = useConfigChangesStore(s => s._ops?.get(providerId)?.pointer ?? -1);

  const [panel,      setPanel]      = useState(null); // 'history' | 'audit' | null
  const [showDeploy, setShowDeploy] = useState(false);

  useEffect(() => { load(); }, [load]);

  const reload = useCallback(async () => {
    clearProvider(providerId);
    await load();
  }, [load, clearProvider, providerId]);

  // ── Change list and descriptions — mode-branched ────────────────────────────

  const pending = getChanges(providerId);

  const changes = useMemo(() => {
    if (docType === 'hierarchical') return getOps(providerId);
    return [...pending.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docType, pending, getOps, providerId, opPointer]);

  const changeDescriptions = useMemo(() => {
    if (docType === 'hierarchical') {
      return changes.map((op, i) => describeOp(op, i));
    }
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
  }, [docType, changes, entries]);

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
    <div className="space-y-6">

      {/* Sticky changes bar */}
      <ChangesBar
        count={changes.length}
        previewing={previewing}
        deploying={deploying}
        onDeploy={handlePreviewDeploy}
        onDiscard={() => clearProvider(providerId)}
      />

      <PageHeader title={title} description={subtitle ?? filePath} icon={Settings2}>
        <button
          onClick={() => setPanel(p => p === 'audit' ? null : 'audit')}
          className={`btn-secondary btn-sm ${panel === 'audit' ? 'bg-surface-border' : ''}`}>
          <ShieldCheck size={13} /> Audit
        </button>
        <button
          onClick={() => setPanel(p => p === 'history' ? null : 'history')}
          className={`btn-secondary btn-sm ${panel === 'history' ? 'bg-surface-border' : ''}`}>
          <History size={13} /> History
        </button>
      </PageHeader>

      {parsedAt && (
        <p className="text-xs text-text-muted -mt-4">
          Read at {new Date(parsedAt).toLocaleTimeString()}
        </p>
      )}

      {/* Drift banner — file changed on disk since page load */}
      {isDrift && (
        <div className="alert alert-warning">
          <AlertCircle size={16} className="shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">Configuration changed outside the UI</p>
            <p className="text-xs mt-0.5 opacity-80">
              The file was edited directly on disk since you loaded this page. Reload to fetch the latest version.
            </p>
          </div>
          <button onClick={reload} className="shrink-0 text-xs font-medium underline hover:no-underline">
            Reload
          </button>
        </div>
      )}

      {/* Deploy error banner — shown when modal is closed */}
      {deployError && !isDrift && !showDeploy && (
        <div className="alert alert-danger">
          <AlertCircle size={16} className="shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold">Deploy failed</p>
            <p className="text-xs mt-0.5 opacity-80">{deployError}</p>
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

      {/* Renderer — dispatched by docType */}
      {docType === 'hierarchical'
        ? <HierarchicalRenderer providerId={providerId} entries={entries} deploying={deploying} />
        : <FlatRenderer         providerId={providerId} entries={entries} deploying={deploying} />
      }

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
