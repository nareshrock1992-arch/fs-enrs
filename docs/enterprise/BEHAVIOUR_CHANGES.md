# Behaviour Change Register

Every change since `7f849ed` that a user, a flow, a call or an API consumer could notice. Written under the
zero-regression requirement (2026-11-03): existing business behaviour is kept unless a security defect or a clear
implementation defect requires otherwise, and then the change is as narrow as the risk, backward-compatible where
possible, and listed here.

**Status:** *kept* = existing behaviour unchanged · *opt-in* = new behaviour only when an operator enables it ·
*fixed* = implementation defect corrected toward the behaviour the code and docs already describe ·
*narrowed* = an unsafe input is refused; everything that could work before still works ·
*by your brief* = permission or isolation change asked for explicitly in the Cycle 2 / 3 briefs.

## Revised on 2026-11-03 to remove regressions

These Cycle 3 changes went further than needed and were rolled back to compatible behaviour:

| Change as first made | Now |
|---|---|
| Broken IVR flow transferred to the failsafe extension instead of hanging up | **Kept: hangs up.** Failsafe only with engine global `ENRS_FAILSAFE_ON_FLOW_ERROR=true` |
| Transfer with the `inline` dialplan refused at call time | **Kept: runs** (logged as deprecated). Blocked only with engine global `ENRS_IVR_BLOCK_INLINE_TRANSFER=true` |
| Transfer destination limited to a character set; dialplan limited to XML/enum at publish | **Narrowed:** only whitespace refused (the argument is split on spaces, so it could only inject); any dialplan except `inline` publishes |
| Webhook moved to the backend proxy (different host, address rules) | **Kept: direct request from the switch host, as before.** Only the URL is now shell-escaped and passed with `--url` |
| Webhook URL had to start with http(s) | **Removed** |
| `destination_number`, caller IDs, `origination_*`, `*_after_bridge`, `conference_*`, `bridge_*`, `*_hook` not writable | **Kept writable.** Only variables the engine runs as a command (`api_hangup_hook`, `api_reporting_hook`, `api_after_bridge`, `api_on_*`, `execute_on_*`, `exec_after_bridge_*`, `bridge_pre_execute_*`) and `uuid` are refused |
| REST mapping names restricted to `[A-Za-z_][A-Za-z0-9_]*` | **Kept:** any name except the command-running ones (e.g. `sip_h_X-Trace` works) |
| Every `${` removed from substituted values (`interp`) | **Kept: `interp` byte-for-byte as before.** Only the command form `${name args}` / `${name(args)}` is made inert, and only where text becomes an engine argument (transfer, built-in TTS, playback). Plain `${var}` is untouched |
| ENS originate rejection carried its `-ERR` cause and could be retried | **Kept: failed, `ORIGINATE_ERROR`, no retry**, as before. It no longer overwrites a retry already scheduled by the hangup event, and no longer marks an answered call failed |
| Retryable failure after cancel → `failed` | **`skipped`** (what cancel gives queued recipients); after expiry → `expired` |
| ERS caller number without digits left out of responder caller ID | **Kept:** a plain token such as `anonymous` passes through; only values with `, = ' {` etc. are left out |
| REST proxy: 1 MiB response cap, no compression | 10 MiB cap; sends fetch()'s default headers and decodes gzip / deflate / br, as before |
| REST redirects not followed (Cycle 2) | **Followed again**, up to 5, with each new address checked and credential headers dropped on a host change |
| Password maximum of 72 characters | **Removed** (long passphrases keep working) |
| Query strings dropped `''` values | **Kept: `''` is sent as before**; only `undefined` / `null` are left out |

## Narrowed again in Cycle 4 (2026-11-03)

Independent re-verification found these rules still stricter than the risk required:

| Rule after the first revision | Now |
|---|---|
| Transfer refused at call time when the destination or context contained any whitespace | **Kept: author-written words work** (`1001 XML public` routes to context `public`, as before). Only a substituted value that adds a word is refused. A context is author-written, so it is not checked |
| Publish refused whitespace in a transfer destination or context | Only `inline` as the destination's dialplan word is refused (it would bypass the inline rule) |
| ENS start-by-config refused (403) when the routed number is not an active registered number | **Kept: the blast starts**, with a warning (deactivated number whose dialplan is still deployed, legacy or transferred routes). Refused only when the number is registered to another tenant, or with `ENS_REQUIRE_IVR_NUMBER=true` |
| Conference control limited to room names of `[A-Za-z0-9_.@-]` | **Kept:** any room name without whitespace or control characters |
| ERS caller name: `$` removed; empty caller number left out | **Kept:** `$` stays (no `${` can form once braces are removed); an empty number is passed empty, as before |
| ERS report summary counted responders without observers | **Kept:** counts every responder row, matching the per-incident rows and the detail screen |
| Designer showed a stored `inline` dialplan as "XML" | Shows the stored value (display only) |

## Found on the real switch in Cycle 5 (2026-11-04)

| Before Cycle 5 | Now | Evidence |
|---|---|---|
| **Deploy** of a version published before the publish-time security rules (inline transfer, `${name args}`, protected variable) was refused (422 at `validate_graph`); HEAD deployed it. Binding a new number to such a flow, or redeploying it to regenerate the executor, therefore failed | **Deploys as before**, with a warning per finding ("already published: deployed as before; republishing refuses it"). Publish still refuses them; the executor still enforces them during the call. Every check that applied at HEAD (dangling references, schema, gather limits, …) still refuses the deploy (C5-1) | staging T-IVR-DEPLOY, T-IVR-4; `ivrCycle3Boundaries` (5 new) |
| ENS: the hangup and the originate result of a failed attempt were settled at the same time; the originate path often won and failed a busy / no-answer recipient whose hangup had scheduled the configured retry (HEAD loses retries the same way, at random) | The hangup, which arrives first on the real switch, settles the attempt; the originate result settles it only when no channel was created (no hangup within 2 s): failed, `ORIGINATE_ERROR`, no retry, as before (C5-2) | staging T-ENS-3…9 (HEAD vs tree); `ensAttemptSettlement` 17/17 |

