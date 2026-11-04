# Real FreeSWITCH Test Results (Cycle 5, 2026-11-04)

Baseline plan: REAL_FREESWITCH_TEST_PLAN.md. Final run: **staging run 4**, after the two Cycle 5 fixes (C5-1 deploy of
already-published flows, C5-2 ENS settlement race). Earlier runs are listed in section 6 with what each one changed.

Classes: **PASS (staging)** = verified on the disposable FreeSWITCH; **PASS (automated)** = automated test only;
**CONDITIONAL** = configuration or migration required; **FAIL** = actual regression; **NOT TESTED** = no environment
or evidence.

## 1. Environment (isolated; nothing shared)

| Part | What was used |
|---|---|
| Switch | The installed FreeSWITCH **1.10.12** binary, started as a **second, disposable process** with its own config, log, db, run and recording directories under `/tmp/enrs-iso-rel/fs` (deleted afterwards). The host's running FreeSWITCH (pid 282) was never contacted. Its pid was the same before and after every run |
| Network | Private network namespace containing only `lo`: SIP 127.0.0.1:55060 (`internal`, the application's switch) and :55070 (`phones`, simulated endpoints), ESL 127.0.0.1:58021 with a fresh password. Host ports 5432, 6379, 8021, 5060, 5080, 5000, 4100 and 8100 were unreachable from inside, and nothing inside was reachable from the host (checked every run) |
| Endpoints | Synthetic phones in the `phones` dialplan: answer (`70020xx`, `7004001`), 486 busy (`70021xx`, `7004002`), ring without answer (`70022xx`, `7004003`), 404 (`70023xx`), 603 (`70024xx`), busy then answer (`7002501`). Directory users dial them with `user/<ext>`, the application's real dial string. No gateway, trunk or registration |
| Database | Disposable PostgreSQL 18 (127.0.0.1:55432), migrated and seeded by the repository's own runners |
| Backend | Working tree (release candidate). For the ENS comparison, the **HEAD `7f849ed` backend** (`git archive`) on the same switch and schema |
| HTTP targets | Mock inside the namespace on 10.77.0.10 (private) and 198.51.100.10 (TEST-NET-2, treated as public) |
| Data | Synthetic only: two tenants, four users, synthetic numbers (`8800001`, `+9668800002`, `8800003`, `8800004`, `8800010`, extensions `7002xxx` / `7004xxx`, caller `5550100010`) |
| Evidence | Session scratchpad `evidence-stg` (run 4), `evidence-stg-run3`, `evidence-ui-c5`. Per test: FreeSWITCH log, ESL events seen by the driver (`esl-observer-*.jsonl`), ESL events in the order the **backend** received them (`esl-tap-backend-*.jsonl`), database rows, mock requests |

Driver and harness: scratchpad `stg/` (`run.sh`, `ns-stage.sh`, `fs-conf.sh`, `stg-tests.mjs`, `esl-tap.cjs`, `mock.mjs`).
No application code was changed to make a test pass. `esl-tap.cjs` only records the events the backend receives.

## 2. IVR

| ID | Test | Expected | Actual (run 4) | Evidence | Class |
|---|---|---|---|---|---|
| T-IVR-PUB | Publish through the API | Normal flows publish; a **new** inline transfer is refused | main / REST / ERS flows 201; new inline flow 400 `"inline" is not allowed` | API responses | PASS (staging) |
| T-IVR-DEPLOY | Deploy writes the executor and dialplan, reloadxml, verify | 200 for each flow, including the inline flow published by an older release; the flow with a dangling reference refused (as at HEAD) | main, plus, inline, ERS: 200, every step ok, `verify_extension_loaded:ok`; dangling flow 422 `validate_graph` | deploy reports, `enrs_ivr.xml` | PASS (staging), after C5-1 |
| T-IVR-1/2/3/5 | Normal execution, DTMF, variable substitution, webhook, XML transfer | DTMF 1 on the IVR leg; webhook body `menu=1`, `flag=dtmf-1-from-5550100001`; transfer to 7003001 XML/default with the variable kept | `DTMF 1@sofia/internal/5550100001`; webhook `{"case":"I1","menu":"1","flag":"dtmf-1-from-5550100001","caller":"5550100001"}`; `STG_XFER_TARGET reached dest=7003001 … stg_flag=dtmf-1-from-5550100001` | FS log, ESL DTMF event, mock log | PASS (staging) |
| T-IVR-4 | Existing inline transfer (published before the rule) | Still runs, with the deprecation WARN | `[ivr_executor] transfer: inline dialplan used (deprecated; republish with XML)`; `transfer(set:stg_inline_ran=yes,log:STG_INLINE_RAN,… inline default)`; `STG_INLINE_RAN` executed | FS log | PASS (staging) |
| T-IVR-7 | REST node, redirect to an allowed address | Followed; mapped variable used | `10.77.0.10/rest/redir-public → 198.51.100.10/rest/final`; outcome success; webhook `rest=silver` | mock log, FS log | PASS (staging) |
| T-IVR-8 | REST redirect to loopback | Refused, `http_error` branch, target never requested | `status=302 outcome=http_error`; `/rest/final` requests 0; webhook `path=error` | mock log | PASS (staging) |
| T-IVR-11a | `+` number matching | `+9668800002` matches literally | executor ran (8 lines) | FS log | PASS (staging) |
| T-IVR-11b | Near-miss numbers | `88000011`, `9668800002`, `880000` reach no flow | no executor; caller leg `NO_ROUTE_DESTINATION` | FS log, ESL | PASS (staging) |
| T-IVR-12a | Broken flow, failsafe **disabled** (default) | Hang up, as before | `flow ended abnormally (node_not_found) … hanging up (ENRS_FAILSAFE_ON_FLOW_ERROR not set)`; failsafe target not reached | FS log | PASS (staging) |
| T-IVR-12b | Broken flow, failsafe **enabled** (set on the staging switch only, reset afterwards) | Transfer to `ENRS_FAILSAFE_EXT` | `entering failsafe` → `transfer(7003009 XML default)` → `STG_FAILSAFE_TARGET` | FS log | PASS (staging) |
| T-IVR-6 | Webhook transport | Direct POST from the switch | Body received by the mock from the switch's curl (`user-agent: curl`) | mock log | PASS (staging) |
| — | Protected variables, `${name args}` neutralised | Refused / inert | Not exercised on the switch this cycle | Lua suite (Fengari) | PASS (automated) |
| — | `ENRS_IVR_BLOCK_INLINE_TRANSFER=true` | Inline transfer refused | Not enabled (brief: do not enable compatibility switches) | Lua suite | NOT TESTED (staging) |

## 3. ENS (same campaign on HEAD and on the working tree, same switch)

Configured policy for the test: `max_attempts` 3, `retry_interval_sec` 15 (cancel test: 60). Order = the order the
**backend** received the events.

| ID | Recipient | Expected (configured) | Working tree, run 4 | HEAD, run 4 | Class (working tree) |
|---|---|---|---|---|---|
| T-ENS-1/2 | 7002001 answers | completed, 1 attempt | completed, 1; `ANSWER → JOB +OK → HANGUP NORMAL_CLEARING` | same | PASS (staging) |
| T-ENS-3 | 7002101 always busy | 3 attempts, failed | 3 attempts, failed `USER_BUSY`; each attempt `HANGUP USER_BUSY → JOB -ERR USER_BUSY` | 3 attempts, failed `ORIGINATE_ERROR` (run 3: 2 attempts) | PASS (staging) |
| T-ENS-4 | 7002201 never answers | 3 attempts × 30 s, failed | 3 attempts, failed `NO_ANSWER` | 3 attempts, `ORIGINATE_ERROR` (run 3: 2) | PASS (staging) |
| T-ENS-5 | 7002301 404 | failed, 1 attempt | failed `UNALLOCATED_NUMBER`, 1 | failed, cause shown `ORIGINATE_ERROR` | PASS (staging) |
| T-ENS-5b | 7002401 603 (CALL_REJECTED is retryable) | 3 attempts, failed | 3 attempts, `CALL_REJECTED` | **1 attempt** | PASS (staging) |
| T-ENS-6 | 7002501 busy, then answers | completed on attempt 2 | completed, 2 attempts | **failed after 1; never re-dialled** | PASS (staging) |
| T-ENS-7 | 7002999 not in directory | failed, `ORIGINATE_ERROR`, no retry | same (`-ERR SUBSCRIBER_ABSENT`, no hangup event) | same | PASS (staging) |
| T-ENS-E1 | Campaign totals | each recipient counted once | 2 completed + 5 failed = 7; status completed | `failed_count` 7 + `completed_count` 1 for 7 recipients with 1 answered (run 3: failed 8, queued 3) | PASS (staging) |
| T-ENS-8 | Two replayed `CHANNEL_HANGUP` (ESL `sendevent`) for a settled answered call | counters unchanged | received 3, `completed` 2 → 2 | `completed` 1 → **3** | PASS (staging) |
| T-ENS-9 | Cancel while a busy recipient waits for its retry | `skipped`, no further call | `queued` (retry set) → cancel 200 → `skipped`; 1 originate in 75 s | recipient `failed` (retry time still set) | PASS (staging) |
| — | Integration suite `ensAttemptSettlement.test.js`, real PostgreSQL | — | **17/17** (2 new race cases) | — | PASS (automated) |

Observed ESL order, every failed attempt: **`CHANNEL_HANGUP` first, `-ERR <cause>` second**, received by the backend
milliseconds apart. Analysis and decision: ENS_RETRY_BEHAVIOUR_DECISION.md.

## 4. ERS

| ID | Test | Expected | Actual (run 4) | Evidence | Class |
|---|---|---|---|---|---|
| T-ERS-1/2 | Responder selection, ring order | Primary tier, all three in wave 1, priority order | originates `7004001, 7004002, 7004003`, all received by the phones | backend log, FS log | PASS (staging) |
| T-ERS-3 | Caller ID on responder phones | Caller number; contact name with `$` kept | `cid_num=5550100010 cid_name=Stg$Caller One` on all three phones | FS log (`STG_PHONE_RX`) | PASS (staging) |
| T-ERS-4/5 | Busy / no-answer responder | Recorded | During the call: `INVITED`, no cause. After completion: `MISSED`, hang-up cause "None". `ersChannelMap` is filled only on conference join, so legs that never join get no cause. **Unchanged from HEAD** (code not touched) | DB, Excel export | PASS (staging), pre-existing limitation noted |
| T-ERS-6 | Conference creation, tenant isolation | Room `8810001` with caller and responder; tenant B refused | members listed for tenant A; tenant B 404 | FS `conference list`, API | PASS (staging) |
| T-ERS-7 | Participant controls (operator) | mute, play, kick | 200 / 200 / 200; `conference::maintenance` `mute-member`, `play-file`, `kick-member`, `del-member`; audited | ESL, audit log | PASS (staging) |
| T-ERS-8 | Recording, completion | File written; incident completed | `ers_8810001_<incident>.wav`, 530 706 bytes; status `COMPLETED`, ended | recordings dir, DB | PASS (staging) |
| T-ERS-REPORT | Report, tenant scope | Incident for tenant A only | tenant A: listed, 3 responders, 1 joined; tenant B: 0 | API, Excel | PASS (staging) |

## 5. Not tested on the switch (and why)

| Item | Reason |
|---|---|
| Real SIP phones, PSTN, gateways, Avaya/Cisco trunks, PAI | Not allowed (no customer trunks); simulated endpoints only |
| `ENRS_IVR_BLOCK_INLINE_TRANSFER=true`, `ENS_REQUIRE_IVR_NUMBER=true`, `IVR_CRED_*` scopes | Brief: do not enable compatibility-changing switches (only the failsafe was toggled, as the brief lists it, on the disposable switch, reset afterwards) |
| TTS (Piper) prompts, `mod_flite` | Piper not present; flows used audio files |
| ENS blast recording through the phone (`ens_blast_record`), ENS playback node | Not in the minimum list; covered by unit tests only |
| Load / many concurrent calls, failover, ESL reconnect during calls | Out of scope for this run |
| The engine's Lua 5.2 vs Fengari differences beyond the flows above | Only the flows above ran on the engine |

## 6. Runs

| Run | Result | What changed afterwards |
|---|---|---|
| 1 (IVR only) | 9/12; deploy of an inline flow published earlier returned **422** | **Regression found → C5-1** (deploy validation) |
| 2 | IVR as run 1 with C5-1; ENS/ERS void: staging directory XML wrong (`SUBSCRIBER_ABSENT` for every call) | Staging config fixed (FreeSWITCH drops a line containing `<include>`) |
| 3 | IVR all pass; ENS: **HEAD and working tree both lose configured retries** on the real switch (race between hangup and originate result) | **Defect found → C5-2** (ENS settlement) |
| 4 (final) | Working tree 28/29 (the one is the pre-existing ERS limitation above); HEAD 5/10 ENS checks | — |

Each run: fresh secrets, fresh database, fresh switch config; teardown removed everything; the host-side check
confirmed nothing listened on the host and the host FreeSWITCH pid was unchanged.
