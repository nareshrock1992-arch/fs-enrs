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
    incident:         (uuid) => request('GET',  `/ers/incidents/${uuid}/detail`),
    queue:            ()     => request('GET',  '/ers/queue'),
    completeIncident: (uuid, body) => request('POST', `/ers/incidents/${uuid}/complete`, body || {}),
    cancelIncident:   (uuid) => request('POST', `/ers/incidents/${uuid}/cancel`),
    confMembers:      (room) => request('GET',  `/ers/conference/${room}/members`),
    confKick:         (room, memberId) => request('POST', `/ers/conference/${room}/kick`, { member_id: memberId }),
    confMute:         (room, memberId, muted) => request('POST', `/ers/conference/${room}/mute`, { member_id: memberId, muted }),
    confPlay:         (room, audioPath) => request('POST', `/ers/conference/${room}/play`, { audio_path: audioPath }),
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
    // Legacy endpoints (kept for backward-compat with old pages)
    notifications: (q) => request('GET', `/reports/notifications?${new URLSearchParams(q || {})}`),
    incidents:     (q) => request('GET', `/reports/incidents?${new URLSearchParams(q || {})}`),
    contactUsage:  ()  => request('GET', '/reports/contact-usage'),
    ersIncidents:  (q) => request('GET', `/reports/ers-incidents?${new URLSearchParams(q || {})}`),
    ensBroadcasts: (q) => request('GET', `/reports/ens-broadcasts?${new URLSearchParams(q || {})}`),
    // Unified paginated report endpoints
    ers:           (q) => request('GET', `/reports/ers?${new URLSearchParams(q || {})}`),
    ersDetail:     (uuid) => request('GET', `/reports/ers/${uuid}`),
    ens:           (q) => request('GET', `/reports/ens?${new URLSearchParams(q || {})}`),
    ensDetail:     (uuid) => request('GET', `/reports/ens/${uuid}`),
  },

  // Settings
  settings: {
    list:             ()          => request('GET', '/settings'),
    update:           (key, val)  => request('PUT', `/settings/${key}`, { value: val }),
    eslStatus:        ()          => request('GET', '/settings/esl/status'),
    flags:            ()          => request('GET', '/settings/feature-flags'),
    setFlag:          (key, val)  => request('PATCH', `/settings/feature-flags/${key}`, { is_enabled: val }),
    emergencyNumbers: ()          => request('GET', '/settings/emergency-numbers'),
    testMode:         ()          => request('GET', '/settings/test-mode'),
  },

  // Telephony gateways (Phase 4 — gateway-agnostic dialing)
  gateways: {
    list:   ()       => request('GET',    '/gateways'),
    create: (d)      => request('POST',   '/gateways', d),
    update: (id, d)  => request('PUT',    `/gateways/${id}`, d),
    remove: (id)     => request('DELETE', `/gateways/${id}`),
    deploy: (id)     => request('POST',   `/gateways/${id}/deploy`),
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
    nodeTypes: () => request('GET', '/ivr/node-types'),
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

  // Media Library (enterprise replacement for Audio Library)
  mediaLibrary: {
    list: (q) => {
      const p = new URLSearchParams();
      Object.entries(q || {}).forEach(([k, v]) => {
        if (v != null && v !== '' && v !== 'undefined') p.set(k, v);
      });
      return request('GET', `/media-library?${p}`);
    },
    categories:  ()     => request('GET',    '/media-library/categories'),
    get:         (id)   => request('GET',    `/media-library/${id}`),
    upload:      (fd)   => request('POST',   '/media-library/upload', fd),
    scan:        ()     => request('POST',   '/media-library/scan'),
    update:      (id,d) => request('PUT',    `/media-library/${id}`, d),
    deploy:      (id)   => request('POST',   `/media-library/${id}/deploy`),
    remove:      (id)   => request('DELETE', `/media-library/${id}`),
    // Token-bearing URLs for <audio src> and <a download> — browser can't set Authorization header
    streamUrl:   (id)   => `/api/v1/media-library/${id}/stream?token=${getToken() || ''}`,
    downloadUrl: (id)   => `/api/v1/media-library/${id}/download?token=${getToken() || ''}`,
    waveformUrl: (id)   => `/api/v1/media-library/${id}/waveform?token=${getToken() || ''}`,
    waveform:    (id)   => request('GET',    `/media-library/${id}/waveform`),
  },

  // Conference Recording Management
  recordings: {
    list: (q) => {
      const p = new URLSearchParams();
      Object.entries(q || {}).forEach(([k, v]) => {
        if (v != null && v !== '' && v !== 'undefined') p.set(k, v);
      });
      return request('GET', `/recordings?${p}`);
    },
    get:         (id)   => request('GET',    `/recordings/${id}`),
    update:      (id,d) => request('PUT',    `/recordings/${id}`, d),
    archive:     (id)   => request('POST',   `/recordings/${id}/archive`),
    remove:      (id)   => request('DELETE', `/recordings/${id}`),
    // Token-bearing URLs for <audio src> and <a download>
    streamUrl:   (id)   => `/api/v1/recordings/${id}/stream?token=${getToken() || ''}`,
    downloadUrl: (id)   => `/api/v1/recordings/${id}/download?token=${getToken() || ''}`,
    waveform:    (id)   => request('GET',    `/recordings/${id}/waveform`),
  },

  // Legacy deployment audio (kept for IVR Builder backward-compat)
  deployment: {
    listAudio:      (q)       => request('GET',    `/deployment/audio?${new URLSearchParams(q || {})}`),
    scanAudio:      ()        => request('POST',   '/deployment/audio/scan'),
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
    disableLegacyExtension: (file, extensionName) =>
      request('POST', '/deployment/diagnostics/disable-legacy-extension', { file, extension_name: extensionName }),
  },

  // Conference Operations Center
  monitoring: {
    conferences: ()       => request('GET', '/monitoring/conferences'),
    status:      ()       => request('GET', '/monitoring/status'),
    // Conference controls
    lock:        (room)   => request('POST',   `/monitoring/conferences/${room}/lock`),
    unlock:      (room)   => request('POST',   `/monitoring/conferences/${room}/unlock`),
    recordStart: (room, path) => request('POST', `/monitoring/conferences/${room}/record/start`, { path }),
    recordStop:  (room, path) => request('POST', `/monitoring/conferences/${room}/record/stop`,  { path }),
    playAudio:   (room, audio_path) => request('POST', `/monitoring/conferences/${room}/play`, { audio_path }),
    say:         (room, text) => request('POST', `/monitoring/conferences/${room}/say`, { text }),
    invite:      (room, dial_string) => request('POST', `/monitoring/conferences/${room}/invite`, { dial_string }),
    terminate:   (room)   => request('DELETE', `/monitoring/conferences/${room}`),
    // Member controls
    mute:     (room, id) => request('POST',   `/monitoring/conferences/${room}/members/${id}/mute`),
    unmute:   (room, id) => request('POST',   `/monitoring/conferences/${room}/members/${id}/unmute`),
    kick:     (room, id) => request('DELETE', `/monitoring/conferences/${room}/members/${id}`),
    deaf:     (room, id) => request('POST',   `/monitoring/conferences/${room}/members/${id}/deaf`),
    undeaf:   (room, id) => request('POST',   `/monitoring/conferences/${room}/members/${id}/undeaf`),
    volume:   (room, id, direction, level) => request('POST', `/monitoring/conferences/${room}/members/${id}/volume`, { direction, level }),
    energy:   (room, id, level) => request('POST', `/monitoring/conferences/${room}/members/${id}/energy`, { level }),
    floor:    (room, id) => request('POST',   `/monitoring/conferences/${room}/members/${id}/floor`),
    transfer: (room, id, extension) => request('POST', `/monitoring/conferences/${room}/members/${id}/transfer`, { extension }),
    promote:  (room, id) => request('POST',   `/monitoring/conferences/${room}/members/${id}/moderator`),
  },

  // ── Platform Configuration Framework (Phase 7) ───────────────────────────────
  platformConfig: {
    providers:  ()                       => request('GET',  '/platform/config/providers'),
    read:       (id)                     => request('GET',  `/platform/config/${id}`),
    preview:    (id, changes)            => request('POST', `/platform/config/${id}/preview`, { changes }),
    deploy:     (id, changes, reason)    => request('POST', `/platform/config/${id}/deploy`, { changes, reason }),
    rollback:   (id, versionId, reason)  => request('POST', `/platform/config/${id}/rollback/${versionId}`, { reason }),
    history:    (id, params)             => request('GET',  `/platform/config/${id}/history?${new URLSearchParams(params ?? {})}`),
    diff:       (id, v1, v2)             => request('GET',  `/platform/config/${id}/history/${v1}/diff/${v2}`),
    audit:      (id)                     => request('GET',  `/platform/config/${id}/audit`),
    auditGlobal: (params)                => request('GET',  `/platform/config/audit?${new URLSearchParams(params ?? {})}`),
  },
};
