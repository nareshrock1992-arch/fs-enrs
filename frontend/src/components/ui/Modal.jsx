import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

export default function Modal({ title, onClose, children, size = 'md' }) {
  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };
  const titleId = useId();
  const panelRef = useRef(null);

  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    // Move focus into the dialog unless a field inside already took it (autoFocus).
    if (!panelRef.current?.contains(document.activeElement)) panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}
           className={`bg-surface-panel border border-surface-border rounded-xl shadow-lg outline-none
                       w-full ${widths[size]} max-h-[90vh] flex flex-col`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border shrink-0">
          <h2 id={titleId} className="text-base font-semibold text-text-primary">{title}</h2>
          <button type="button" onClick={onClose} className="btn-ghost p-1" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="overflow-y-auto flex-1 p-5">{children}</div>
      </div>
    </div>
  );
}
