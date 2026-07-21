# Troubleshooting Guide

**Document:** 23-troubleshooting-guide.md  
**Product:** fs-enrs  
**Audience:** System administrators, network engineers, integration engineers  
**Scope:** Runtime diagnostics, failure isolation, and recovery procedures

---

## Diagnostic Tools

Before investigating individual symptoms, run the following diagnostics to establish baseline system state.

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/deployment/diagnostics` | Overall system health: path accessibility, ESL state, DB connectivity |
| `GET /api/v1/monitoring/status` | ESL connection state + live conference count |
| `GET /api/v1/monitoring/debug/conf-sync` | Force immediate xml_list resync from FreeSWITCH |

**Backend SQL logging:** Set `NODE_ENV=development` to enable annotated query logging. All SQL errors include `._sql` (query text) and `._params` (bound values) in the log output, written at `ERROR` level.

---

## Problem: ESL Not Connected

**Symptoms**
- `GET /api/v1/monitoring/status` returns `esl_connected: false`
- No real-time conference events delivered to monitoring UI
- Ring-all fails silently — no responders called

**Diagnostic Checklist**

| Step | Command / Check |
|---|---|
| 1. Verify FreeSWITCH is running | `fs_cli -x "status"` |
| 2. Verify ESL port is listening | `netstat -tlnp \| grep 8021` |
| 3. Verify backend environment | Confirm `ESL_HOST`, `ESL_PORT`, `ESL_PASSWORD` in `backend/.env` |
| 4. Verify ESL password matches FS config | `/etc/freeswitch/autoload_configs/event_socket.conf.xml` — `<param name="password" value="..."/>` |
| 5. Verify network path | From backend host: `nc -zv $ESL_HOST 8021` |
| 6. Confirm backend reconnect attempt | Backend log line: `[esl] Connecting to X.X.X.X:8021` |

**Recovery**

ESL auto-reconnects on the interval configured by `ESL_RECONNECT_MS` (default: `3000` ms). Correcting the FreeSWITCH configuration or network path causes automatic reconnection without a backend restart.

If reconnection does not occur within 30 seconds after the fix, restart the backend process.

---

## Problem: IVR Deployment Fails

**Symptoms**
- `POST /api/v1/deployment/flows/:uuid/deploy` returns an error response
- FreeSWITCH dialplan not updated after deploy

**Diagnostic Checklist**

| Step | Command / Check |
|---|---|
| 1. Verify filesystem paths | `GET /api/v1/deployment/diagnostics/paths` — confirms each path exists and is writable |
| 2. Verify environment variables | `FS_SCRIPT_DIR`, `FS_DIALPLAN_DIR` must point to writable directories |
| 3. Verify process permissions | `ls -la /etc/freeswitch/dialplan/` and `ls -la /usr/share/freeswitch/scripts/` — backend process user must have write access |
| 4. Verify ESL is connected | `reloadxml` is issued over ESL; deployment fails if ESL is disconnected |
| 5. Verify extension loaded | After `reloadxml`, backend polls `verifyExtensionLoaded` (3 attempts × 500 ms delay) |
| 6. Check FreeSWITCH XML parse errors | `/var/log/freeswitch/freeswitch.log` — search for `[ERROR]` around the reload timestamp |

**Recovery**

1. Fix filesystem permissions or incorrect path environment variables.
2. Reconnect ESL (see ESL Not Connected procedure above).
3. Redeploy the flow via `POST /deployment/flows/:uuid/deploy`.

---

## Problem: Reports Show 0 Responders / 0 Answered

**Symptoms**
- ERS incident occurred and monitoring displayed active conference participants
- Post-incident report shows `responder_count: 0`, `answered_count: 0`, `participant_count: 1` (initiator only)

**Root Cause**

`trackParticipant` was resolving contact identity using `Caller-Caller-ID-Number`, which equals the initiator's origination caller ID due to `origination_caller_id_number` passthrough. This caused all responder joins to be misidentified as the initiator. The fix changes lookup order to use `Caller-Destination-Number` (`destNum`) first, falling back to `callerNum` only for the initiator's inbound leg.

**Diagnostic Checklist**

```sql
-- Step 1: Inspect raw participant rows
SELECT * FROM ers_incident_participants WHERE incident_id = <incident_id>;

