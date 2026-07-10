import { useState } from 'react';
import { CheckCircle2, Upload, History, Phone, AlertTriangle, Loader2, Save, FlaskConical } from 'lucide-react';
import Modal from '../../ui/Modal.jsx';
import { api } from '../../../api/client.js';

export default function BuilderToolbar({
  flow,
  dirty,
  saving,
  errors,
  warnings,
  onValidate,
  onPublished,
  onShowHistory,
  onShowBind,
  onFlowChange,
}) {
  const [showPublish, setShowPublish] = useState(false);
  const [changeNotes, setChangeNotes] = useState('');
  const [publishing,  setPublishing]  = useState(false);
  const [pubError,    setPubError]    = useState('');
  const [validating,  setValidating]  = useState(false);
  const [lastValidation, setLastValidation] = useState(null);
  const [savingTestFlag, setSavingTestFlag] = useState(false);

  async function toggleTestFlow() {
    if (!flow?.flow_uuid) return;
    setSavingTestFlag(true);
    try {
      const r = await api.ivr.update(flow.flow_uuid, { is_test_flow: !flow.is_test_flow });
      onFlowChange?.(r.flow);
    } catch (e) {
      alert(e.message);
    } finally {
      setSavingTestFlag(false);
    }
  }

  const errorCount   = Object.values(errors).flat().filter(e => e && !e.startsWith('__')).length
    + (errors.__global?.length || 0);
  const latestVer    = flow?.latest_version;

  async function handleValidate() {
    setValidating(true);
    const result = await onValidate();
    setLastValidation(result);
    setValidating(false);
  }

  async function handlePublish() {
    setPubError('');
    setPublishing(true);
    try {
      const r = await api.ivr.publish(flow.flow_uuid, changeNotes);
      onPublished?.(r.version);
      setShowPublish(false);
      setChangeNotes('');
      setLastValidation(null);
    } catch (e) {
      setPubError(e.data?.errors?.join(' · ') || e.message || 'Publish failed');
    } finally {
      setPublishing(false);
    }
  }

  // Open publish modal — auto-validate first
  async function openPublish() {
    setLastValidation(null);
    setPubError('');
    setShowPublish(true);
    setValidating(true);
    const result = await onValidate();
    setLastValidation(result);
    setValidating(false);
  }

  return (
    <>
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-surface-border
                      bg-surface-panel shrink-0 min-w-0 overflow-x-auto">
        {/* Flow name */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-text-primary truncate">
            {flow?.name || 'IVR Flow'}
          </p>
          <p className="text-[10px] text-text-muted">
            {flow?.organization_name || 'IVR Builder'}
          </p>
        </div>

        {/* Save status */}
        <div className="flex items-center gap-1 text-[10px] shrink-0">
          {saving && <><Loader2 size={11} className="animate-spin text-text-muted" /><span className="text-text-muted">Saving…</span></>}
          {!saving && dirty && <><Save size={11} className="text-yellow-500" /><span className="text-yellow-500">Unsaved</span></>}
          {!saving && !dirty && <span className="text-text-muted">Saved</span>}
        </div>

        {/* Published version pill */}
        <div className={`text-[10px] px-2.5 py-1 rounded-full font-medium shrink-0
          ${latestVer
            ? 'bg-green-500/15 text-green-500 border border-green-500/20'
            : 'bg-surface-hover text-text-muted border border-surface-border'}`}>
          {latestVer ? `● Published v${latestVer.version_number}` : '○ Draft'}
        </div>

        {/* Error badge */}
        {errorCount > 0 && (
          <div className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-full
                          bg-red-500/15 text-red-400 border border-red-500/20 shrink-0">
            <AlertTriangle size={10} /> {errorCount} error{errorCount !== 1 ? 's' : ''}
          </div>
        )}

        {/* Validate */}
        <button
          onClick={handleValidate}
          disabled={validating}
          className="btn-ghost text-xs flex items-center gap-1.5 px-3 py-1.5 shrink-0"
        >
          {validating
            ? <Loader2 size={12} className="animate-spin" />
            : <CheckCircle2 size={12} />}
          Validate
        </button>

        {/* History */}
        <button
          onClick={onShowHistory}
          className="btn-ghost text-xs flex items-center gap-1.5 px-3 py-1.5 shrink-0"
        >
          <History size={12} /> History
        </button>

        {/* Bind numbers */}
        <button
          onClick={onShowBind}
          className="btn-ghost text-xs flex items-center gap-1.5 px-3 py-1.5 shrink-0"
        >
          <Phone size={12} />
          <span>{flow?.bound_numbers?.length || 0} numbers</span>
        </button>

        {/* Test Flow toggle — marks this flow eligible for the Test Mode
            caller-ID override at deploy time (Settings → Test Mode) */}
        <button
          onClick={toggleTestFlow}
          disabled={savingTestFlag}
          title="Mark this flow as a test flow — eligible for the Test Mode caller-ID override"
          className={`flex items-center gap-1.5 text-[10px] px-2.5 py-1.5 rounded-full font-medium
                     border shrink-0 transition-colors disabled:opacity-50
                     ${flow?.is_test_flow
                       ? 'bg-amber-500/15 text-amber-500 border-amber-500/30'
                       : 'bg-surface-hover text-text-muted border-surface-border'}`}
        >
          <FlaskConical size={11} />
          {flow?.is_test_flow ? 'Test Flow' : 'Mark as Test'}
        </button>

        {/* Publish */}
        <button
          onClick={openPublish}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg
                     bg-brand text-white hover:bg-brand/90 font-medium transition-colors shrink-0"
        >
          <Upload size={12} /> Publish
        </button>
      </div>

      {/* Validation warnings bar */}
      {warnings.length > 0 && (
        <div className="px-4 py-1.5 bg-yellow-500/10 border-b border-yellow-500/20 flex items-center gap-2">
          <AlertTriangle size={11} className="text-yellow-500 shrink-0" />
          <p className="text-[10px] text-yellow-500 truncate">{warnings[0]}</p>
          {warnings.length > 1 && (
            <span className="text-[10px] text-yellow-500 shrink-0">+{warnings.length - 1} more</span>
          )}
        </div>
      )}

      {/* Publish modal */}
      {showPublish && (
        <Modal title="Publish Flow" onClose={() => setShowPublish(false)} size="sm">
          <div className="space-y-4">
            <p className="text-xs text-text-muted">
              Publishing <strong className="text-text-primary">"{flow?.name}"</strong> will make
              this version live on FreeSWITCH immediately on the next inbound call.
            </p>

            {/* Validation summary */}
            <div className={`rounded-lg px-3 py-2.5 text-xs border
              ${validating ? 'bg-surface border-surface-border text-text-muted'
                : lastValidation?.valid
                ? 'bg-green-500/10 border-green-500/20 text-green-500'
                : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
              {validating && <span className="flex items-center gap-1.5"><Loader2 size={11} className="animate-spin" /> Validating graph…</span>}
              {!validating && lastValidation?.valid && (
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 size={11} />
                  Valid — {lastValidation.stats?.node_count || 0} nodes, no errors
                  {lastValidation.warnings?.length > 0 && ` · ${lastValidation.warnings.length} warning(s)`}
                </span>
              )}
              {!validating && lastValidation && !lastValidation.valid && (
                <div>
                  <p className="font-medium mb-1">Graph has errors — fix before publishing:</p>
                  {lastValidation.errors?.slice(0, 3).map((e, i) => (
                    <p key={i} className="text-[10px]">• {e}</p>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs text-text-muted mb-1.5">Change notes (optional)</label>
              <textarea
                value={changeNotes}
                onChange={e => setChangeNotes(e.target.value)}
                placeholder="e.g. Added retry loop for invalid DTMF"
                rows={3}
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2
                           text-xs text-text-primary placeholder:text-text-muted focus:outline-none
                           focus:border-brand resize-none"
              />
            </div>

            {pubError && (
              <p className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg border border-red-500/20">
                {pubError}
              </p>
            )}

            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowPublish(false)} className="btn-ghost text-sm px-4 py-2">
                Cancel
              </button>
              <button
                onClick={handlePublish}
                disabled={publishing || validating || (lastValidation && !lastValidation.valid)}
                className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg
                           bg-brand text-white hover:bg-brand/90 font-medium transition-colors
                           disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {publishing
                  ? <><Loader2 size={13} className="animate-spin" /> Publishing…</>
                  : <>
                      <Upload size={13} />
                      Publish v{(latestVer?.version_number || 0) + 1}
                    </>}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
