# Reporting Guide

## Overview

fs-enrs provides two primary report categories: ERS incident reports and ENS broadcast reports. All reporting endpoints require the ADMIN or OPERATOR role. Reports reflect persisted historical data and are accurate regardless of live conference state.

---

## ERS Incident Reports

### Summary Report

**Endpoint:** `GET /reports/ers`

**Query Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `page` | integer | Page number (1-based) |
| `limit` | integer | Records per page |
| `from` | ISO 8601 | Start of date range (inclusive) |
| `to` | ISO 8601 | End of date range (inclusive) |
| `status` | string | Filter by incident status |
| `org_id` | UUID | Filter by organization |

**Response fields per incident:**

| Field | Source | Description |
|---|---|---|
| `incident_uuid` | `ers_incidents.uuid` | Unique incident identifier |
| `conference_room` | `ers_incidents.conference_room` | FreeSWITCH conference room name |
| `started_at` | `ers_incidents.started_at` | Incident start timestamp |
| `ended_at` | `ers_incidents.ended_at` | Incident end timestamp (null if active) |
| `status` | `ers_incidents.status` | ACTIVE / ENDED / ABANDONED |
| `caller_number` | `ers_incidents.caller_number` | DNIS / initiating caller number |
| `caller_name` | `ers_incidents.caller_name` | Caller display name |
| `ers_configuration` | `ers_configurations.name` | ERS configuration name |
| `organization` | `organizations.name` | Organization name |
| `participant_count` | `ers_incident_participants` COUNT | Total participants (historical, persisted) |
| `responder_count` | `ers_incident_responders` COUNT | Contacts rung via ring-all |
| `answered_count` | `ers_incident_responders` | Responders with status JOINED or `join_time IS NOT NULL` |
| `duration_seconds` | `ended_at - started_at` | Incident duration in seconds |
| `recording_path` | `ers_incidents.recording_path` | Path to recording file (if enabled) |

---

### Detailed Report

**Endpoint:** `GET /reports/ers/:incidentUuid`

Returns full incident metadata plus two sub-arrays.

#### participants[]

Sourced from `ers_incident_participants`. Contains the historical record of every party that joined the conference bridge.

| Field | Description |
|---|---|
| `contact_id` | FK to `emergency_contacts` (nullable for external callers) |
| `raw_number` | Caller number as received by FreeSWITCH |
| `role` | `initiator` or `responder` |
| `joined_at` | Timestamp of first join |
| `left_at` | Timestamp of last departure |
| `rejoined_at` | Timestamp of most recent rejoin (if REJOIN flow used) |
| `first_name`, `last_name` | Joined from `emergency_contacts` |

#### responders[]

Sourced from `ers_incident_responders`. Contains the outcome for each contact that was rung by the ring-all mechanism.

| Field | Description |
|---|---|
| `emergency_contact_id` | FK to `emergency_contacts` |
| `mobile_number` | Number dialled for this responder |
| `status` | INVITED / JOINED / MISSED / REJOINED / OBSERVER |
| `join_time` | When the responder answered |
| `leave_time` | When the responder disconnected |
| `rejoin_count` | Number of REJOIN flow uses |
| `joined_via` | Channel or gateway used |

---

### Data Integrity Notes

- `participant_count` and `responder_count` are always sourced from persisted database records — never from live conference state.
- `trackParticipant` writes to `ers_incident_participants` in real time as ESL events fire, not post-hoc. Records survive conference teardown.
- Reports remain accurate after a conference ends.

---

## ENS Broadcast Reports

### Summary Report

**Endpoint:** `GET /reports/ens`

**Query Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `page` | integer | Page number (1-based) |
| `limit` | integer | Records per page |
| `from` | ISO 8601 | Start of date range (inclusive) |
| `to` | ISO 8601 | End of date range (inclusive) |
| `status` | string | Filter by notification status |
| `org_id` | UUID | Filter by organization |

**Response fields per notification:**

