# Administrator Guide

**Document:** 24-administrator-guide.md  
**Product:** fs-enrs  
**Audience:** System administrators, tenant administrators  
**Scope:** Post-installation configuration, user management, operational administration

---

## Initial Setup Checklist

Complete the following steps in order after installation. All UI paths are relative to the application root (default: `http://<host>:8100`).

- [ ] **1.** Log in with default credentials: `admin@enrs.local` / `Admin@12345`
- [ ] **2.** Change admin password: **Settings → Security → Change Password**
- [ ] **3.** Create your organization(s): **Organizations → New**
- [ ] **4.** Upload locations for each organization
- [ ] **5.** Import emergency contacts (bulk CSV or manual entry)
- [ ] **6.** Create responder groups and assign contacts to groups
- [ ] **7.** Configure ERS if required: **ERS → New Configuration**
- [ ] **8.** Configure ENS if required: **ENS → New Configuration**
- [ ] **9.** Upload audio files: **Deployment → Audio → Upload**
- [ ] **10.** Deploy audio files to FreeSWITCH
- [ ] **11.** Create IVR flows: **IVR → New Flow**
- [ ] **12.** Publish and deploy IVR flows
- [ ] **13.** Bind emergency numbers to flows and configurations
- [ ] **14.** Test by calling each configured number from a registered extension
- [ ] **15.** Create additional user accounts for operators and supervisors

---

## User Management

### Roles and Permissions

| Role | Access Level |
|---|---|
| `ADMIN` | Full access — user management, configuration, deployments, reporting |
| `SUPERVISOR` | Monitoring, incident management, reporting; no user management or configuration changes |
| `OPERATOR` | Basic incident monitoring and reporting; no configuration changes |
| `VIEWER` | Read-only access to monitoring and reports |

Role enforcement is implemented in `backend/src/middleware/rbac.js`. Role checks are applied at the route level — role cannot be escalated via request body.

### Creating a User

**Endpoint:** `POST /api/v1/users`  
**Required role:** `ADMIN`

```json
{
  "email": "user@example.com",
  "fullName": "Jane Smith",
  "role": "SUPERVISOR",
  "password": "SecurePass123!"
}
```

**Response:** `201 Created` with the new user record (password excluded).

### Password Policy

- The `must_change_password` flag is set on accounts created by an administrator. The user is prompted to change their password on first login.
- Account lockout: after a configurable number of failed login attempts, `locked_until` is set. The account is automatically unlocked after the lockout period expires, or an administrator can clear `locked_until` directly in the database.

---

## Feature Flags

Feature flags control module availability at runtime. They are stored in the `feature_flags` table.

| Flag | Default | Description |
|---|---|---|
| `ens_enabled` | `false` | Enable the ENS (Emergency Notification System) module |
| `ers_enabled` | `false` | Enable the ERS (Emergency Response System) module |
| `ivr_designer` | `false` | Enable the IVR flow builder UI |
| `multi_tenant` | `false` | Enable multi-tenant mode (multiple organizations with isolation) |
| `csv_bulk_upload` | `false` | Enable bulk contact import via CSV |
| `audit_logging` | `false` | Enable write-through to the `audit_logs` table |

**To enable a feature flag:**

```sql
UPDATE feature_flags SET is_enabled = true WHERE key = 'ens_enabled';
```

**To disable:**

```sql
UPDATE feature_flags SET is_enabled = false WHERE key = 'ens_enabled';
```

Changes take effect immediately — no restart required. The backend reads flag state per request.

---

## ERS Administration

### Creating an ERS Configuration

**Endpoint:** `POST /api/v1/ers/configurations`  
**Required role:** `ADMIN`

```json
{
  "name": "Building A Emergency Response",
  "organization_id": 1,
  "max_concurrent_conferences": 2,
  "conference_profile": "default",
  "emergency_number": "5911",
  "rejoin_number": "5912",
  "ring_timeout_seconds": 300,
  "record_conferences": true,
  "queue_enabled": true,
  "allow_rejoin": true
}
```

**Field reference:**

