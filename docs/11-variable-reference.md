# Variable Reference

**Product:** fs-enrs Emergency Notification and Response System
**Applies to:** IVR Executor (Lua runtime), IVR Flow Builder node configuration

---

## Overview

Session variables are key-value pairs maintained by FreeSWITCH for the lifetime of a single call channel. The IVR executor (`ivr_executor.lua`) reads and writes these variables as it advances through the node graph. No variables persist across calls, and no variable is shared between concurrent calls.

Variable names follow the varName pattern enforced by the Zod schema: must start with a letter or underscore, may contain letters, digits, and underscores, maximum 128 characters.

Variables are read using `session:getVariable(name)` and written using `session:setVariable(name, value)`. All values are strings in the FreeSWITCH channel variable model — numeric values are stored and returned as strings.

---

## System Variables

System variables are set by FreeSWITCH before the Lua script starts executing. They are read-only from the IVR executor's perspective (writing them has no effect on FreeSWITCH's internal state for the current channel, though it would update the channel variable store).

| Variable | Type | Description |
|---|---|---|
| `destination_number` | string | The DNIS — the number the caller dialed. Used by ENS/ERS lookup endpoints to identify the correct configuration. Example: `"19055551234"` |
| `caller_id_number` | string | The caller's ANI (calling party number). Used for ENS callback authorization and passed to ERS incident creation. Example: `"19055559999"` |
| `caller_id_name` | string | The caller's display name as presented by the SIP signaling layer. May be empty if the carrier does not provide it. |
| `uuid` | string | The channel UUID assigned by FreeSWITCH. Used by `record_message` to construct unique recording filenames. Format: UUID v4, e.g. `"3f8a2b1c-0000-0000-0000-000000000000"` |

### Using System Variables

System variables are available to all node types that support `${varname}` interpolation:

```
say: text = "Calling from ${caller_id_number}"
set_variable: value = "${destination_number}"
condition: variable = "destination_number", operator = "ens_pin_valid"
webhook: body_template = {"caller": "${caller_id_number}", "dest": "${destination_number}"}
```

---

## Flow Variables

Flow variables are created by `gather` and `set_variable` nodes during flow execution. Their names are configured in the node's `variable_name` (gather) or `variable` (set_variable) field.

### Naming Convention

Use descriptive names that reflect the data being stored:

| Example Name | Used For |
|---|---|
| `menu_choice` | Top-level menu digit |
| `sub_menu_choice` | Second-level menu digit |
| `entered_pin` | PIN digits from gather node |
| `dept_code` | Department selection code |
| `selected_language` | Language preference |

### Scope and Lifetime

- Variables set with `session:setVariable()` persist for the entire call session.
- All variables are global within one call session — there is no block or node-level scoping.
- Variables are lost when the call ends (hangup, transfer, or ERS/ENS terminal).
- No variable is accessible from a different concurrent call.

### Default Variable Name

If `variable_name` is not set on a `gather` node, the default `gather_result` is used. Flows with multiple `gather` nodes should use distinct `variable_name` values to avoid overwriting earlier results.

---

## ENS Workflow Variables

ENS workflow variables are set as side effects of `condition` nodes using the `ens_pin_valid` or `ens_callback_valid` operators. They are not set by configuration in the node's form — they are produced automatically by the Lua handler on a successful authorization check.

These variables are consumed by downstream `ens` nodes (via `ens_config_var` and `recording_file_var` fields).

### Variables Set by `ens_pin_valid`

When a `condition` node with `operator=ens_pin_valid` successfully verifies the PIN:

| Variable | Type | Description |
|---|---|---|
| `ens_configuration_id` | string (integer) | The ENS configuration ID associated with the trigger number. Used by downstream `ens` nodes via `ens_config_var = "ens_configuration_id"`. |
| `ens_blast_clid` | string | The blast caller ID for the ENS campaign — the number that will appear on recipients' phones when they receive the call notification. |

Source: `GET /internal/ens/lookup?number=<trigger_number>` (called automatically by the condition handler on PIN success).

### Variables Set by `ens_callback_valid`

When a `condition` node with `operator=ens_callback_valid` successfully authorizes a callback caller:

| Variable | Type | Description |
|---|---|---|
| `ens_notification_uuid` | string (UUID) | The UUID of the ENS notification that the caller is authorized to replay. |
| `ens_recording_file` | string (path) | Absolute filesystem path to the ENS recording file. Passed to `session:streamFile()` for playback. |
| `ens_delivery_id` | string (integer) | The delivery record ID for logging the callback access event. |

Source: `GET /internal/ens/callbacks/authorize?reply_clid=<clid>&caller=<caller_id_number>`.

### Variables Set by `ens` Node (on successful blast trigger)

| Variable | Type | Description |
|---|---|---|
| `ens_notification_uuid` | string (UUID) | Set to the notification UUID returned by `POST /internal/ens/notifications` on success. |

