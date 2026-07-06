# PROJECT VISION — fs-enrs Enterprise Emergency Communication Platform

## Mission Statement

fs-enrs is a multi-tenant, enterprise-grade Emergency Notification and Response System built on FreeSWITCH telephony. It enables organizations to broadcast emergency notifications to large contact pools (ENS) and coordinate real-time emergency response conferences (ERS) with full auditability, AI-assisted routing, and multi-channel delivery.

## Target Users

| Role | Responsibility |
|---|---|
| SUPERADMIN | Platform-wide management, tenant provisioning |
| ADMIN | Tenant admin: orgs, users, configs, DIDs |
| SUPERVISOR | Monitor active incidents, run reports |
| OPERATOR | Trigger ENS blasts, manage active ERS conferences |
| VIEWER | Read-only dashboard and reports |

## Core Capabilities

### Phase A — Foundation (Complete)
- JWT authentication with RBAC (4 roles)
- Multi-tenant organization hierarchy (Tenant → Org → Dept/Location)
- Emergency Contact and Responder Group management
- ENS: Configuration-driven outbound blast calling via FreeSWITCH Lua
- ERS: Conference-based incident response with queue management
- ESL persistent connection with real-time Socket.IO events
- React dashboard, CRUD UI for all entities, basic reports

### Phase B — Enterprise Hardening
- Internal API (Lua contract) for FreeSWITCH ↔ Backend integration
- Real-time dashboard with Socket.IO push events
- IVR Visual Builder (drag-and-drop, simulator, versioning)
- Media Library (audio file management for IVR prompts)
- Audit Logging (immutable trail of all admin actions)
- DID Management and PBX connections (Avaya, Cisco, Asterisk)
- Notification Templates and full multi-tenant data isolation

### Phase C — AI + Orchestration
- BullMQ queue engine for reliable ENS blast delivery
- Multi-channel dispatch: SMS, Email, Push, WhatsApp, Teams, Slack
- AI Microservice: classification, speech-to-text, auto incident summary
- Advanced reporting: CSV, Excel, PDF with AI-generated summaries
- Analytics heatmaps and predictive availability engine
- IVR AI Intent node (live ASR + NLU in call flow)
- Production hardening: rate limiting, Prometheus, Docker Compose

## Guiding Principles

1. **Reliability over features**: A missed emergency call is a critical failure. Every call path must have retry logic, queue guarantees, and fallback behavior.
2. **Tenant isolation is non-negotiable**: No data leakage across tenant boundaries under any RBAC role.
3. **Auditability**: Every state-changing action must be traceable to a user, IP, and timestamp.
4. **Lua compatibility**: The FreeSWITCH Lua runtime is the telephony execution layer. The Internal API is a contract — breaking it breaks live calls.
5. **Progressive enhancement**: Phase A features must remain stable while Phase B/C are layered on.

## Technology Stack

| Layer | Technology |
|---|---|
| Telephony | FreeSWITCH, Lua 5.1, ESL TCP :8021 |
| Backend | Node.js 20, Express 4, Socket.IO 4 |
| Queue | BullMQ + Redis 7 (Phase C) |
| Database | PostgreSQL 15 (fs_enrs schema) |
| Frontend | React 18, Vite, Tailwind CSS |
| AI | OpenAI GPT-4 / Whisper (Phase C) |
| Deployment | PM2, Nginx, Docker Compose |

## Success Metrics

- ENS blast delivery rate ≥ 98%
- ERS incident first-responder join time ≤ 30 seconds
- Dashboard real-time latency ≤ 500ms
- API p95 response time ≤ 200ms
- Zero cross-tenant data leakage incidents
- 100% audit log coverage on mutating operations
