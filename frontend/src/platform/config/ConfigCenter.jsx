import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  Settings2, Variable, Server, Network, Shield,
  Phone, Radio, Layers, BookOpen, LogOut, History, ShieldCheck
} from 'lucide-react';

/**
 * ConfigCenter — root layout for all configuration modules.
 *
 * Renders a two-column layout:
 *  Left  — module navigation (similar to VMware vCenter / Cisco CUCM)
 *  Right — <Outlet /> for the selected module page
 */

const NAV_SECTIONS = [
  {
    label: 'Core System',
    items: [
      { id: 'vars',         label: 'System Variables',  icon: Variable, to: '/config/vars',         active: true  },
      { id: 'switch',       label: 'Switch Core',        icon: Server,   to: '/config/switch',        active: false },
      { id: 'event-socket', label: 'Event Socket',       icon: Radio,    to: '/config/event-socket',  active: false },
    ],
  },
  {
    label: 'Network',
    items: [
      { id: 'acl',          label: 'ACL Rules',          icon: Shield,   to: '/config/acl',           active: false },
      { id: 'sip-profiles', label: 'SIP Profiles',       icon: Phone,    to: '/config/sip-profiles',  active: false },
      { id: 'gateways',     label: 'Gateways',           icon: Network,  to: '/config/gateways',      active: false },
    ],
  },
  {
    label: 'Media & Routing',
    items: [
      { id: 'conference',   label: 'Conference',         icon: Layers,   to: '/config/conference',    active: false },
      { id: 'dialplan',     label: 'Dialplan',           icon: BookOpen, to: '/config/dialplan',      active: false },
      { id: 'directory',    label: 'Directory',          icon: BookOpen, to: '/config/directory',     active: false },
      { id: 'modules',      label: 'Modules',            icon: Settings2,to: '/config/modules',       active: false },
      { id: 'logging',      label: 'Logging',            icon: LogOut,   to: '/config/logging',       active: false },
    ],
  },
  {
    label: 'Governance',
    items: [
      { id: 'history', label: 'Version History', icon: History,      to: '/config/history',  active: false },
      { id: 'audit',   label: 'Audit Log',       icon: ShieldCheck,  to: '/config/audit',    active: false },
    ],
  },
];

function NavItem({ item }) {
  const Icon = item.icon;
  const base = `flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition-colors
                 font-medium`;

  if (!item.active) {
    return (
      <div className={`${base} text-text-muted opacity-40 cursor-not-allowed`}
           title="Coming in a future phase">
        <Icon size={14} className="shrink-0" />
        {item.label}
        <span className="ml-auto text-[9px] opacity-70">Soon</span>
      </div>
    );
  }

  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        `${base} ${isActive
          ? 'bg-brand/10 text-brand'
          : 'text-text-muted hover:text-text-primary hover:bg-surface-border'}`
      }>
      <Icon size={14} className="shrink-0" />
      {item.label}
    </NavLink>
  );
}

export default function ConfigCenter() {
  return (
    <div className="flex gap-0 -m-4 md:-m-6 min-h-[calc(100vh-56px)]">

      {/* Left navigation */}
      <aside className="w-52 shrink-0 border-r border-surface-border bg-surface-panel
                        py-4 px-2 overflow-y-auto">
        <div className="px-2 mb-4">
          <div className="flex items-center gap-2">
            <Settings2 size={16} className="text-brand shrink-0" />
            <span className="text-sm font-bold text-text-primary">Config Center</span>
          </div>
          <p className="text-[10px] text-text-muted mt-0.5 ml-6">FreeSWITCH</p>
        </div>

        {NAV_SECTIONS.map(section => (
          <div key={section.label} className="mb-3">
            <p className="text-[9px] font-bold uppercase tracking-[0.1em]
                          text-text-muted px-3 py-1.5">
              {section.label}
            </p>
            <div className="space-y-0.5">
              {section.items.map(item => (
                <NavItem key={item.id} item={item} />
              ))}
            </div>
          </div>
        ))}
      </aside>

      {/* Module content */}
      <main className="flex-1 overflow-y-auto p-4 md:p-6">
        <Outlet />
      </main>
    </div>
  );
}
