import { notify } from '../ui/Toast.jsx';
import { useState, useEffect, useRef } from 'react';
import { Menu, Sun, Moon, LogOut, KeyRound, Building2, ChevronDown } from 'lucide-react';
import { useAuthStore } from '../../store/authStore.js';
import { useTheme } from '../../hooks/useTheme.js';
import { api } from '../../api/client.js';
import { useNavigate } from 'react-router-dom';
import ChangePasswordDialog from './ChangePasswordDialog.jsx';

export default function Header({ onMenuToggle, menuOpen }) {
  const { isDark, toggle } = useTheme();
  const [pwOpen, setPwOpen] = useState(false);
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  async function handleLogout() {
    try { await api.logout(); } catch {}
    logout();
    navigate('/login');
  }

  return (
    <header className="h-12 bg-surface-panel border-b border-surface-border
                       flex items-center gap-2 px-3 shrink-0">
      <button type="button" onClick={onMenuToggle} aria-expanded={menuOpen}
              className="btn-ghost p-1.5" aria-label="Toggle navigation">
        <Menu size={16} />
      </button>

      <div className="flex-1" />

      {user?.role === 'SUPER_ADMIN' && <TenantSelector />}

      <button type="button" onClick={toggle} className="btn-ghost p-1.5" aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}>
        {isDark ? <Sun size={16} /> : <Moon size={16} />}
      </button>

      {/* There is no password page; the dialog uses the change-password API directly. */}
      <button type="button" onClick={() => setPwOpen(true)} className="btn-ghost p-1.5"
              title="Change password" aria-label="Change password">
        <KeyRound size={16} />
      </button>

      <div className="flex items-center gap-2 pl-1 border-l border-surface-border ml-1">
        <div className="text-right hidden sm:block">
          <p className="text-xs font-medium text-text-primary leading-tight">
            {user?.fullName || user?.email}
          </p>
          <p className="text-[10px] text-text-muted capitalize">
            {user?.role?.toLowerCase()}
          </p>
        </div>
        <button type="button" onClick={handleLogout} className="btn-ghost p-1.5 text-red-500 hover:bg-red-500/10"
                title="Sign out" aria-label="Sign out">
          <LogOut size={16} />
        </button>
      </div>
      {pwOpen && <ChangePasswordDialog onClose={() => setPwOpen(false)} />}
    </header>
  );
}

function TenantSelector() {
  const { activeTenantId, activeTenantName, setActiveTenant } = useAuthStore();
  const [open, setOpen]       = useState(false);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  async function openDropdown() {
    setOpen(v => !v);
    if (tenants.length === 0) {
      setLoading(true);
      try {
        // Use raw fetch to avoid injecting tenant_id into this list call
        const token = localStorage.getItem('enrs_token');
        const res = await fetch('/api/v1/tenants?limit=1000', {
          credentials: 'include',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const d = await res.json();
        setTenants(d.tenants || []);
      } catch (e) { notify(`Tenant list could not be loaded: ${e.message}`); }
      setLoading(false);
    }
  }

  function select(id, name) {
    setActiveTenant(id, name);
    setOpen(false);
  }

  const label = activeTenantName ? activeTenantName : 'All Tenants';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={openDropdown}
        className="btn-ghost px-2 py-1 flex items-center gap-1.5 text-xs font-medium border border-surface-border rounded-md"
        title="Select operating tenant"
      >
        <Building2 size={13} className="text-brand" />
        <span className="max-w-[120px] truncate">{label}</span>
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-52 bg-surface border border-surface-border rounded-lg shadow-lg z-50 py-1">
          <button
            onClick={() => select(null, null)}
            className={`w-full text-left px-3 py-2 text-xs hover:bg-surface-panel ${!activeTenantId ? 'text-brand font-medium' : 'text-text-primary'}`}
          >
            All Tenants
          </button>
          <div className="border-t border-surface-border my-1" />
          {loading && <p className="px-3 py-2 text-xs text-text-muted">Loading…</p>}
          {tenants.map(t => (
            <button
              key={t.id}
              onClick={() => select(t.id, t.name)}
              className={`w-full text-left px-3 py-2 text-xs hover:bg-surface-panel ${activeTenantId === t.id ? 'text-brand font-medium' : 'text-text-primary'}`}
            >
              <span className="block truncate">{t.name}</span>
              <span className="text-[10px] text-text-muted font-mono">{t.code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
