# Architecture Review

The frozen pipeline in `ARCHITECTURE.md` is unchanged. `GOVERNANCE.md` requires an approved Design Impact Assessment
before code; the mission's authority for reversible local improvements is treated as that approval, and these notes
stand in as the assessment for each change.

## Additions

| Component | Why reuse was not enough | Reuse |
|---|---|---|
| `services/conferenceOwnership.js` | No room-to-tenant mapping existed | Middleware, snapshot filter, socket routing |
| `middleware/conferenceAccess.js` | No shared rule for ESL arguments | Any route that builds ESL commands |
| `utils/xlsxWriter.js` | No Excel capability; extends `utils/zipStore.js`, no new dependency | Any report |
| `components/ui/ExportButton.jsx` | No Blob download with progress and error state | Any export |

## Observations

- Single-process backend: in-memory call state (`conferenceRegistry`, `activeRings`, `ersChannelMap`) is lost on restart.
- The room-owner cache in `eslService` is per process and expires after 60 s; a room belongs to one ERS configuration.
- Not reviewed yet: event bus use, Redis role, deployment engine.

AI-first statement: new APIs return structured JSON or standard files, are tenant-scoped, and are audited.

Observability: exports log `module: reporting`; owner-lookup failures log at WARN; no credentials are logged.
