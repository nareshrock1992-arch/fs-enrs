import { Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useTheme } from './hooks/useTheme.js';
import { useAuthStore } from './store/authStore.js';

import AppShell      from './components/layout/AppShell.jsx';
import Login         from './pages/Login.jsx';
import Dashboard     from './pages/Dashboard.jsx';
import Monitoring    from './pages/Monitoring.jsx';
import UserList      from './pages/users/UserList.jsx';
import OrgList       from './pages/organizations/OrgList.jsx';
import LocationList  from './pages/organizations/LocationList.jsx';
import DeptList      from './pages/organizations/DeptList.jsx';
import ContactList   from './pages/contacts/ContactList.jsx';
import GroupList     from './pages/groups/GroupList.jsx';
import EnsList       from './pages/ens/EnsList.jsx';
import ErsConfigList from './pages/ers/ErsConfigList.jsx';
import ErsLive       from './pages/ers/ErsLive.jsx';
import IvrList       from './pages/ivr/IvrList.jsx';
import IvrBuilder    from './pages/ivr/IvrBuilder.jsx';
import ReportNotifications from './pages/reports/ReportNotifications.jsx';
import ReportIncidents     from './pages/reports/ReportIncidents.jsx';
import ReportContactUsage  from './pages/reports/ReportContactUsage.jsx';
import ReportErsIncidents  from './pages/reports/ReportErsIncidents.jsx';
import ReportEnsBroadcasts from './pages/reports/ReportEnsBroadcasts.jsx';
import SettingsPage        from './pages/settings/SettingsPage.jsx';
import TelephonyGateways   from './pages/settings/TelephonyGateways.jsx';
import AudioLibrary        from './pages/audio/AudioLibrary.jsx';
import DeploymentDashboard from './pages/deployment/DeploymentDashboard.jsx';
import ServiceRegistry     from './pages/services/ServiceRegistry.jsx';
import CampaignDashboard   from './pages/ens/CampaignDashboard.jsx';

function RequireAuth({ children }) {
  const token = useAuthStore(s => s.token);
  return token ? children : <Navigate to="/login" replace />;
}

function RequireAdmin({ children }) {
  const user = useAuthStore(s => s.user);
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'ADMIN') return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const { theme } = useTheme();

  // Keep <html> class in sync (useTheme already does this via useEffect but
  // calling here ensures the theme applies before first paint on hydration)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index                        element={<Dashboard />} />
        <Route path="monitoring"            element={<Monitoring />} />

        {/* Service Registry */}
        <Route path="services"              element={<ServiceRegistry />} />

        {/* Emergency Config */}
        <Route path="ens"                   element={<EnsList />} />
        <Route path="ens/campaigns"         element={<CampaignDashboard />} />
        <Route path="ers"                   element={<ErsConfigList />} />
        <Route path="ers/live"              element={<ErsLive />} />

        {/* IVR */}
        <Route path="ivr"                   element={<IvrList />} />
        <Route path="ivr/:uuid"             element={<IvrBuilder />} />

        {/* Audio + Deployment */}
        <Route path="audio"                 element={<AudioLibrary />} />
        <Route path="deployment"            element={<DeploymentDashboard />} />

        {/* Organization */}
        <Route path="organizations"         element={<OrgList />} />
        <Route path="locations"             element={<LocationList />} />
        <Route path="departments"           element={<DeptList />} />
        <Route path="contacts"             element={<ContactList />} />
        <Route path="groups"               element={<GroupList />} />

        {/* Reports */}
        <Route path="reports/notifications" element={<ReportNotifications />} />
        <Route path="reports/incidents"     element={<ReportIncidents />} />
        <Route path="reports/contact-usage" element={<ReportContactUsage />} />
        <Route path="reports/ers-incidents"  element={<ReportErsIncidents />} />
        <Route path="reports/ens-broadcasts" element={<ReportEnsBroadcasts />} />

        {/* Admin-only */}
        <Route path="users"    element={<RequireAdmin><UserList /></RequireAdmin>} />
        <Route path="settings" element={<RequireAdmin><SettingsPage /></RequireAdmin>} />
        <Route path="settings/gateways" element={<RequireAdmin><TelephonyGateways /></RequireAdmin>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
