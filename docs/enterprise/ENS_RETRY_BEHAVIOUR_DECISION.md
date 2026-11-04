# ENS Retry Behaviour — Decision Record (Cycle 5, 2026-11-04)

> **Decision: APPROVED (2026-11-04): retry exactly as configured.** RB-1 is closed as an approved business-behaviour
> decision. Conditions:
>
> - the Cycle 5 `settleAttempt` is kept;
> - `max_attempts`, `retry_interval_sec` and `RETRYABLE_CAUSES` are unchanged;
> - no additional retries are introduced and no retry setting changes meaning;
> - no customer configuration is changed;
> - the "0 = no retries" discrepancy (section 7, O-3) remains a separate pre-existing business-rule issue and is not fixed.
>
> The approval covers this behaviour only. It does not authorise a commit, push, deploy, any DEV or production change,
> or closing any other release blocker.

Closes the question left open as RELEASE_BLOCKERS RB-1: what the committed code really does on a switch, what the
working tree does, and whether the working tree follows the retry policy the customer has configured.

Evidence: isolated staging (a disposable FreeSWITCH 1.10.12 with simulated phones answering 200, 486, 404 and 603,
or not answering), the same campaign run on the **committed engine (HEAD `7f849ed`)** and on the **working tree**,
same switch, same database. Event order is taken from the backend's own ESL connection (`esl-tap` harness preload:
it only records, it does not change the backend). Details: REAL_FREESWITCH_TEST_RESULTS.md, section ENS.

## 1. The configured retry policy (unchanged by this mission)

| Setting | Where | Meaning in the engine |
|---|---|---|
| `max_attempts` (ENS configuration, default 3) | copied to the campaign and to every recipient at creation | **total** attempts, the first call included. A retry is scheduled only while `attempt_count < max_attempts` |
| `retry_interval_sec` (default 60) | copied to the campaign | delay before the next attempt (`next_attempt_at`) |
| Retryable causes | `RETRYABLE_CAUSES` in `campaignEngine.js` | `BUSY`, `USER_BUSY`, `NO_ANSWER`, `CALL_REJECTED`, `NORMAL_CIRCUIT_CONGESTION`, `SWITCH_CONGESTION`, `NO_ROUTE_DESTINATION`, `ORIGINATOR_CANCEL`, `NO_USER_RESPONSE`, `ALLOTTED_TIMEOUT`, `SUBSCRIBER_ABSENT` |
| Any other hangup cause | | final: `failed` |
| Originate refused before a channel exists | `-ERR …` with no channel (for example an unknown extension) | final: `failed`, cause `ORIGINATE_ERROR`, no retry |
| Ring time | `ORIGINATE_TIMEOUT = 30` s | after it, cause `NO_ANSWER` |

Campaign creation, recipient selection, dispatch, pacing, `RETRYABLE_CAUSES`, intervals and attempt counts are
**byte-for-byte unchanged** from HEAD. Only the settlement of a finished attempt changed. Note that `retry_failed_only` is
stored but not read by the engine, at HEAD and now.

## 2. What the switch actually sends

Observed on every failed attempt in staging (busy, no answer, 404, 603), in this order, milliseconds apart:

1. `CHANNEL_HANGUP` with the real cause (`USER_BUSY`, `NO_ANSWER`, `UNALLOCATED_NUMBER`, `CALL_REJECTED`);
2. the originate result (`BACKGROUND_JOB`) `-ERR <the same cause>`.

Only when no channel can be created at all (an extension missing from the directory) is there no hangup, only
`-ERR SUBSCRIBER_ABSENT`.

So **the order is hangup first**. That is the case Cycle 4 flagged as the one that matters (RB-1).

## 3. What happens today with the committed code (HEAD), measured

Both events update the same recipient with no check of its current state. The final status is whichever database
update happens to run last, so the result changes from call to call:

