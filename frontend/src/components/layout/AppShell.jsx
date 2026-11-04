import { useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import Header from './Header.jsx';
import TestModeBanner from './TestModeBanner.jsx';
import { Toaster } from '../ui/Toast.jsx';
import { ConfirmHost } from '../ui/ConfirmDialog.jsx';

const DESKTOP = '(min-width: 1024px)';
const isDesktop = () => typeof window === 'undefined' || !window.matchMedia || window.matchMedia(DESKTOP).matches;

export default function AppShell() {
  const [desktop, setDesktop] = useState(isDesktop);
  const [desktopOpen, setDesktopOpen] = useState(true);   // inline column on wide screens
  const [overlayOpen, setOverlayOpen] = useState(false);  // slide-over on narrow screens

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(DESKTOP);
    const onChange = () => { setDesktop(mq.matches); setOverlayOpen(false); };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const toggle = () => (desktop ? setDesktopOpen(o => !o) : setOverlayOpen(o => !o));
  const closeOverlay = useCallback(() => setOverlayOpen(false), []);

  return (
    <div className="flex h-screen bg-surface-bg overflow-hidden">
      <Toaster />
      <ConfirmHost />
      {desktop
        ? <Sidebar mode="inline" open={desktopOpen} />
        : <Sidebar mode="overlay" open={overlayOpen} onClose={closeOverlay} />}
      <div className="flex flex-col flex-1 min-w-0">
        <Header onMenuToggle={toggle} menuOpen={desktop ? desktopOpen : overlayOpen} />
        <TestModeBanner />
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