| Field | Description |
|---|---|
| `max_concurrent_conferences` | Maximum simultaneous active conferences for this configuration; additional calls are queued when `queue_enabled: true` |
| `conference_profile` | FreeSWITCH conference profile name (must exist in `conference.conf.xml`) |
| `emergency_number` | Dialable extension/number that triggers ring-all and creates the conference |
| `rejoin_number` | Dialable number that allows a responder to rejoin an active conference |
| `ring_timeout_seconds` | Duration (seconds) ring-all continues attempting to reach responders |
| `record_conferences` | When `true`, FreeSWITCH records the conference to the ERS recordings directory |
| `queue_enabled` | When `true`, calls arriving when all slots are occupied are queued rather than rejected |
| `allow_rejoin` | When `true`, responders may rejoin via `rejoin_number` after initial hangup |

### Assigning Tier Groups

**Endpoint:** `PUT /api/v1/ers/configurations/:id/tier-groups`  
**Required role:** `ADMIN`

```json
{
  "primary": {
    "groups": [1, 2],
    "contacts": [5, 8]
  },
  "secondary": {
    "groups": [3],
    "contacts": []
  }
}
```

Primary tier contacts are called first. Secondary tier contacts are called if the primary tier does not answer within the configured timeout. Both individual contacts and group members are resolved and deduplicated at call time.

**Prerequisite:** `extension_number` must be set on every `emergency_contacts` record assigned to a tier.

### Binding Emergency Numbers

The `emergency_numbers` table is the unified service registry. An ERS number binding must have:
- `type = 'ERS'`
- `ers_configuration_id` pointing to the target configuration
- `is_active = true`

Bindings are managed through the Settings → Emergency Numbers UI or directly via `POST /api/v1/settings/emergency-numbers`.

### Managing Active Incidents

| Operation | Endpoint |
|---|---|
| List all incidents (active + historical) | `GET /api/v1/ers/incidents` |
| View live member list | `GET /api/v1/ers/conference/:room/members` |
| Manually complete an incident | `POST /api/v1/ers/incidents/:uuid/complete` |
| Cancel a stuck QUEUED incident | `POST /api/v1/ers/incidents/:uuid/cancel` |

---

## ENS Administration

### Creating an ENS Configuration

**Endpoint:** `POST /api/v1/ens/configurations`  
**Required role:** `ADMIN`

```json
{
  "name": "Hospital Code Blue",
  "organization_id": 1,
  "destination_number": "5500",
  "blast_clid": "5500",
  "reply_clid": "5501",
  "playback_number": "5501",
  "pin": "1234",
  "max_concurrent_calls": 30,
  "calls_per_second": 2.0,
  "max_attempts": 3,
  "retry_interval_sec": 60,
  "campaign_timeout_min": 120,
  "no_pending_msg": "There are no active notifications at this time.",
  "expiry_announcement": "This notification has expired."
}
```

**Field reference:**

| Field | Description |
|---|---|
| `destination_number` | Number dialed by the notification initiator to record and send a blast |
| `blast_clid` | Caller ID presented to recipients during the outbound notification call |
| `reply_clid` | Number recipients call back to hear the notification playback |
| `playback_number` | Internal routing number for the playback IVR handler |
| `pin` | PIN required for initiator authentication before recording (stored in DB; never returned to Lua — Lua calls `verify-pin` endpoint) |
| `max_concurrent_calls` | Maximum simultaneous outbound notification calls |
| `calls_per_second` | Outbound call origination rate limit |
| `max_attempts` | Number of times the engine will attempt to reach each destination before marking it failed |
| `retry_interval_sec` | Seconds between retry attempts for each destination |
| `campaign_timeout_min` | Minutes after which an incomplete campaign is automatically expired |
| `no_pending_msg` | Text-to-speech message played when no active notification exists |
| `expiry_announcement` | Text-to-speech message played when a notification has expired |

### Triggering ENS via UI

**Endpoint:** `POST /api/v1/ens/notifications`  
**Required role:** `ADMIN` or `SUPERVISOR`

```json
{
  "configuration_id": 1,
  "triggered_via": "UI",
  "recording_file": "/var/lib/freeswitch/recordings/ens/message.wav"
}
```

The recording file must be accessible to the FreeSWITCH process. For phone-initiated blasts, recording is captured through the IVR flow.

---

## IVR Administration

IVR flows are built graphically in the IVR Designer UI, then published and deployed to FreeSWITCH.

### Workflow