| Recipient | Configured: 3 attempts, 15 s apart | HEAD, staging run 3 |
|---|---|---|
| Answers | completed, 1 attempt | completed, 1 attempt ✔ |
| Always busy | 3 attempts, then failed | **2 attempts**, failed `ORIGINATE_ERROR` |
| Never answers | 3 attempts, then failed | **2 attempts**, failed `ORIGINATE_ERROR` |
| 404 | failed, 1 attempt | failed, 1 attempt (cause shown as `ORIGINATE_ERROR`, not `UNALLOCATED_NUMBER`) |
| 603 (retryable) | 3 attempts, then failed | **1 attempt**, failed |
| Busy, then answers | completed on attempt 2 | **failed after attempt 1; never called again** |
| Not in directory | failed, 1 attempt | failed, 1 attempt ✔ |
| Campaign counters | each recipient counted once | **`failed_count` 8 for 7 recipients**, `queued_count` 3 on a completed campaign, `busy_count` 3 |
| 2 replayed hangups for an answered call | no change | `completed_count` 1 → **3** |
| Cancel while a retry is pending | recipient `skipped` | recipient `failed` (with a retry time still set) |

**Today, configured retries run only sometimes**, depending on timing, and the campaign report over-counts failures.

## 4. What happens with the updated code

Cycle 4's version (compare-and-set settlement) removed the double counting. But staging run 3 showed it still lost
retries: the two events were settled at the same moment, and the originate path, one query shorter, often won (busy
recipient: 2 attempts; no answer: 1 attempt). The Cycle 4 tests ran the two events one after the other, so they could
not show this.

Fixed in Cycle 5 (`campaignEngine.js`, `settleAttempt`):

- the hangup is noted the moment its event arrives, before any database work;
- when a hangup exists, **the hangup alone settles the attempt** with its real cause. That is the rule HEAD's own
  hangup handler encodes: retry if the cause is retryable and attempts remain, otherwise failed;
- the originate result settles the attempt only when no hangup comes within 2 seconds, which means no channel was
  created. The outcome is then exactly as before: `failed`, `ORIGINATE_ERROR`, no retry.

Measured after the fix (staging run 4): see REAL_FREESWITCH_TEST_RESULTS.md, T-ENS-E1, and section 7 below.

## 5. Which cases were previously incorrect

1. Busy / no-answer / 603 recipients lost some or all of their configured retries (random, timing-dependent).
2. A recipient who would have answered on the configured retry was never called again.
3. The final cause of a recipient whose phone rejected the call was recorded as `ORIGINATE_ERROR`, hiding the real
   cause (`UNALLOCATED_NUMBER`, `USER_BUSY`, …) in reports.
4. `failed_count`, `busy_count`, `retried_count` and `queued_count` were over-counted, so campaign totals did not
   add up to the number of recipients.
5. Repeated hangup events counted a delivery more than once.
6. A cancelled campaign could leave a recipient marked `failed` with a retry scheduled, instead of `skipped`.

## 6. Does the updated code follow the configured policy?

Yes, and only that policy. No attempt count, interval, cause list, recipient or dialling order was changed. The only
difference a customer can notice is that **retries they configured now actually happen**. A busy or no-answer
recipient receives up to `max_attempts` calls, `retry_interval_sec` apart, as the ENS configuration screen states,
instead of sometimes fewer. A campaign can therefore place more calls than it did on DEV before, but never more than
configured.

## 7. Does any customer configuration need changing?

No. Recommended checks before production:

- Review each ENS configuration's **Max Attempts** with the customer. Where it was set high because "retries never
  seemed to happen", the configured number will now be honoured.
- Pre-existing, not changed: the screen says "0 = no retries", but the engine stores `max_attempts || 3`, so **0
  becomes 3 attempts**. Use 1 for "no retry". This is a business-rule question to settle with the product owner; it
  is not changed here.
- Pre-existing, not changed: the live `dialing_count` gauge can stay one too high after a peak update
  (`processCampaign` sets it from the dialing **and** answered rows). It is a live gauge only; completion and the
  report use the recipient rows.

## 8. Decision

Options presented: approve "retry exactly as configured", or decide that ENS must not retry (then `max_attempts` = 1
per configuration, a configuration change, no code change).

**Approved 2026-11-04: retry exactly as configured.** RB-1 is closed with the conditions listed at the top of this
record.
