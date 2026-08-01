import { useEffect, useState, useCallback } from 'react';
import {
  Activity, CheckCircle2, XCircle, AlertTriangle, Database,
  Server, Clock, Shield, Package, Layers, Zap, Cpu,
  RefreshCw, AlertCircle, ChevronDown, ChevronRight
} from 'lucide-react';
import { api } from '../../api/client.js';
import { useConfigChangesStore } from './stores/configChangesStore.js';
import StatusBadge from './StatusBadge.jsx';
import PageHeader from '../../components/ui/PageHeader.jsx';

// ── Utility ────────────────────────────────────────────────────────────────────

function SectionTitle({ icon: Icon, title, subtitle }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon size={14} className="text-brand shrink-0" />
      <div>
        <h2 className="text-sm font-bold text-text-primary leading-none">{title}</h2>
        {subtitle && <p className="text-[10px] text-text-muted mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono = false }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-surface-border last:border-0">
      <span className="text-xs text-text-muted">{label}</span>
      <span className={`text-xs font-semibold text-text-primary ${mono ? 'font-mono' : ''}`}>
        {value ?? '—'}
      </span>
    </div>
  );
}

// ── Health check icon ──────────────────────────────────────────────────────────

function CheckIcon({ status }) {
  if (status === 'ok')   return <CheckCircle2  size={13} className="text-emerald-500 shrink-0" />;
  if (status === 'warn') return <AlertTriangle size={13} className="text-amber-500  shrink-0" />;
  return <XCircle size={13} className="text-red-500 shrink-0" />;
}

// ── Section: Platform Health ───────────────────────────────────────────────────

