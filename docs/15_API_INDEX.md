# 15 — Master API Index

All endpoints across both API surfaces. `requireAuth` = JWT Bearer token. `internalAuth` = X-Internal-Key header.

## UI API (`/api/v1/`)

| # | Method | Path | Auth | Role | Controller |
|---|---|---|---|---|---|
| 1 | POST | `/auth/login` | None | — | `authController.login` |
| 2 | POST | `/auth/refresh` | Cookie | — | `authController.refresh` |
| 3 | POST | `/auth/logout` | Bearer | any | `authController.logout` |
| 4 | GET | `/auth/me` | Bearer | any | `authController.me` |
| 5 | POST | `/auth/change-password` | Bearer | any | `authController.changePassword` |
| 6 | GET | `/users` | Bearer | ADMIN | `userController.list` |
| 7 | GET | `/users/:id` | Bearer | ADMIN | `userController.get` |
| 8 | POST | `/users` | Bearer | ADMIN | `userController.create` |
| 9 | PUT | `/users/:id` | Bearer | ADMIN | `userController.update` |
| 10 | DELETE | `/users/:id` | Bearer | ADMIN | `userController.delete` |
| 11 | GET | `/organizations` | Bearer | ADMIN/OP | `organizationController.list` |
| 12 | GET | `/organizations/:id` | Bearer | ADMIN/OP | `organizationController.get` |
| 13 | POST | `/organizations` | Bearer | ADMIN | `organizationController.create` |
| 14 | PUT | `/organizations/:id` | Bearer | ADMIN | `organizationController.update` |
| 15 | DELETE | `/organizations/:id` | Bearer | ADMIN | `organizationController.delete` |
| 16 | GET | `/organizations/locations` | Bearer | ADMIN/OP | `organizationController.listLocations` |
| 17 | POST | `/organizations/locations` | Bearer | ADMIN | `organizationController.createLocation` |
| 18 | PUT | `/organizations/locations/:id` | Bearer | ADMIN | `organizationController.updateLocation` |
| 19 | DELETE | `/organizations/locations/:id` | Bearer | ADMIN | `organizationController.deleteLocation` |
| 20 | GET | `/organizations/departments` | Bearer | ADMIN/OP | `organizationController.listDepts` |
| 21 | POST | `/organizations/departments` | Bearer | ADMIN | `organizationController.createDept` |
| 22 | PUT | `/organizations/departments/:id` | Bearer | ADMIN | `organizationController.updateDept` |
| 23 | DELETE | `/organizations/departments/:id` | Bearer | ADMIN | `organizationController.deleteDept` |
| 24 | GET | `/contacts` | Bearer | ADMIN/OP | `contactController.list` |
| 25 | GET | `/contacts/:id` | Bearer | ADMIN/OP | `contactController.get` |
| 26 | POST | `/contacts` | Bearer | ADMIN | `contactController.create` |
| 27 | PUT | `/contacts/:id` | Bearer | ADMIN | `contactController.update` |
| 28 | DELETE | `/contacts/:id` | Bearer | ADMIN | `contactController.delete` |
| 29 | POST | `/contacts/bulk-upload` | Bearer | ADMIN | `contactController.bulkUpload` |
| 30 | GET | `/groups` | Bearer | ADMIN/OP | `groupController.list` |
| 31 | POST | `/groups` | Bearer | ADMIN | `groupController.create` |
| 32 | PUT | `/groups/:id` | Bearer | ADMIN | `groupController.update` |
| 33 | DELETE | `/groups/:id` | Bearer | ADMIN | `groupController.delete` |
| 34 | POST | `/groups/:id/members` | Bearer | ADMIN | `groupController.addMembers` |
| 35 | DELETE | `/groups/:id/members/:cid` | Bearer | ADMIN | `groupController.removeMember` |
| 36 | GET | `/ens/configurations` | Bearer | ADMIN/OP | `ensController.list` |
| 37 | GET | `/ens/configurations/:id` | Bearer | ADMIN/OP | `ensController.get` |
| 38 | POST | `/ens/configurations` | Bearer | ADMIN | `ensController.create` |
| 39 | PUT | `/ens/configurations/:id` | Bearer | ADMIN | `ensController.update` |
| 40 | PATCH | `/ens/configurations/:id/toggle` | Bearer | ADMIN | `ensController.toggle` |
| 41 | DELETE | `/ens/configurations/:id` | Bearer | ADMIN | `ensController.delete` |
| 42 | GET | `/ens/notifications` | Bearer | ADMIN/OP | `ensController.listNotifications` |
| 43 | POST | `/ens/notifications` | Bearer | canTriggerEns | `ensController.createNotification` |
| 44 | GET | `/ers/configurations` | Bearer | ADMIN/OP | `ersController.list` |
| 45 | GET | `/ers/configurations/:id` | Bearer | ADMIN/OP | `ersController.get` |
| 46 | POST | `/ers/configurations` | Bearer | ADMIN | `ersController.create` |
| 47 | PUT | `/ers/configurations/:id` | Bearer | ADMIN | `ersController.update` |
| 48 | PATCH | `/ers/configurations/:id/toggle` | Bearer | ADMIN | `ersController.toggle` |
| 49 | DELETE | `/ers/configurations/:id` | Bearer | ADMIN | `ersController.delete` |
| 50 | GET | `/ers/configurations/:id/tier-groups` | Bearer | ADMIN/OP | `ersController.getTierGroups` |
| 51 | PUT | `/ers/configurations/:id/tier-groups` | Bearer | ADMIN | `ersController.updateTierGroups` |
| 52 | GET | `/ers/incidents` | Bearer | ADMIN/OP | `ersController.listIncidents` |
| 53 | GET | `/ers/incidents/:uuid/detail` | Bearer | ADMIN/OP | `ersController.incidentDetail` |
| 54 | GET | `/ers/incidents/:id/responders` | Bearer | ADMIN/OP | `ersController.responders` |
| 55 | POST | `/ers/incidents/:uuid/complete` | Bearer | ADMIN/OP | `ersController.completeIncident` |
| 56 | POST | `/ers/incidents/:uuid/cancel` | Bearer | ADMIN/OP | `ersController.cancelIncident` |
| 57 | GET | `/ers/queue` | Bearer | ADMIN/OP | `ersController.queue` |
| 58 | GET | `/ers/conference/:room/members` | Bearer | ADMIN/OP | `ersController.conferenceMembers` |
| 59 | POST | `/ers/conference/:room/kick` | Bearer | ADMIN/OP | `ersController.kick` |
| 60 | POST | `/ers/conference/:room/mute` | Bearer | ADMIN/OP | `ersController.mute` |
| 61 | POST | `/ers/conference/:room/play` | Bearer | ADMIN/OP | `ersController.play` |
| 62 | GET | `/ivr/node-types` | Bearer | any | `ivrController.nodeTypes` |
| 63 | GET | `/ivr/flows` | Bearer | ADMIN/OP | `ivrController.list` |
| 64 | POST | `/ivr/flows` | Bearer | ADMIN | `ivrController.create` |
| 65 | GET | `/ivr/flows/templates` | Bearer | ADMIN/OP | `ivrController.templates` |
| 66 | POST | `/ivr/flows/templates/:id/create` | Bearer | ADMIN | `ivrController.createFromTemplate` |
| 67 | GET | `/ivr/flows/:uuid` | Bearer | ADMIN/OP | `ivrController.get` |
| 68 | PUT | `/ivr/flows/:uuid` | Bearer | ADMIN | `ivrController.update` |
| 69 | DELETE | `/ivr/flows/:uuid` | Bearer | ADMIN | `ivrController.delete` |
| 70 | POST | `/ivr/flows/:uuid/validate` | Bearer | ADMIN/OP | `ivrController.validate` |
| 71 | POST | `/ivr/flows/:uuid/publish` | Bearer | ADMIN | `ivrController.publish` |
| 72 | GET | `/ivr/flows/:uuid/versions` | Bearer | ADMIN/OP | `ivrController.versions` |
| 73 | GET | `/ivr/flows/:uuid/versions/:v` | Bearer | ADMIN/OP | `ivrController.getVersion` |
| 74 | PATCH | `/ivr/flows/:uuid/bind` | Bearer | ADMIN | `ivrController.bind` |
| 75 | PATCH | `/ivr/flows/:uuid/unbind` | Bearer | ADMIN | `ivrController.unbind` |
| 76 | GET | `/deployment/audio` | Bearer | ADMIN/OP | `deploymentController.listAudio` |
| 77 | GET | `/deployment/audio/categories` | Bearer | ADMIN/OP | `deploymentController.audioCategories` |
| 78 | POST | `/deployment/audio/scan` | Bearer | ADMIN | `deploymentController.scanAudio` |
| 79 | POST | `/deployment/audio/upload` | Bearer | ADMIN | `deploymentController.uploadAudio` |
| 80 | POST | `/deployment/audio/:id/deploy` | Bearer | ADMIN | `deploymentController.deployAudio` |
| 81 | GET | `/deployment/audio/:id/stream` | Bearer/Token | any | `deploymentController.streamAudio` |
| 82 | DELETE | `/deployment/audio/:id` | Bearer | ADMIN | `deploymentController.deleteAudio` |
| 83 | GET | `/deployment/flows` | Bearer | ADMIN/OP | `deploymentController.flows` |
| 84 | GET | `/deployment/flows/:uuid/preview` | Bearer | ADMIN/OP | `deploymentController.preview` |
| 85 | POST | `/deployment/flows/:uuid/deploy` | Bearer | ADMIN | `deploymentController.deployFlow` |
| 86 | GET | `/deployment/flows/:uuid/history` | Bearer | ADMIN/OP | `deploymentController.deployHistory` |
| 87 | POST | `/deployment/redeploy-all` | Bearer | ADMIN | `deploymentController.redeployAll` |
| 88 | GET | `/deployment/diagnostics` | Bearer | ADMIN/OP | `deploymentController.diagnostics` |
| 89 | POST | `/deployment/diagnostics/reloadxml` | Bearer | ADMIN | `deploymentController.reloadxml` |
| 90 | GET | `/deployment/diagnostics/paths` | Bearer | ADMIN/OP | `deploymentController.paths` |
| 91 | GET | `/deployment/diagnostics/esl` | Bearer | ADMIN/OP | `deploymentController.eslStatus` |
| 92 | POST | `/deployment/diagnostics/disable-legacy-extension` | Bearer | ADMIN | `deploymentController.disableLegacyExtension` |
| 93 | GET | `/services` | Bearer | any | `serviceController.list` |
| 94 | GET | `/services/:id` | Bearer | any | `serviceController.get` |
| 95 | POST | `/services` | Bearer | ADMIN | `serviceController.create` |
| 96 | PUT | `/services/:id` | Bearer | ADMIN | `serviceController.update` |
| 97 | DELETE | `/services/:id` | Bearer | ADMIN | `serviceController.delete` |
| 98 | GET | `/campaigns` | Bearer | ADMIN/OP | `campaignController.list` |
| 99 | GET | `/campaigns/engine/stats` | Bearer | ADMIN/OP | `campaignController.engineStats` |
| 100 | POST | `/campaigns` | Bearer | canTriggerEns | `campaignController.create` |
| 101 | GET | `/campaigns/:id` | Bearer | ADMIN/OP | `campaignController.get` |
| 102 | GET | `/campaigns/:id/destinations` | Bearer | ADMIN/OP | `campaignController.destinations` |
| 103 | POST | `/campaigns/:id/pause` | Bearer | ADMIN/OP | `campaignController.pause` |
| 104 | POST | `/campaigns/:id/resume` | Bearer | ADMIN/OP | `campaignController.resume` |
| 105 | POST | `/campaigns/:id/cancel` | Bearer | ADMIN/OP | `campaignController.cancel` |
| 106 | GET | `/dashboard/metrics` | Bearer | any | `dashboardController.metrics` |
| 107 | GET | `/dashboard/active` | Bearer | any | `dashboardController.active` |
| 108 | GET | `/dashboard/chart` | Bearer | any | `dashboardController.chart` |
| 109 | GET | `/reports/notifications` | Bearer | canExport | `reportController.notifications` |
| 110 | GET | `/reports/incidents` | Bearer | canExport | `reportController.incidents` |
| 111 | GET | `/reports/contact-usage` | Bearer | canExport | `reportController.contactUsage` |
| 112 | GET | `/reports/ers-incidents` | Bearer | canExport | `reportController.ersIncidents` |
| 113 | GET | `/reports/ens-broadcasts` | Bearer | canExport | `reportController.ensBroadcasts` |
| 114 | GET | `/settings` | Bearer | ADMIN | `settingsController.getAll` |
| 115 | GET | `/settings/test-mode` | Bearer | any | `settingsController.testMode` |
| 116 | GET | `/settings/emergency-numbers` | Bearer | ADMIN/SUPER | `settingsController.emergencyNumbers` |
| 117 | PUT | `/settings/:key` | Bearer | ADMIN | `settingsController.update` |
| 118 | GET | `/settings/esl/status` | Bearer | ADMIN | `settingsController.eslStatus` |
| 119 | GET | `/settings/feature-flags` | Bearer | ADMIN | `settingsController.featureFlags` |
| 120 | PATCH | `/settings/feature-flags/:key` | Bearer | ADMIN | `settingsController.toggleFlag` |
| 121 | GET | `/gateways` | Bearer | any | `gatewayController.list` |
| 122 | POST | `/gateways` | Bearer | ADMIN/SUPER | `gatewayController.create` |
| 123 | PUT | `/gateways/:id` | Bearer | ADMIN/SUPER | `gatewayController.update` |
| 124 | DELETE | `/gateways/:id` | Bearer | ADMIN/SUPER | `gatewayController.delete` |
| 125 | POST | `/gateways/:id/deploy` | Bearer | ADMIN/SUPER | `gatewayController.deploy` |
| 126 | GET | `/monitoring/conferences` | Bearer | any | `monitoringController.list` |
| 127 | GET | `/monitoring/status` | Bearer | any | `monitoringController.status` |
| 128 | GET | `/monitoring/debug/conf-sync` | Bearer | ADMIN/SUPER | `monitoringController.confSync` |
| 129 | POST | `/monitoring/conferences/:room/lock` | Bearer | ADMIN/SUPER | `monitoringController.lock` |
| 130 | POST | `/monitoring/conferences/:room/unlock` | Bearer | ADMIN/SUPER | `monitoringController.unlock` |
| 131 | POST | `/monitoring/conferences/:room/record/start` | Bearer | ADMIN/SUPER | `monitoringController.startRecord` |
| 132 | POST | `/monitoring/conferences/:room/record/stop` | Bearer | ADMIN/SUPER | `monitoringController.stopRecord` |
| 133 | POST | `/monitoring/conferences/:room/play` | Bearer | ADMIN/SUPER | `monitoringController.play` |
| 134 | POST | `/monitoring/conferences/:room/say` | Bearer | ADMIN/SUPER | `monitoringController.say` |
| 135 | POST | `/monitoring/conferences/:room/invite` | Bearer | ADMIN/SUPER | `monitoringController.invite` |
| 136 | DELETE | `/monitoring/conferences/:room` | Bearer | ADMIN/SUPER | `monitoringController.end` |
| 137 | POST | `/monitoring/conferences/:room/members/:id/mute` | Bearer | ADMIN/SUPER | `monitoringController.muteMember` |
| 138 | POST | `/monitoring/conferences/:room/members/:id/unmute` | Bearer | ADMIN/SUPER | `monitoringController.unmuteMember` |
| 139 | DELETE | `/monitoring/conferences/:room/members/:id` | Bearer | ADMIN/SUPER | `monitoringController.kickMember` |
| 140 | POST | `/monitoring/conferences/:room/members/:id/deaf` | Bearer | ADMIN/SUPER | `monitoringController.deafMember` |
| 141 | POST | `/monitoring/conferences/:room/members/:id/undeaf` | Bearer | ADMIN/SUPER | `monitoringController.undeafMember` |
| 142 | POST | `/monitoring/conferences/:room/members/:id/volume` | Bearer | ADMIN/SUPER | `monitoringController.volumeMember` |
| 143 | POST | `/monitoring/conferences/:room/members/:id/energy` | Bearer | ADMIN/SUPER | `monitoringController.energyMember` |
| 144 | POST | `/monitoring/conferences/:room/members/:id/floor` | Bearer | ADMIN/SUPER | `monitoringController.floorMember` |
| 145 | POST | `/monitoring/conferences/:room/members/:id/transfer` | Bearer | ADMIN/SUPER | `monitoringController.transferMember` |
| 146 | GET | `/media-library` | Bearer | ADMIN/OP | `mediaLibraryController.list` |
| 147 | GET | `/media-library/categories` | Bearer | ADMIN/OP | `mediaLibraryController.categories` |
| 148 | POST | `/media-library/upload` | Bearer | ADMIN | `mediaLibraryController.upload` |
| 149 | POST | `/media-library/scan` | Bearer | ADMIN | `mediaLibraryController.scan` |
| 150 | GET | `/media-library/:id` | Bearer | ADMIN/OP | `mediaLibraryController.get` |
| 151 | PUT | `/media-library/:id` | Bearer | ADMIN | `mediaLibraryController.update` |
| 152 | POST | `/media-library/:id/deploy` | Bearer | ADMIN | `mediaLibraryController.deploy` |
| 153 | GET | `/media-library/:id/stream` | Bearer/Token | any | `mediaLibraryController.stream` |
| 154 | GET | `/media-library/:id/download` | Bearer/Token | any | `mediaLibraryController.download` |
| 155 | GET | `/media-library/:id/waveform` | Bearer/Token | any | `mediaLibraryController.waveform` |
| 156 | DELETE | `/media-library/:id` | Bearer | ADMIN | `mediaLibraryController.delete` |
| 157 | GET | `/recordings` | Bearer | canViewRec | `recordingController.list` |
| 158 | GET | `/recordings/:id` | Bearer | canViewRec | `recordingController.get` |
| 159 | PUT | `/recordings/:id` | Bearer | ADMIN/OP | `recordingController.update` |
| 160 | POST | `/recordings/:id/archive` | Bearer | ADMIN/OP | `recordingController.archive` |
| 161 | DELETE | `/recordings/:id` | Bearer | ADMIN/OP | `recordingController.delete` |
| 162 | GET | `/recordings/:id/stream` | Bearer/Token | canViewRec | `recordingController.stream` |
| 163 | GET | `/recordings/:id/download` | Bearer/Token | canViewRec | `recordingController.download` |
| 164 | GET | `/recordings/:id/waveform` | Bearer/Token | canViewRec | `recordingController.waveform` |