### Variables Set by `ens_blast_record` Node (on successful blast)

| Variable | Type | Description |
|---|---|---|
| `ens_notification_uuid` | string (UUID) | Set to the notification UUID returned by `POST /internal/ens/notifications` on success. |

---

## ERS Workflow Variables

ERS workflow variables are set as side effects of `ers`, `ers_ring_all`, and related nodes.

| Variable | Type | Set By | Description |
|---|---|---|---|
| `ers_incident_uuid` | string (UUID) | `ers`, `ers_ring_all` | The ERS incident UUID created by the backend. |

---

## Recording Variables

| Variable | Type | Set By | Description |
|---|---|---|---|
| `recorded_file_path` | string (path) | `record_message` (default name) | Absolute filesystem path to the caller's recorded audio. Consumed by downstream `ens` node via `recording_file_var`. |

Any custom `variable_name` configured on a `record_message` node is also a recording variable — the default `recorded_file_path` applies only when `variable_name` is not explicitly set.

---

## Variable Interpolation Syntax

Any node field that supports variable interpolation uses `${variable_name}` syntax. Interpolation is performed at Lua runtime by the `interp(session, text)` helper function, which calls `session:getVariable(name)` for each `${name}` placeholder found.

### Syntax Rules

- Placeholder format: `${variable_name}` (curly braces required; no spaces inside).
- Variable name inside `${}` must be a valid FreeSWITCH channel variable name.
- If the variable is not set or is empty, the placeholder is replaced with an empty string.
- Interpolation is recursive only in the sense that if the resolved value contains `${...}` — it is NOT re-interpolated (single-pass only).

### Fields Supporting Interpolation

| Node | Field(s) |
|---|---|
| `say` | `text` |
| `gather` | `prompt_text` |
| `condition` | `expected_value` |
| `set_variable` | `value` |
| `hangup` | — (no interpolation fields) |
| `transfer` | `destination` |
| `record_message` | `prompt_text` |
| `webhook` | `url`, `body_template` |
| `ens_blast_record` | `pin_prompt_text`, `record_prompt_text` |
| `ers_overflow_wait` | `hold_prompt_text` |
| `ens_playback_gate` | `no_message_text` |

### Interpolation Examples

**`say` node — dynamic announcement:**
```
text: "Hello, you are calling from ${caller_id_number}. You have reached extension ${destination_number}."
```

**`set_variable` node — copy system variable:**
```
variable: dept_extension
value: ${destination_number}
```

**`transfer` node — dynamic destination:**
```
destination: ${dept_extension}
```

**`webhook` node — structured JSON body:**
```json
{"caller": "${caller_id_number}", "menu": "${menu_choice}", "dest": "${destination_number}"}
```

**`condition` node — compare against caller ID:**
```
variable: caller_id_number
operator: starts_with
expected_value: 1905
```

---

## Variable Precedence and Overwriting

Because all variables are global within the call session, later assignments overwrite earlier ones. Common pitfalls:

- Two `gather` nodes with the same `variable_name` — the second collect overwrites the first. Use distinct names.
- A `set_variable` node that overwrites `ens_configuration_id` before an `ens` node reads it. Be explicit about variable names.
- The `ens_playback_gate` node does not store the recording path in a session variable — it streams directly. If you need the path downstream, use a `record_message` node earlier in the flow instead.

---

## Complete Variable Index

| Variable | Source | Readable By |
|---|---|---|
| `destination_number` | FreeSWITCH (system) | All node types via `${destination_number}` |
| `caller_id_number` | FreeSWITCH (system) | All node types; used internally by `ens_callback_valid`, `ers`, `ers_ring_all`, `ens_blast_record`, `ens_playback_gate` |
| `caller_id_name` | FreeSWITCH (system) | All node types; used internally by `ers_ring_all`, `ers_overflow_wait` |
| `uuid` | FreeSWITCH (system) | Used internally by `record_message` for filename construction |
| `gather_result` | `gather` (default variable_name) | `condition`, `set_variable`, `say`, `webhook` |
| *(custom)* | `gather`, `set_variable` | Any downstream node |
| `ens_configuration_id` | `condition` (ens_pin_valid) | `ens` via `ens_config_var` field |
| `ens_blast_clid` | `condition` (ens_pin_valid) | Read-only (metadata) |
| `ens_notification_uuid` | `condition` (ens_callback_valid), `ens`, `ens_blast_record` | Webhook, say (for confirmation messages) |
| `ens_recording_file` | `condition` (ens_callback_valid) | Consumed internally by `ens_playback_gate` |
| `ens_delivery_id` | `condition` (ens_callback_valid) | Read-only (metadata) |
| `ers_incident_uuid` | `ers`, `ers_ring_all` | Webhook |
| `recorded_file_path` | `record_message` (default) | `ens` via `recording_file_var` |
| *(custom recording var)* | `record_message` | `ens` via `recording_file_var` |
