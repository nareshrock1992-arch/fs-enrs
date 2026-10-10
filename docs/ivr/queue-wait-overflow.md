# Queue Wait node (`queue_wait`)

Bounded **pre-transfer** eligibility wait for contact-centre queues. It replaces
the ad-hoc pattern of looping `queue_eligibility` back into itself (which has no
deadline and announces every polling cycle). `queue_wait` owns the hold +
recheck + deadline internally and exits through three clear outcomes.

It reuses the **same read-only eligibility endpoint** as `queue_eligibility`
(`POST /api/v1/internal/ivr/queue-eligibility`) — no new backend logic — and is
contact-centre-specific (no ERS/conference reuse). `queue_eligibility` is
unchanged and remains available for one-shot checks.

## Configuration
| Field | Req | Meaning |
|---|---|---|
| `queue` | ✔ | Exact `mod_callcenter` queue to recheck (supports `${var}`). **Not** inherited from another node. |
| `max_wait_seconds` | ✔ | Absolute pre-transfer deadline (5–3600). Measured once at entry, **never reset**. |
| `recheck_interval_seconds` | | Poll/hold-chunk interval (1–60, default 5). |
| `check_timeout_seconds` | | Per-check eligibility timeout (1–15, default 5). |
| `hold_source_type` | | `none` (silence) / `audio` / `tts`. Finite per chunk — never a looping MOH stream. |
| `hold_audio_url` / `hold_prompt_text` | | Asset for the chosen hold source. |
| `announcement_source_type` | | `none` (default) / `audio` / `tts` — periodic message (e.g. support email). |
| `announcement_audio_url` / `announcement_text` | | Asset for the chosen announcement source. |
| `announcement_every_seconds` | | Cadence (0 = never). First plays **after** this many seconds, never at t=0. |
| `branches` | ✔ | Outcome → target node. |

Validation is enforced **server-side** (Zod), not just in the UI: `queue` and
`max_wait_seconds` required; all timing fields range-bounded; a chosen
hold/announcement source requires its asset; an announcement source requires a
positive cadence; audio URLs must be local `/media/...` (no external URLs).

## Business policy (admin-configurable per eligibility reason)
`ELIGIBLE` always exits immediately via the `ELIGIBLE` branch — it is never a
policy choice. For every other reason the administrator chooses the strategy:

| Eligibility reason | Allowed strategies | Default (new node) | Absent field (legacy graph) |
|---|---|---|---|
| `NO_AVAILABLE_AGENTS` (busy) | `wait` / `overflow` | `wait` | `wait` |
| `ALL_AGENTS_PAUSED` | `wait` / `overflow` | `wait` | `wait` |
| `NO_AGENTS_LOGGED_IN` | `wait` / `overflow` | `wait` | `wait` |
| `NO_MEMBERS` (misconfig) | `error` / `overflow` | `error` | `wait` *(legacy preserve)* |
| `QUEUE_NOT_FOUND` (misconfig) | `error` / `overflow` | `error` | `wait` *(legacy preserve)* |
| `CHECK_ERROR` / malformed / timeout / **unknown reason** | fixed → `CHECK_ERROR` | — | — |

- `wait` = keep polling until eligible or the deadline. `overflow` = exit now via `OVERFLOW`. `error` = exit now via `CHECK_ERROR`.
- **Structural reasons never offer `wait`** in the UI — a missing/empty queue can't become eligible, so waiting would hold the caller pointlessly.
- A **check failure / malformed data / unknown reason** is *always* `CHECK_ERROR`, never treated as ordinary unavailability. This is distinct from `NO_*` states.

### Where a node's policy values come from (three origins)
The runtime fallback depends on how the node was created, not only on the saved value:

| Origin | How policy fields are populated | Absent field | Invalid field |
|---|---|---|---|
| **Builder node** (new, via the UI) | `NODE_DEFAULTS` seeds every policy; publish passes Zod enum validation | n/a — always present | can't occur (UI select + Zod enum reject) |
| **Legacy graph** (saved before policy existed) | no policy fields at all | → `wait` *(preserve original pre-policy behaviour)* | n/a |
| **Imported / programmatic graph** (API/script, not builder) | whatever the importer wrote; **still** gated by Zod enum on publish | → `wait` *(treated as legacy)* | rejected at publish; if it somehow reaches Lua, coerced to the safe default (see below) |

