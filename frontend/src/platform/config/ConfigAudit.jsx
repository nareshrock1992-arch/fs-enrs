import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck, AlertCircle } from 'lucide-react';
import { api } from '../../api/client.js';

const ACTION_COLOR = {
  deploy:   'bg-brand/10 text-brand',
  rollback: 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300',
  preview:  'bg-surface-bg text-text-muted',
  read:     'bg-surface-bg text-text-muted',
};

const STATUS_COLOR = {
  success: 'text-emerald-600 dark:text-emerald-400',
  failed:  'text-red-600 dark:text-red-400',
};

/**
 * ConfigAudit — audit log table for a single provider.
 */
export default function ConfigAudit({ providerId }) {
  const [entries,    setEntries]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [loadError,  setLoadError]  = useState(null);

  const load = useCallback(async () => {
    if (!providerId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.platformConfig.audit(providerId);
      setEntries(data.audit ?? []);
    } catch (err) {
      setLoadError(err?.message ?? 'Failed to load audit log.');
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-text-muted py-4">
        <ShieldCheck size={14} />
        Loading audit log…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 py-4">
        <AlertCircle size={14} className="shrink-0 mt-0.5" />
        {loadError}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="text-xs text-text-muted py-4 italic">
        No audit entries yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-surface-border">
            <th className="text-left py-2 pr-3 font-semibold text-text-muted uppercase tracking-wide text-[10px]">Time</th>
            <th className="text-left py-2 pr-3 font-semibold text-text-muted uppercase tracking-wide text-[10px]">Action</th>
            <th className="text-left py-2 pr-3 font-semibold text-text-muted uppercase tracking-wide text-[10px]">User</th>
            <th className="text-left py-2 pr-3 font-semibold text-text-muted uppercase tracking-wide text-[10px]">Status</th>
            <th className="text-left py-2 font-semibold text-text-muted uppercase tracking-wide text-[10px]">Duration</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(e => (
            <tr key={e.id} className="border-b border-surface-border hover:bg-surface-panel transition-colors">
              <td className="py-2 pr-3 text-text-muted whitespace-nowrap">
                {new Date(e.performed_at).toLocaleString()}
              </td>
              <td className="py-2 pr-3">
                <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold
                  ${ACTION_COLOR[e.action] ?? 'bg-surface-bg text-text-muted'}`}>
                  {e.action}
                </span>
              </td>
              <td className="py-2 pr-3 text-text-muted">
                {e.user_name ?? e.user_email ?? '—'}
              </td>
              <td className="py-2 pr-3">
                <span className={`font-medium ${STATUS_COLOR[e.status] ?? ''}`}>
                  {e.status}
                </span>
                {e.error && (
                  <span className="block text-red-500 dark:text-red-400 truncate max-w-48" title={e.error}>
                    {e.error}
                  </span>
                )}
              </td>
              <td className="py-2 text-text-muted">
                {e.duration_ms != null ? `${e.duration_ms}ms` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