-- Step 2: Inspect responder rows
SELECT * FROM ers_incident_responders WHERE ers_incident_id = <incident_id>;
```

| Step | Check |
|---|---|
| 3. Backend log errors | Search logs for `[esl] trackParticipant failed` during the incident window |
| 4. Contact extension data | Verify `extension_number` is set on all `emergency_contacts` records for this configuration |

**Recovery**

The fix is already applied in the current codebase. Historical incidents with missing responder data cannot be backfilled — the ESL event data is not retained after processing.

**Prevention:** Ensure `extension_number` is populated for every `emergency_contacts` record before assigning them to an ERS tier.

---

## Problem: Monitoring Shows "Outbound Call" as Member Name

**Symptoms**
- Active conference member list in monitoring UI shows display name `"Outbound Call"` instead of the responder's name

**Cause**

Before the `trackParticipant` fix, the `Caller-Caller-ID-Name` field in the `add-member` ESL event contained `"Outbound Call"` — the FreeSWITCH default when `origination_caller_id_name` is not applied or when the initiator's name is not configured. The member registry was not updated with the resolved contact name.

After the fix, `trackParticipant` resolves the contact by `destNum` and updates `registry.member.displayName` to the actual responder name from `emergency_contacts`.

**Diagnostic Checklist**

| Step | Check |
|---|---|
| 1. Contact extension set | Is `extension_number` populated on the `emergency_contacts` record? |
| 2. Backend log — contact found | Does the backend log show `trackParticipant` finding the contact by `destNum`? |
| 3. Name still wrong after fix | If extension data exists but name is still wrong, confirm the extension in the ESL event matches `extension_number` exactly (no leading zeros, no domain suffix) |

---

## Problem: ENS Campaign Not Starting

**Symptoms**
- `POST /api/v1/campaigns` returns `201 Created`
- No outbound calls placed; campaign status does not progress

**Diagnostic Checklist**

| Step | Command / Check |
|---|---|
| 1. Campaign engine running | `GET /campaigns/engine/stats` — `is_running` must be `true` |
| 2. Campaign status | `GET /campaigns/:id` — status should transition `queued → running` within 1 second of creation |
| 3. Campaign not expired | Check `campaign_timeout_min` — if elapsed time exceeds this, campaign is marked expired without dialing |
| 4. Destinations populated | Query `ens_campaign_destinations` for the campaign ID — must have rows |
| 5. ESL connected | `originateCampaignCall()` requires active ESL connection |
| 6. SIP gateway configured | `GET /gateways` — a default outbound gateway must exist for external PSTN calls |
| 7. Originate mode | `ENS_ORIGINATE_MODE=user` dials internal SIP extensions only; set to `gateway` for PSTN numbers |

**Recovery**

- If engine is stopped: restart the backend process (engine starts automatically on boot).
- If campaign is stuck in `queued`: cancel the campaign and recreate.
- If `ENS_ORIGINATE_MODE` is wrong: update `.env`, restart backend, recreate campaign.

---

## Problem: Conference Not Appearing in Monitoring

**Symptoms**
- Active ERS incident exists in DB but monitoring UI shows no conference
- Member count shows zero despite active FreeSWITCH conference

**Cause**

Conference was created in FreeSWITCH but the `conference-create` ESL event was not received by the backend — typically due to ESL disconnection at the moment of conference creation, or a missed event during reconnect.

**Diagnostic Checklist**

| Step | Command / Check |
|---|---|
| 1. ESL connected | `GET /monitoring/status` — `esl_connected` must be `true` |
| 2. Wait for heartbeat reseed | The 30-second heartbeat re-seeds the conference registry from `xml_list` automatically |
| 3. Force immediate resync | `POST /monitoring/debug/conf-sync` |
| 4. Verify conference exists in FS | `fs_cli -x "conference list"` — confirms whether FreeSWITCH has the conference |

---

## Problem: Ring-All Not Calling Responders

**Symptoms**
- ERS incident created successfully
- No outbound calls placed to responders

**Diagnostic Checklist**

| Step | Command / Check |
|---|---|
| 1. Responders assigned | `GET /ers/configurations/:id/tier-groups` — primary/secondary tiers must have contacts or groups assigned |
| 2. Contacts active | Verify `emergency_contacts.is_active = true` for all responder records |
| 3. Extension numbers set | Verify `extension_number` is populated on all responder contacts |
| 4. ESL connected | Ring-all uses ESL `originate` command |
| 5. SIP registration | FreeSWITCH must be able to reach the responder extensions (SIP registered) |
| 6. Backend log — ring start | Search logs for `[ersRingService] startRingAll` during incident creation timestamp |
| 7. Ring deduplication | Confirm no prior active ring loop exists for this room (`activeRings` Map deduplicates by room name) |

---

## Problem: IVR Call Drops After Answering

**Symptoms**
- Caller dials IVR number; call is answered
- Brief silence followed by hangup

**Diagnostic Checklist**

| Step | Command / Check |
|---|---|
| 1. Lua script present | Verify `ivr_executor.lua` exists at the path configured by `FS_SCRIPT_DIR` |
| 2. Lua syntax error | Check `/var/log/freeswitch/freeswitch.log` for Lua parse or runtime errors |
| 3. Internal API reachable from FS | `curl -H "X-Internal-Key: $FS_INTERNAL_KEY" http://127.0.0.1:4100/api/v1/internal/ivr/lookup?number=TEST` — must return 200 |
| 4. API URL configured in Lua | `ENRS_API_URL` environment variable must be set and reachable from the FreeSWITCH host |
| 5. IVR flow published and bound | Confirm a published IVR version exists and `emergency_numbers` has `type=IVR` bound to this number |

