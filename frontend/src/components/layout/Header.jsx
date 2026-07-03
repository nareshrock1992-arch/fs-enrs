import { Menu, Sun, Moon, LogOut, KeyRound } from 'lucide-react';
import { useAuthStore } from '../../store/authStore.js';
import { useTheme } from '../../hooks/useTheme.js';
import { api } from '../../api/client.js';
import { useNavigate } from 'react-router-dom';

export default function Header({ onMenuToggle }) {
  const { isDark, toggle } = useTheme();
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
      <button onClick={onMenuToggle}
              className="btn-ghost p-1.5" aria-label="Toggle sidebar">
        <Menu size={16} />
      </button>

      <div className="flex-1" />

      <button onClick={toggle} className="btn-ghost p-1.5" aria-label="Toggle theme">
        {isDark ? <Sun size={16} /> : <Moon size={16} />}
      </button>

      <button onClick={() => navigate('/settings/password')} className="btn-ghost p-1.5"
              title="Change password">
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
        <button onClick={handleLogout} className="btn-ghost p-1.5 text-red-500 hover:bg-red-500/10"
                title="Logout">
          <LogOut size={16} />
        </button>
      </div>
    </header>
  );
}