- **Backward compatibility:** policy fields are optional; an **absent** field makes the Lua default to `wait` (the pre-policy behaviour) for **both** recoverable and structural reasons, so a legacy saved `queue_wait` graph is unchanged. New builder nodes get the safe defaults above (structural → `error`). **No existing graph's behaviour changes.**
- **Defensive handling of invalid values (M-2):** a published graph can never carry an out-of-enum policy value — `ivrValidator.js` validates each policy field with a `z.enum` and rejects at publish. As a second layer, the Lua `policy_pick()` helper normalises a **present-but-invalid** value (empty string, unknown string, non-string) to the field's **safe default**: recoverable → `wait`, structural → `error`. This guarantees a corrupt or hand-imported structural value can **never silently become an indefinite `wait`**. An **absent** field is still `wait` for both — `policy_pick` distinguishes `nil` (legacy) from present-but-invalid, so an absent structural policy is never upgraded to `error`.

## Outcomes (branches)
- **ELIGIBLE** — an agent can take the call now (`status=Available`, `state∈{Waiting,Idle}`, tier `Ready`). Routes the instant it's detected. **Wire to a Transfer node.**
- **OVERFLOW** — the absolute deadline expired. Routes **exactly once**. Wire to your timed-out route (overflow dialer — see below — voicemail, or an announcement + hangup).
- **CHECK_ERROR** — the eligibility check itself failed (endpoint/parse error), or a structural/unknown reason resolved to `error`. Fail-closed: a failed check is **never** treated as "no agents". Wire to a safe fallback. When a **reason is available** (structural policy `error`, or an unknown reason), the channel variable `queue_wait_reason` is set to `<reason>:CHECK_ERROR` for diagnostics; the branch taken is unchanged. (The empty-queue and nil/malformed-response early exits have no reason to report, so they set no variable.)
- `_default` catches any outcome you leave unwired.

## Algorithm
`deadline = os.time() + max_wait_seconds` (computed once). While the session is
ready and `os.time() < deadline`: (1) one eligibility check — `ELIGIBLE` →
ELIGIBLE; nil/invalid → CHECK_ERROR; (2) if the check consumed the remaining
time, stop without another cycle; (3) play the announcement if its cadence has
elapsed; (4) play a finite hold chunk (≤ remaining time). On exit: caller gone →
end quietly; otherwise → OVERFLOW once.

## Timing limitations (important)
- Elapsed time uses `os.time()` → **1-second granularity**, wall-clock (a backward
  NTP step could marginally extend the wait). Adequate for a seconds–minutes wait.
- **Worst-case overrun:** a check at the top of an iteration starts only while
  `os.time() < deadline`, and `internal_post_t` caps the HTTP call at
  `check_timeout_seconds + 2` (the `+2` padding is in the generated `curl -s -m`).
  So the actual pre-transfer wait is bounded by
  **`max_wait_seconds + check_timeout_seconds + 2` seconds** (one in-flight check);
  the hold chunk never overruns because it is capped at the remaining time.
- `mod_lua` is single-threaded: hold/announcement playback **blocks**, so the real
  recheck interval ≈ hold-chunk length + the eligibility call's latency. There is
  no true "continuous MOH while polling"; chunks pace the loop. `local_stream://`
  (infinite) is intentionally **not** used.
- The deadline governs **pre-transfer** waiting only. After `ELIGIBLE → Transfer`,
  native `mod_callcenter` timers own the in-queue experience (unchanged here).

## Testing & what's proven
Deterministic tests (`backend/src/__tests__/lua/queueWait.test.js`) run the real
generated Lua in the Fengari harness with a **controllable clock**: eligible
first/after-N checks, OVERFLOW-once, no-deadline-reset, deadline-during-check,
CHECK_ERROR on API/malformed response, hangup-safe exit, announcement cadence;
plus server-side schema validation. These prove **control flow and routing with
a mocked session** — they do **not** prove real FreeSWITCH/LuaJIT playback
interruption, timing precision, HTTP timeout, or live call routing, which require
a DEV live-call.

## `OVERFLOW` → future `queue_overflow_dial` (out of scope here)
`OVERFLOW` is just a branch today. A future `queue_overflow_dial` node will
connect one caller to the first answering endpoint from an explicitly-typed
desk/mobile/Avaya-group list (no ERS/conference). No dial-string/bridge behaviour
is defined or implemented yet.