---

## Problem: Database Migration Fails

**Diagnostic Checklist**

| Step | Command / Check |
|---|---|
| 1. DB credentials | Verify `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` in `backend/.env` |
| 2. Partial application | `SELECT * FROM schema_migrations ORDER BY applied_at;` — identify last successfully applied migration |
| 3. Idempotency check | Confirm migration file uses `IF NOT EXISTS` and `ON CONFLICT DO NOTHING` throughout |
| 4. Run migration manually | `psql -U fs_enrs -d fs_enrs -f backend/src/db/migrations/XXX_name.sql` — captures full error output |

---

## Problem: JWT Authentication Fails

**Diagnostic Checklist**

| Step | Check |
|---|---|
| 1. Secrets configured | `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` must be set to non-default values (minimum 32 characters) |
| 2. Token expired | Access tokens expire after 15 minutes. The client must call `POST /auth/refresh` using the httpOnly cookie to obtain a new access token |
| 3. Clock skew | JWT validation uses `exp` claim; server and client clocks must be within 60 seconds |
| 4. Role insufficient | VIEWER role attempting ADMIN-only endpoint returns `403 Forbidden` — not an auth failure |

---

## Problem: Recording Not Saved

**Symptoms**
- ERS incident completed but no recording file found

**Diagnostic Checklist**

| Step | Command / Check |
|---|---|
| 1. Recording enabled | Verify `record_conferences = true` in the ERS configuration |
| 2. Directory exists and writable | `ls -la /var/lib/freeswitch/recordings/ers/` — directory must exist with write permission for the FreeSWITCH process user |
| 3. FreeSWITCH process permissions | FreeSWITCH user must own or have write access to the recordings directory |
| 4. ESL start-recording event | Backend log: search for `start-recording` ESL event receipt during the incident window |
| 5. Background scanner | The 120-second `scanRecordingDirectory` job heals missed `stop-recording` events — check logs for scan results |
