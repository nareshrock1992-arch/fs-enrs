# Improvement Roadmap

Ordered by the mission's priorities. Everything is uncommitted until you ask.

## Done
1. Conference tenant isolation, ESL input safety, socket routing (Cycles 1, 2)
2. SUPER_ADMIN model and global-settings boundary (Cycle 2)
3. All live events tenant-scoped (Cycle 2)
4. IVR trust boundaries: dialplan, REST node, API expansion (Cycle 2)
5. Excel exports, report totals, worker-thread generation (Cycles 1, 2)
6. Non-blocking notices and Audit Log page (Cycle 2)
7. IVR node handlers read line by line; command-execution paths, cross-tenant ENS, DNS rebinding, credential scope, failsafe on broken flows (Cycle 3)
8. Unauthenticated backend crash; ENS attempt settling (Cycle 3)
9. Password policy, CSRF review (Cycle 3)
10. Navigation, confirmations, Audit Log, phone layout, ENS Campaigns fixes, accessibility pass, browser-verified (Cycle 3)

## Next
11. **Commit, regenerate the IVR executor on DEV, run `scripts/ivr-compat-report.js` there** (needs you)
12. Scope every REST credential with `_TENANT_IDS`, then `IVR_CRED_REQUIRE_TENANT_SCOPE=true`; after the redeploy, `ENS_REQUIRE_IVR_NUMBER=true`
13. Screen review: ENS / ERS configuration forms, Contacts, Users, Settings, monitoring widgets, dark theme
14. IVR-10: move the internal API key off the curl command line (header file written at deploy)
15. Report query timing on realistic volumes; indexes by migration if justified
16. TTS integration audit

## Needs your decision
- Persisting IVR execution events and ENS acknowledgements (schema + Lua; needs a call-tested rollout)
- Emergency type on campaigns
- Removing tracked `.env` files from history (F-15)
