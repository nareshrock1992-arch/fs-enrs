# 11 — Frontend to Backend Mapping

## Frontend Pages (`frontend/src/pages/`)

This document maps each page to its API calls, backend controllers, DB tables, and Socket.IO events.

---

### Authentication

**Page:** `auth/LoginPage.jsx`

| Action | API Call | Controller | DB |
|---|---|---|---|
| Login | `POST /api/v1/auth/login` | `authController.login` | `users` |
| Token refresh (auto) | `POST /api/v1/auth/refresh` | `authController.refresh` | `users` |
| Logout | `POST /api/v1/auth/logout` | `authController.logout` | `users` |

**State:** `authStore` (Zustand) — stores `token`, `user`, `isAuthenticated`

---

### Dashboard

**Page:** `dashboard/DashboardPage.jsx`

| Action | API Call | Controller | DB |
|---|---|---|---|
| KPI metrics | `GET /api/v1/dashboard/metrics` | `dashboardController.metrics` | `ers_incidents`, `ens_campaigns`, `emergency_contacts`, `ers_configurations` |
| Active items | `GET /api/v1/dashboard/active` | `dashboardController.active` | `ers_incidents`, `ens_campaigns` |
| Chart data | `GET /api/v1/dashboard/chart?period=week` | `dashboardController.chart` | `ers_incidents`, `ens_campaigns` |

**Socket.IO events consumed:**
- `enrs::ers_incident_created` — increment active incidents counter
- `enrs::ers_incident_ended` — decrement active incidents counter
- `enrs::ens_started` — increment active campaigns counter
- `enrs::ens_complete` — decrement active campaigns counter

---

### Monitoring (Operations Center)

**Page:** `monitoring/MonitoringPage.jsx`

| Action | API Call | Controller | Socket Event |
|---|---|---|---|
| Initial load | `GET /api/v1/monitoring/conferences` | `monitoringController.list` | — |
| ESL status | `GET /api/v1/monitoring/status` | `monitoringController.status` | — |
| Lock | `POST /monitoring/conferences/:room/lock` | `monitoringController.lock` | `conference.locked` |
| Unlock | `POST /monitoring/conferences/:room/unlock` | `monitoringController.unlock` | `conference.locked` |
| Mute member | `POST …/members/:id/mute` | `monitoringController.muteMember` | `conference.member.muted` |
| Kick member | `DELETE …/members/:id` | `monitoringController.kickMember` | `conference.member.removed` |
| Start recording | `POST …/record/start` | `monitoringController.startRecord` | `conference.recording` |
| Stop recording | `POST …/record/stop` | `monitoringController.stopRecord` | `conference.recording` |
| Play audio | `POST …/play` | `monitoringController.play` | — |
| TTS say | `POST …/say` | `monitoringController.say` | — |
| End conference | `DELETE …/conferences/:room` | `monitoringController.end` | `conference.destroyed` |

**Socket.IO events consumed (live updates):**
- `conference.created` — new conference panel appears
- `conference.member.added` — member row added
- `conference.member.removed` — member row removed
- `conference.member.muted` — mute indicator
- `conference.member.talking` — audio activity ring
- `conference.locked` — lock badge on conference header
- `conference.recording` — recording indicator
- `conference.destroyed` — panel removed
- `enrs::ers_incident_created` — incident panel opens
- `enrs::ers_incident_ended` — incident panel closes
- `enrs::ers_responder_update` — responder status column
- `enrs::ers_queue_changed` — queue display

---

### ERS Configuration

**Page:** `ers/ErsConfigList.jsx` (list + create/edit form in same page)

| Action | API Call | Controller | DB |
|---|---|---|---|
| List configs | `GET /api/v1/ers/configurations` | `ersController.list` | `ers_configurations` |
| Get single | `GET /api/v1/ers/configurations/:id` | `ersController.get` | `ers_configurations` |
| Create | `POST /api/v1/ers/configurations` | `ersController.create` | `ers_configurations` |
| Update | `PUT /api/v1/ers/configurations/:id` | `ersController.update` | `ers_configurations` |
| Toggle active | `PATCH /api/v1/ers/configurations/:id/toggle` | `ersController.toggle` | `ers_configurations` |
| Delete | `DELETE /api/v1/ers/configurations/:id` | `ersController.delete` | `ers_configurations` (soft-delete) |
| Get tiers | `GET /api/v1/ers/configurations/:id/tier-groups` | `ersController.getTierGroups` | `ers_tier_contacts`, `ers_tier_groups` |
| Update tiers | `PUT /api/v1/ers/configurations/:id/tier-groups` | `ersController.updateTierGroups` | `ers_tier_contacts`, `ers_tier_groups` |

