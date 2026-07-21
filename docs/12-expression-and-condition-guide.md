# Expression and Condition Guide

**Product:** fs-enrs Emergency Notification and Response System
**Applies to:** IVR `condition` node — all eight operators

---

## Overview

The `condition` node is the primary decision-making node in IVR flows. It evaluates a single FreeSWITCH session variable against an expected value using one of eight operators, then routes to one of two downstream nodes (`true_node` or `false_node`).

The `condition` node does not support AND/OR logic within a single node. Compound conditions require chaining multiple `condition` nodes in series.

---

## Operator Reference

### String Operators

These operators compare the session variable's current value (a string) against the `expected_value` using standard string logic.

---

#### `==` — Equal

Performs a case-sensitive exact string match.

```
session.variable == expected_value
```

| Input Variable | Expected Value | Result |
|---|---|---|
| `"1"` | `"1"` | true |
| `"1"` | `"01"` | false |
| `"Yes"` | `"yes"` | false (case-sensitive) |
| `""` | `""` | true |

**Use cases:**
- Check a specific DTMF digit: `gather_result == "1"`
- Check if a session variable matches a known code: `dept_code == "ERS"`

---

#### `!=` — Not Equal

Inverse of `==`. Returns true when the variable's value does not exactly match `expected_value`.

```
session.variable != expected_value
```

**Use cases:**
- Route differently when no PIN was entered: `entered_pin != ""`
- Detect any input other than a sentinel value.

---

#### `contains` — Substring Match

Returns true when `expected_value` appears anywhere within the variable's value as a literal substring.

```
session.variable:find(expected_value, 1, true) ~= nil
```

| Input Variable | Expected Value | Result |
|---|---|---|
| `"emergency_1234"` | `"emergency"` | true |
| `"1234"` | `"12"` | true |
| `"hello"` | `"HELLO"` | false (case-sensitive) |

**Use cases:**
- Check if a caller ID starts with a known prefix (use `starts_with` instead for anchored prefix checks).
- Detect a keyword in a variable that might contain compound values.

---

#### `starts_with` — Prefix Match

Returns true when the variable's value begins with `expected_value`.

```
session.variable:sub(1, #expected_value) == expected_value
```

| Input Variable | Expected Value | Result |
|---|---|---|
| `"19055551234"` | `"1905"` | true |
| `"19055551234"` | `"1904"` | false |
| `"1234"` | `""` | true (empty prefix always matches) |

**Use cases:**
- Area code routing: `caller_id_number starts_with "1905"` → local campus; else external.
- Prefix-based menu routing when callers enter multi-digit codes.

---

### ENS Authentication Operators

These operators make HTTP calls to the backend internal API and set session variables as side effects. They should be used only in flows that handle ENS authorization workflows.

---

#### `ens_pin_valid` — ENS PIN Validation

Validates the caller's entered PIN against the ENS configuration associated with the dialed trigger number. This is the recommended way to gate ENS blast triggers behind a PIN.

**How it works:**

1. Takes `expected_value` as the ENS trigger number. If `expected_value` is empty, falls back to the `destination_number` session variable (the number the caller dialed).
2. The `variable` field specifies which session variable holds the caller's entered PIN (typically set by a prior `gather` node).
3. Calls `POST /internal/ens/verify-pin` with `{ trigger_number, pin }`.
4. If `authorized: true` is returned:
   - Calls `GET /internal/ens/lookup?number=<trigger_number>` to fetch configuration metadata.
   - Sets `ens_configuration_id` session variable to the resolved configuration ID.
   - Sets `ens_blast_clid` session variable to the blast caller ID.
   - Routes to `true_node`.
5. If `authorized: false`: routes to `false_node`.

**Important:** The raw PIN is never returned by the `/internal/ens/lookup` endpoint. PIN verification only goes through `/internal/ens/verify-pin`. This matches the contract in CLAUDE.md: "The lookup endpoint returns only `pin_required: true/false` — the raw PIN is never sent to Lua."

**Configuration:**
```
variable:       entered_pin       ← session var holding the PIN digits
operator:       ens_pin_valid
expected_value: ${destination_number}   ← or hardcode the ENS number
true_node:      → blast_record_node
false_node:     → invalid_pin_node
```

