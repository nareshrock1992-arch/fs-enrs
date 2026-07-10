# Connecting a Real PBX (Avaya, Cisco, or any SIP Trunk)

Every outbound call this system places — ERS responder ring-all, ENS
blast campaign calls, an ad-hoc test originate — goes through exactly one
function: `resolveDialString()` in `backend/src/services/dialResolver.js`.
Nothing else in the codebase is allowed to construct a
`sofia/internal/...` or `sofia/gateway/.../...` string directly. That's
what makes connecting a real PBX a **configuration change, never a code
change** — this doc is the whole procedure.

## How resolution works, in order

1. **Explicit override** — a `gatewayId` or `gatewayName` passed directly
   to `resolveDialString()` (e.g. a legacy `ens_configurations.sip_gateway`
   string column).
2. **Per-contact override** — `emergency_contacts.gateway_id`. Lets one
   responder or one ENS contact route through a different trunk than
   everyone else (e.g. a mobile-only contact who needs the carrier trunk
   even though the rest of the team is on the office PBX).
3. **Tenant default** — the `sip_gateways` row with
   `is_default_outbound = true` for that tenant.
4. **Fallback: internal** — with none of the above configured, every call
   dials `sofia/internal/<extension>@<domain>`. This is what every local
   test call in this system uses today, and it requires zero setup.

## Adding a gateway

All through the UI — **Settings → Telephony Gateways** — no manual
FreeSWITCH XML editing:

1. **Add Gateway.** Fill in:
   - **Name** — becomes the FreeSWITCH gateway name
     (`sofia/gateway/<name>/...`). Must be unique per tenant, alphanumeric/
     underscore/hyphen. Cannot be changed after creation (it's the file
     name on disk too).
   - **Type** — Avaya Aura / Cisco UC / Generic SIP / Other. Informational
     today (affects labeling, not behavior) — if a specific vendor needs
     non-standard gateway parameters in the future, this is the field
     that would drive it.
   - **Host / Port** — the trunk's SIP address.
   - **Username / Password** — if the trunk requires registration.
   - **Register** — uncheck for IP-authenticated trunks that don't need a
     REGISTER handshake (common for Avaya/Cisco trunks on a fixed IP).
   - **Caller ID in From header** — some PBXs require the caller ID in
     the `From` header rather than the default location; check this if
     calls arrive with no caller ID on the PBX side.
   - **Default outbound gateway for this tenant** — check this to make
     it the tenant-wide default (step 3 in the resolution order above).
     Only one gateway per tenant can be default; checking this on a new
     gateway automatically unchecks it on any previous default.

2. **Deploy.** Writes the gateway XML to
   `${FS_SIP_PROFILE_DIR}/external/<name>.xml`, reloads FreeSWITCH's
   config, and rescans the external SIP profile so the gateway actually
   registers — the same generate → write → reloadxml → verify pipeline
   the IVR dialplan deployment uses (`services/gatewayDeployment.js`).
   The deploy button reports **Live** only after independently confirming
   via `sofia status gateway <name>` that FreeSWITCH picked it up — not
   just that the file was written.

3. **Confirm registration** (if `register` is checked) from the
   FreeSWITCH console directly, the same way you'd verify any gateway:
   ```
   fs_cli -x "sofia status gateway <name>"
   ```
   Look for `Status  REGED` — anything else means the trunk itself
   rejected the registration (wrong credentials, firewall, IP not
   allow-listed on the PBX side) and is a PBX-side problem to resolve
   with whoever administers the Avaya/Cisco trunk, not this app.

4. **Assign contacts, if not using the tenant default.** In each
   responder's or ENS contact's edit form (Emergency Contacts / Responder
   Groups), an optional gateway override picks a specific trunk for that
   one person — everyone else stays on the tenant default (or internal,
   if no default is set).

## Verifying the switch actually worked

`backend/src/__tests__/integration/dialResolver.test.js` is the automated
version of this: it adds one dummy/loopback gateway and confirms exactly
the contacts that should resolve through it do, and contacts with no
override or no tenant default are completely unaffected. To check by
hand after connecting a real trunk, place one real test call through a
flow bound to a contact using the new gateway, and confirm in
`backend.log` that the dial string logged for that call is
`sofia/gateway/<name>/...`, not `sofia/internal/...`.

## What never changes

- `luaGenerator.js`'s generated Lua never references a gateway name or
  dial string directly — `ers`/`ens` node handlers hand off origination
  to the backend via the internal API, and the backend resolves the dial
  string at origination time.
- `campaignEngine.js` (ENS blast calls) and any future ERS ring-all
  origination code call `resolveDialString()` — the only two ways a
  dial string differs from `sofia/internal/...` are the two overrides
  above, both configured through the UI.