| Field | Source | Description |
|---|---|---|
| `notification_uuid` | `ens_notifications.uuid` | Unique notification identifier |
| `configuration` | `ens_configurations.name` | ENS configuration name |
| `organization` | `organizations.name` | Organization name |
| `triggered_via` | `ens_notifications.triggered_via` | PHONE / UI / API |
| `triggered_by` | `users.name` | User who initiated (if UI/API) |
| `started_at` | `ens_notifications.started_at` | Notification start timestamp |
| `completed_at` | `ens_notifications.completed_at` | Completion timestamp |
| `status` | `ens_notifications.status` | PENDING / ACTIVE / COMPLETED / CANCELLED |
| `total_targets` | campaign counter | Total contacts targeted |
| `total_answered` | campaign counter | Contacts who answered |
| `total_no_answer` | campaign counter | No-answer outcomes |
| `total_replayed` | campaign counter | Contacts who requested replay |
| `callback_count` | campaign counter | Callbacks received |

---

### Detailed Report

**Endpoint:** `GET /reports/ens/:notificationUuid`

Returns full notification metadata plus:

#### deliveries[]

Sourced from `ens_notification_deliveries` or `ens_campaign_destinations`.

| Field | Description |
|---|---|
| `contact_number` | Number dialled |
| `delivery_status` | PENDING / ANSWERED / NO_ANSWER / BUSY / FAILED |
| `attempt_number` | Which retry attempt this record represents |
| `answered_at` | Timestamp of answer (null if not answered) |
| `hangup_cause` | FreeSWITCH hangup cause string |
| `first_name`, `last_name` | Joined from `emergency_contacts` |

---

## Campaign Reports

### Campaign Summary

**Endpoint:** `GET /campaigns/:id`

Returns campaign record with all counters from `ens_campaigns`:

| Counter Field | Description |
|---|---|
| `total_destinations` | Total contacts targeted |
| `queued_count` | Contacts waiting to be dialled |
| `dialing_count` | Calls currently in progress |
| `answered_count` | Calls answered |
| `completed_count` | Calls fully completed (including DTMF interaction) |
| `failed_count` | Unrecoverable failures |
| `retried_count` | Contacts that required at least one retry |
| `busy_count` | BUSY / USER_BUSY outcomes |
| `no_answer_count` | NO_ANSWER / CALL_REJECTED outcomes |
| `peak_concurrent` | Maximum simultaneous calls reached |
| `campaign_duration_sec` | Total campaign runtime in seconds |

### Campaign Destinations

**Endpoint:** `GET /campaigns/:id/destinations`

Returns per-destination delivery status for every contact in the campaign.

---

## Aggregate Reports

| Endpoint | Description |
|---|---|
| `GET /reports/ers-incidents?from=&to=` | Time-range aggregate statistics for ERS incidents |
| `GET /reports/ens-broadcasts?from=&to=` | Time-range aggregate statistics for ENS broadcasts |
| `GET /reports/notifications` | Paginated list of all notifications |
| `GET /reports/incidents` | Paginated list of all incidents |
| `GET /reports/contact-usage` | Contact utilization across incidents and broadcasts |

---

## Dashboard

**Endpoint:** `GET /api/v1/dashboard`

Returns summary tiles for the main monitoring dashboard:

| Tile | Description |
|---|---|
| Active Incidents | Count of ERS incidents with status ACTIVE |
| Active Campaigns | Count of ENS campaigns currently running |
| Recent Incidents | List of most recent ERS incidents |
| Recent Broadcasts | List of most recent ENS notifications |

---

## Performance Indexes

Migration 030 adds the following indexes to support report query performance:

| Index Name | Table | Columns |
|---|---|---|
| `idx_ers_incidents_config_tier_status` | `ers_incidents` | `(ers_configuration_id, group_type, status)` |
| `idx_recordings_tenant_ts` | `recordings` | `(tenant_id, started_at DESC)` |
| Additional indexes | `campaign_destinations`, `incident_participants` | See migration 030 |

These indexes materially reduce query time for date-range and status-filtered report queries on large datasets.