## Current register

| Area | Change | Status | Who notices | Evidence |
|---|---|---|---|---|
| Conference control | Another tenant's or an incident-less room: 404 for tenant users; SUPER_ADMIN reaches all | by your brief | Tenant users of manual (incident-less) rooms lose control of them | `conferenceTenantIsolation`, e2e S-26, S-30 |
| Live events | Tenant-scoped; `channel.*` to SUPER_ADMIN only (no page uses them) | by your brief | — | `socketTenantIsolation`, e2e S-27–29 |
| Recording start | Path must be a new `.wav` in the recording directory | narrowed | A caller passing another path | unit |
| Global settings, Config Center, redeploy-all, reloadxml, legacy-extension fix | SUPER_ADMIN only; tenant ADMIN keeps read | by your brief | Tenant ADMINs | `platformAuthorization`, e2e S-30 |
| IVR / gateway write routes | SUPER_ADMIN no longer refused (was 403) | fixed | SUPER_ADMIN | unit |
| Dialplan numbers | Matched literally (a bound `.*` captured every call) | by your brief | Numbers that were deliberate patterns | `ivrTrustBoundaries`; **listed by the compatibility report** |
| IVR publish | `${name args}`, new `inline` transfers (dialplan field or the destination's dialplan word), writes to command-running variables refused, with the field named | narrowed | Admins re-publishing such flows | e2e S-33; compatibility report |
| IVR call time | Command-running variable writes skipped (logged); a transfer whose substituted value adds a word refused (call hangs up as on any node error) | narrowed | Only flows doing those | `executorSecurity` |
| ENS from a session variable | 403 when the configuration belongs to another tenant than the routed number's registered tenant | narrowed (cross-tenant only) | — | e2e S-32, `ivrCycle3Boundaries` |
| ENS lookup | 404 when the dialled ENS number belongs to another tenant than the routed number (executor sends the routed number; standalone scripts unchanged) | narrowed (cross-tenant only) | — | e2e S-34 |
| ENS attempts | Each attempt settled once, by its hangup (real cause) when there is one; configured retries happen reliably; no double counts | fixed | Recipients receive the retries configured in Max Attempts / Retry Interval, which HEAD skipped at random; the recorded cause is the real one (`USER_BUSY`, …) instead of `ORIGINATE_ERROR`. **Approved 2026-11-04 (RB-1 closed): retry exactly as configured** — ENS_RETRY_BEHAVIOUR_DECISION.md | real switch (staging run 4, HEAD vs tree); `ensAttemptSettlement` 17/17; e2e F-30 |
| IVR deploy | Already-published versions are re-checked only with the rules they were published under; newer rules are warnings | restored (C5-1) | — (HEAD behaviour) | staging, unit |
| REST proxy | Loopback / link-local / metadata refused, also at connection time; private addresses **allowed** unless `IVR_REST_BLOCK_PRIVATE=true`; credentials optionally per tenant | narrowed | Integrations calling the backend host itself (listed by the report for fixed URLs) | `ivrCycle3Boundaries`; staging T-IVR-7/8 |
| Passwords | Change-password applies the existing creation rule | fixed | Users choosing a weak new password | `passwordPolicy` |
| Socket `authenticate` | A malformed message no longer stops the process | fixed | — | e2e S-31 |
| ERS caller name | `{` removed from the display name on responder legs (was `' } \`; an unmatched `{` broke the originate block) | narrowed | Names containing `{` | `ersOriginateInjection` |
| Reports / campaign cards | Recipient outcomes instead of attempt counters; "Completed today" by date | fixed | Numbers on screen differ from the old counters | unit, browser |
| ENS Campaigns "All" tab | Lists campaigns (sent `status=undefined` and showed none) | fixed | Operators | browser |
| UI | Navigation regrouped, shared confirm dialog, notices, Audit Log, phone layout, accessibility | UI only | Everyone | browser |
| API (additive) | `/campaigns` adds `outcomes`; `/audit` adds `entity_types`; internal calls accept optional `ivr_number` | additive | — | unit |

## Release gate (updated 2026-11-04, Cycle 5)

| Gate | Result |
|---|---|
| ENS workflows | Dialled on a disposable FreeSWITCH: answered, busy, no answer, 404, 603, busy-then-answer, no channel, cancel during retry, replayed events — all follow the configured policy (REAL_FREESWITCH_TEST_RESULTS.md) |
| Conference workflows | Real conference on the disposable switch: ring-all wave, caller ID, controls (mute, play, kick), recording, completion, tenant isolation |
| IVR flows | Executed on the switch: play, DTMF, variables, webhook, REST redirect rules, XML and legacy inline transfer, literal numbers, failsafe off/on; deploy of older flows restored (C5-1). Compatibility report still **not run on DEV** |
| Tenant permissions, SUPER_ADMIN | e2e security 39/39; browser (SUPER_ADMIN and tenant ADMIN); staging tenant checks |
| Reporting | Real call outcomes match the screen, the export (opened in Excel 16) and the database |
| Historical data | No migration, no destructive statement; all runs on throw-away databases |
| API contracts | Only additive fields and optional parameters |
| Tests | Backend 1972, 23 failing, all pre-existing (same names as Cycle 4); integration HEAD 188/243 vs tree 205/260, same 7 failures; frontend 276/276 |
