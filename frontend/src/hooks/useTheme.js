import { useState, useEffect } from 'react';

const KEY = 'enrs_theme';

function getInitial() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {}
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState(getInitial);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try { localStorage.setItem(KEY, theme); } catch {}
  }, [theme]);

  return {
    theme,
    isDark: theme === 'dark',
    toggle: () => setTheme(t => t === 'dark' ? 'light' : 'dark'),
  };
}
