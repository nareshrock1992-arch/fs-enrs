import { X, AlertCircle, CheckCircle2 } from 'lucide-react';
import { create } from 'zustand';

// Non-blocking notices. A browser alert box stops the page until dismissed: wrong on a live
// monitor; a notice stays on screen while the operator keeps working.
const useToasts = create((set) => ({
  toasts: [],
  add: (toast) => set((s) => ({ toasts: [...s.toasts, toast].slice(-5) })),
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

let nextId = 1;
export function notify(message, type = 'error') {
  const text = String(message);
  if (useToasts.getState().toasts.some((t) => t.message === text)) return;   // already on screen
  const id = nextId++;
  useToasts.getState().add({ id, message: text, type });
  if (type === 'success') setTimeout(() => useToasts.getState().remove(id), 5000);   // errors stay until read
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const remove = useToasts((s) => s.remove);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} role={t.type === 'error' ? 'alert' : undefined}
             className="card flex items-start gap-2 border border-surface-border text-sm">
          {t.type === 'error'
            ? <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-500" />
            : <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-500" />}
          <p className="flex-1 break-words text-text-primary">{t.message}</p>
          <button type="button" className="btn-ghost p-1" aria-label="Dismiss" onClick={() => remove(t.id)}><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
