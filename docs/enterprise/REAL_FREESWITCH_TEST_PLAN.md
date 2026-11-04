# Real Telephony Test Plan (isolated FreeSWITCH)

**Status (Cycle 5, 2026-11-04): executed on an isolated disposable FreeSWITCH with simulated endpoints.** Results,
including what was not covered: REAL_FREESWITCH_TEST_RESULTS.md. Still open: the customer's real trunk / handsets
(RELEASE_BLOCKERS RB-8). This plan must not be run against DEV or production, and it must never use a real
emergency number or real responders.

## What has been verified without telephony, and what this plan adds

| Layer | Automated today | Needs this plan |
|---|---|---|
| Generated IVR executor (Lua) | Runs under Fengari (Lua 5.3) with a fake `session` / `freeswitch` API (`__tests__/lua/*`) | The engine's own Lua 5.2, real `session:execute`, real argument parsing and `${...}` expansion |
| Backend ↔ database | Real PostgreSQL in a private network namespace (e2e, `integration/ensAttemptSettlement.test.js`) | — |
| ESL events → ENS engine | Handlers called directly with the events' values | Real `CHANNEL_ANSWER` / `CHANNEL_HANGUP` / `BACKGROUND_JOB` order and timing |
| ERS ring-all, conferences | Unit tests with a mocked ESL | Real originate, conference membership, recording |

## Environment requirements

- A dedicated FreeSWITCH host (or container) with no route to the PSTN or to any production gateway. Outbound
  calls go only to registered lab extensions (`ENS_ORIGINATE_MODE=user`) or a lab SIP UA (e.g. SIPp / softphones).
- A dedicated database created by `node src/db/migrate.js` on an empty database, plus synthetic tenants, contacts
  and configurations. No copy of DEV or production data.
- The backend and the generated executor from the release candidate. Run Deploy in the test environment so
  `ivr_executor.lua` is regenerated (the Lua fixes reach calls only after this).
- Logging: `fs_cli -x "console loglevel debug"`; an ESL listener recording every event with its timestamp
  (`event plain ALL` on a second connection); backend logs at `LOG_LEVEL=debug`.
- Engine globals to vary per test (in `vars.xml`, then `reloadxml`): `ENRS_FAILSAFE_ON_FLOW_ERROR`,
  `ENRS_FAILSAFE_EXT`, `ENRS_FAILSAFE_PROMPT`, `ENRS_IVR_BLOCK_INLINE_TRANSFER`.

For every test record: test ID, release-candidate commit, executor generation time, the fs_cli log excerpt
(grep `[ivr_executor]`, `[ers-ring]`), the ESL event sequence for the call UUID, and the database rows listed.

## Tests

### IVR

| ID | Setup | Expected behaviour | Verify |
|---|---|---|---|
| T-IVR-1 Normal execution | Flow: say (Piper) → gather 1 digit → condition → play → hangup | Prompt heard, DTMF routes to the matching branch, call ends normally | fs_cli: `[ivr_executor]` node trace in order, no `ERR`; `CHANNEL_HANGUP` cause `NORMAL_CLEARING` |
| T-IVR-2 Transfer (XML) | transfer `destination=${agent_ext}`, `agent_ext` set by set_variable to a lab extension | Caller bridged to the extension | `CHANNEL_EXECUTE` application `transfer`, data `<ext> XML default`; the extension rings |
| T-IVR-3 Transfer, author-written words | destination `1001 XML public` (published before Cycle 3, or via the API) | Routed in context `public`, as before | `transfer` data `1001 XML public XML default`; dialplan log shows context `public` |
| T-IVR-4 Transfer, injected word | `agent_ext` from a REST mapping returning `1000 inline` | Transfer refused, call hangs up (default) | fs_cli `a variable value added a word to the destination — refused`; no `transfer` execute |
| T-IVR-5 Existing inline transfer | Flow stored with `dialplan: inline`, destination `playback:/tmp/lab.wav` | Still runs; WARN logged. With `ENRS_IVR_BLOCK_INLINE_TRANSFER=true`: refused, call hangs up | fs_cli `inline dialplan used (deprecated…)` / `blocked by ENRS_IVR_BLOCK_INLINE_TRANSFER` |
| T-IVR-6 Webhook | webhook to a lab HTTP listener; URL containing `'` and a body using `${caller_id_name}` | One POST from the telephony host, JSON body intact, no extra process run | Listener access log; `ps`/auditd on the host shows only `curl`; flow continues to next node |
| T-IVR-7 Variable substitution | say `Hello ${caller_id_name}` with caller name `Ann ${x}`; set_variable greeting from it | Plain `${var}` behaves as before | Piper request body / `speak` data contains the substituted text |
| T-IVR-8 Command form neutralised | caller name `${system touch /tmp/pwned}`; say node with Piper unset (built-in TTS fallback) and a transfer from that variable | No file created; speech/transfer shows inert text | `ls /tmp/pwned` absent; `speak` data has no `${system` |
| T-IVR-9 Protected variable | set_variable `api_hangup_hook=system touch /tmp/hook` (published before Cycle 3) | Write skipped, logged; hangup runs no command | fs_cli `refused to set protected variable`; `/tmp/hook` absent |
| T-IVR-10 Flow error, default | Flow whose goto references a deleted node | Call hangs up, as before | fs_cli broken-flow ERR with reason, `hanging up (ENRS_FAILSAFE_ON_FLOW_ERROR not set)` |
| T-IVR-11 Flow error, failsafe on | Same, with `ENRS_FAILSAFE_ON_FLOW_ERROR=true` and `ENRS_FAILSAFE_EXT=<lab ext>` | Failsafe prompt then transfer to the extension | `transfer` data `<ext> XML default` |
| T-IVR-12 Number matching | IVR bound to `7100`; dial `7100`, `71000`, `7101` | Only `7100` reaches the flow (literal match since Cycle 2) | Dialplan log; compare with `scripts/ivr-compat-report.js` `pattern_numbers` |
| T-IVR-13 DTMF | gather with min/max digits, terminator `#`, timeout branch, invalid branch, retries | Each branch taken as configured; retry prompts as configured | `DTMF` events; `[ivr_executor] gather` log lines with `reason=` |

