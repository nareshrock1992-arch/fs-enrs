import { create } from 'zustand';
import { authenticateSocket, deauthenticateSocket } from '../api/socket.js';
import { isTokenExpired, refreshAccessToken } from '../api/client.js';

const TOKEN_KEY         = 'enrs_token';
const USER_KEY          = 'enrs_user';
const ACTIVE_TENANT_KEY = 'enrs_active_tenant';

// An expired access token (15 minutes) is kept on page load: the session is
// renewed from the 7-day httpOnly refresh cookie by restoreSession() below,
// and only a refused refresh signs the user out. Before this, reloading the
// page after 15 minutes always went to the login page.
function loadStored() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const user  = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    if (!token || !user) return { token: null, user: null, activeTenantId: null, activeTenantName: null };

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
    // Live events are per identity: a socket opened before sign-in has no rooms yet.
    authenticateSocket(token);
    set({ token, user, activeTenantId: null, activeTenantName: null });
  },

  logout: () => {
    deauthenticateSocket();
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

/**
 * Renews an expired stored session once, at page load. The server says no
 * (401: cookie missing, expired after 7 days, or revoked by sign-out) → sign
 * out. A network error or a server fault keeps the session: the next API call
 * retries the refresh (api/client.js), so a backend restart never signs anyone out.
 */
export async function restoreSession() {
  const { token } = useAuthStore.getState();
  if (!token || !isTokenExpired(token)) return 'valid';
  const renewed = await refreshAccessToken();      // shared with API calls made during page load
  if (renewed.status === 401 || renewed.status === 403) {
    if (useAuthStore.getState().token) useAuthStore.getState().logout();
    return 'signed-out';
  }
  if (!renewed.token) return 'offline';
  if (!useAuthStore.getState().token) return 'signed-out';            // signed out meanwhile
  authenticateSocket(renewed.token);
  useAuthStore.setState({ token: renewed.token });
  return 'renewed';
}

/** The renewal that runs once when the app loads ('valid' | 'renewed' | 'signed-out' | 'offline'). */
export const sessionRestored = restoreSession();
