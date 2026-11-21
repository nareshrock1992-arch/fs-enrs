# Gather DTMF redesign — summary

Branch `feat/dtmf-node-redesign` (pushed; not merged, not deployed). Design: `DTMF_NODE_DESIGN.md`; audit: `DTMF_NODE_AUDIT.md`; decisions D1–D16: `DECISIONS.md`.

## What changed

**Runtime (`backend/src/nodeTypes/registry.js`, `exec_gather`)**
- **Digits-mode routes:** checked top to bottom before the existing `br[d] / _default` lookup, in all three paths (classic, one attempt, retry in node).
  - Rule types: equals, one of, range, starts with, length, and pattern (a safe regex subset translated to a Lua pattern; no new dependency).
  - A route whose exit is not connected is skipped.
  - With no `routes`, the old code path runs unchanged.
- **Separate exits:** `failure_exits: "separate"` (opt-in) routes by the *last* failure reason once retries are used up:
  - No input → `no_input`;
  - Invalid → `invalid_option` / `invalid_length`;
  - otherwise the existing chain (`max_attempts_exceeded → timeout → _default`).

**Validation (`ivrValidator.js`, `ivrGraphValidator.js`, new `utils/gatherRoutes.js`)**
- **Saved with drafts:** `routes`, `failure_exits`, `option_labels`.
- **Draft saves:** "requires at least one branch" now runs on Validate/Publish only, so a new Menu node saves as a draft.
- **Errors on publish:** empty value, bad range, length outside 1–20, a pattern that doesn't compile or isn't supported, duplicate route id.
- **Warnings:** prompt missing, route unreachable or overlapping, route not connected.

**Frontend**
- **Panel** (one column):
  - **Mode:** Press a key / Enter digits.
  - **Prompt:** Audio file / Text-to-speech / None.
  - **Options** (key, label, destination) or **Digits** (length, end key, variable) with a **Routes** editor (rule, value, name, destination, reorder) and **Any valid entry**.
  - **When something goes wrong:** Failed, plus No input and Invalid when separate.
  - **Summary line** ("3 tries · 5 s timeout · barge-in on · # ends entry") with **Customize**.
  - **Advanced:** retries, first-digit and inter-digit timeouts, No-input / Invalid / Failed prompts, re-prompt pause, barge-in, separate exits, modified dots, Reset to defaults, older settings with one-click upgrades.
- **Exit names** (identical in both modes, on the panel, the card and the wires): `1 · Sales`, route name, Any valid entry / Any other key, No input, Invalid, Failed.
- **Canvas card:**
  - **Header:** mode badge (Menu / Digits).
  - **Body:** prompt line (~40 characters) and a chip row ("4 digits · # · 3 tries").
  - **Exits:** success exits first; failure exits muted (dashed, italic) and last.
  - **Below 60 % zoom:** name, badge and "n exits" only. Port positions don't change.
- **Validation icon:** combines the server result with client checks, so "No prompt text" is never a green tick.
- **Toolbar:** "Save failed: <reason>", with the node named, instead of a bare "Save failed".
- **Layout:** segmented controls wrap and labels never ellipsize.

## Fields removed from the UI or merged
| Field | Change | Why |
|---|---|---|
| `retry_mode` (Failure handling select) | Removed. Older one-attempt nodes show "One attempt (older setting)" + **Retry in this node** | Retry in the node is the only behaviour offered (D9) |
| `retry_on_no_input` / `_invalid_option` / `_invalid_length` | Merged into **Separate exits** + the Retries count. Older immediate-exit nodes show **Retry first** | One failure model (D6, D7) |
| `invalid_length_*` prompt | Merged into the **Invalid prompt** (one control writes both) | Same concept for the caller (D10) |
| `max_digits` in Menu mode | Automatic (raised to the longest key); still in Advanced | Menus never ask for a digit count (D11) |

Nothing was deleted from storage. **Show all fields** still edits every stored field.

## How migration works
There is **no migration** and no DB change:
- **Branch keys:** stored keys are unchanged. Only display names changed (D2).
- **Older nodes:** normalised on load, in the view model only:
  - old exit names map to the new ones;
  - the separate-exits toggle shows **on** when an older node has connected No input / Invalid exits or reasons that exit at once, so no edge disappears.
- **Proof:** the golden test runs the pre-change executor (stored fixture) beside the new one on the lab flows (HELP_DESK_2222, New_TTS_IVR), ZZ UX TEST and every built-in template, with 17 caller behaviours per Menu node. Every session call and variable is identical.

## Tests
| Suite | Result |
|---|---|
| Backend `goldenEquivalence` (Lua, Fengari) | 10/10 |
| Backend `dtmfRoutes.harness` (routes, every rule type, separate exits, all paths) | 25/25 |
| Backend `gatherRoutes` (rules, translation, warnings, validator draft vs publish) | 23/23 |
| Backend unit + Lua, all | 2105 passed, 24 failed. The 24 are the same failures as on `main` in 9 unrelated files (config parsers, ERS caller name, event bus, ivrCycle3 compat script, xmlGenerator) |
| Frontend, all (incl. `dtmfRedesign`, route parity) | 431/431 |
| Frontend lint (`--quiet`) | 0 errors |
| Frontend build | passes; only the existing chunk-size notice |

## Left undone or needing a decision
1. **Live save and publish with routes:** the lab backend runs `main`, which drops the new fields, so routes can't be saved there until the branch backend runs. The `fs-enrs-dev` folder shares port 4100 and the `fs_enrs` database with the lab, so it was not used. Decide whether to test the branch on the lab (check it out and restart) or on a separate dev database.
2. **Screenshots:** done in the browser pane at 1280×800, in `docs/ivr/screenshots/`:
   - `01-digits-basic-and-card-100.jpg`: Digits panel and canvas at 100 %;
   - `02-digits-routes-editor.jpg`;
   - `03-advanced-open.jpg`;
   - `04-canvas-51-percent-compact.jpg`.

   An automated check found no ellipsized label in the panel (Basic or Advanced). There is no Playwright in the repo.

   **Found while testing:** a Menu option that repeats its own menu ("0 = repeat") showed "Choose destination…". This is fixed.

   **Lab check:** saving routes against the lab backend (`main`) confirmed that it drops `routes` but keeps the `route_*` connections. The panel then shows them as "Removed route", so nothing disappears silently.
3. **Backend warning texts:** these still name nodes by internal id (`Node "node_…"`); the panel strips the prefix, but the toolbar banner shows it.
4. **Other node types:** fields in the shared generic panel still use the undefined `bg-surface` class (white in dark mode).
5. **Lint warnings:** the "no new warnings" check is only approximate. ESLint reports components used only in JSX as unused (the config has no `react/jsx-uses-vars`), so new components add warnings of that existing false-positive kind.