**API methods called via `frontend/src/api/client.js`:**
```js
api.ers.listConfigurations()
api.ers.createConfiguration(data)
api.ers.updateConfiguration(id, data)
```

**Form sections (after Phase 4 migration):**
- Conference (type, bridge numbers, profile, max concurrent, queue)
- Recording (record_conferences legacy flag, recording_enabled, recording_mode, recording_trigger)
- Advanced (max_participants, bridge_timeout, lock, destroy, external, duplicate, moderator)

---

### ERS Incidents

**Page:** `ers/ErsIncidents.jsx`

| Action | API Call | Controller |
|---|---|---|
| List incidents | `GET /api/v1/ers/incidents` | `ersController.listIncidents` |
| Incident detail | `GET /api/v1/ers/incidents/:uuid/detail` | `ersController.incidentDetail` |
| Responders | `GET /api/v1/ers/incidents/:id/responders` | `ersController.responders` |
| Complete | `POST /api/v1/ers/incidents/:uuid/complete` | `ersController.completeIncident` |
| Cancel | `POST /api/v1/ers/incidents/:uuid/cancel` | `ersController.cancelIncident` |
| Queue | `GET /api/v1/ers/queue` | `ersController.queue` |

---

### ENS Configuration

**Page:** `ens/EnsConfigList.jsx`

| Action | API Call | Controller | DB |
|---|---|---|---|
| List | `GET /api/v1/ens/configurations` | `ensController.list` | `ens_configurations` |
| Create | `POST /api/v1/ens/configurations` | `ensController.create` | `ens_configurations` |
| Update | `PUT /api/v1/ens/configurations/:id` | `ensController.update` | `ens_configurations` |
| Toggle | `PATCH /api/v1/ens/configurations/:id/toggle` | `ensController.toggle` | |
| Delete | `DELETE /api/v1/ens/configurations/:id` | `ensController.delete` | |
| Contacts dropdown | `GET /api/v1/contacts?limit=1000` | `contactController.list` | `emergency_contacts` |
| Groups dropdown | `GET /api/v1/groups?limit=1000` | `groupController.list` | `responder_groups` |

---

### ENS Notifications

**Page:** `ens/EnsNotifications.jsx`

| Action | API Call | Notes |
|---|---|---|
| List notifications | `GET /api/v1/ens/notifications` | |
| Trigger manual | `POST /api/v1/ens/notifications` | UI-initiated blast (not Lua) |

**Socket.IO events:**
- `enrs::ens_delivery` — per-contact progress bar
- `enrs::ens_complete` — campaign finished banner

---

### Campaigns

**Page:** `campaigns/CampaignsPage.jsx`

| Action | API Call | Controller |
|---|---|---|
| List | `GET /api/v1/campaigns` | `campaignController.list` |
| Detail | `GET /api/v1/campaigns/:id` | `campaignController.get` |
| Destinations | `GET /api/v1/campaigns/:id/destinations` | `campaignController.destinations` |
| Pause | `POST /api/v1/campaigns/:id/pause` | `campaignController.pause` |
| Resume | `POST /api/v1/campaigns/:id/resume` | `campaignController.resume` |
| Cancel | `POST /api/v1/campaigns/:id/cancel` | `campaignController.cancel` |
| Engine stats | `GET /api/v1/campaigns/engine/stats` | `campaignController.engineStats` |

---

### IVR Builder

**Page:** `ivr/IvrBuilder.jsx` (full drag-and-drop graph editor)

