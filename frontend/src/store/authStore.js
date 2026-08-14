import { create } from 'zustand';

const TOKEN_KEY         = 'enrs_token';
const USER_KEY          = 'enrs_user';
const ACTIVE_TENANT_KEY = 'enrs_active_tenant';

function loadStored() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const user  = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    if (!token || !user) return { token: null, user: null, activeTenantId: null, activeTenantName: null };

    // Check JWT expiry
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp * 1000 < Date.now()) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem(ACTIVE_TENANT_KEY);
      return { token: null, user: null, activeTenantId: null, activeTenantName: null };
    }

    const stored = JSON.parse(localStorage.getItem(ACTIVE_TENANT_KEY) || 'null');
    return {
      token,
      user,
      activeTenantId:   stored?.id   ?? null,
      activeTenantName: stored?.name ?? null,
    };
  } catch {
    return { token: null, user: null, activeTenantId: null, activeTenantName: null };
  }
}

export const useAuthStore = create((set) => ({
  ...loadStored(),

  login: (token, user) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    // Clear any previously selected tenant on fresh login
    localStorage.removeItem(ACTIVE_TENANT_KEY);
    set({ token, user, activeTenantId: null, activeTenantName: null });
  },

  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(ACTIVE_TENANT_KEY);
    set({ token: null, user: null, activeTenantId: null, activeTenantName: null });
  },

  // SUPER_ADMIN only: set the current operating tenant context.
  // Does NOT change the user's DB identity (tenant_id stays NULL).
  setActiveTenant: (id, name) => {
    if (id) {
      localStorage.setItem(ACTIVE_TENANT_KEY, JSON.stringify({ id, name }));
    } else {
      localStorage.removeItem(ACTIVE_TENANT_KEY);
    }
    set({ activeTenantId: id ?? null, activeTenantName: name ?? null });
  },

  isAuthenticated: () => {
    const { token } = useAuthStore.getState();
    return !!token;
  },
}));
