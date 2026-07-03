import { create } from 'zustand';

const TOKEN_KEY = 'enrs_token';
const USER_KEY  = 'enrs_user';

function loadStored() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const user  = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    if (!token || !user) return { token: null, user: null };

    // Check JWT expiry
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp * 1000 < Date.now()) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      return { token: null, user: null };
    }
    return { token, user };
  } catch {
    return { token: null, user: null };
  }
}

export const useAuthStore = create((set) => ({
  ...loadStored(),

  login: (token, user) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    set({ token, user });
  },

  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    set({ token: null, user: null });
  },

  isAuthenticated: () => {
    const { token } = useAuthStore.getState();
    return !!token;
  },
}));
