import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Workflow, Plus, Pencil, Trash2, Search, Phone,
  LayoutTemplate, ChevronLeft, ChevronRight, Loader2,
} from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Modal from '../../components/ui/Modal.jsx';
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
  const [flows,      setFlows]      = useState([]);
  const [total,      setTotal]      = useState(0);
  const [search,     setSearch]     = useState('');
  const [page,       setPage]       = useState(1);
  const [loading,    setLoading]    = useState(true);
  const [templates,  setTemplates]  = useState([]);
  const [tplLoading, setTplLoading] = useState(false);
  const PAGE_SIZE = 20;
  const navigate = useNavigate();
  const user           = useAuthStore(s => s.user);
  const activeTenantId = useAuthStore(s => s.activeTenantId);
  const canEdit = user?.role === 'ADMIN' || user?.role === 'SUPERVISOR';

  // ── Create flow modal ────────────────────────────────────────────────────────
  const [showCreate,  setShowCreate]  = useState(false);
  const [createName,  setCreateName]  = useState('');
  const [createError, setCreateError] = useState('');
  const [creating,    setCreating]    = useState(false);

  // ── Template creation modal ──────────────────────────────────────────────────
  const [tplModal, setTplModal] = useState(null); // null | template object
  const [tplName,  setTplName]  = useState('');
  const [tplError, setTplError] = useState('');

  // ── Rename modal ─────────────────────────────────────────────────────────────
  const [renameTarget, setRenameTarget] = useState(null); // null | flow object
  const [renameName,   setRenameName]   = useState('');
  const [renameError,  setRenameError]  = useState('');
  const [renaming,     setRenaming]     = useState(false);

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
  }, [search, page, activeTenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [search]);

  useEffect(() => {
    if (!canEdit) return;
    api.ivr.listTemplates()
      .then(r => setTemplates(r.templates || []))
      .catch(() => {});
  }, [canEdit]);

  // ── Create flow ──────────────────────────────────────────────────────────────

  function openCreateModal() {
    setCreateName('');
    setCreateError('');
    setShowCreate(true);
  }

  async function handleCreate(e) {
    e.preventDefault();
    const name = createName.trim();
    if (!name) { setCreateError('Flow name is required.'); return; }
    setCreating(true);
    setCreateError('');
    try {
      const { flow } = await api.ivr.create({ name });
      setShowCreate(false);
      navigate(`/ivr/${flow.flow_uuid}`);
    } catch (err) {
      setCreateError(err.message || 'Failed to create flow.');
    } finally {
      setCreating(false);
    }
  }

  // ── Create from template ─────────────────────────────────────────────────────

  function openTplModal(tpl) {
    setTplModal(tpl);
    setTplName(tpl.name);
    setTplError('');
  }

  async function handleCreateFromTemplate(e) {
    e.preventDefault();
    const name = tplName.trim() || tplModal.name;
    setTplLoading(true);
    setTplError('');
    try {
      const r = await api.ivr.createFromTemplate(tplModal.id, name);
      setTplModal(null);
      navigate(`/ivr/${r.flow_uuid}`);
    } catch (err) {
      setTplError(err.message || 'Failed to create from template.');
    } finally {
      setTplLoading(false);
    }
  }

  // ── Rename flow ──────────────────────────────────────────────────────────────

  function openRenameModal(flow) {
    setRenameTarget(flow);
    setRenameName(flow.name);
    setRenameError('');
  }

  async function handleRename(e) {
    e.preventDefault();
    const name = renameName.trim();
    if (!name) { setRenameError('Flow name is required.'); return; }
    if (name === renameTarget.name) { setRenameTarget(null); return; }
    setRenaming(true);
    setRenameError('');
    try {
      await api.ivr.update(renameTarget.flow_uuid, { name });
      setRenameTarget(null);
      load();
    } catch (err) {
      setRenameError(err.message || 'Failed to rename flow.');
    } finally {
      setRenaming(false);
    }
  }

  // ── Delete flow ──────────────────────────────────────────────────────────────

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
          <button onClick={openCreateModal} className="btn-primary">
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
            <button onClick={openCreateModal} className="mt-3 text-xs text-brand hover:underline">
              Create your first flow
            </button>
          )}
        </div>
      )}

      <div className="space-y-2">
        {flows.map(flow => (
          <div
            key={flow.flow_uuid}
            className="card flex items-center gap-4 hover:bg-surface-hover transition-colors
                       cursor-pointer group"
            onClick={() => navigate(`/ivr/${flow.flow_uuid}`)}
          >
            {/* Icon */}
            <div className="w-10 h-10 rounded-xl bg-brand/10 border border-brand/20
                            flex items-center justify-center shrink-0">
              <Workflow size={16} className="text-brand" />
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold text-text-primary truncate">{flow.name}</p>
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

            {/* Actions — stopPropagation so they don't trigger the card-level navigate */}
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={e => { e.stopPropagation(); navigate(`/ivr/${flow.flow_uuid}`); }}
                className="btn-ghost p-2 text-text-muted hover:text-brand"
                title="Open in builder"
              >
                <Pencil size={14} />
              </button>
              {canEdit && (
                <button
                  onClick={e => { e.stopPropagation(); openRenameModal(flow); }}
                  className="btn-ghost px-2 py-1.5 text-[11px] text-text-muted hover:text-brand"
                  title="Rename flow"
                >
                  Rename
                </button>
              )}
              {canEdit && (
                <button
                  onClick={e => { e.stopPropagation(); deleteFlow(flow); }}
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

      {/* Templates */}
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
                onClick={() => openTplModal(tpl)}
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

      {/* ── Create Flow modal ────────────────────────────────────────────────── */}
      {showCreate && (
        <Modal title="Create IVR Flow" onClose={() => setShowCreate(false)} size="sm">
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1.5 uppercase tracking-wide">
                Flow Name
              </label>
              <input
                autoFocus
                value={createName}
                onChange={e => { setCreateName(e.target.value); setCreateError(''); }}
                placeholder="e.g. Main Helpdesk IVR"
                maxLength={128}
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2
                           text-sm text-text-primary placeholder:text-text-muted focus:outline-none
                           focus:border-brand transition-colors"
              />
              {createError && (
                <p className="text-xs text-red-400 mt-1.5">{createError}</p>
              )}
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="btn-ghost text-sm px-4 py-2"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating}
                className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg
                           bg-brand text-white hover:bg-brand/90 font-medium transition-colors
                           disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating
                  ? <><Loader2 size={13} className="animate-spin" /> Creating…</>
                  : <><Plus size={13} /> Create Flow</>}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── Create from Template modal ───────────────────────────────────────── */}
      {tplModal && (
        <Modal
          title={`Create from Template`}
          onClose={() => setTplModal(null)}
          size="sm"
        >
          <form onSubmit={handleCreateFromTemplate} className="space-y-4">
            <p className="text-xs text-text-muted">
              Template: <strong className="text-text-primary">{tplModal.name}</strong>
              {tplModal.node_count ? ` · ${tplModal.node_count} nodes` : ''}
            </p>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1.5 uppercase tracking-wide">
                Flow Name
              </label>
              <input
                autoFocus
                value={tplName}
                onChange={e => { setTplName(e.target.value); setTplError(''); }}
                placeholder={tplModal.name}
                maxLength={128}
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2
                           text-sm text-text-primary placeholder:text-text-muted focus:outline-none
                           focus:border-brand transition-colors"
              />
              {tplError && (
                <p className="text-xs text-red-400 mt-1.5">{tplError}</p>
              )}
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <button
                type="button"
                onClick={() => setTplModal(null)}
                className="btn-ghost text-sm px-4 py-2"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={tplLoading}
                className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg
                           bg-brand text-white hover:bg-brand/90 font-medium transition-colors
                           disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {tplLoading
                  ? <><Loader2 size={13} className="animate-spin" /> Creating…</>
                  : <><Plus size={13} /> Create Flow</>}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── Rename Flow modal ────────────────────────────────────────────────── */}
      {renameTarget && (
        <Modal title="Rename Flow" onClose={() => setRenameTarget(null)} size="sm">
          <form onSubmit={handleRename} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1.5 uppercase tracking-wide">
                New Name
              </label>
              <input
                autoFocus
                value={renameName}
                onChange={e => { setRenameName(e.target.value); setRenameError(''); }}
                maxLength={128}
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2
                           text-sm text-text-primary placeholder:text-text-muted focus:outline-none
                           focus:border-brand transition-colors"
              />
              {renameError && (
                <p className="text-xs text-red-400 mt-1.5">{renameError}</p>
              )}
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <button
                type="button"
                onClick={() => setRenameTarget(null)}
                className="btn-ghost text-sm px-4 py-2"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={renaming}
                className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg
                           bg-brand text-white hover:bg-brand/90 font-medium transition-colors
                           disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {renaming
                  ? <><Loader2 size={13} className="animate-spin" /> Saving…</>
                  : 'Save Name'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