| Action | API Call | Controller |
|---|---|---|
| List flows | `GET /api/v1/ivr/flows` | `ivrController.list` |
| Get flow | `GET /api/v1/ivr/flows/:uuid` | `ivrController.get` |
| Create | `POST /api/v1/ivr/flows` | `ivrController.create` |
| Save graph | `PUT /api/v1/ivr/flows/:uuid` | `ivrController.update` |
| Validate | `POST /api/v1/ivr/flows/:uuid/validate` | `ivrController.validate` |
| Publish | `POST /api/v1/ivr/flows/:uuid/publish` | `ivrController.publish` |
| Versions | `GET /api/v1/ivr/flows/:uuid/versions` | `ivrController.versions` |
| Node types (palette) | `GET /api/v1/ivr/node-types` | `ivrController.nodeTypes` |
| Templates | `GET /api/v1/ivr/flows/templates` | `ivrController.templates` |
| Create from template | `POST /api/v1/ivr/flows/templates/:id/create` | `ivrController.createFromTemplate` |
| Bind number | `PATCH /api/v1/ivr/flows/:uuid/bind` | `ivrController.bind` |
| Emergency numbers dropdown | `GET /api/v1/settings/emergency-numbers` | `settingsController.emergencyNumbers` |
| ERS configs dropdown | `GET /api/v1/ers/configurations?limit=1000` | `ersController.list` |
| ENS configs dropdown | `GET /api/v1/ens/configurations?limit=1000` | `ensController.list` |

---

### Deployment

**Page:** `deployment/DeploymentPage.jsx`

| Action | API Call | Controller |
|---|---|---|
| Flow list | `GET /api/v1/deployment/flows` | `deploymentController.flows` |
| Deploy flow | `POST /api/v1/deployment/flows/:uuid/deploy` | `deploymentController.deployFlow` |
| Preview | `GET /api/v1/deployment/flows/:uuid/preview` | `deploymentController.preview` |
| Redeploy all | `POST /api/v1/deployment/redeploy-all` | `deploymentController.redeployAll` |
| Diagnostics | `GET /api/v1/deployment/diagnostics` | `deploymentController.diagnostics` |
| Reload XML | `POST /api/v1/deployment/diagnostics/reloadxml` | `deploymentController.reloadxml` |
| FS paths | `GET /api/v1/deployment/diagnostics/paths` | `deploymentController.paths` |

**Audio sub-section:**

| Action | API Call |
|---|---|
| Audio list | `GET /api/v1/deployment/audio` |
| Upload | `POST /api/v1/deployment/audio/upload` |
| Deploy audio | `POST /api/v1/deployment/audio/:id/deploy` |
| Stream (player) | `GET /api/v1/deployment/audio/:id/stream?token=...` |

---

### Organizations

**Page:** `organizations/OrganizationsPage.jsx`

| Action | API Call |
|---|---|
| List orgs | `GET /api/v1/organizations?limit=1000` |
| Create | `POST /api/v1/organizations` |
| Update | `PUT /api/v1/organizations/:id` |
| Locations | `GET /api/v1/organizations/locations?organization_id=` |
| Add location | `POST /api/v1/organizations/locations` |
| Departments | `GET /api/v1/organizations/departments?organization_id=` |

---

### Contacts

**Page:** `contacts/ContactsPage.jsx`

| Action | API Call |
|---|---|
| List | `GET /api/v1/contacts?limit=1000` |
| Create | `POST /api/v1/contacts` |
| Update | `PUT /api/v1/contacts/:id` |
| Delete | `DELETE /api/v1/contacts/:id` |
| Bulk upload | `POST /api/v1/contacts/bulk-upload` (multipart) |
| Orgs dropdown | `GET /api/v1/organizations?limit=1000` |

---

### Responder Groups

**Page:** `groups/GroupsPage.jsx`

| Action | API Call |
|---|---|
| List groups | `GET /api/v1/groups?limit=1000` |
| Create | `POST /api/v1/groups` |
| Update | `PUT /api/v1/groups/:id` |
| Add members | `POST /api/v1/groups/:id/members` |
| Remove member | `DELETE /api/v1/groups/:id/members/:contactId` |

---

### Users

**Page:** `users/UsersPage.jsx`

| Action | API Call |
|---|---|
| List | `GET /api/v1/users` |
| Create | `POST /api/v1/users` |
| Update | `PUT /api/v1/users/:id` |
| Delete | `DELETE /api/v1/users/:id` |
| Change own password | `POST /api/v1/auth/change-password` |

---

### Settings

**Page:** `settings/SettingsPage.jsx`

