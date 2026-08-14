import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Workflow, Plus, Pencil, Trash2, Search, Phone, LayoutTemplate, ChevronLeft, ChevronRight } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader.jsx';
import { api } from '../../api/client.js';
import { useAuthStore } from '../../store/authStore.js';

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000)    return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

export default function IvrList() {
  const [flows,     setFlows]     = useState([]);
  const [total,     setTotal]     = useState(0);
  const [search,    setSearch]    = useState('');
  const [page,      setPage]      = useState(1);
  const [loading,   setLoading]   = useState(true);
  const [templates, setTemplates] = useState([]);
  const [tplLoading, setTplLoading] = useState(false);
  const PAGE_SIZE = 20;
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const canEdit = user?.role === 'ADMIN' || user?.role === 'SUPERVISOR';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.ivr.list({ search: search || undefined, page, limit: PAGE_SIZE });
      setFlows(r.flows || []);
      setTotal(r.total || 0);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [search, page]);

  useEffect(() => { load(); }, [load]);

  // Reset to page 1 whenever the search term changes
  useEffect(() => { setPage(1); }, [search]);

  useEffect(() => {
    if (!canEdit) return;
    api.ivr.listTemplates()
      .then(r => setTemplates(r.templates || []))
      .catch(() => {});
  }, [canEdit]);

  async function createFlow() {
    const name = window.prompt('Flow name:');
    if (!name?.trim()) return;
    try {
      const { flow } = await api.ivr.create({ name: name.trim() });
      navigate(`/ivr/${flow.flow_uuid}`);
    } catch (e) {
      alert(e.message);
    }
  }

  async function createFromTemplate(tpl) {
    const name = window.prompt(`Flow name for "${tpl.name}":`, tpl.name);
    if (name === null) return;
    setTplLoading(true);
    try {
      const r = await api.ivr.createFromTemplate(tpl.id, name.trim() || tpl.name);
      navigate(`/ivr/${r.flow_uuid}`);
    } catch (e) {
      alert(e.message);
    } finally {
      setTplLoading(false);
    }
  }

  async function deleteFlow(flow) {
    if (!window.confirm(`Delete "${flow.name}"? This will unbind all numbers.`)) return;
    try {
      await api.ivr.delete(flow.flow_uuid);
      load();
    } catch (e) {
      alert(e.message);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="IVR Flows"
        description={`${total} flow${total !== 1 ? 's' : ''} configured`}
        icon={Workflow}
      >
        {canEdit && (
          <button onClick={createFlow} className="btn-primary">
            <Plus size={14} /> New Flow
          </button>
        )}
      </PageHeader>

      {/* Search */}
      <div className="relative max-w-xs">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search flows…"
          className="input-sm pl-8"
        />
      </div>

      {/* List */}
      {loading && (
        <div className="text-center py-12 text-text-muted text-sm">Loading…</div>
      )}

      {!loading && flows.length === 0 && (
        <div className="card text-center py-12">
          <Workflow size={32} className="mx-auto text-text-muted mb-3" />
          <p className="text-sm text-text-muted">{search ? 'No flows match your search' : 'No IVR flows yet'}</p>
          {canEdit && !search && (
            <button onClick={createFlow}
                    className="mt-3 text-xs text-brand hover:underline">
              Create your first flow
            </button>
          )}
        </div>
      )}

      <div className="space-y-2">
        {flows.map(flow => (
          <div key={flow.flow_uuid}
               className="card flex items-center gap-4 hover:bg-surface-hover transition-colors">
            {/* Icon */}
            <div className="w-10 h-10 rounded-xl bg-brand/10 border border-brand/20
                            flex items-center justify-center shrink-0">
              <Workflow size={16} className="text-brand" />
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold text-text-primary truncate">{flow.name}</p>
                {/* Publish status */}
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium
                  ${flow.latest_version
                    ? 'bg-green-500/15 text-green-500 border border-green-500/20'
                    : 'bg-surface-hover text-text-muted border border-surface-border'}`}>
                  {flow.latest_version
                    ? `● Published v${flow.latest_version}`
                    : '○ Draft'}
                </span>
              </div>
              <div className="flex items-center gap-3 mt-0.5 text-[10px] text-text-muted">
                <span>Updated {fmt(flow.updated_at)}</span>
                {flow.organization_name && <span>{flow.organization_name}</span>}
                {flow.bound_number_count > 0 && (
                  <span className="flex items-center gap-1">
                    <Phone size={9} /> {flow.bound_number_count} number{flow.bound_number_count !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => navigate(`/ivr/${flow.flow_uuid}`)}
                className="btn-ghost p-2 text-text-muted hover:text-brand"
                title="Edit flow"
              >
                <Pencil size={14} />
              </button>
              {canEdit && (
                <button
                  onClick={() => deleteFlow(flow)}
                  className="btn-ghost p-2 text-text-muted hover:text-red-400"
                  title="Delete flow"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-text-muted pt-1">
          <span>
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total} flows
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="btn-ghost p-1 disabled:opacity-40"
              aria-label="Previous page"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="px-2">Page {page} of {Math.ceil(total / PAGE_SIZE)}</span>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={page * PAGE_SIZE >= total}
              className="btn-ghost p-1 disabled:opacity-40"
              aria-label="Next page"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Templates — always shown for editors as a creation shortcut, never mixed with flows */}
      {!loading && canEdit && !search && templates.length > 0 && (
        <div className="mt-6 space-y-2">
          <div className="flex items-center gap-2 text-text-muted text-xs mb-3">
            <LayoutTemplate size={12} />
            <span>Start from a template</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {templates.map(tpl => (
              <button
                key={tpl.id}
                disabled={tplLoading}
                onClick={() => createFromTemplate(tpl)}
                className="card text-left hover:bg-surface-hover transition-colors p-4 disabled:opacity-50"
              >
                <div className="flex items-center gap-2 mb-1">
                  <LayoutTemplate size={13} className="text-brand shrink-0" />
                  <span className="text-xs font-semibold text-text-primary truncate">{tpl.name}</span>
                </div>
                <p className="text-[10px] text-text-muted line-clamp-2">{tpl.description}</p>
                <p className="text-[9px] text-text-muted mt-2">{tpl.node_count} nodes</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
