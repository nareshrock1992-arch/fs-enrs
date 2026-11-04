import {
  LayoutDashboard, ShieldAlert, Building2, FileBarChart2, Settings, Radio, Workflow,
} from 'lucide-react';

// Application navigation. Grouped by what the operator is doing: live operations first,
// then the configuration behind them, then directory data, reports and administration.
// Visibility flags mirror the server's rules (auth/permissions.js → visibleNav); a link
// the server would answer with 403 is not shown.
export const NAV = [
  { label: 'Dashboard', icon: LayoutDashboard, to: '/' },

  {
    label: 'Operations', icon: Radio, children: [
      { label: 'Live Monitoring', to: '/monitoring' },
      { label: 'ERS Live View',   to: '/ers/live' },
      { label: 'ENS Campaigns',   to: '/ens/campaigns' },
    ],
  },

  {
    label: 'Emergency Services', icon: ShieldAlert, children: [
      { label: 'Service Registry',   to: '/services' },
      { label: 'ENS Configurations', to: '/ens' },
      { label: 'ERS Configurations', to: '/ers' },
    ],
  },

  {
    label: 'IVR', icon: Workflow, children: [
      { label: 'IVR Flows',     to: '/ivr' },
      { label: 'Media Library', to: '/media', capability: 'media.view' },
      { label: 'Deployment',    to: '/deployment' },
    ],
  },

  {
    label: 'Directory', icon: Building2, children: [
      { label: 'Organizations',      to: '/organizations' },
      { label: 'Locations',          to: '/locations' },
      { label: 'Departments',        to: '/departments' },
      { label: 'Emergency Contacts', to: '/contacts' },
      { label: 'Responder Groups',   to: '/groups' },
    ],
  },

  {
    label: 'Reports', icon: FileBarChart2, children: [
      { label: 'ERS Reports',           to: '/reports/ers',           capability: 'reports.view' },
      { label: 'ENS Reports',           to: '/reports/ens',           capability: 'reports.view' },
      { label: 'Contact Usage',         to: '/reports/contact-usage', capability: 'reports.view' },
      { label: 'Conference Recordings', to: '/recordings',            capability: 'recordings.view' },
    ],
  },

  {
    label: 'Administration', icon: Settings, children: [
      { label: 'Users',              to: '/users',             adminOnly: true },
      { label: 'Tenants',            to: '/tenants',           superAdminOnly: true },
      { label: 'Audit Log',          to: '/audit',             superAdminOnly: true },
      { label: 'General Settings',   to: '/settings',          adminOnly: true },
      { label: 'Telephony Gateways', to: '/settings/gateways', adminOnly: true },
      { label: 'Config Center',      to: '/config/vars',       superAdminOnly: true },
    ],
  },
];

// The nav entry for a path: the longest link that is the path or a parent of it, so
// /ens/campaigns belongs to ENS Campaigns (Operations), not ENS Configurations.
export function activeNavTarget(nav, pathname) {
  const targets = nav.flatMap(n => (n.children ? n.children.map(c => c.to) : [n.to]));
  return targets.filter(t => pathname === t || (t !== '/' && pathname.startsWith(`${t}/`)))
    .sort((a, b) => b.length - a.length)[0] ?? null;
}