---

## Internal API (`/api/v1/internal/`)

All require `X-Internal-Key` header. Rate limit: 500 req/min.

| # | Method | Path | Controller |
|---|---|---|---|
| 165 | GET | `/services/:number` | `serviceController.internalLookup` |
| 166 | GET | `/ers/lookup` | `ersInternalController.ersLookup` |
| 167 | GET | `/ers/tier-status` | `ersInternalController.tierStatus` |
| 168 | POST | `/ers/ring-all` | `ersInternalController.ersRingAll` |
| 169 | POST | `/ers/overflow/enqueue` | `ersInternalController.enqueue` |
| 170 | GET | `/ers/overflow/poll` | `ersInternalController.pollQueue` |
| 171 | POST | `/ers/overflow/cancel` | `ersInternalController.cancelQueue` |
| 172 | GET | `/ers/playback/authorize` | `ersInternalController.authorizePlayback` |
| 173 | POST | `/ers/incidents` | `ersInternalController.createIncident` |
| 174 | GET | `/ers/incidents/:uuid/status` | `ersInternalController.incidentStatus` |
| 175 | POST | `/ers/incidents/:uuid/complete` | `ersInternalController.completeIncident` |
| 176 | PATCH | `/ers/incidents/:uuid/responder` | `ersInternalController.updateResponder` |
| 177 | POST | `/ers/incidents/:uuid/observer` | `ersInternalController.addObserver` |
| 178 | GET | `/ers/incidents/rejoin` | `ersInternalController.checkRejoin` |
| 179 | GET | `/ers/incidents/open-join` | `ersInternalController.openJoin` |
| 180 | GET | `/ens/lookup` | `ensInternalController.ensLookup` |
| 181 | POST | `/ens/verify-pin` | `ensInternalController.verifyPin` |
| 182 | POST | `/ens/campaign/start` | `ensInternalController.startCampaign` |
| 183 | GET | `/ens/notifications/queue-status` | `ensInternalController.queueStatus` |
| 184 | POST | `/ens/notifications` | `ensInternalController.createNotification` |
| 185 | GET | `/ens/notifications/:uuid/pending-contacts` | `ensInternalController.pendingContacts` |
| 186 | PATCH | `/ens/notifications/:uuid/delivery` | `ensInternalController.updateDelivery` |
| 187 | POST | `/ens/notifications/:uuid/complete` | `ensInternalController.completeNotification` |
| 188 | GET | `/ens/campaigns/latest` | `ensInternalController.latestCampaign` |
| 189 | GET | `/ens/campaigns/:id/playback-log` | `ensInternalController.playbackLog` |
| 190 | GET | `/ens/callbacks/authorize` | `ensInternalController.authorizeCallback` |
| 191 | POST | `/ens/callbacks` | `ensInternalController.createCallback` |
| 192 | GET | `/ivr/lookup` | `ivrInternalController.ivrLookup` |

---

## Non-versioned Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | None | Health check |
| GET/POST | `/socket.io/*` | JWT (socket auth) | Socket.IO transport |
| GET | `/uploads/*` | None | Static file serving |

---

**Total endpoints: ~192**
