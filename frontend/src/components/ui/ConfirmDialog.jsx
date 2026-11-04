import { useEffect, useId, useRef } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { create } from 'zustand';

/**
 * Confirmation dialog — blocks destructive actions.
 * variant: 'danger' | 'warning' | 'info'
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel  = 'Cancel',
  variant      = 'danger',
  loading      = false,
  onConfirm,
  onCancel,
}) {
  const cancelBtnRef = useRef(null);
  const confirmBtnRef = useRef(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onCancel?.(); };
    window.addEventListener('keydown', handler);
    // Destructive dialogs start on Cancel, so a stray Enter cannot confirm them.
    const t = setTimeout(() => (variant === 'info' ? confirmBtnRef : cancelBtnRef).current?.focus(), 30);
    return () => { clearTimeout(t); window.removeEventListener('keydown', handler); };
  }, [open, onCancel, variant]);

  if (!open) return null;

  const icon = variant === 'info'
    ? <Info size={20} className="text-info" aria-hidden="true" />
    : <AlertTriangle size={20} className={variant === 'danger' ? 'text-danger' : 'text-warning'} aria-hidden="true" />;

  const confirmClass = variant === 'danger' ? 'btn-danger' : variant === 'warning' ? 'btn bg-warning text-white hover:opacity-90' : 'btn-primary';

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40" aria-hidden="true" onClick={onCancel} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? messageId : undefined}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
      >
        <div className="card w-full max-w-md p-5 pointer-events-auto shadow-lg">
          <div className="flex gap-3 items-start mb-3">
            <div className="shrink-0 mt-0.5">{icon}</div>
            <div className="min-w-0">
              <h3 id={titleId} className="text-sm font-semibold text-text-primary">{title}</h3>
              {message && <p id={messageId} className="text-sm text-text-secondary mt-1 leading-relaxed whitespace-pre-line break-words">{message}</p>}
            </div>
          </div>
          <div className="flex gap-2 justify-end mt-4">
            <button ref={cancelBtnRef} type="button" className="btn-secondary btn-sm" onClick={onCancel} disabled={loading}>
              {cancelLabel}
            </button>
            <button ref={confirmBtnRef} type="button" className={`${confirmClass} btn-sm`} onClick={onConfirm} disabled={loading}>
              {loading ? 'Working…' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Promise-based confirmation ────────────────────────────────────────────────
// The browser's own confirm box stops the page — wrong on a live monitor, where events must keep
// arriving while the operator decides. confirmAction() shows the shared dialog and
// resolves true (confirmed) or false (cancelled, Escape, backdrop).
const useConfirm = create((set) => ({ request: null, set: (request) => set({ request }) }));

export function confirmAction({ title = 'Are you sure?', message, confirmLabel = 'Confirm', cancelLabel, variant = 'danger' } = {}) {
  return new Promise((resolve) => {
    const previous = useConfirm.getState().request;
    previous?.resolve(false);   // a newer question replaces an unanswered one
    useConfirm.getState().set({ title, message, confirmLabel, cancelLabel, variant, resolve });
  });
}

export function ConfirmHost() {
  const request = useConfirm((s) => s.request);
  const clear = useConfirm((s) => s.set);
  if (!request) return null;
  const answer = (value) => { clear(null); request.resolve(value); };
  return (
    <ConfirmDialog
      open
      title={request.title}
      message={request.message}
      confirmLabel={request.confirmLabel}
      cancelLabel={request.cancelLabel}
      variant={request.variant}
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
    />
  );
}
