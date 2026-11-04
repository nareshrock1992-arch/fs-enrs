# Bug Tracker

This is the main tracker. IDs match `ENTERPRISE_AUDIT.md` (F-) and `IVR_AUDIT.md` (IVR-).
The repository root `BUG_TRACKER.md` covers the Dialplan Editor only (DP- entries) and stays with that module.

| IDs | Status |
|---|---|
| F-01 to F-06, F-08 to F-11, F-17 to F-33 | Fixed in the working tree, uncommitted |
| IVR-1 to IVR-8, IVR-12 to IVR-17 | Fixed in the working tree, uncommitted |
| F-07 | Reporting and campaign dashboard fixed; engine counters themselves unchanged |
| F-12 to F-16, IVR-9 to IVR-11, IVR-18 to IVR-20 | Open |
| Baseline | 23 pre-existing backend test failures, all also failing at `7b40b59` |

Behaviour changes, their compatibility status and the release gate: `BEHAVIOUR_CHANGES.md`.

Cycle 4 compatibility defects in the Cycle 2–3 work (C4-1 to C4-7, all fixed in the working tree):
`CYCLE4_COMPATIBILITY_REPORT.md` section 3. Release blockers: `RELEASE_BLOCKERS.md`.

Cycle 5 (found on the disposable FreeSWITCH, fixed in the working tree): **C5-1** Deploy refused versions published
before the publish-time security rules (regression from Cycles 2–3); **C5-2** ENS hangup / originate-result race lost
configured retries (also at HEAD; Cycle 4's fix did not cover concurrent settlement). Pre-existing, not changed:
**O-1** ERS busy / no-answer responder legs get no hang-up cause (never join, so `ersChannelMap` never has them);
**O-2** `dialing_count` live gauge can stay one high after a peak update; **O-3** ENS screen says "0 = no retries"
but the engine uses `max_attempts || 3`; **O-4** `esl_connections` stores the ESL password in clear and the dev
seed prints the seed admin password. Details: `STAGING_VERIFICATION_REPORT.md`.

## Exposed on DEV until committed and redeployed

These are in the committed/pushed code (`7f849ed`) and therefore on DEV:
F-01 (conference takeover), F-23 (unauthenticated backend crash), IVR-1 (dialplan hijack), IVR-4 / IVR-13 / IVR-14 /
IVR-16 (command execution paths on the telephony host), IVR-12 (cross-tenant ENS blast), F-24 (lost ENS retries).
The Lua fixes reach calls only after the executor is regenerated (Deploy).