function PlatformHealthSection({ status }) {
  const [expanded, setExpanded] = useState(false);

  if (!status) {
    return (
      <div className="card flex items-center gap-2 text-xs text-text-muted py-6 justify-center">
        <RefreshCw size={13} className="animate-spin" />
        Loading platform status…
      </div>
    );
  }

  const statusColor =
    status.status === 'healthy'   ? 'text-emerald-600 dark:text-emerald-400' :
    status.status === 'degraded'  ? 'text-amber-600  dark:text-amber-400'  :
    'text-red-600 dark:text-red-400';

  const failedChecks = status.checks?.filter(c => c.status !== 'ok') ?? [];

  return (
    <div className="card">
      <SectionTitle icon={Activity} title="Platform Health" subtitle="Live connectivity and filesystem checks" />

      <div className="flex items-center gap-3 mb-3">
        <div className={`text-base font-bold capitalize ${statusColor}`}>
          {status.status}
        </div>
        <span className="text-xs text-text-muted">·</span>
        <span className="text-xs text-text-muted">
          {status.checks?.filter(c => c.status === 'ok').length ?? 0} / {status.checks?.length ?? 0} checks passed
        </span>
        <span className="text-xs text-text-muted ml-auto">
          {status.checkedAt ? new Date(status.checkedAt).toLocaleTimeString() : ''}
        </span>
      </div>

      {failedChecks.length > 0 && (
        <div className="mb-3">
          {failedChecks.map(c => (
            <div key={c.name} className="flex items-start gap-2 text-xs mb-1.5">
              <CheckIcon status={c.status} />
              <div>
                <span className="font-semibold text-text-primary font-mono">{c.name}</span>
                {c.detail && <span className="text-text-muted ml-1">{c.detail}</span>}
                {c.error  && <span className="text-red-500 ml-1">({c.error})</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-primary">
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {expanded ? 'Hide' : 'Show'} all checks
      </button>

      {expanded && status.checks && (
        <div className="mt-2 space-y-1">
          {status.checks.map(c => (
            <div key={c.name} className="flex items-center gap-2 text-xs">
              <CheckIcon status={c.status} />
              <span className="font-mono text-text-primary">{c.name}</span>
              <span className="text-text-muted truncate ml-1">{c.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Section: Configuration Summary ────────────────────────────────────────────

function ConfigSummarySection({ summary }) {
  if (!summary) {
    return (
      <div className="card flex items-center gap-2 text-xs text-text-muted py-6 justify-center">
        <RefreshCw size={13} className="animate-spin" />
        Loading configuration summary…
      </div>
    );
  }

  return (
    <div className="card">
      <SectionTitle icon={Database} title="Configuration Summary" subtitle="Registered providers and active versions" />
      <div className="space-y-2">
        {summary.providers.map(p => (
          <div key={p.id}
            className="flex items-start gap-3 p-2.5 rounded-lg border border-surface-border
                       bg-surface-bg hover:bg-surface-border/40 transition-colors">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-text-primary">{p.name}</p>
              <p className="text-[10px] text-text-muted mt-0.5 truncate">{p.description}</p>
            </div>
            <div className="text-right shrink-0">
              {p.activeVersion ? (
                <span className="text-[10px] font-mono text-brand">
                  v{p.activeVersion.version_num}
                </span>
              ) : (
                <span className="text-[10px] text-text-muted italic">not deployed</span>
              )}
              {p.latestBackup && (
                <p className="text-[10px] text-text-muted">
                  backup {new Date(p.latestBackup.createdAt).toLocaleDateString()}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Section: Pending Changes ───────────────────────────────────────────────────

function PendingChangesSection() {
  const { totalPending, providerCounts } = useConfigChangesStore();
  const total  = totalPending();
  const counts = providerCounts();

  return (
    <div className="card">
      <SectionTitle icon={Zap} title="Pending Changes" subtitle="Unsaved edits across all providers" />
      {total === 0 ? (
        <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400 py-2">
          <CheckCircle2 size={13} />
          No pending changes — all providers are in sync.
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold text-amber-600 dark:text-amber-400">{total}</span>
            <span className="text-xs text-text-muted">unsaved {total === 1 ? 'change' : 'changes'}</span>
          </div>
          {counts.map(c => (
            <div key={c.providerId} className="flex items-center justify-between text-xs">
              <span className="font-mono text-text-muted">{c.providerId}</span>
              <span className="font-semibold text-amber-600 dark:text-amber-400">{c.count}</span>
            </div>
          ))}
          <p className="text-[10px] text-text-muted pt-1">
            Navigate to a provider to review and deploy.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Section: Validation Summary ───────────────────────────────────────────────

function ValidationSection({ validation }) {
  if (!validation) return null;

  return (
    <div className="card">
      <SectionTitle icon={Shield} title="Validation Summary" subtitle="Current file validation status" />
      <div className="space-y-2">
        {validation.providers?.map(p => (
          <div key={p.id} className="flex items-center gap-2 text-xs">
            {p.valid
              ? <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
              : <XCircle     size={13} className="text-red-500     shrink-0" />}
            <span className="text-text-primary font-medium">{p.name}</span>
            {!p.valid && p.errors.length > 0 && (
              <span className="text-red-600 dark:text-red-400 truncate">
                — {p.errors[0]}
              </span>
            )}
            {p.warnings.length > 0 && (
              <span className="text-amber-600 dark:text-amber-400 ml-auto shrink-0">
                {p.warnings.length} warning{p.warnings.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
        ))}
      </div>
      {validation.allValid && (
        <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-2">
          All configuration files passed validation.
        </p>
      )}
    </div>
  );
}

// ── Section: Provider Overview ─────────────────────────────────────────────────

function ProviderOverviewSection({ summary }) {
  if (!summary?.providers) return null;

  return (
    <div className="card">
      <SectionTitle icon={Layers} title="Provider Overview" subtitle="Deployment metadata for each configuration provider" />
      <div className="space-y-3">
        {summary.providers.map(p => {
          const meta = p.deploymentMeta;
          if (!meta) return null;
          return (
            <div key={p.id} className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-text-primary">{p.name}</span>
                  <StatusBadge status={meta.riskLevel} label={`${meta.riskLevel} risk`} />
                </div>
                <p className="text-[10px] text-text-muted mt-0.5">{meta.actionLabel}</p>
              </div>
              <div className="text-right text-[10px] text-text-muted shrink-0">
                <div>{meta.restartRequired ? '⚠ Restart' : '✓ No restart'}</div>
                <div>Downtime: {meta.estimatedDowntime}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Section: Platform Information ─────────────────────────────────────────────

function PlatformInfoSection({ summary, status }) {
  return (
    <div className="card">
      <SectionTitle icon={Cpu} title="Platform Information" subtitle="Software versions and build context" />
      <div>
        <InfoRow label="Platform Version"    value={summary?.platformInfo?.platformVersion} mono />
        <InfoRow label="FreeSWITCH Version"  value={status?.freeSwitchVersion}              mono />
        <InfoRow label="DB Schema Version"   value={summary?.platformInfo?.dbSchemaVersion} mono />
        <InfoRow label="Build Environment"   value={summary?.platformInfo?.buildEnvironment} />
        <InfoRow label="ESL Connected"
          value={status?.eslConnected === true ? 'Yes' : status?.eslConnected === false ? 'No' : '—'} />
      </div>
    </div>
  );
}

// ── Root component ─────────────────────────────────────────────────────────────

export default function ConfigDashboard() {
  const [summary,    setSummary]    = useState(null);
  const [status,     setStatus]     = useState(null);
  const [loadError,  setLoadError]  = useState(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [s, h] = await Promise.all([
        api.platformConfig.summary(),
        api.platformConfig.platformStatus(),
      ]);
      setSummary(s);
      setStatus(h);
    } catch (err) {
      setLoadError(err?.message ?? 'Failed to load dashboard.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loadError) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800
                      bg-red-50 dark:bg-red-950 p-6 flex gap-3 items-start">
        <AlertCircle size={18} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-red-700 dark:text-red-300">Dashboard error</p>
          <p className="text-xs text-red-600 dark:text-red-400 mt-1">{loadError}</p>
          <button onClick={load}
            className="mt-2 text-xs text-red-700 dark:text-red-300 underline hover:no-underline">
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Configuration Dashboard"
        description="Enterprise configuration overview — platform health, pending changes, and deployment status."
        icon={Layers}
      />

      {/* Two-column grid on wide screens */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <PlatformHealthSection  status={status} />
        <PendingChangesSection />
        <ConfigSummarySection   summary={summary} />
        <ValidationSection      validation={summary?.validation} />
        <ProviderOverviewSection summary={summary} />
        <PlatformInfoSection    summary={summary} status={status} />
      </div>
    </div>
  );
}
