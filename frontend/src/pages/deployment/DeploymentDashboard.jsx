import { useEffect, useState, useCallback } from 'react';
import {
  Rocket, CheckCircle, XCircle, AlertTriangle, Clock, RefreshCw,
  Terminal, FolderOpen, Wifi, WifiOff, FileText, FileCode,
  ChevronDown, ChevronRight, Phone, Play
} from 'lucide-react';
import { api } from '../../api/client.js';
import { useAuthStore } from '../../store/authStore.js';

// ── Status Chips ──────────────────────────────────────────────────────────────

function StatusChip({ status }) {
  const map = {
    pass:    { icon: CheckCircle,   cls: 'bg-green-500/15 text-green-500  border-green-500/20',   label: 'PASS' },
    warn:    { icon: AlertTriangle, cls: 'bg-amber-500/15 text-amber-500  border-amber-500/20',   label: 'WARN' },
    fail:    { icon: XCircle,       cls: 'bg-red-500/15   text-red-400    border-red-500/20',     label: 'FAIL' },
    success: { icon: CheckCircle,   cls: 'bg-green-500/15 text-green-500  border-green-500/20',   label: 'OK'   },
    failed:  { icon: XCircle,       cls: 'bg-red-500/15   text-red-400    border-red-500/20',     label: 'FAIL' },
    partial: { icon: AlertTriangle, cls: 'bg-amber-500/15 text-amber-500  border-amber-500/20',   label: 'PARTIAL'},
    pending: { icon: Clock,         cls: 'bg-surface-hover text-text-muted border-surface-border', label: 'PENDING'},
  };
  const cfg = map[status] || map.pending;
  const Icon = cfg.icon;
  return (
    <span className={`flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-full border font-medium ${cfg.cls}`}>
      <Icon size={9} /> {cfg.label}
    </span>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Deployment Status Badge (for flows) ──────────────────────────────────────

function FlowDeployStatus({ flow }) {
  const hasPublished = !!flow.latest_version;
  const isDeployed   = !!flow.last_deployed_at;
  const inSync       = isDeployed && flow.last_deployed_version === flow.latest_version;

  if (!hasPublished) {
    return <span className="text-[9px] text-text-muted px-2 py-0.5 rounded-full border border-surface-border">Not published</span>;
  }
  if (!isDeployed) {
    return <span className="text-[9px] text-amber-500 px-2 py-0.5 rounded-full border border-amber-500/20 bg-amber-500/10">Published — not deployed</span>;
  }
  if (!inSync) {
    return <span className="text-[9px] text-amber-500 px-2 py-0.5 rounded-full border border-amber-500/20 bg-amber-500/10">Deployed v{flow.last_deployed_version} — new v{flow.latest_version} available</span>;
  }
  return <span className="text-[9px] text-green-500 px-2 py-0.5 rounded-full border border-green-500/20 bg-green-500/10">Deployed v{flow.last_deployed_version} ✓</span>;
}

// ── Flow Row ──────────────────────────────────────────────────────────────────

function FlowRow({ flow, onDeploy, deploying }) {
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory]   = useState(null);

  const loadHistory = async () => {
    if (!expanded) {
      try {
        const r = await api.deployment.flowHistory(flow.flow_uuid);
        setHistory(r.history || []);
      } catch { setHistory([]); }
    }
    setExpanded(v => !v);
  };

  const canDeploy = !!flow.latest_version;

  return (
    <>
      <div className="card flex items-center gap-4 hover:bg-surface-hover transition-colors">
        <button onClick={loadHistory} className="text-text-muted hover:text-text-primary transition-colors">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        <div className="w-9 h-9 rounded-lg bg-brand/10 border border-brand/20 flex items-center justify-center shrink-0">
          <Rocket size={14} className="text-brand" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-text-primary truncate">{flow.name}</p>
            <FlowDeployStatus flow={flow} />
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[10px] text-text-muted">
            {flow.bound_numbers?.length > 0 ? (
              <span className="flex items-center gap-1">
                <Phone size={9} />
                {flow.bound_numbers.join(', ')}
              </span>
            ) : (
              <span className="opacity-60">No numbers bound</span>
            )}
            {flow.last_deployed_at && (
              <span>Last deployed {fmtDate(flow.last_deployed_at)}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {flow.last_deployment_status && (
            <StatusChip status={flow.last_deployment_status} />
          )}
          <button
            onClick={() => onDeploy(flow.flow_uuid)}
            disabled={!canDeploy || deploying[flow.flow_uuid]}
            title={canDeploy ? 'Deploy to FreeSWITCH' : 'Publish the flow first'}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg
                       bg-brand text-white hover:bg-brand/90
                       disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {deploying[flow.flow_uuid]
              ? <RefreshCw size={11} className="animate-spin" />
              : <Rocket size={11} />}
            Deploy
          </button>
        </div>
      </div>

      {expanded && (
        <div className="ml-14 mr-0 -mt-1 mb-2 card rounded-t-none border-t-0 text-xs">
          <p className="text-[10px] font-medium text-text-muted uppercase tracking-wide mb-2">Deployment History</p>
          {history === null ? (
            <p className="text-text-muted">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-text-muted italic">No deployments yet</p>
          ) : (
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-text-muted border-b border-surface-border">
                  <th className="text-left pb-1">Time</th>
                  <th className="text-left pb-1">Status</th>
                  <th className="text-left pb-1">Version</th>
                  <th className="text-left pb-1">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {history.map(h => (
                  <tr key={h.id} className="text-text-muted">
                    <td className="py-1">{fmtDate(h.deployed_at)}</td>
                    <td className="py-1"><StatusChip status={h.status} /></td>
                    <td className="py-1">{h.version_number ? `v${h.version_number}` : '—'}</td>
                    <td className="py-1">{h.deployed_by_email || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}

// ── Diagnostics Panel ─────────────────────────────────────────────────────────

function DiagnosticsPanel() {
  const [result,     setResult]     = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [paths,      setPaths]      = useState(null);
  const [disabling,  setDisabling]  = useState(null);

  const run = async () => {
    setLoading(true);
    try {
      const [diagRes, pathRes] = await Promise.all([
        api.deployment.diagnostics(),
        api.deployment.paths(),
      ]);
      setResult(diagRes);
      setPaths(pathRes);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { run(); }, []);

  const doReloadXml = async () => {
    try {
      await api.deployment.reloadXml();
      alert('reloadxml executed successfully');
    } catch (e) {
      alert('reloadxml failed: ' + e.message);
    }
  };

  const disableConflict = async (conflict) => {
    const ok = confirm(
      `Disable legacy extension "${conflict.extension_name}" in ${conflict.file}?\n\n` +
      `This comments out (does not delete) the block that matches number "${conflict.number}" ` +
      `via expression "${conflict.expression}". It can be re-enabled by editing the file and ` +
      `removing the comment wrapper.`
    );
    if (!ok) return;
    setDisabling(`${conflict.file}::${conflict.extension_name}`);
    try {
      await api.deployment.disableLegacyExtension(conflict.file, conflict.extension_name);
      await run();
    } catch (e) {
      alert('Failed to disable extension: ' + e.message);
    } finally {
      setDisabling(null);
    }
  };

  const checkIcon = (status) => {
    if (status === 'pass') return <CheckCircle size={14} className="text-green-500 shrink-0" />;
    if (status === 'warn') return <AlertTriangle size={14} className="text-amber-500 shrink-0" />;
    return <XCircle size={14} className="text-red-400 shrink-0" />;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-text-primary">FreeSWITCH Integration Diagnostics</p>
          {result && (
            <p className="text-[10px] text-text-muted mt-0.5">
              {result.summary.pass} pass · {result.summary.warn} warn · {result.summary.fail} fail
              &nbsp;— finished {fmtDate(result.finished_at)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={doReloadXml}
            className="text-xs px-3 py-1.5 rounded-lg border border-surface-border
                       text-text-muted hover:text-brand hover:border-brand transition-colors flex items-center gap-1.5"
          >
            <RefreshCw size={11} /> reloadxml
          </button>
          <button
            onClick={run}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand/90
                       disabled:opacity-50 transition-colors flex items-center gap-1.5"
          >
            {loading ? <RefreshCw size={11} className="animate-spin" /> : <Play size={11} />}
            Run Diagnostics
          </button>
        </div>
      </div>

      {/* Summary bar */}
      {result && (
        <div className={`px-4 py-3 rounded-lg border flex items-center gap-3 ${
          result.overall === 'pass' ? 'bg-green-500/10 border-green-500/20' :
          result.overall === 'warn' ? 'bg-amber-500/10 border-amber-500/20' :
          'bg-red-500/10 border-red-500/20'
        }`}>
          {result.overall === 'pass' ? <CheckCircle size={16} className="text-green-500" /> :
           result.overall === 'warn' ? <AlertTriangle size={16} className="text-amber-500" /> :
           <XCircle size={16} className="text-red-400" />}
          <div>
            <p className={`text-xs font-bold ${
              result.overall === 'pass' ? 'text-green-500' :
              result.overall === 'warn' ? 'text-amber-500' : 'text-red-400'
            }`}>
              Overall: {result.overall.toUpperCase()}
            </p>
            <p className="text-[10px] text-text-muted">
              {result.summary.pass}/{result.summary.total} checks passed
            </p>
          </div>
        </div>
      )}

      {/* Checks */}
      {result && (
        <div className="space-y-1.5">
          {result.checks.map((c, i) => (
            <div key={i}
                 className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border ${
                   c.status === 'pass' ? 'border-surface-border bg-surface' :
                   c.status === 'warn' ? 'border-amber-500/20 bg-amber-500/5' :
                   'border-red-500/20 bg-red-500/5'
                 }`}>
              {checkIcon(c.status)}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-text-primary">{c.label}</p>
                <p className="text-[10px] text-text-muted mt-0.5 break-all">{c.detail}</p>
                {c.action && (
                  <p className="text-[10px] text-brand mt-1 font-medium">→ {c.action}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Conflicting legacy extensions — one-click disable */}
      {result?.conflicts?.length > 0 && (
        <div className="card space-y-2">
          <p className="text-[10px] font-medium text-amber-500 uppercase tracking-wide mb-1 flex items-center gap-1.5">
            <AlertTriangle size={11} /> Conflicting Legacy Extensions
          </p>
          {result.conflicts.map((c, i) => {
            const key = `${c.file}::${c.extension_name}`;
            return (
              <div key={i} className="flex items-start gap-3 px-3 py-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-text-primary">
                    "{c.extension_name}" in {c.file}
                    {c.severity === 'blocking' && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400">
                        will shadow
                      </span>
                    )}
                  </p>
                  <p className="text-[10px] text-text-muted mt-0.5">{c.message}</p>
                </div>
                <button
                  onClick={() => disableConflict(c)}
                  disabled={disabling === key}
                  className="text-[10px] px-2.5 py-1.5 rounded-lg border border-amber-500/30
                             text-amber-500 hover:bg-amber-500/10 transition-colors shrink-0
                             disabled:opacity-50"
                >
                  {disabling === key ? 'Disabling…' : 'Disable'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Path Reference */}
      {paths && (
        <div className="card">
          <p className="text-[10px] font-medium text-text-muted uppercase tracking-wide mb-3 flex items-center gap-1.5">
            <FolderOpen size={11} /> Configured FreeSWITCH Paths
          </p>
          <div className="space-y-1.5">
            {Object.entries(paths).map(([key, val]) => (
              <div key={key} className="flex items-center gap-3 text-[10px]">
                <span className="text-text-muted w-36 shrink-0">{key}</span>
                <code className="font-mono text-text-primary break-all">{val}</code>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DeploymentDashboard() {
  const [tab,      setTab]      = useState('flows');
  const [flows,    setFlows]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [deploying,setDeploying]= useState({});
  const [report,   setReport]   = useState(null);

  const user    = useAuthStore(s => s.user);
  const canEdit = user?.role === 'ADMIN';

  const loadFlows = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.deployment.listFlows();
      setFlows(r.flows || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadFlows(); }, [loadFlows]);

  const handleDeploy = async (uuid) => {
    if (!canEdit) return alert('Admin access required');
    setDeploying(d => ({ ...d, [uuid]: true }));
    setReport(null);
    try {
      const r = await api.deployment.deploy(uuid);
      setReport(r);
      loadFlows();
    } catch (e) {
      setReport({ status: 'failed', errors: [e.message], steps: [], warnings: [] });
    } finally {
      setDeploying(d => ({ ...d, [uuid]: false }));
    }
  };

  const TABS = [
    { id: 'flows',       label: 'IVR Flows',   icon: Rocket },
    { id: 'diagnostics', label: 'Diagnostics', icon: Terminal },
  ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Rocket size={20} className="text-brand" />
        <div>
          <h1 className="text-xl font-bold text-text-primary">Deployment Dashboard</h1>
          <p className="text-xs text-text-muted">Deploy IVR flows to FreeSWITCH and verify integration</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-surface-border">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-brand text-brand'
                  : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              <Icon size={13} /> {t.label}
            </button>
          );
        })}
      </div>

      {/* Deploy report */}
      {report && (
        <div className={`px-4 py-3 rounded-lg border ${
          report.status === 'success' ? 'bg-green-500/10 border-green-500/20' : 'bg-red-500/10 border-red-500/20'
        }`}>
          <div className="flex items-center justify-between mb-2">
            <p className={`text-xs font-bold flex items-center gap-1.5 ${
              report.status === 'success' ? 'text-green-500' : 'text-red-400'
            }`}>
              {report.status === 'success' ? <CheckCircle size={13} /> : <XCircle size={13} />}
              Deployment {report.status === 'success' ? 'succeeded' : 'failed'}
            </p>
            <button onClick={() => setReport(null)} className="text-text-muted hover:text-text-primary text-[10px]">Dismiss</button>
          </div>
          {report.errors?.map((e, i) => (
            <p key={i} className="text-[10px] text-red-400">✗ {e}</p>
          ))}
          {report.warnings?.map((w, i) => (
            <p key={i} className="text-[10px] text-amber-500">⚠ {w}</p>
          ))}
          {report.files?.lua && (
            <p className="text-[10px] text-text-muted mt-1 flex items-center gap-1">
              <FileCode size={9} /> Lua: <code className="font-mono">{report.files.lua}</code>
            </p>
          )}
          {report.files?.xml && (
            <p className="text-[10px] text-text-muted flex items-center gap-1">
              <FileText size={9} /> XML: <code className="font-mono">{report.files.xml}</code>
            </p>
          )}
        </div>
      )}

      {/* Tab content */}
      {tab === 'flows' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-text-muted">{flows.length} IVR flow{flows.length !== 1 ? 's' : ''}</p>
            <button onClick={loadFlows} className="p-1.5 text-text-muted hover:text-brand transition-colors">
              <RefreshCw size={13} />
            </button>
          </div>

          {loading ? (
            <div className="text-center py-12 text-text-muted text-sm">Loading…</div>
          ) : flows.length === 0 ? (
            <div className="card text-center py-12">
              <Rocket size={32} className="mx-auto text-text-muted mb-3" />
              <p className="text-sm text-text-muted">No IVR flows yet</p>
              <p className="text-[11px] text-text-muted mt-1 opacity-60">
                Create and publish flows in the IVR Builder, then deploy them here
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {flows.map(f => (
                <FlowRow
                  key={f.flow_uuid}
                  flow={f}
                  onDeploy={handleDeploy}
                  deploying={deploying}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'diagnostics' && <DiagnosticsPanel />}
    </div>
  );
}