| Step | UI Path / Endpoint |
|---|---|
| 1. Create flow | `POST /api/v1/ivr/flows` or **IVR → New Flow** |
| 2. Edit graph | **IVR → [flow name]** — drag-and-drop node canvas |
| 3. Validate | `POST /api/v1/ivr/flows/:uuid/validate` (automatic before publish) |
| 4. Publish | `POST /api/v1/ivr/flows/:uuid/publish` — creates immutable version |
| 5. Bind number | `PATCH /api/v1/ivr/flows/:uuid/bind { "number_id": N }` |
| 6. Deploy | `POST /api/v1/deployment/flows/:uuid/deploy` — writes Lua + XML to FreeSWITCH |

**Important:** Publishing creates an immutable `ivr_flow_versions` record. Subsequent edits require re-publishing before deployment picks up the changes.

---

## Gateway Administration (Production PSTN)

PSTN gateway configuration is required when `ENS_ORIGINATE_MODE=gateway` or when ERS responders use PSTN numbers rather than internal SIP extensions.

### Configuring a Gateway

**Step 1 — Register the gateway:**

```http
POST /api/v1/gateways
```

```json
{
  "name": "Primary SIP Trunk",
  "type": "sip",
  "host": "sip.provider.example.com",
  "port": 5060,
  "username": "account_id",
  "password": "sip_password",
  "register": true,
  "is_default_outbound": true
}
```

**Step 2 — Deploy gateway to FreeSWITCH:**

```http
POST /api/v1/gateways/:id/deploy
```

This writes the FreeSWITCH SIP profile XML and reloads the profile.

**Step 3 — Update backend origination mode:**

```bash
# backend/.env
ENS_ORIGINATE_MODE=gateway
```

Restart the backend after updating `.env`.

**Step 4 — Reload FreeSWITCH SIP profile:**

```bash
fs_cli -x "sofia profile external restart"
```

Verify registration: `fs_cli -x "sofia status gateway Primary SIP Trunk"`

---

## Backup and Recovery

### Database Backup

```bash
# Full database dump
pg_dump -U fs_enrs fs_enrs > backup_$(date +%Y%m%d_%H%M%S).sql

# Compress for storage
pg_dump -U fs_enrs fs_enrs | gzip > backup_$(date +%Y%m%d).sql.gz
```

Schedule daily backups via cron. Retain at minimum 30 days of backups.

### Recording Backup

```bash
# Sync recordings to backup storage (adjust destination as appropriate)
rsync -av --progress /var/lib/freeswitch/recordings/ /backup/recordings/
```

### Restore Procedure

```bash
# Restore from SQL dump
psql -U fs_enrs fs_enrs < backup_20250120.sql
```

**Post-restore steps:**
1. Verify `schema_migrations` table reflects all expected migrations.
2. Restart the backend to re-establish DB pool connections.
3. Confirm ESL connectivity and campaign engine status via diagnostic endpoints.

---

## Audit Logging

When `feature_flag` `audit_logging = true`, all authenticated API requests are written to the `audit_logs` table.

### Schema

| Column | Type | Description |
|---|---|---|
| `user_id` | `INTEGER` | Authenticated user performing the action |
| `action` | `TEXT` | Verb describing the action (e.g., `CREATE`, `UPDATE`, `DELETE`) |
| `entity_type` | `TEXT` | Resource type affected (e.g., `ers_configuration`, `contact`) |
| `entity_id` | `TEXT` | ID of the affected record |
| `details` | `JSONB` | Request body or change summary |
| `ip_address` | `INET` | Client IP address |
| `http_method` | `TEXT` | HTTP method |
| `http_path` | `TEXT` | Request path |
| `user_agent` | `TEXT` | Client user agent string |
| `created_at` | `TIMESTAMPTZ` | Timestamp |

### Querying Audit Logs

```sql
-- All actions by a specific user (most recent first)
SELECT action, entity_type, entity_id, http_method, http_path, created_at
FROM audit_logs
WHERE user_id = 5
ORDER BY created_at DESC
LIMIT 100;

-- All changes to ERS configurations in the last 7 days
SELECT u.email, a.action, a.entity_id, a.details, a.created_at
FROM audit_logs a
JOIN users u ON u.id = a.user_id
WHERE a.entity_type = 'ers_configuration'
  AND a.created_at > now() - INTERVAL '7 days'
ORDER BY a.created_at DESC;
```
