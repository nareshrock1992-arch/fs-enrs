# fs-enrs Platform Documentation

**Emergency Notification and Response System — Complete Technical Reference**

---

## Documentation Map

### Architecture

| Document | Description |
|---|---|
| [01 — System Architecture](01-system-architecture.md) | Component overview, system boundaries, API surfaces, multi-tenancy |
| [02 — Runtime Architecture](02-runtime-architecture.md) | Express stack, JWT lifecycle, Socket.IO, ESL connection, background jobs |
| [03 — FreeSWITCH Integration](03-freeswitch-integration.md) | ESL events, conference rooms, ring-all, XML dialplan, Lua scripts |
| [04 — ESL Event Processing](04-esl-event-processing.md) | Every ESL event handler, conference registry, trackParticipant algorithm |
| [05 — Lua Runtime](05-lua-runtime.md) | ivr_executor.lua generation, node dispatch, HTTP transport, TTS, DTMF |
| [06 — XML Generation Pipeline](06-xml-generation-pipeline.md) | Dialplan XML, Lua generation, deploy pipeline, extension verification |

### Database & API

| Document | Description |
|---|---|
| [07 — Database Schema Reference](07-database-schema-reference.md) | All 33 tables: columns, indexes, FK constraints, soft-delete pattern |
| [08 — REST API Reference](08-rest-api-reference.md) | Every route: auth, request schema, response shape, error codes |

### IVR Designer

| Document | Description |
|---|---|
| [09 — IVR Designer User Manual](09-ivr-designer-user-manual.md) | Canvas UI, node palette, validate, publish, bind, deploy workflows |
| [10 — IVR Node Reference](10-ivr-node-reference.md) | All 17 node types: config fields, Lua generated, runtime behavior |
| [11 — Variable Reference](11-variable-reference.md) | Session variables, ENS workflow vars, ${} interpolation syntax |
| [12 — Expression and Condition Guide](12-expression-and-condition-guide.md) | All condition operators including time_of_day, ens_pin_valid, day_of_week |
| [13 — Audio Path Guide](13-audio-path-guide.md) | /media/ URI format, supported formats, TTS configuration |

### Feature Guides

| Document | Description |
|---|---|
| [14 — Recording Guide](14-recording-guide.md) | ERS conference recording, ENS recording, recording lifecycle API |
| [15 — ENS Guide](15-ens-guide.md) | Campaign engine, phone blast flow, UI trigger, callback/replay |
| [16 — ERS Guide](16-ers-guide.md) | Ring-all flow, tier system, participant tracking (destNum fix), overflow queue |
| [17 — Conference Guide](17-conference-guide.md) | Conference registry, ESL events, monitoring controls, member state |

### Operations

| Document | Description |
|---|---|
| [18 — Reporting Guide](18-reporting-guide.md) | ERS/ENS reports, campaign counters, aggregate queries, data integrity notes |
| [19 — Monitoring Guide](19-monitoring-guide.md) | Real-time Socket.IO events, conference control API, member actions |
| [20 — Media Library Guide](20-media-library-guide.md) | Audio upload, deploy to FreeSWITCH, format specs, IVR usage |
| [21 — Organization Guide](21-organization-guide.md) | Tenant/org hierarchy, contact management, bulk upload, responder groups |
| [22 — Deployment Guide](22-deployment-guide.md) | Installation, environment variables, FreeSWITCH setup, production checklist |

### Admin, Dev & Testing

| Document | Description |
|---|---|
| [23 — Troubleshooting Guide](23-troubleshooting-guide.md) | Diagnostic tools, common failure modes with root causes and recovery steps |
| [24 — Administrator Guide](24-administrator-guide.md) | Initial setup checklist, user roles, ERS/ENS administration, backup |
| [25 — Developer Guide](25-developer-guide.md) | Dev environment, code architecture, adding routes/nodes, DB patterns |
| [26 — End-to-End Testing Guide](26-end-to-end-testing-guide.md) | Test infrastructure, scenario walkthroughs, coverage checklist |

---

## Quick Start by Role

**New Engineer — get the codebase running**
→ [22 — Deployment Guide](22-deployment-guide.md) → [02 — Runtime Architecture](02-runtime-architecture.md) → [01 — System Architecture](01-system-architecture.md)

**Configuring ERS for the first time**
→ [16 — ERS Guide](16-ers-guide.md) → [24 — Administrator Guide](24-administrator-guide.md) → [21 — Organization Guide](21-organization-guide.md)

**Configuring ENS for the first time**
→ [15 — ENS Guide](15-ens-guide.md) → [09 — IVR Designer User Manual](09-ivr-designer-user-manual.md) → [10 — IVR Node Reference](10-ivr-node-reference.md)

**Debugging a live incident**
→ [23 — Troubleshooting Guide](23-troubleshooting-guide.md) → [19 — Monitoring Guide](19-monitoring-guide.md) → [04 — ESL Event Processing](04-esl-event-processing.md)

**Building or extending IVR flows**
→ [09 — IVR Designer User Manual](09-ivr-designer-user-manual.md) → [10 — IVR Node Reference](10-ivr-node-reference.md) → [12 — Expression and Condition Guide](12-expression-and-condition-guide.md)

**Adding a new backend feature**
→ [25 — Developer Guide](25-developer-guide.md) → [07 — Database Schema Reference](07-database-schema-reference.md) → [08 — REST API Reference](08-rest-api-reference.md)

**Investigating report discrepancies**
→ [18 — Reporting Guide](18-reporting-guide.md) → [04 — ESL Event Processing](04-esl-event-processing.md) (trackParticipant section) → [16 — ERS Guide](16-ers-guide.md) (Participant Tracking section)

---

## Key Technical Notes

### CallerID Identity Resolution (Critical)
For ERS ring-all, `origination_caller_id_number` is set to the **initiator's** number so the responder's phone shows who is calling them. This means `Caller-Caller-ID-Number` in the ESL `add-member` event contains the **initiator's** number, not the responder's. `trackParticipant()` resolves this by using `Caller-Destination-Number` (the responder's actual extension) first. See [04 — ESL Event Processing](04-esl-event-processing.md) and [16 — ERS Guide](16-ers-guide.md).

### Soft-Delete Pattern
Every table has `deleted_at TIMESTAMPTZ`. All queries must include `AND deleted_at IS NULL`. No hard deletes in application code.

### Tenant Scoping
`tenant_id` is always sourced from `req.user.tenantId` (set by JWT). Never trust `tenant_id` from the request body.

### Two API Surfaces
- `/api/v1/*` — JWT Bearer auth (UI-facing)
- `/api/v1/internal/*` — `X-Internal-Key` header auth (Lua/FreeSWITCH-facing, 500 req/min)

Never mix auth middleware between these surfaces.

### IVR Deployment Chain
`publish flow` → `validate graph` → `generate Lua` → `generate XML` → `bgapi reloadxml` → `verify extension`

See [06 — XML Generation Pipeline](06-xml-generation-pipeline.md).
