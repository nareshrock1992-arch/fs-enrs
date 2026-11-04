# Reporting Strategy

Report what is stored; label what is not. A missing value is never written as 0.

## Availability

| Metric | Source | State |
|---|---|---|
| Campaign reference, configuration, organization, status, timings, duration | `ens_campaigns` | Available |
| Initiator | `triggered_by` user, else `trigger_number` | Available |
| Recipients, answered, busy, no answer, failed, expired, skipped, pending | `ens_campaign_destinations`, one outcome per recipient | Available |
| Attempts, retries | `attempt_count` | Available |
| Average time to answer | `answered_at - last_attempt_at` (final attempt only) | Available; `answer_time_ms` is never written |
| Emergency type | — | **Not stored** |
| Acknowledgements, DTMF responses | — | **Not stored** |
| Incident, caller, tier, room, timings | `ers_incidents` | Available |
| Responders invited, joined, not joined; ring and join times; hang-up cause | `ers_incident_responders` | Available |
| Participant time and disconnect cause | `ers_incident_participants` | Available |
| Recording file | `recordings`, same tenant | Available |
| IVR executions, node traversal, DTMF, drop-off | — | **Not stored**; no IVR report is possible yet |

## Outcome rules

Answered if `answered_at` is set; otherwise pending (queued, dialing), expired, skipped; otherwise by hang-up cause:
busy, no answer, or failed. A test keeps the cause lists equal to `campaignEngine.js`. Rates are empty, not 0%, when
there are no recipients.

## Exports

`GET /reports/ens-campaigns/export`, `/reports/ens-campaigns/:id/export` and `/reports/ers/export` return `.xlsx`:
a Summary sheet (generated time and user, filters, totals, notes) plus detail sheets with frozen headers, filters,
column widths, and real date, number and duration cells. Times are UTC and labelled. Each export is written to
`audit_logs` as `report_exported`.

## Size limit

Workbooks are capped at 50,000 rows (413 with guidance). Above 2,000 rows the workbook is built in a worker thread
(Cycle 2), so a large export does not hold up the thread that serves live events. No job queue is used.

## Campaign dashboard (Cycle 3)

The ENS Campaigns page now uses the same per-recipient outcomes as the reports (`services/ensOutcomes.js`). Its cards
used the attempt counters on `ens_campaigns`, so a campaign could show 0 answered while recipients had answered.

## Data model for what is not stored (proposal, not implemented)

None of these can be reconstructed for past calls; reports will show "not recorded" before the change, never 0.

| Need | Proposed storage | Written by | Rollout risk |
|---|---|---|---|
| ENS acknowledgement / DTMF response | `ens_destination_responses (destination_id, campaign_id, tenant_id, digits, received_at)`; the engine already sees DTMF events over ESL | Backend ESL handler (no Lua change): match the event's call UUID to `ens_campaign_destinations.call_uuid` | Low: additive table; needs a real call to confirm the DTMF event fields |
| Emergency type | `ens_configurations.emergency_type` (enumerated, nullable) copied to `ens_campaigns.emergency_type` at creation | Admin form; `createCampaign*` | Low: nullable columns, migration only |
| IVR execution history | `ivr_executions (uuid, tenant_id, flow_id, version, number, caller, started_at, ended_at, outcome)` and `ivr_execution_steps (execution_id, seq, node_id, node_type, branch, at)`; digits stored only as a length unless the flow marks the field reportable | Executor posts once at the end of the call (one internal request, not per node) | Medium: Lua change, call-tested rollout; volume needs a retention policy |

## Not done yet

Search, sorting and organization filter in the report UI; trend charts; opening an export in real Excel.
