import { useEffect, useRef } from 'react';
import { AlertTriangle, Info } from 'lucide-react';

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
  const confirmBtnRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onCancel?.(); };
    window.addEventListener('keydown', handler);
    // Auto-focus the cancel button (safest default for destructive dialogs)
    setTimeout(() => confirmBtnRef.current?.focus(), 50);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  if (!open) return null;

  const icon = variant === 'info'
    ? <Info size={20} className="text-blue-500" />
    : <AlertTriangle size={20} className={variant === 'danger' ? 'text-red-500' : 'text-amber-500'} />;

  const confirmClass = variant === 'danger' ? 'btn-danger' : variant === 'warning' ? 'btn bg-amber-600 text-white hover:bg-amber-700' : 'btn-primary';

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
        aria-hidden="true"
        onClick={onCancel}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
      >
        <div className="card w-full max-w-sm p-5 pointer-events-auto shadow-2xl">
          <div className="flex gap-3 items-start mb-3">
            <div className="shrink-0 mt-0.5">{icon}</div>
            <div>
              <h3 id="confirm-title" className="text-sm font-semibold text-text-primary">{title}</h3>
              {message && <p className="text-xs text-text-secondary mt-1 leading-relaxed">{message}</p>}
            </div>
          </div>
          <div className="flex gap-2 justify-end mt-4">
            <button className="btn-secondary text-xs px-3 py-1.5" onClick={onCancel} disabled={loading}>
              {cancelLabel}
            </button>
            <button
              ref={confirmBtnRef}
              className={`${confirmClass} text-xs px-3 py-1.5`}
              onClick={onConfirm}
              disabled={loading}
            >
              {loading ? 'Working…' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
