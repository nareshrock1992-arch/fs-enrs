import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronRight, ShieldAlert } from 'lucide-react';
import { useAuthStore } from '../../store/authStore.js';
import { visibleNav } from '../../auth/permissions.js';
import { NAV, activeNavTarget } from './navigation.js';

function NavGroup({ item, activeTo }) {
  const containsActive = item.children.some(c => c.to === activeTo);
  const [open, setOpen] = useState(containsActive);
  // Navigating into a group (link elsewhere, back button) opens it.
  useEffect(() => { if (containsActive) setOpen(true); }, [containsActive]);
  const id = `nav-${item.label.replace(/\W+/g, '-').toLowerCase()}`;

  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-controls={id}
              className={`sidebar-link w-full text-left ${containsActive && !open ? 'text-text-primary' : ''}`}>
        {item.icon && <item.icon size={16} className="shrink-0" aria-hidden="true" />}
        <span className="flex-1">{item.label}</span>
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      </button>
      {open && (
        <div id={id} className="ml-4 mt-0.5 border-l border-surface-border pl-2 space-y-0.5">
          {item.children.map(c => (
            <NavLink key={c.to} to={c.to} aria-current={c.to === activeTo ? 'page' : undefined}
              className={() => `sidebar-link text-xs py-1.5 ${c.to === activeTo ? 'active' : ''}`}>
              {c.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * mode 'inline'  — desktop column; `open` false hides it.
 * mode 'overlay' — narrow screens; slides over the page with a backdrop and closes on
 *                  navigation, so the page keeps the full screen width.
 */
export default function Sidebar({ open = true, mode = 'inline', onClose }) {
  const user = useAuthStore(s => s.user);
  const location = useLocation();
  const visible = visibleNav(NAV, user);
  const activeTo = activeNavTarget(visible, location.pathname);

  useEffect(() => { if (mode === 'overlay') onClose?.(); }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (mode !== 'overlay' || !open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, open, onClose]);

  const panel = (
    <aside
      aria-label="Main navigation"
      className={mode === 'overlay'
        ? `fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] bg-surface-panel border-r border-surface-border flex flex-col shadow-lg
           transition-transform duration-200 ${open ? 'translate-x-0' : '-translate-x-full'}`
        : `bg-surface-panel border-r border-surface-border flex flex-col shrink-0 transition-all duration-200
           ${open ? 'w-64' : 'w-0 overflow-hidden border-r-0'}`}
      {...(mode === 'overlay' && !open ? { inert: '' } : {})}
    >
      <div className="px-4 py-4 border-b border-surface-border flex items-center gap-3">
        <div className="w-8 h-8 bg-brand rounded-lg flex items-center justify-center shrink-0">
          <ShieldAlert size={16} className="text-white" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-text-primary leading-tight truncate">fs-enrs</p>
          <p className="text-[10px] text-text-muted uppercase tracking-wide truncate">Emergency System</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
        {visible.map(item => item.children
          ? <NavGroup key={item.label} item={item} activeTo={activeTo} />
          : (
            <NavLink key={item.to} to={item.to} end={item.to === '/'}
                     className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
              {item.icon && <item.icon size={16} className="shrink-0" aria-hidden="true" />}
              {item.label}
            </NavLink>
          ))}
      </nav>

      <div className="px-3 py-3 border-t border-surface-border">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-brand/20 border border-brand/30
                          flex items-center justify-center text-brand text-xs font-bold shrink-0" aria-hidden="true">
            {(user?.fullName || user?.email || 'U')[0].toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-text-primary truncate">{user?.fullName || user?.email}</p>
            <p className="text-[10px] text-text-muted capitalize">{user?.role?.toLowerCase().replace('_', ' ')}</p>
          </div>
        </div>
      </div>
    </aside>
  );

  if (mode !== 'overlay') return panel;
  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/40" aria-hidden="true" onClick={onClose} />}
      {panel}
    </>
  );
}
