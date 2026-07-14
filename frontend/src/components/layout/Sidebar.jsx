import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Users, Bell, ShieldAlert, Building2,
  MapPin, Layers, Contact, Group, FileBarChart2,
  Settings, ChevronDown, ChevronRight, Radio, Workflow,
  Library, Rocket, PhoneCall, Headphones
} from 'lucide-react';
import { useAuthStore } from '../../store/authStore.js';

const NAV = [
  { label: 'Dashboard',  icon: LayoutDashboard, to: '/' },
  { label: 'Monitoring', icon: Radio,            to: '/monitoring' },

  {
    label: 'Emergency Config', icon: ShieldAlert, children: [
      { label: 'Service Registry',   to: '/services' },
      { label: 'ENS Configurations', to: '/ens' },
      { label: 'ENS Campaigns',      to: '/ens/campaigns' },
      { label: 'ERS Configurations', to: '/ers' },
      { label: 'ERS Live View',      to: '/ers/live' },
    ]
  },

  {
    label: 'IVR Builder', icon: Workflow, children: [
      { label: 'IVR Flows',     to: '/ivr' },
      { label: 'Media Library', to: '/media' },
      { label: 'Deployment',    to: '/deployment' },
    ]
  },

  {
    label: 'Organization', icon: Building2, children: [
      { label: 'Organizations',     to: '/organizations' },
      { label: 'Locations',         to: '/locations' },
      { label: 'Departments',       to: '/departments' },
      { label: 'Emergency Contacts', to: '/contacts' },
      { label: 'Responder Groups',  to: '/groups' },
    ]
  },

  {
    label: 'Reports', icon: FileBarChart2, children: [
      { label: 'Notification Report',    to: '/reports/notifications' },
      { label: 'Incident Report',        to: '/reports/incidents' },
      { label: 'Contact Usage',          to: '/reports/contact-usage' },
      { label: 'ERS Incident Detail',    to: '/reports/ers-incidents' },
      { label: 'ENS Broadcast Detail',   to: '/reports/ens-broadcasts' },
      { label: 'Conference Recordings',  to: '/recordings' },
    ]
  },

  // Admin-only items
  { label: 'User Management', icon: Users, to: '/users', adminOnly: true },
  {
    label: 'Settings', icon: Settings, adminOnly: true, children: [
      { label: 'General',            to: '/settings' },
      { label: 'Telephony Gateways', to: '/settings/gateways' },
    ]
  },
];

function NavItem({ item, depth = 0 }) {
  const location = useLocation();
  const [open, setOpen]  = useState(() =>
    item.children?.some(c => location.pathname.startsWith(c.to))
  );

  if (item.children) {
    return (
      <div>
        <button
          onClick={() => setOpen(o => !o)}
          className={`sidebar-link w-full text-left ${depth > 0 ? 'pl-5' : ''}`}
        >
          {item.icon && <item.icon size={16} className="shrink-0" />}
          <span className="flex-1">{item.label}</span>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {open && (
          <div className="ml-4 mt-0.5 border-l border-surface-border/50 pl-2 space-y-0.5">
            {item.children.map(c => (
              <NavLink key={c.to} to={c.to}
                className={({ isActive }) =>
                  `sidebar-link text-xs py-1.5 ${isActive ? 'active' : ''}`
                }>
                {c.label}
              </NavLink>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
    >
      {item.icon && <item.icon size={16} className="shrink-0" />}
      {item.label}
    </NavLink>
  );
}

export default function Sidebar({ collapsed, onToggle }) {
  const user = useAuthStore(s => s.user);

  const visible = NAV.filter(n => !n.adminOnly || user?.role === 'ADMIN');

  return (
    <aside className={`
      bg-surface-panel border-r border-surface-border flex flex-col
      transition-all duration-200
      ${collapsed ? 'w-0 overflow-hidden' : 'w-64'}
    `}>
      {/* Logo */}
      <div className="px-4 py-4 border-b border-surface-border flex items-center gap-3">
        <div className="w-8 h-8 bg-brand rounded-lg flex items-center justify-center shrink-0">
          <ShieldAlert size={16} className="text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-text-primary leading-tight truncate">fs-enrs</p>
          <p className="text-[10px] text-text-muted uppercase tracking-wide truncate">
            Emergency System
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
        {visible.map(item => (
          <NavItem key={item.label} item={item} />
        ))}
      </nav>

      {/* User strip */}
      <div className="px-3 py-3 border-t border-surface-border">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-brand/20 border border-brand/30
                          flex items-center justify-center text-brand text-xs font-bold shrink-0">
            {(user?.fullName || user?.email || 'U')[0].toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-text-primary truncate">
              {user?.fullName || user?.email}
            </p>
            <p className="text-[10px] text-text-muted capitalize">{user?.role?.toLowerCase()}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
