# Gather DTMF redesign — decisions

Each entry: the choice, why, and the reference product behaviour where one applies (Genesys Cloud *Collect Input* / *Menu*, Amazon Connect *Get customer input* / *Store customer input*, Webex Contact Center *Menu* / *Collect Digits*).

### D1. Where the work happens
- **Choice:** code is written in the laptop repo on branch `feat/dtmf-node-redesign` and pushed as a branch only. Nothing is committed or edited under `/opt/freeswitch-ui/`.
- **Why the brief's dev-instance instruction isn't followed literally:**
  - The owner's standing workflow is laptop → GitHub → Ubuntu-FS pull, and never commit on Ubuntu-FS.
  - `/opt/freeswitch-ui/fs-enrs-dev` is a stale `main` checkout (`95b7e7d`) with local `.env` edits.
  - Its `.env` uses **port 4100 and database `fs_enrs`**, the same as the running instance. Starting it would collide with the live backend and write to the lab database, which the brief forbids.
- **Not done:**
  - **Dev database:** creating a separate one (`fs_enrs_dev`) needs database credentials and privileges, which the session was not allowed to use.
  - **Live save/publish:** the "save and publish on the dev instance" check is therefore replaced by validator and API-schema tests plus a Lua harness. A live dev run is listed in the summary as an owner decision.

### D2. Old port IDs — keep the stored keys, rename only what is displayed
- **Choice:** the stored branch keys stay exactly as they are (`max_attempts_exceeded`, `invalid_option`, `invalid_length`, `no_input`, `timeout`, `invalid`, `_default`, digit keys). Only display names change: **Failed**, **Invalid**, **No input**, **Any valid entry** / **Any other key**.
- **Why:**
  - No DB rows change, so there is no migration and no down step.
  - The Lua keeps reading the same keys.
  - Published versions stay valid.
- **Alternative rejected:** a migration rewriting keys would touch every flow and every published version.

### D3. Routes for Digits mode
- **Storage:** `routes: [{ id, type, value, value2?, name? }]` on the gather node.
- **Exit key:** each route's exit is `route_<id>` (ids are short `[a-z0-9]`), which stays within the 24-character key limit.
- **Evaluation:**
  - The Lua checks routes top to bottom before the existing `br[d] / _default` lookup.
  - Nodes without `routes` take exactly the old code path.
  - A matching route whose exit is not connected is skipped, and evaluation continues. This mirrors how Amazon Connect ignores unconnected conditions.

### D4. Pattern rules
- **Choice:** a safe subset of regular expressions, translated to a Lua pattern by a small translator in the executor (mirrored in JS for validation):
  - anchors `^` and `$`;
  - `\d` (and `\*`, `\#`);
  - character classes like `[2-4]`;
  - single-item quantifiers `? * +`;
  - counted repeats `{n}`, `{n,m}`, `{n,}`.
- **Rejected:** groups and alternation (`( ) |`) are a validation error, because Lua patterns have no equivalent.
- **Why:** this adds no runtime dependency and behaves the same on LuaJIT (FreeSWITCH) and Lua 5.3 (the test VM).

### D5. Range rule
- **Choice:** the entry must be all digits, and is compared as a number to `value`–`value2` inclusive.
- **Leading zeros:** these are ignored numerically (`0500` is in `100–999`).
- **Why:** Genesys and Webex compare numerically; a *Length* rule can enforce the digit count.

### D6. Standard exits
- **Default exits:** options or routes, plus **Failed** (`max_attempts_exceeded`).
- **Separate exits:** the advanced toggle "Separate exits for No input and Invalid" adds **No input** and **Invalid**.
- **New field:** `failure_exits: "separate"` makes the Lua route by the *last* failure reason once retries are used up. This is the Amazon Connect pattern (Timeout / No match / Error after retries).
- **Existing flows:** nodes without the field run exactly as before.

### D7. Legacy nodes and the toggle
- **Shown ON automatically:** an existing node shows the toggle **ON** when either:
  - a no-input / invalid exit is connected;
  - a failure reason is set to exit at once (old per-reason retry switches off). For example, every node built before this change has `retry_on_invalid_option` unset, which means "exit at once".
- **Why:** no edge disappears and nothing about the call changes.
- **Older setting note:** such nodes show "Invalid leaves the node without retrying (older setting)" with a **Retry first** button.

### D8. New-node defaults
- **Choice:** new Menu nodes store `retry_on_invalid_option: "yes"` in addition to the existing defaults.
- **Effect:** every failure is retried inside the node and then leaves through **Failed**, matching Genesys and Webex menus.
- **Scope:** existing nodes are not touched.

### D9. "Failure handling" select removed
- **Choice:** retry inside the node is the only behaviour offered.
- **External nodes:** existing `retry_mode: "external"` nodes keep working and show "One attempt (older setting)" with a **Retry in this node** button.
- **Why:** Genesys, Connect and Webex all retry inside the node.

### D10. Too-few-digits prompt merged into the Invalid prompt
- **Choice:** the Invalid prompt control writes both `invalid_option_*` and `invalid_length_*`.
- **Divergent older nodes:** where the two differ, the panel says so and "Show all fields" still edits them separately.

### D11. Mode names and Menu digit count
- **Labels:** "Press a key" (Menu) and "Enter digits" (Digits).
- **Menu digit count:** in Menu mode `max_digits` is managed automatically. It is raised when a longer key is added and never lowered below the longest key.
- **Why:** Genesys/Webex menus never ask for a digit count.

### D12. Option labels
- **Choice:** new cosmetic field `option_labels: { "1": "Sales" }`. It is shown on the canvas exit ("1 · Sales") and is never read by the runtime.
- **Without a label:** the exit shows the destination name, as today.

### D13. Save failed
- **Draft saves:** the "gather node requires at least one branch" rule moves from the per-type draft schema to `nodeRules`, which runs on Validate and Publish only. Drafts of a brand-new Menu then save.
- **Toolbar:**
  - `describeSaveFailure` now reads the API's `issues` and names the node.
  - The toolbar shows the reason next to "Save failed".

### D14. Main prompt missing
- **Warning, not error:** a TTS main prompt with empty text, or an audio prompt with no file, is a **warning** (amber).
- **Why:** classic flows may legitimately have an empty prompt (the Lua skips it), and an error would block republishing existing flows.
- **Card icon:** the canvas validation icon combines server validation with this client-side lint.

### D15. Zoomed-out canvas card
- **Choice:** below 60 % zoom the card hides the prompt and chip lines and the port labels, and shows the exit count in the header.
- **Why port positions stay:** port rows keep their positions so wires do not move between zoom levels. Collapsing the ports would require new anchor geometry for every node type.

### D16. Golden flows
- **Choice:** golden inputs are the built-in templates, the two lab flows (HELP_DESK_2222 and New_TTS_IVR, exported read-only through the app API, with URLs and headers replaced by placeholders), and a reconstruction of the "ZZ UX TEST" flow. ZZ UX TEST itself was deleted at the end of the previous task.
- **Equivalence:** proved by running the **baseline** executor (generated from `main`, stored as a fixture) and the **new** executor in the Fengari harness on the same inputs, and comparing every session call.
