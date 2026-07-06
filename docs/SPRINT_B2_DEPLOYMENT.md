# Sprint B2 — Real-time Dashboard: Deployment Guide

## What changed

| Layer    | File                                              | Change                                                          |
|----------|---------------------------------------------------|-----------------------------------------------------------------|
| Frontend | `src/hooks/useSocketEvent.js`                     | New hook — stable Socket.IO listener with `useRef` handler      |
| Frontend | `src/hooks/useLiveDuration.js`                    | New hook — ticking elapsed timer from ISO start time            |
| Frontend | `src/components/ui/ProgressRing.jsx`              | New SVG circular progress component                             |
| Frontend | `src/components/ui/PulsingDot.jsx`                | New animated presence indicator                                 |
| Frontend | `src/components/dashboard/EslStatusBanner.jsx`    | New ESL connection status bar (push-driven)                     |
| Frontend | `src/components/dashboard/ENSBlastPanel.jsx`      | New live blast progress cards                                   |
| Frontend | `src/components/dashboard/ErsActivePanel.jsx`     | New live incident cards with responder chips                    |
| Frontend | `src/components/dashboard/ErsQueuePanel.jsx`      | New queue row list with live wait timers                        |
| Frontend | `src/pages/Dashboard.jsx`                         | Full rewrite — `useReducer` + push-driven state                 |
| Frontend | `src/pages/ers/ErsLive.jsx`                       | Upgraded — push-driven incidents, REST queue sync               |
| Frontend | `src/pages/Monitoring.jsx`                        | Upgraded — push-driven ESL status + conference list             |
| Frontend | `src/api/client.js`                               | Added `api.ers.completeIncident(uuid)`                          |
| Backend  | `src/controllers/dashboardController.js`          | Enriched `getActive`: `incident_uuid`, `caller_number`, `responders` array |
| Backend  | `src/services/eslService.js`                      | Added `reconnect_attempts` counter; fuller `esl.status` payload |

## No new dependencies

Sprint B2 uses only packages already installed. No `npm install` required.

## No new migrations

No schema changes in B2. All new fields come from existing columns.

## Deployment steps (Dabin server)

```bash
# 1. Pull latest
cd /opt/fs-enrs
git pull

# 2. Rebuild frontend
cd frontend
npm run build

# 3. Reload backend (picks up dashboardController + eslService changes)
cd ..
pm2 reload enrs-backend

# 4. Verify ESL push events flow
#    Open dashboard in browser — ESL status banner should show green/red within 2s of load
#    Trigger a test ERS call — incident card should appear without page refresh
```

## Smoke tests (manual)

1. **ESL Banner** — Disconnect FreeSWITCH (`fs_cli -x "shutdown"` on FS server). Banner turns red within 5s. Restart FS — banner turns green.

2. **ERS Incident** — Dial an ERS number. Incident card should appear on Dashboard and ErsLive within 1-2 seconds. Live duration timer ticks every second.

3. **Responder join** — Second phone dials the conference. Responder chip appears on the incident card within 1-2 seconds (green chip shows masked number).

4. **ENS Blast** — Trigger a test blast via API. Blast card appears on Dashboard with ProgressRing at 0%. As Lua calls `POST /api/v1/internal/ens/notifications/:uuid/delivery`, ring advances in real time.

5. **Queue** — Call ERS while a conference is already active. Queue row appears on Dashboard and ErsLive. When the active incident completes, queue row disappears.

6. **Complete button** — Click the ✓ button on an incident in ErsLive. Card disappears immediately (optimistic). Confirm `ers_incidents.status = 'COMPLETED'` in DB.

## Rollback

If the frontend has a rendering error after deploy:

```bash
cd frontend
git stash   # or revert to previous dist
npm run build
```

Backend changes are additive (no schema changes, no removed routes) — rollback is not needed unless `getActive` response breaks something.