| Action | API Call |
|---|---|
| All settings | `GET /api/v1/settings` |
| Update setting | `PUT /api/v1/settings/:key` |
| Test mode | `GET /api/v1/settings/test-mode` |
| Feature flags | `GET /api/v1/settings/feature-flags` |
| Toggle flag | `PATCH /api/v1/settings/feature-flags/:key` |
| ESL status | `GET /api/v1/settings/esl/status` |

---

### SIP Gateways

**Page:** `gateways/GatewaysPage.jsx`

| Action | API Call |
|---|---|
| List | `GET /api/v1/gateways` |
| Create | `POST /api/v1/gateways` |
| Update | `PUT /api/v1/gateways/:id` |
| Delete | `DELETE /api/v1/gateways/:id` |
| Deploy | `POST /api/v1/gateways/:id/deploy` |

---

### Media Library

**Page:** `media/MediaLibraryPage.jsx`

| Action | API Call |
|---|---|
| List files | `GET /api/v1/media-library?limit=1000` |
| Categories | `GET /api/v1/media-library/categories` |
| Upload | `POST /api/v1/media-library/upload` (multipart) |
| Scan | `POST /api/v1/media-library/scan` |
| Deploy | `POST /api/v1/media-library/:id/deploy` |
| Stream | `GET /api/v1/media-library/:id/stream?token=` |
| Waveform | `GET /api/v1/media-library/:id/waveform` |
| Delete | `DELETE /api/v1/media-library/:id` |

---

### Recordings

**Page:** `recordings/RecordingsPage.jsx`

| Action | API Call |
|---|---|
| List | `GET /api/v1/recordings?recording_type=ERS` |
| Stream | `GET /api/v1/recordings/:id/stream?token=` |
| Waveform | `GET /api/v1/recordings/:id/waveform` |
| Download | `GET /api/v1/recordings/:id/download` |
| Archive | `POST /api/v1/recordings/:id/archive` |
| Delete | `DELETE /api/v1/recordings/:id` |

---

### Reports

**Page:** `reports/ReportsPage.jsx`

| Report | API Call |
|---|---|
| Incidents | `GET /api/v1/reports/ers-incidents?from=&to=` |
| Broadcasts | `GET /api/v1/reports/ens-broadcasts?from=&to=` |
| Notifications | `GET /api/v1/reports/notifications` |
| Contact usage | `GET /api/v1/reports/contact-usage` |

---

## `frontend/src/api/client.js` — API Module Structure

```js
api.auth.login(email, password)
api.auth.logout()
api.auth.me()
api.auth.changePassword(current, newPw)

api.ers.listConfigurations(params)
api.ers.getConfiguration(id)
api.ers.createConfiguration(data)
api.ers.updateConfiguration(id, data)
api.ers.toggleConfiguration(id)
api.ers.deleteConfiguration(id)
api.ers.getTierGroups(id)
api.ers.updateTierGroups(id, data)
api.ers.listIncidents(params)
api.ers.incidentDetail(uuid)

api.ens.listConfigurations(params)
api.ens.createConfiguration(data)
api.ens.updateConfiguration(id, data)
api.ens.listNotifications(params)
api.ens.triggerNotification(data)

api.ivr.listFlows(params)
api.ivr.getFlow(uuid)
api.ivr.createFlow(data)
api.ivr.updateFlow(uuid, data)
api.ivr.publishFlow(uuid, data)
api.ivr.getVersions(uuid)
api.ivr.getNodeTypes()

api.campaigns.list(params)
api.campaigns.pause(id)
api.campaigns.resume(id)
api.campaigns.cancel(id)

api.contacts.list(params)
api.contacts.create(data)
api.contacts.bulkUpload(formData)

api.groups.list(params)
api.groups.addMembers(id, contactIds)

api.monitoring.listConferences()
api.monitoring.mute(room, memberId)
api.monitoring.kick(room, memberId)

api.services.list(params)
api.services.create(data)

api.settings.getAll()
api.settings.update(key, value)

api.gateways.list()
api.gateways.deploy(id)

api.deployment.deployFlow(uuid)
api.deployment.reloadxml()
api.deployment.diagnostics()
```

All methods call the internal `request(method, path, body)` function which:
1. Reads access token from `authStore`
2. Sets `Authorization: Bearer <token>` header
3. On `401`: calls `POST /auth/refresh` → retries once
4. On persistent `401`: clears store → redirect to `/login`
