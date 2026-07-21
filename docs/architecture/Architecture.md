# Architecture Overview

**ENRS Unified Communications Platform**  
Version 1.0 · 2026-07-21

---

## Platform Identity

ENRS is a **Unified Communications Platform**. FreeSWITCH is one execution backend among several that may be supported in the future. ENS, ERS, and IVR are business modules that consume platform services. No business module may contain knowledge of how communications are executed.

This distinction is not cosmetic. Every architectural decision flows from it.

---

## System Boundaries

```
FreeSWITCH (:8021 ESL)
    │  ESL TCP (modesl)              Lua scripts call:
    │                                  curl → /api/v1/internal/*
    ▼
Backend (:4100)  ←──── PostgreSQL (enrs_db, 33+ tables, soft-delete)
    │  Socket.IO
    ▼
Frontend (:8100)  — Vite dev / nginx prod
```

The Vite dev server proxies `/api`, `/socket.io`, and `/uploads` to `localhost:4100`.

---

## The Five-Layer Model

```
Layer 1 — Business Modules
  ENS │ ERS │ IVR │ Contact Center (future)
  → Submit CommunicationRequests. Own business state.
  → Never construct dial strings, select gateways, or call ESL.

Layer 2 — Communication Engine  (Wave 3)
  communicationEngine.js
  → Single entry point for all outbound communication.
  → Creates and owns Communication Sessions.
  → Translates provider events to standard status codes.

Layer 3 — Outbound Router  (Wave 1)
  outboundRouter.js + destinationClassifier.js + dialResolver.js
  → Classifies destinations. Normalizes numbers.
  → Selects gateway. Builds provider-agnostic CallInstruction.

Layer 4 — Provider Layer  (Wave 4)
  providers/freeswitchProvider.js + providerRegistry.js
  → Translates CallInstruction to provider protocol.
  → Emits standard CallEvents.

Layer 5 — Execution Backends
  FreeSWITCH ESL │ Twilio (future) │ SBC (future) │ WebRTC (future)
```

---

## Two Separate API Surfaces

### `/api/v1/*` — UI REST API
- Protected by `requireAuth` (JWT Bearer or httpOnly refresh cookie)
- `req.user` shape: `{ id, email, role, tenantId }`
- **`tenantId` always sourced from JWT — never from request body**

### `/api/v1/internal/*` — Lua Contract API
- Protected by `requireInternalKey` (timing-safe X-Internal-Key comparison)
- Used exclusively by FreeSWITCH Lua scripts
- Rate-limited at 500 req/min
- **Never mix auth middleware between these two surfaces**

---

## Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM modules) |
| API framework | Express.js |
| Database | PostgreSQL (soft-delete, TIMESTAMPTZ everywhere) |
| Real-time | Socket.IO |
| FreeSWITCH integration | modesl (ESL TCP client) |
| IVR execution | FreeSWITCH Lua scripts |
| Frontend | React + Vite + Zustand |
| Auth | JWT (15m access) + httpOnly refresh cookie (7d) |
| Validation | Zod |
| Testing | Vitest |

---

## Architectural Constraints (Frozen)

1. Business modules never contain provider-specific concepts (bgapi, dial strings, channel variables, hangup cause strings)
2. All outbound communication passes through the Communication Engine (Wave 3+)
3. Routing decisions made only in the Outbound Router
4. `tenant_id` from JWT is the security boundary — never sourced from request body
5. All database migrations are additive only — no destructive changes
6. Each implementation wave leaves the platform in a fully production-ready state
7. The single Lua executor model (`ivr_executor.lua`) is the canonical IVR runtime
8. `dialResolver.js` is the single source of gateway resolution logic

See [DecisionLog.md](DecisionLog.md) for rationale behind each frozen decision.
