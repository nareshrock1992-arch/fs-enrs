const BASE = import.meta.env.VITE_API_URL || '/api/v1';

function getToken() {
  return localStorage.getItem('enrs_token');
}

async function request(method, path, body, opts = {}) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/refresh') {
    const refreshRes = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST', credentials: 'include',
    });
    if (refreshRes.ok) {
      const { token: newToken } = await refreshRes.json();
      localStorage.setItem('enrs_token', newToken);
      return request(method, path, body, {
        ...opts, headers: { Authorization: `Bearer ${newToken}` }
      });
    } else {
      localStorage.removeItem('enrs_token');
      localStorage.removeItem('enrs_user');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
  }

  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data, status: res.status });
  return data;
}

export const api = {
  // Auth
  login:          (email, password) => request('POST', '/auth/login', { email, password }),
  logout:         ()                => request('POST', '/auth/logout'),
  me:             ()                => request('GET',  '/auth/me'),
  changePassword: (cur, next)       => request('POST', '/auth/change-password', { currentPassword: cur, newPassword: next }),

  // Dashboard
  dashMetrics: () => request('GET', '/dashboard/metrics'),
  dashActive:  () => request('GET', '/dashboard/active'),
  dashChart:   (p) => request('GET', `/dashboard/chart?period=${p || 'week'}`),

  // Users
  users: {
    list:   ()       => request('GET',    '/users'),
    get:    (id)     => request('GET',    `/users/${id}`),
    create: (d)      => request('POST',   '/users', d),
    update: (id, d)  => request('PUT',    `/users/${id}`, d),
    remove: (id)     => request('DELETE', `/users/${id}`),
  },

  // Organizations
  orgs: {
    list:   (q)      => request('GET',    `/organizations?${new URLSearchParams({ limit: 1000, ...(q || {}) })}`),
    get:    (id)     => request('GET',    `/organizations/${id}`),
    create: (d)      => request('POST',   '/organizations', d),
    update: (id, d)  => request('PUT',    `/organizations/${id}`, d),
    remove: (id)     => request('DELETE', `/organizations/${id}`),
  },

  // Locations
  locations: {
    list:   (orgId)  => request('GET',    `/organizations/locations?organization_id=${orgId || ''}`),
    create: (d)      => request('POST',   '/organizations/locations', d),
    update: (id, d)  => request('PUT',    `/organizations/locations/${id}`, d),
    remove: (id)     => request('DELETE', `/organizations/locations/${id}`),
  },

  // Departments
  departments: {
    list:   (orgId)  => request('GET',    `/organizations/departments?organization_id=${orgId || ''}`),
    create: (d)      => request('POST',   '/organizations/departments', d),
    update: (id, d)  => request('PUT',    `/organizations/departments/${id}`, d),
    remove: (id)     => request('DELETE', `/organizations/departments/${id}`),
  },

  // Contacts
  contacts: {
    list:       (q)      => request('GET',    `/contacts?${new URLSearchParams({ limit: 1000, ...(q || {}) })}`),
    get:        (id)     => request('GET',    `/contacts/${id}`),
    create:     (d)      => request('POST',   '/contacts', d),
    update:     (id, d)  => request('PUT',    `/contacts/${id}`, d),
    remove:     (id)     => request('DELETE', `/contacts/${id}`),
    bulkUpload: (orgId, file) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('organization_id', orgId);
      return request('POST', '/contacts/bulk-upload', fd);
    },
  },

  // Responder Groups
  groups: {
    list:         (q)         => request('GET',    `/groups?${new URLSearchParams({ limit: 1000, ...(q || {}) })}`),
    get:          (id)        => request('GET',    `/groups/${id}`),
    create:       (d)         => request('POST',   '/groups', d),
    update:       (id, d)     => request('PUT',    `/groups/${id}`, d),
    remove:       (id)        => request('DELETE', `/groups/${id}`),
    addMembers:   (id, ids)   => request('POST',   `/groups/${id}/members`, { contact_ids: ids }),
    removeMember: (id, cid)   => request('DELETE', `/groups/${id}/members/${cid}`),
  },

  // ENS
  ens: {
    list:       (q)      => request('GET',    `/ens/configurations?${new URLSearchParams(q || {})}`),
    get:        (id)     => request('GET',    `/ens/configurations/${id}`),
    create:     (d)      => request('POST',   '/ens/configurations', d),
    update:     (id, d)  => request('PUT',    `/ens/configurations/${id}`, d),
    toggle:     (id)     => request('PATCH',  `/ens/configurations/${id}/toggle`),
    remove:     (id)     => request('DELETE', `/ens/configurations/${id}`),
    notifications: (q)   => request('GET',    `/ens/notifications?${new URLSearchParams(q || {})}`),
    trigger:    (d)      => request('POST',   '/ens/notifications', d),
  },

  // ERS
  ers: {
    list:       (q)      => request('GET',    `/ers/configurations?${new URLSearchParams(q || {})}`),
    get:        (id)     => request('GET',    `/ers/configurations/${id}`),
    create:     (d)      => request('POST',   '/ers/configurations', d),
    update:     (id, d)  => request('PUT',    `/ers/configurations/${id}`, d),
    toggle:     (id)     => request('PATCH',  `/ers/configurations/${id}/toggle`),
    remove:     (id)     => request('DELETE', `/ers/configurations/${id}`),
    tierGroups:       (id)   => request('GET', `/ers/configurations/${id}/tier-groups`),
    updateTierGroups: (id, d) => request('PUT', `/ers/configurations/${id}/tier-groups`, d),
    incidents:        (q)    => request('GET',  `/ers/incidents?${new URLSearchParams(q || {})}`),
    queue:            ()     => request('GET',  '/ers/queue'),
    completeIncident: (uuid) => request('POST', `/ers/incidents/${uuid}/complete`),
  },

  // Service Registry (emergency numbers — full CRUD)
  services: {
    list:   (q)      => request('GET',    `/services?${new URLSearchParams(q || {})}`),
    get:    (id)     => request('GET',    `/services/${id}`),
    create: (d)      => request('POST',   '/services', d),
    update: (id, d)  => request('PUT',    `/services/${id}`, d),
    remove: (id)     => request('DELETE', `/services/${id}`),
  },

  // ENS Campaigns
  campaigns: {
    list:         (q)      => request('GET',  `/campaigns?${new URLSearchParams(q || {})}`),
    get:          (id)     => request('GET',  `/campaigns/${id}`),
    destinations: (id, q)  => request('GET',  `/campaigns/${id}/destinations?${new URLSearchParams(q || {})}`),
    trigger:      (d)      => request('POST', '/campaigns', d),
    pause:        (id)     => request('POST', `/campaigns/${id}/pause`),
    resume:       (id)     => request('POST', `/campaigns/${id}/resume`),
    cancel:       (id)     => request('POST', `/campaigns/${id}/cancel`),
    engineStats:  ()       => request('GET',  '/campaigns/engine/stats'),
  },

  // Reports
  reports: {
    notifications: (q) => request('GET', `/reports/notifications?${new URLSearchParams(q || {})}`),
    incidents:     (q) => request('GET', `/reports/incidents?${new URLSearchParams(q || {})}`),
    contactUsage:  ()  => request('GET', '/reports/contact-usage'),
  },

  // Settings
  settings: {
    list:             ()          => request('GET', '/settings'),
    update:           (key, val)  => request('PUT', `/settings/${key}`, { value: val }),
    eslStatus:        ()          => request('GET', '/settings/esl/status'),
    flags:            ()          => request('GET', '/settings/feature-flags'),
    setFlag:          (key, val)  => request('PATCH', `/settings/feature-flags/${key}`, { is_enabled: val }),
    emergencyNumbers: ()          => request('GET', '/settings/emergency-numbers'),
  },

  // IVR flows
  ivr: {
    list:     (q)           => request('GET',    `/ivr/flows?${new URLSearchParams(q || {})}`),
    get:      (uuid)        => request('GET',    `/ivr/flows/${uuid}`),
    create:   (d)           => request('POST',   '/ivr/flows', d),
    update:   (uuid, d)     => request('PUT',    `/ivr/flows/${uuid}`, d),
    delete:   (uuid)        => request('DELETE', `/ivr/flows/${uuid}`),
    validate: (uuid, graph) => request('POST',   `/ivr/flows/${uuid}/validate`, graph ? { graph } : {}),
    publish:  (uuid, notes) => request('POST',   `/ivr/flows/${uuid}/publish`, { change_notes: notes || undefined }),
    versions: (uuid)        => request('GET',    `/ivr/flows/${uuid}/versions`),
    getVersion: (uuid, v)   => request('GET',    `/ivr/flows/${uuid}/versions/${v}`),
    bind:             (uuid, numId) => request('PATCH',  `/ivr/flows/${uuid}/bind`, { emergency_number_id: numId }),
    unbind:           (uuid, numId) => request('PATCH',  `/ivr/flows/${uuid}/unbind`, { emergency_number_id: numId }),
    listTemplates:    ()            => request('GET',    '/ivr/flows/templates'),
    createFromTemplate: (id, name) => request('POST',   `/ivr/flows/templates/${id}/create`, name ? { name } : {}),
  },

  // Media
  media: {
    list:   (q)   => request('GET',    `/media?${new URLSearchParams(q || {})}`),
    upload: (orgId, type, file) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('organization_id', orgId);
      fd.append('type', type || 'RECORDING');
      return request('POST', '/media/upload', fd);
    },
    remove: (id)  => request('DELETE', `/media/${id}`),
  },

  // Audio Library + Deployment
  deployment: {
    listAudio:      (q)       => request('GET',    `/deployment/audio?${new URLSearchParams(q || {})}`),
    listCategories: ()        => request('GET',    '/deployment/audio/categories'),
    uploadAudio:    (formData) => request('POST',  '/deployment/audio/upload', formData),
    deployAudio:    (id)      => request('POST',   `/deployment/audio/${id}/deploy`),
    deleteAudio:    (id)      => request('DELETE', `/deployment/audio/${id}`),
    listFlows:      ()        => request('GET',    '/deployment/flows'),
    previewDeploy:  (uuid)    => request('GET',    `/deployment/flows/${uuid}/preview`),
    deploy:         (uuid)    => request('POST',   `/deployment/flows/${uuid}/deploy`),
    flowHistory:    (uuid, n) => request('GET',    `/deployment/flows/${uuid}/history${n ? `?limit=${n}` : ''}`),
    redeployAll:    ()        => request('POST',   '/deployment/redeploy-all'),
    diagnostics:    ()        => request('GET',    '/deployment/diagnostics'),
    reloadXml:      ()        => request('POST',   '/deployment/diagnostics/reloadxml'),
    paths:          ()        => request('GET',    '/deployment/diagnostics/paths'),
    eslStatus:      ()        => request('GET',    '/deployment/diagnostics/esl'),
  },
};
