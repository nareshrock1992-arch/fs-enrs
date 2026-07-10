import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import Header from './Header.jsx';
import TestModeBanner from './TestModeBanner.jsx';

export default function AppShell() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-screen bg-surface-bg overflow-hidden">
      <Sidebar collapsed={collapsed} />
      <div className="flex flex-col flex-1 min-w-0">
        <Header onMenuToggle={() => setCollapsed(c => !c)} />
        <TestModeBanner />
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