**Side effects (on true):**
- `ens_configuration_id` = resolved ENS config ID (string)
- `ens_blast_clid` = blast caller ID string

**ENS configurations with no PIN configured:** `verify-pin` returns `authorized: true` for any input, so the condition always routes to `true_node`. This allows configurations to be optionally PIN-protected.

---

#### `ens_callback_valid` — ENS Callback Authorization

Authorizes an inbound caller to replay an ENS notification recording. Used in playback flows where recipients call back to hear the latest notification.

**How it works:**

1. Takes `expected_value` as the `reply_clid` — the ENS reply number that the caller dialed.
2. The `variable` field is evaluated but not used directly in the API call (the variable's value is not sent to the authorize endpoint). The caller's identity comes from the `caller_id_number` system variable.
3. Calls `GET /internal/ens/callbacks/authorize?reply_clid=<expected_value>&caller=<caller_id_number>`.
4. If `authorized: true`:
   - Sets `ens_notification_uuid` session variable.
   - Sets `ens_recording_file` session variable (path to the recording).
   - Sets `ens_delivery_id` session variable.
   - Routes to `true_node`.
5. If `authorized: false` or the caller is not on the authorized list: routes to `false_node`.

**Configuration:**
```
variable:       destination_number  ← value not used in API call; required by schema
operator:       ens_callback_valid
expected_value: ${destination_number}  ← the reply_clid number
true_node:      → playback_node
false_node:     → rejected_node
```

**Side effects (on true):**
- `ens_notification_uuid` = notification UUID
- `ens_recording_file` = absolute path to the recording WAV
- `ens_delivery_id` = delivery record ID (string)

---

### Time-Based Operators

Time-based operators use the FreeSWITCH host's system clock (`os.date()`). Ensure the server's timezone is configured correctly.

---

#### `time_of_day` — Time of Day Range

Checks whether the current time falls within a specified 24-hour range.

**`expected_value` format:** `"HHMM-HHMM"` — four-digit 24-hour time, no separators, a hyphen between start and end.

| Example | Meaning |
|---|---|
| `"0800-1700"` | 8:00 AM to 4:59 PM |
| `"0000-0800"` | Midnight to 7:59 AM |
| `"2200-0600"` | 10:00 PM to 5:59 AM (overnight — end < start) |
| `"0900-0900"` | Never true (same start and end) |

**Overnight ranges:** When the end time is less than the start time, the condition uses `OR` logic: `now >= start OR now < end`. Example: `"2200-0600"` matches from 22:00 to 05:59.

**Boundary behavior:** The range is inclusive of the start minute and exclusive of the end minute. `"0800-1700"` matches from `0800` through `1659`; `1700` is not matched.

**Lua implementation:**
```lua
local now_hhmm = tonumber(os.date("%H%M")) or 0
local s_part, e_part = exp:match("^(%d%d%d%d)-(%d%d%d%d)$")
if s_part and e_part then
  local start_n = tonumber(s_part) or 0
  local end_n   = tonumber(e_part) or 2359
  if start_n <= end_n then
    ok = (now_hhmm >= start_n and now_hhmm < end_n)
  else
    -- overnight range
    ok = (now_hhmm >= start_n or now_hhmm < end_n)
  end
end
```

**Common mistakes:**
- Using colons: `"08:00-17:00"` — the regex `^(%d%d%d%d)-(%d%d%d%d)$` does not match and the condition is always false. Use `"0800-1700"` without colons.
- Forgetting that the variable field is required by the schema but ignored for this operator (the time check uses system clock, not a session variable). Set `variable` to any valid varName (e.g., `"destination_number"`).

---

#### `day_of_week` — Day of Week

Checks whether the current day of the week is in a specified set.

**`expected_value` format:** Comma-separated integers using Lua's `os.date("%w")` convention: `0`=Sunday, `1`=Monday, `2`=Tuesday, `3`=Wednesday, `4`=Thursday, `5`=Friday, `6`=Saturday.

| Example | Meaning |
|---|---|
| `"1,2,3,4,5"` | Weekdays (Mon–Fri) |
| `"0,6"` | Weekends (Sat–Sun) |
| `"1"` | Monday only |
| `"0,1,2,3,4,5,6"` | Every day (always true) |

**Lua implementation:**
```lua
local today = tonumber(os.date("%w")) or -1
for d in exp:gmatch("%d+") do
  if tonumber(d) == today then ok = true; break end
end
```

**Common mistakes:**
- Expecting `1`=Sunday (ISO 8601 convention) — Lua uses `0`=Sunday. Monday is `1` in this system.
- Not accounting for holidays — `day_of_week` only checks the day number; it has no awareness of public holidays or custom calendar events.

---

## Combining Conditions

The `condition` node evaluates a single expression. To implement compound logic (AND, OR, NOT), chain multiple `condition` nodes.

### AND Logic (Both Must Be True)

Connect the `true_node` output of the first condition to a second condition node. Both conditions must pass for the flow to reach the combined true path.

```
[condition A: time_of_day 0800-1700]
    │ true_node                    │ false_node
    ▼                              ▼
[condition B: day_of_week 1,2,3,4,5]    [after_hours_node]
    │ true_node     │ false_node
    ▼               ▼
[business_      [weekend_
 hours_node]     node]
```

This routes to `business_hours_node` only when it is both weekday AND business hours.

### OR Logic (Either Can Be True)

Use a `goto` to merge paths, or connect both `true_node` outputs to the same downstream node.

```
[condition A: caller_id_number starts_with "1905"]
    │ true_node              │ false_node
    ▼                        ▼
[local_ers_node]        [condition B: caller_id_number starts_with "1416"]
                             │ true_node     │ false_node
                             ▼               ▼
                        [local_ers_node] [external_node]
```

### NOT Logic (Negate)

Connect the `false_node` to the "positive" action and the `true_node` to the fallback. For example, to take action when a variable is NOT set:

```
[condition: variable=entered_pin, operator=!=, expected_value=""]
    │ true_node (pin was entered)     │ false_node (pin is empty)
    ▼                                 ▼
[validate pin…]                   [say: "No PIN entered."]
                                      │ next
                                      ▼
                                  [hangup]
```

---

## Complete End-to-End Flow Examples

### Example 1: ENS Authorization via PIN

Operator calls the ENS trigger number, enters their PIN, records a message, and the notification is blasted to all contacts.

```
[Entry]
[say: "Emergency Notification System. Enter your PIN followed by pound."]
    │ next
    ▼
[gather: variable_name=entered_pin, max_digits=8, terminators=#, timeout_seconds=10,
         branches: _default→condition_node, invalid→no_input_node]

no_input_node:
[say: "No input received. Goodbye."]
    │ next → [hangup]

condition_node:
[condition: variable=entered_pin, operator=ens_pin_valid, expected_value=${destination_number}]
    │ true_node                          │ false_node
    ▼                                    ▼
[ens_blast_record:                   [say: "Invalid PIN."]
  pin_prompt_text=... (internal)          │ next
  record_prompt_text=...]                 ▼
    │ next                           [gather: (retry)]
    ▼
[say: "Your notification has been sent."]
    │ next
    ▼
[hangup]
```

### Example 2: ENS Callback Playback

A recipient calls the ENS reply number to hear the latest notification.

```
[Entry]
[say: "Welcome to the Emergency Notification replay line."]
    │ next
    ▼
[condition: variable=destination_number, operator=ens_callback_valid,
            expected_value=${destination_number}]
    │ true_node (authorized)              │ false_node (rejected)
    ▼                                     ▼
[say: "Playing your notification."]   [say: "You are not authorized to access this line."]
(note: ens_playback_gate handles          │ next
 playback — use that node instead         ▼
 of condition for this pattern)       [hangup]
```

> For ENS callback playback, prefer the `ens_playback_gate` node, which handles both the authorization check and the recording playback in a single node.

### Example 3: Time-of-Day + Day-of-Week Combined

Route to primary ERS on weekday business hours, secondary ERS on weekday evenings, and a recorded message on weekends.

```
[Entry]
[say: "Thank you for calling Campus Emergency."]
    │ next
    ▼
[condition A: variable=destination_number, operator=day_of_week, expected_value="1,2,3,4,5"]
    │ true (weekday)                   │ false (weekend)
    ▼                                  ▼
[condition B: operator=time_of_day,   [say: "Campus Emergency is in weekend mode."]
              expected_value=           │ next
              "0800-1700"]              ▼
    │ true (business hours)         [ers_ring_all: tier=secondary]
    ▼
[ers_ring_all: tier=primary]

    │ false (after hours weekday)
    ▼
[say: "After-hours emergency response."]
    │ next
    ▼
[ers_ring_all: tier=secondary]
```

### Example 4: Multi-Attempt PIN with Lockout

Allow up to 3 PIN attempts, then lock out with a hangup.

```
[Entry]
[set_variable: variable=attempt_count, value=0]
    │ next
    ▼
pin_prompt:
[say: "Enter your emergency PIN followed by pound."]
    │ next
    ▼
[gather: variable_name=entered_pin, max_digits=8, terminators=#,
         branches: _default→check_pin, invalid→hangup_node]

check_pin:
[condition: variable=entered_pin, operator=ens_pin_valid,
            expected_value=${destination_number}]
    │ true_node              │ false_node
    ▼                        ▼
[ens_blast_record]    [set_variable: variable=attempt_count,
                                     value=... (increment not natively
                                     supported — use separate branches
                                     or simplify to 3 fixed nodes)]
                          │ next
                          ▼
                      [condition: variable=attempt_count, operator="==", expected_value="3"]
                          │ true (3rd fail)    │ false (1st or 2nd fail)
                          ▼                    ▼
                      [say: "Locked out."] [goto: → pin_prompt]
                          │ next
                          ▼
                      [hangup]

hangup_node:
[hangup]
```

> **Note:** Because `set_variable` does not support arithmetic, implementing a true increment counter requires either using `goto` with a fixed maximum depth (using the `MAX_STEPS=100` guard as the backstop) or duplicating the prompt nodes for each attempt. The `ens_blast_record` node provides a built-in 3-attempt PIN gate without this complexity.

---

## Operator Quick Reference

| Operator | Variable Source | Expected Value Format | Side Effects |
|---|---|---|---|
| `==` | session variable value | Any string | None |
| `!=` | session variable value | Any string | None |
| `contains` | session variable value | Substring | None |
| `starts_with` | session variable value | Prefix string | None |
| `ens_pin_valid` | session variable (PIN digits) | ENS trigger number or `${destination_number}` | Sets `ens_configuration_id`, `ens_blast_clid` |
| `ens_callback_valid` | (ignored) | Reply CLID number | Sets `ens_notification_uuid`, `ens_recording_file`, `ens_delivery_id` |
| `time_of_day` | (ignored — uses system clock) | `"HHMM-HHMM"` | None |
| `day_of_week` | (ignored — uses system clock) | Comma-separated day numbers (0=Sun…6=Sat) | None |

---

## Troubleshooting Conditions

| Symptom | Likely Cause | Resolution |
|---|---|---|
| `time_of_day` condition always routes to `false_node` | `expected_value` uses colons (`"08:00-17:00"`) instead of `"0800-1700"` | Remove colons from the expected value |
| `ens_pin_valid` always routes to `false_node` | Caller entering wrong PIN; ENS trigger number mismatch; `verify-pin` endpoint unreachable | Check FreeSWITCH logs for the curl call; verify `ENRS_INTERNAL_API` env var |
| `day_of_week` condition wrong day | Expecting 1=Sunday (ISO) but Lua uses 0=Sunday | Shift day numbers: Mon=1, Tue=2, …, Sun=0 |
| `ens_callback_valid` always rejects | Caller's ANI not on the ENS delivery list; notification expired | Check ENS delivery list; verify `caller_id_number` is being passed correctly by the carrier |
| Condition node routes to wrong branch | Variable not set before condition (empty string comparison) | Add a `set_variable` or `gather` node earlier to ensure the variable is populated |
