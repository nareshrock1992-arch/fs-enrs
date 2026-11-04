# Security Review

Updated Cycle 2, 2026-11-02.

## Authorization model

| Role | Reach |
|---|---|
| SUPER_ADMIN | All tenants, from the verified token's role. Tenant selection in the UI only narrows lists; it never removes access to a conference |
| ADMIN and below | Own tenant, from the token. `tenant_id` and `role` in a request are ignored |
| Platform-wide actions | SUPER_ADMIN only: global settings, feature flags, `/platform/config`, `redeploy-all`, `reloadxml`, legacy-extension fix, audit log |

SUPER_ADMIN gets no bypass of authentication, input validation or auditing.

### Reviewed

| Path | Result |
|---|---|
| Role middleware on all route files | 12 IVR and gateway write routes omitted SUPER_ADMIN (403); fixed |
| `/monitoring/conferences/*`, `/ers/conference/*` | One shared rule, `requireConferenceAccess` |
| Recordings, media, reports, exports | Use `effectiveTenantId`; SUPER_ADMIN sees all |
| Socket.IO | Rooms come only from a verified token; no client event joins a room |
| Background work | Campaign engine and internal API events resolve their tenant from the record |

**Exception:** creating a tenant-owned record as SUPER_ADMIN needs a target tenant (400 otherwise), because the record
must belong to someone. The UI sends the selected tenant.

## Live conferences

A room's owner is the tenant of the most recent ERS incident that used it, of any status. Rooms with no incident are
reachable by SUPER_ADMIN only. Other tenants get 404. If the ownership lookup fails, tenant users are refused;
SUPER_ADMIN needs no lookup, so platform control survives a database outage.

Every command is written to `audit_logs` as `conference_control` before it runs, with room and action but no spoken text
or dial strings. An audit failure is logged and does not block an emergency action. Role-refused attempts inside the
tenant are recorded too, so the entry means "attempted".

## ESL commands

`eslCommandTimeout` refuses any command with a line break. Routes validate rooms, members, levels and single-argument
values. Remaining: `audio_path` is not limited to the sound directory, and a dial string can carry channel variables.

## Recording paths

A supplied path must be a `.wav` directly inside the recording directory and must not already exist. `lstat` is used, so
symlinks, including dangling ones, are refused and no recording can be overwritten. Between that check and the engine
opening the file there is a small window; only a local user on the host could use it.

## Socket.IO

Nothing is sent before authentication. Re-authenticating, signing out or disconnecting drops all rooms first. Access ends
when the token expires, and the client refreshes once. Events with no known tenant go to SUPER_ADMIN only.

A deactivated user keeps a connected socket until the token expires, at most 15 minutes.

## Cycle 3

- **Unauthenticated crash (F-23):** a malformed `authenticate` message stopped the process; the handler no longer throws.
  Checked with real Socket.IO clients (e2e S-31).
- **IVR → telephony host:** webhook shell injection, command-running variables, new inline transfers, whitespace
  injection into transfers and second-stage `${name args}` are closed (IVR_AUDIT.md). Revised 2026-11-03 to the
  narrowest compatible fixes: existing inline transfers still run unless an operator blocks them, identity variables
  stay writable, the webhook still calls directly. Narrowed again in Cycle 4: only a substituted value that adds a
  word to a transfer is refused, and ENS start-by-config refuses only a routed number registered to another tenant.
  The REST proxy checks the address it actually connects to.
- **Cross-tenant:** ENS start-by-config (403) and ENS lookup (404) refuse a configuration or number of another tenant
  than the routed number; REST credentials can be scoped with `IVR_CRED_<NAME>_TENANT_IDS`.
- **Originate injection (IVR-17):** a caller number that could inject no longer reaches the responder legs raw;
  plain tokens such as `anonymous` still do.
- **CSRF:** not exploitable: the API takes Bearer tokens only and the refresh cookie is `SameSite=Lax`.
- **Passwords:** one rule (upper, lower, digit, symbol, at least 8) for administrator-set and self-service passwords;
  no new maximum. A password change replaces the refresh session, so other devices cannot renew theirs.

New settings, all optional: `IVR_CRED_<NAME>_TENANT_IDS`, `IVR_CRED_REQUIRE_TENANT_SCOPE`, `ENS_REQUIRE_IVR_NUMBER`.
All three are documented in `backend/.env.example`. Two engine global variables (set in the switch's `vars.xml`,
not the backend) control call-time behaviour: `ENRS_IVR_BLOCK_INLINE_TRANSFER` and `ENRS_FAILSAFE_ON_FLOW_ERROR`;
both default to the existing behaviour.

## Open

- F-15: real `.env` files tracked in git
- IVR-6 residual: unscoped credentials stay usable by every tenant until `_TENANT_IDS` is set for each
- IVR-10: the internal API key is visible on the curl command line in the host's process list
- Token and signed-link revocation window; legacy `?token=`
- Upload validation was hardened in the media mission and not re-reviewed here
- O-4 (seen in Cycle 5 staging, pre-existing): `esl_connections.password` holds the ESL password in clear (written by
  `db/seed.js`), and the dev seed prints the seed admin password to its output
- Cycle 5: Deploy of an already-published version reports the publish-time rules as warnings (C5-1). The protection
  is unchanged, because publish still refuses new violations and the executor enforces the rules during the call
