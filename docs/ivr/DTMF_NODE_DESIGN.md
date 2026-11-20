# Gather DTMF node — design (Phase 2)

An incremental change to the existing node: the same node type and edges, the same stored keys, and the same generator pipeline. Decisions are numbered as in `DECISIONS.md`.

## A. One node, two modes
| Mode (stored as) | Label | Exits |
|---|---|---|
| Menu (option keys, or `max_digits` 1) | **Press a key** | one per option (`1 · Sales`), optional **Any other key** (`_default`) |
| Digits (no option keys, `max_digits` > 1) | **Enter digits** | one per route, **Any valid entry** (`_default`, always last) |

The mode is derived from stored fields, as before; no new mode field is added. Switching to Digits removes the option keys after a confirmation. Switching to Menu sets the digit count to 1 (D11).

## B. Routes (Digits mode)
- **Storage:** `routes: [{ id, type, value, value2?, name? }]`. Exit key `route_<id>`, label = `name`, or a generated label (D3).

| Type | Fields | Matches when | Generated label |
|---|---|---|---|
| `equals` | value `1234` | entry = value | `= 1234` |
| `one_of` | value `1001, 1002` | entry is in the list | `1001, 1002` (shortened) |
| `range` | value `1000`, value2 `1999` | all digits and lo ≤ number ≤ hi (D5) | `1000–1999` |
| `starts_with` | value `9` | entry starts with value | `9…` |
| `length` | value `6` | entry has exactly n characters | `6 digits` |
| `pattern` | value `^[2-4]\d{3}$` | safe-subset regex matches (D4) | `Pattern` |

- **Order:** first match wins, then **Any valid entry**.
- **No match:**
  - with **Any valid entry** connected, the call goes there;
  - otherwise the entry is **invalid** and the normal retry → Failed / Invalid handling applies.
- **Variable:** the entry is still saved to the variable before routing.

**Validation:**

| Severity | Rule |
|---|---|
| Error | empty value |
| Error | non-numeric bounds, or lo > hi |
| Error | length outside 1–20 |
| Error | a pattern that doesn't compile or uses unsupported syntax |
| Error | more than 20 routes |
| Error | a route with no destination (on publish) |
| Warning | a route that can never match because an earlier route catches everything it would (unreachable) |
| Warning | partially overlapping ranges |
| Warning | an equals / one-of value that an earlier route already matches |

**Lua:** a helper `route_target(node, br, d)` is evaluated wherever the old code computed `br[d] or br["_default"]`, in all three paths. With no `routes` it returns `nil`, so the old expression decides exactly as before.

## C. Standard exits
| Display name | Stored key(s) | Present when |
|---|---|---|
| option `1 · Sales` / route name | digit key / `route_<id>` | always |
| Any other key (Menu) / Any valid entry (Digits) | `_default` | Digits always; Menu when connected (offered by "+ Any other key") |
| **Failed** | `max_attempts_exceeded` | retry-in-node nodes |
| **No input** | `no_input` (v2) or `timeout` (classic/external) | separate exits on |
| **Invalid** | `invalid_option` (+ `invalid_length` if wired) or `invalid` (classic/external) | separate exits on |

- **Separate exits** (D6/D7): `failure_exits: "separate"`. The Lua keeps a `last_reason`; when the attempts run out it routes by that reason before the existing exhaustion chain:
  - `no_input` → `no_input`;
  - otherwise the matching reason key, then `invalid_option`.
- **Port order:** success exits first, failure exits last and muted (No input, Invalid, Failed).

## D. Settings panel (single column, labels above inputs)
**Basic**
1. **Mode:** Press a key / Enter digits.
2. **Prompt:** Audio file / Text-to-speech / None (full labels; segmented options wrap instead of truncating).
3. **Mode-specific:**
   - **Menu:** options list (key, label, destination), "Add option", optional "Any other key".
   - **Digits:** digits min–max, end key, save as variable, **Routes** list, Any valid entry destination.
4. **Exits when something goes wrong:** Failed destination, plus No input / Invalid destinations when separate exits are on.
5. **Summary line:** "3 tries · 5 s timeout · barge-in on · # ends entry" with **Customize**.

**Advanced** (collapsed; opened by Customize)
- **Fields:** Retries, first-digit timeout, inter-digit timeout, invalid prompt (D10), no-input prompt, failed prompt, re-prompt pause, barge-in, separate exits, and the variable name in Menu mode.
- **Modified dot:** a field that differs from the default shows a dot. **Reset to defaults** writes the defaults back.
- **Older settings:** shown only when present (classic 3 tries, one attempt, per-reason immediate exit), each with a one-click upgrade.
- **Show all fields:** stays at the bottom.

**Layout rules**
- One spacing scale.
- Help text in (i) tooltips.
- Number inputs show the unit next to the value.
- No `truncate` on labels or segmented options.

## E. Compatibility
- **No DB change.** Display-only renames (D2).
- **Normalising on load** is done in the view model only, without writing:
  - toggle state (D7);
  - display names;
  - Menu or Digits mode.
- **Lua for an unchanged flow:** identical behaviour. Proved by the golden test (D16).
- **New fields** (`routes`, `failure_exits`, `option_labels`) are added to the Zod gather schema so draft saves keep them.

## F. Canvas card
- **Normal zoom:**
  - **Header:** icon, name and a mode badge (Menu / Digits).
  - **Prompt line:** the file name, or the first ~40 characters of the TTS text.
  - **Chip row:** "4 digits · # · 3 tries".
  - **Exits:** the exit rows, with failure exits muted at the bottom.
- **Below 60 % zoom:**
  - **Header:** name and icon, plus "n exits".
  - **Hidden:** the prompt line, the chips and the port labels.
  - **Unchanged:** the port positions, so wires don't move (D15).
- **Status icon:** server validation plus client lint:
  - **Red:** no options in Menu mode, an invalid route.
  - **Amber:** missing prompt, an unconnected route or option, no Failed destination.