### ENS

| ID | Setup | Expected behaviour | Verify |
|---|---|---|---|
| T-ENS-1 Outbound call answered | Campaign to 3 lab extensions that auto-answer and play | Each called once, message played | `ens_campaign_destinations`: `completed`, `answered_at` set; `ens_campaigns.completed_count = 3`; campaign `completed` |
| T-ENS-2 Busy | One extension returns 486 | Retried after `retry_interval_sec` until `max_attempts`, then final | ESL: `CHANNEL_HANGUP` `USER_BUSY`, then `BACKGROUND_JOB` `-ERR USER_BUSY` (**record the order**); rows: `queued` + `next_attempt_at` after each attempt, `attempt_count` increments, final `failed` / `USER_BUSY`; `failed_count` +1 once |
| T-ENS-3 No answer | One extension never answers | Retried as T-ENS-2 with `NO_ANSWER` | Same queries; `no_answer_count` per attempt |
| T-ENS-4 Retry succeeds | Extension busy on attempt 1, answers on attempt 2 | Completed on attempt 2 | `attempt_count = 2`, `completed`; report shows 1 recipient answered, 1 retry |
| T-ENS-5 Campaign cancelled | Cancel while one call rings and one recipient waits for a retry | No further calls; ringing call's recipient → `skipped`; waiting one → `skipped` | No new `CHANNEL_CREATE` for the campaign after cancel; no `queued`/`dialing` rows left |
| T-ENS-6 Campaign timeout | `campaign_timeout_min` short, recipients unreachable | Campaign closes; in-flight recipients end `expired` | Rows `expired`; campaign `completed` |
| T-ENS-7 Originate rejected | Recipient number with no route | Failed, `ORIGINATE_ERROR`, no retry (unchanged) | `error_message` holds the `-ERR` text; no second attempt |
| T-ENS-8 IVR-triggered blast | IVR ens node / ens_blast_record on the tenant's number | Campaign created for the tenant's configuration only | `ens_campaigns.ens_configuration_id`; backend log; a configuration of another tenant (session variable) → 403, no campaign |
| T-ENS-9 Playback | Call the playback number after T-ENS-1 | Latest recording played | `playback-log` row for the caller |

### ERS and conferences

| ID | Setup | Expected behaviour | Verify |
|---|---|---|---|
| T-ERS-1 Responder selection | Config with tier contacts and a responder group | Every contact of the tier (both sources, de-duplicated) is rung | `ers_incident_responders` rows `INVITED` per contact; one `originate` per responder in backend log |
| T-ERS-2 Ring order | Tier 1 nobody answers within `ring_timeout_seconds`, tier 2 answers | Tier behaviour as configured before Cycle 2 (no change made) | Responder rows per tier; `ring_start_time`; `enrs::ers_ring_ended` event |
| T-ERS-3 Busy / no answer | One responder busy, one never answers | Re-ring waves until someone joins; non-joiners end `MISSED`/`INVITED` | Responder rows; occupancy via `conference <room> list` |
| T-ERS-4 Caller identity | Caller with directory name, caller with SIP name containing `'`/`{`, caller `anonymous`, caller with empty number | Responders see the caller's name/number; `'` `{` `}` `\` removed from the name; `anonymous` passed; empty number passed empty (as before) | Responder phone display; `origination_caller_id_*` in the originate string (backend debug log) |
| T-ERS-5 Conference creation and participants | Caller + 2 responders join | Room `ers_<config>_p`, recording starts on first responder join | `conference ... list`; `ers_incident_participants`; recording file present |
| T-ERS-6 Conference controls | From the Monitoring page as tenant ADMIN (own incident) and SUPER_ADMIN (any room, incl. one without incident): mute, unmute, kick, lock, play, record | Each command acts once; tenant user on another tenant's or an ownerless room gets 404 | ESL `api conference …` log; `audit_logs` `conference_control` rows |
| T-ERS-7 Recording access | Tenant A and B users open the incident recordings | Only own tenant's; SUPER_ADMIN all | HTTP status; `audit_logs` |
| T-ERS-8 Live events | Two browsers (tenant A, tenant B) on Monitoring during T-ERS-5 | Only tenant A sees A's incident events | Socket frames in browser dev tools |

### Recording and DTMF (shared)

- Recording: IVR record_message node and conference recording — file written under the recording directory as a
  new `.wav`, path stored in the variable / incident; a request to record to another path is refused (400).
- DTMF: in-band and RFC 2833 both, on T-IVR-13 and the ENS PIN prompt (correct PIN, wrong PIN, max attempts).

## Exit criteria

All rows pass, or each deviation is logged with its evidence and judged against `FINAL_BUSINESS_LOGIC_REGRESSION_MATRIX.md`.
T-ENS-2/3/4 decide the one ENS behaviour that depends on event timing (see RELEASE_BLOCKERS.md, RB-1). Executed in
Cycle 5: the hangup arrives first; RB-1 approved and closed on 2026-11-04.
