import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/**
 * Enterprise slide-over drawer.
 * Sizes: 'sm' (384px), 'md' (480px), 'lg' (600px), 'xl' (740px)
 */
const WIDTHS = { sm: 384, md: 480, lg: 600, xl: 740 };

export default function Drawer({ open, onClose, title, subtitle, size = 'md', children, footer }) {
  const width   = WIDTHS[size] || WIDTHS.md;
  const panelRef = useRef(null);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Focus trap
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 40,
          background: 'rgba(0,0,0,0.45)',
          backdropFilter: 'blur(2px)',
          transition: 'opacity 0.2s',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'all' : 'none',
        }}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width, zIndex: 50,
          display: 'flex', flexDirection: 'column',
          transform: open ? 'translateX(0)' : `translateX(${width}px)`,
          transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1)',
          outline: 'none',
        }}
        className="bg-surface-panel border-l border-surface-border shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-surface-border shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
            {subtitle && <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="btn-ghost p-1.5 -mr-1 -mt-0.5 text-text-muted"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="px-5 py-3 border-t border-surface-border shrink-0 flex gap-2 justify-end bg-surface-raised/50">
            {footer}
          </div>
        )}
      </div>
    </>
  );
}
