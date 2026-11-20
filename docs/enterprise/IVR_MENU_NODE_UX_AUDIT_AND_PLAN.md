# IVR Builder — Menu (Gather DTMF) node: audit and redesign plan

| | |
|---|---|
| Date | 2026-11-20 |
| Repository | FS-ENRS `main` at `bec05e2`. The tree is clean and identical to GitHub. |
| Scope | Checkpoint 1 (audit) and Checkpoint 2 (proposed layout and plan) |
| Changes made | **None.** No code was changed, nothing was deployed, and no database was touched. |
| Reference screenshots | The Zoom and current-builder screenshots did not come through with the request. This plan follows the written brief. |

---

## 1. Summary

**What the Menu node can do.** It is the most capable node in the builder:
- It has three ways of handling a caller who doesn't answer or presses the wrong key (section 3).
- It can play a separate announcement for each kind of failure.
- It can route up to seven different outcomes.

**Why it feels cluttered:**
- The side panel draws its fields automatically from a list kept in the backend. It sorts them into sections by guessing from each field's name.
- The result is one long page:
  - The menu prompt sits beside twelve retry-announcement fields.
  - The retry on/off switches are in a different section from the announcements they control.
  - The "wait for input" time is in a collapsed section.
  - Where the caller goes next is at the very bottom.
  - Almost every field carries a paragraph of help text.
- A new Menu node shows about 23 controls before any destination.

**The proposal:**
- A dedicated Menu panel, built in the frontend only, with compact sections that follow your brief: Prompt, Menu options, No response, Wrong key, When attempts run out, Caller input and Advanced.
- It uses the same stored fields, with the same names and the same values.
- Nothing changes in the call-handling engine (Lua), the XML, the dialplan, the backend validation or the published flows. Every other node type keeps today's panel.

**Problems found along the way.** There are nine existing problems (section 6). Three directly affect this work:
1. **Node names are not saved.** The name you type in the panel's title box is discarded by the backend on every save, so it disappears after reload. This affects every node type, not just Menu.
2. **Menu keys can't be chosen, and adding one can break another.** "+ Add digit branch" always names the new option by counting rows. You can't create 0, 9, `*`, `#` or multi-digit keys from the panel. After a deletion, adding an option can wipe the destination of an existing one.
3. **Older Menu nodes are shown as "Internal" retry when they actually use the classic 3-try behaviour.**

The redesign fixes 2 and 3 inside the panel. Fixing 1 needs a one-line backend change, which is your decision (section 10).

---

## 2. How the IVR Builder is put together

| Part | File | What it does |
|---|---|---|
| Builder page | `frontend/src/pages/ivr/IvrBuilder.jsx` | Toolbar, node library (left), canvas (centre), inspector (right). The inspector is 320 px by default, resizable from 240 to 600 px (remembered per browser), and collapsible. The page is fixed-height and only the panels scroll. |
| Node definitions | `backend/src/nodeTypes/registry.js` | Single list of node types: label, icon, ports, summary text, **form fields (`configSchema`)** and **the Lua code that runs the node (`luaHandler`)**. The frontend loads it from `GET /api/v1/ivr/node-types` (`hooks/useNodeTypes.js`). |
| Inspector | `frontend/src/components/ivr/panels/PropertyPanel.jsx` | Generic form. Each field in `configSchema` is drawn by its type (text, number, select, media picker, destination picker, branch editor). `showWhen` hides a field based on another field's value. |
| Section grouping | `frontend/src/components/ivr/panels/fieldSections.js` | Chooses a section heading from the field name (General, Content, Input, Retries, Timeouts, Outputs). Only Timeouts and Advanced start collapsed. |
| Inline errors | `frontend/src/components/ivr/panels/inspectorErrors.js` | Places validation messages next to the field they mention. Sections that contain an error open automatically. |
| Canvas card | `canvas/FlowNode.jsx`, `nodeSubtitle.js`, `nodeIdentity.js`, `nodeGeometry.js`, `ConnectionDot.jsx` | Card with title, type, status badge (errors/warnings), one-line summary, optional description and one output row per port. The geometry is shared with the canvas so wires stay attached. |
| Ports | `canvas/nodePorts.js` | `gatherBranchKeysFor()` decides which Menu outputs exist (mode-aware). The canvas and the panel both use it. |
| State and saving | `frontend/src/hooks/useIvrGraph.js`, `hooks/autosave.js` | Every edit updates the in-memory flow immediately and adds an undo step. The flow autosaves 0.8 s after the last change (`PUT /api/v1/ivr/flows/:uuid`). Empty Menu destinations are removed before saving. |
| Validation | `backend/src/validators/ivrValidator.js`, `backend/src/utils/ivrGraphValidator.js` | Field and cross-field rules, plus whole-flow checks (missing targets, unreachable nodes, "no catch-all" warnings). These run on **Validate** and **Publish**. Autosave only blocks structural problems. |
| Publish and deploy | `ivrController.js` → `deploymentEngine.js` → `utils/luaGenerator.js` | Publishing freezes a version. Deploy generates the Lua that runs the call (`exec_gather`). |
| Media library | `MediaPickerField` (in `PropertyPanel.jsx`) | Search, preview and select deployed media. Stores `/media/<file>` in the `*_audio_url` field. |
| Text-to-speech | `speak()` in the generated Lua | Uses the system voice (Piper, then FreeSWITCH TTS as fallback). **Menu nodes have no language or voice setting.** Only the Say node has them. |

---

## 3. How the Menu node behaves during a call

The Lua is in `registry.js:311-551`. Which of the three behaviours a node uses depends only on two stored fields:

| Mode (name used in this plan) | Stored data | Behaviour |
|---|---|---|
| **Classic** (older nodes) | no `retry_mode` and no `max_attempts` | Fixed retries:<ul><li>**Audio prompt:** FreeSWITCH replays the prompt up to 3 times.</li><li>**Text prompt:** no input ends at once. Too few digits plays a built-in English "Please enter at least N digits" and retries up to 3 times.</li></ul>Routes:<ul><li>no input → `timeout`, else `_default`;</li><li>key pressed → that key, else `_default`, else `invalid`.</li></ul> |
| **Retry in this node** (`internal`, the default for new nodes) | `retry_mode: "internal"`, or `max_attempts` set without `retry_mode` | Up to `max_attempts` tries. Each failure type (no input / too few digits / wrong key) has:<ul><li>its own retry on/off;</li><li>its own announcement (none / text / audio);</li><li>a "replay menu after the announcement" switch.</li></ul>A failure type with retry **off** leaves the node through its own output. When the tries run out:<ol><li>an optional announcement plays;</li><li>the call goes to `max_attempts_exceeded`, else `timeout`, else `_default`.</li></ol> |
| **One attempt, route failures** (`external`) | `retry_mode: "external"` | A single try. No input → `timeout`. Too few digits or wrong key → `invalid`. Valid → that key, else `_default` ("Continue"). |

Edge case: `retry_mode: "internal"` without `max_attempts` runs **1** attempt.

**Values used when a field is empty during a call** (the panel must display these, not invent new ones):

| Field | Classic | Retry in this node | One attempt |
|---|---|---|---|
| Wait for first key (`timeout_seconds`) | **10 s** | 5 s | 5 s |
| Digits min / max | 1 / 1 | 1 / 1 | 1 / 1 |
| Pause allowed between digits (`inter_digit_timeout`) | 2 s (audio prompt only; text prompt ignores it) | 2 s | 2 s |
| Terminator key | none | none | none |
| Prompt source | text-to-speech | none (but see note) | none (but see note) |
| Caller can interrupt the prompt (`allow_barge_in`) | not used (audio prompts can always be interrupted; text prompts always play in full) | yes | yes |
| Retry on no input / too few digits / wrong key | — | yes / yes / **no** | — |
| Replay menu after an announcement | — | yes | — |
| Pause before replaying (`reprompt_pause_ms`) | — | 700 ms | — |

Note: in practice a saved node always contains `prompt_source_type`, because the save path writes the validator's defaults into the stored flow (problem F2 in section 6).

---

## 4. Every Menu field (inventory)

Required means Validate/Publish fails without it. Autosave still accepts the draft.

| # | Field | Today in the panel | What it does at runtime | Applies in | Required / depends on |
|---|---|---|---|---|---|
| 1 | `nickname` | Title box in the panel header | Canvas title and name in destination lists. **Not saved by the backend** (F1). | UI only | — |
| 2 | `description` | Description box (top) | Canvas subtitle only | UI only | max 500 characters |
| 3 | `prompt_source_type` | Prompt Source (Content) | Which prompt plays first | all | text / audio / none |
| 4 | `prompt_text` | Prompt Text, single line | Text spoken. `${variables}` are filled in during the call. | all | shown when text; max 1000 |
| 5 | `prompt_audio_url` | Prompt Audio File (media picker) | File played | all | **required when source = audio** |
| 6 | `branches` — digit keys | Branches editor (Outputs) | Key pressed → destination | all | **at least one branch** in total |
| 7 | `branches._default` | "Continue" row | Any other valid input. Also a fallback for several failures. | all | recommended (catch-all) |
| 8 | `min_digits` | Input | Fewest digits accepted | all | 1–11, ≤ max |
| 9 | `max_digits` | Input | Collection stops at this many digits | all | 1–11 |
| 10 | `timeout_seconds` | Timeouts (collapsed) | Wait for the first key | all | 1–60 |
| 11 | `terminators` | Input | Key that ends entry early (`#`/`*`) | all | none / # / * |
| 12 | `inter_digit_timeout` | Input | Pause allowed between digits | all except Classic+text | 0–30 |
| 13 | `variable_name` | Input | Session variable that receives the digits (used by later Condition nodes) | all | protected names refused |
| 14 | `allow_barge_in` | General | First key stops the prompt | Retry, One attempt | yes / no |
| 15 | `retry_mode` | Retry handling | Selects the mode (section 3) | — | internal / external / empty = Classic |
| 16 | `max_attempts` | Retries | Total tries | Retry | 1–10. **Needed whenever any field 17–30 is present** (rule R1) |
| 17 | `reprompt_pause_ms` | Retries | Pause after an announcement, before the menu replays | Retry | 0–5000 |
| 18–21 | `retry_on_no_input`, `no_input_source_type`, `no_input_text`, `no_input_audio_url`, `no_input_replay_menu` | Split between Retries and Content | No-input retry and its announcement | Retry | **text required when source = text; file required when source = audio** |
| 22–25 | `retry_on_invalid_length`, `invalid_length_*` (same four) | Split | Too-few-digits retry and announcement | Retry | same rule |
| 26–29 | `retry_on_invalid_option`, `invalid_option_*` (same four) | Split | Wrong-key retry and announcement (**off by default**) | Retry | same rule |
| 30 | `max_attempts_exceeded_source_type` / `_text` / `_audio_url` | Content | Announcement when the tries run out | Retry | same rule |
| 31 | `branches.no_input` / `.invalid_length` / `.invalid_option` | Outputs (only when that retry is off) | Exit for that failure type | Retry | optional |
| 32 | `branches.max_attempts_exceeded` | Outputs | Exit when the tries run out | Retry | recommended |
| 33 | `branches.timeout` / `.invalid` | Outputs | No-input / invalid exits | Classic, One attempt (fallback in Retry) | optional |
| 34 | `config_version` | not shown | Marker `2` on nodes created by the current builder; not read during calls | — | keep untouched |
| 35 | `prompt_audio_file_id` | not shown | Older way of naming the prompt file. Publish checks it exists, but the Menu runtime does not read it. | — | keep untouched |
| 36 | `label` | not shown | Older node title, read only; discarded on save (F1) | — | keep untouched |

Values for the on/off fields are stored as `"yes"`/`"no"`. The backend also accepts `true`/`false`, so the panel must display both correctly.

---

## 5. Answers to the eight audit questions

1. **Every field.** See section 4. That is 36 stored properties: the digit keys plus 7 reserved outcome keys inside `branches`, 32 named fields and the UI-only name.
2. **Mandatory** (enforced at Validate/Publish):
   - at least one branch;
   - an audio file when the prompt source is audio;
   - text or a file for each failure announcement that is set to text or audio;
   - `max_attempts` whenever any retry-only field is present;
   - min digits ≤ max digits;
   - a variable name that isn't protected;
   - every destination must exist.
   The "no catch-all" check is a warning, not an error.
3. **Optional.** Everything else.
4. **Dependencies:**
   - prompt text/file ← prompt source;
   - every retry field ← Retry mode;
   - a failure's announcement and replay switch ← that failure's retry being on;
   - a failure's exit ← that failure's retry being off;
   - barge-in ← not Classic;
   - too-few-digits handling ← min digits > 1 (with min = 1 it can never happen);
   - the "attempts run out" announcement and exit ← Retry mode.
5. **Technical / advanced:** variable name, terminator key, pause between digits, re-prompt pause and the failure-handling mode.
6. **Affect calls:** all of them except name, description, `label`, `config_version` and `prompt_audio_file_id`.
7. **Safe to hide:**
   - retry announcements and replay behind their retry switch;
   - too-few-digits settings when min digits = 1;
   - each failure exit when its retry is on (matching the canvas);
   - the technical fields in a collapsed Advanced section.
   Hidden values stay stored and come back when shown again.
8. **Must stay unchanged:**
   - every field name and branch key (`_default`, `timeout`, `invalid`, `no_input`, `invalid_length`, `invalid_option`, `max_attempts_exceeded`);
   - the `"yes"`/`"no"` value format;
   - the "field absent" meaning, so the panel must **never write defaults** into a node just because it was opened;
   - Classic nodes must stay Classic unless an administrator explicitly upgrades them.

---

## 6. Existing problems found (not caused by this work)

| # | Severity | Problem | Evidence | In this redesign |
|---|---|---|---|---|
| F1 | High | **Node names are not saved.** The backend's per-node rules don't list `nickname`, so the save step drops it, and a renamed node shows its default title after reload. The older `label` is dropped too. Affects every node type. | `ivrValidator.js:342` (`BASE_NODE_FIELDS` has only `description`). Parsing a node with a name through the save schema returned it without the name. | Needs a one-line backend change: allow `nickname`. It has no effect on calls. **Your decision.** |
| F2 | High | **Every save writes the validator's defaults into the stored flow.** A Classic Menu node without a stored wait time gets `timeout_seconds: 5`, so its no-input wait changes from 10 s to 5 s at the next publish. | `ivrController.js:166-206` stores the parsed graph. Confirmed by a parse test. | Not changed here (backend save behaviour). The new panel shows the true stored value. Recommended as a separate fix. |
| F3 | Medium | **Opening a flow probably triggers an automatic save.** The canvas reports its zoom/position 0.4 s after loading, which marks the flow as changed, so F1 and F2 apply just from viewing a flow. | `FlowCanvas.jsx:199-221` with `useIvrGraph.js` `MOVE_VIEWPORT`. Code reading only; **to confirm** on a test flow. | Not changed here. **Testing will never open existing flows** (section 8). Recommended as a separate fix together with F2. |
| F4 | Medium | **"+ Add digit branch" can wipe a destination**, and keys can't be chosen. The new key is "number of rows + 1". After deleting option 1 of {1, 2}, adding creates "2" again and clears option 2's destination. 0, 9, `*`, `#` and multi-digit keys can't be created. | `PropertyPanel.jsx:553-556`. Reproduced with the repository's own port logic: `{"2":"support"}` became `{"2":""}`. | Fixed in the new panel: the key is chosen from a list and the next free key is suggested. **Your decision** (it adds the ability to choose keys). |
| F5 | Medium | **Classic nodes look like "Internal" retry.** The Retry handling list has no empty choice, so the browser shows the first option. Choosing "Internal" then does nothing, and switching leaves Max attempts empty (one attempt only). | `PropertyPanel.jsx:206-224`, `registry.js:221-227` | Fixed: the mode is shown as Classic, with an explicit "Use configurable retries (3 attempts)" action. |
| F6 | Low | The barge-in help says "configurable retry only", but it also applies in One-attempt mode. In Classic it is ignored. | `registry.js:240-243` vs `exec_gather` `collect()` | The panel shows it per mode. |
| F7 | Low | Prompt text is a single-line box without "Insert variable", although `${variables}` work. | `registry.js:214` (`fieldType: 'text'`) | Uses the existing multi-line box with the variable picker. |
| F8 | Low | Hidden trap R1: retry-only fields left on a node without `max_attempts` fail validation. | `ivrValidator.js:479-487` | The panel never removes `max_attempts` and never writes retry-only fields outside Retry mode. |
| F9 | Low | Canvas summary shows "Collect ? digit(s) · ?s" when values aren't stored. The node reference doc still describes the pre-2026 Menu node (for example "`#` terminator by default", "`invalid` = timeout"). | `registry.js:159`, `docs/10-ivr-node-reference.md:217-305` | New canvas summary. Doc update offered after implementation. |

**Environment note.** The laptop's `node_modules` are Linux builds, and `node_modules/.bin/vitest` is an empty file. Tests and the build therefore run inside Ubuntu-FS against the laptop copy (`node node_modules/vitest/vitest.mjs`). That only reads the files and changes nothing on the server.

**Baseline before any change** (laptop copy, run inside Ubuntu-FS, 2026-11-20):

| Suite | Result |
|---|---|
| Frontend | **24 of 24 files, 335 of 335 tests passed** |
| Backend unit (`src/__tests__/unit`, database and Redis pointed at a closed port) | 69 files: 60 passed, 9 with failures. **1,926 passed, 24 failed** of 1,950. |

- **All Menu-related backend tests pass:**
  - `gatherConfigurableRetry` 66, `gatherInterDigitTimeout` 4, `gatherCatchAllWarning` 10;
  - `ivrGraphValidator` 13, `ivrNodeAudit` 97, `luaGenerator` 36;
  - `nodeTypeRegistry` 9, `nodeCanvasLabels` 14, `nodeDescription` 6.
- **The 24 failures already exist** and are outside the Menu node:
  - XML/config parsers (`varsParser`, `gatewayFileProvider`, `sofiaProvider`, `switchConfParser`, `conferenceProvider`, `xmlGenerator`);
  - ERS caller-name presentation;
  - the event bus;
  - one test that loads `scripts/ivr-compat-report.js` (`SyntaxError` on load).
- Their cause is not investigated here; the laptop checkout uses Windows line endings, which may be a factor. The requirement for this work is that **the same list is unchanged afterwards**.

Integration tests (`src/__tests__/integration`) were **not** run, because they write to a real database.

---

## 7. Proposed Menu panel (Checkpoint 2)

### 7.1 Layout (default width 320 px; everything fits in 320–360 px)

```
┌───────────────────────────────────────────┐
│ ⌨ GATHER DTMF                           ✕ │  header (unchanged)
│   Main menu                               │  name → canvas title
│   + Add description                       │  compact; opens a 2-line box
├───────────────────────────────────────────┤
│ ▾ PROMPT                                  │
│   [ Speak text │ Audio file │ None ]      │  segmented control
│   ┌─────────────────────────────────────┐ │
│   │ For billing press 1, support 2 …    │ │  multi-line + {x} Insert variable
│   └─────────────────────────────────────┘ │
│ ▾ MENU OPTIONS                       3  ⓘ │
│   [1 ▾] → [Billing queue           ▾]  🗑 │
│   [2 ▾] → [Support queue           ▾]  🗑 │
│   [0 ▾] → [Operator                ▾]  🗑 │
│   + Add option                            │
│   Any other key → [Continue …      ▾]     │  _default
│ ▾ NO RESPONSE                    5 s · ↻ ⓘ │
│   Wait for first key          [ 5 ] s     │
│   Retry                         ●━━  On   │
│     Announcement [None│Text│Audio]        │
│     Replay menu afterwards      ●━━  On   │
│ ▾ WRONG KEY                     route  ⓘ  │
│   Retry                         ━━○  Off  │
│   Send caller to → [Invalid choice  ▾]    │  invalid_option
│ ▾ WHEN ATTEMPTS RUN OUT          3 tries  │
│   Attempts in total           [ 3 ]       │
│   Announcement [None│Text│Audio]          │
│   Send caller to → [Operator        ▾] *  │  max_attempts_exceeded
│ ▸ CALLER INPUT          interrupt · 1 key │  collapsed, summary on the right
│ ▸ ADVANCED                                │  collapsed
├───────────────────────────────────────────┤
│ ☆ Set as entry node        🗑 Delete node │  footer (unchanged)
└───────────────────────────────────────────┘
```

- Section headers show a short summary on the right (for example "5 s · ↻", "3 tries"), so a collapsed section still says what it does.
- Help text moves into ⓘ tooltips. Only warnings and errors are written inline.
- The panel keeps its own scroll; the canvas stays visible and the page doesn't scroll.
- Toggles are used only for genuine on/off features: retry per failure type, replay menu, barge-in. Prompt and announcement sources stay three-way choices.
- Escape hatch: a small "Show all fields" link at the bottom of Advanced opens today's complete generic list for this node. No capability is ever unreachable, and it helps verification.

### 7.2 What appears in each mode

| Section | Retry in this node | One attempt, route failures | Classic |
|---|---|---|---|
| Prompt, Menu options | ✓ | ✓ | ✓ |
| No response | wait time; retry switch; announcement and replay (retry on) or "Send caller to" `no_input` (retry off) | wait time; "Send caller to" `timeout` | wait time (shows 10 s if empty); "Send caller to" `timeout` |
| Wrong key | same pattern with `invalid_option`. A "Too few digits" sub-block (`invalid_length`) appears when min digits > 1 or it already has values | "Send caller to" `invalid` (covers wrong key and too few digits) | "Send caller to" `invalid` |
| When attempts run out | attempts, announcement, `max_attempts_exceeded` | hidden (single attempt) | "Classic: 3 fixed tries" + **Use configurable retries** button |
| Caller input | barge-in switch; digits min–max | same | barge-in shown off-limits with a note; digits |
| Advanced | variable name, terminator, pause between digits, re-prompt pause, failure-handling mode | same (no re-prompt pause) | same; mode shown as Classic |

Destinations already wired that the mode doesn't use (for example an old `timeout` wire on a Retry node) are listed under "Other connections". The panel shows exactly the outputs the canvas shows, because both use `gatherBranchKeysFor()`.

### 7.3 Existing field → new control

| Existing field | New control | Section | Shown when |
|---|---|---|---|
| `nickname` | Title box (unchanged) | Header | always |
| `description` | "+ Add description", then a 2-line box | Header area | always |
| `prompt_source_type` | Segmented: Speak text / Audio file / None | Prompt | always |
| `prompt_text` | Multi-line box + Insert variable | Prompt | Speak text |
| `prompt_audio_url` | Media library picker (unchanged component) | Prompt | Audio file |
| `branches` (digit keys) | Key list + destination + remove; Add option | Menu options | always |
| `branches._default` | "Any other key" destination | Menu options | always |
| `timeout_seconds` | Number, seconds (shows the mode's runtime value as a hint when empty) | No response | always |
| `retry_on_no_input` | Toggle | No response | Retry mode |
| `no_input_source_type` / `_text` / `_audio_url` | Segmented + box/picker | No response | Retry mode, retry on |
| `no_input_replay_menu` | Toggle | No response | Retry mode, retry on |
| `branches.no_input` / `branches.timeout` | "Send caller to" | No response | per 7.2 |
| `retry_on_invalid_option`, `invalid_option_*`, `branches.invalid_option` | Toggle, segmented, toggle, destination | Wrong key | Retry mode |
| `retry_on_invalid_length`, `invalid_length_*`, `branches.invalid_length` | Same pattern | Wrong key → Too few digits | Retry mode, and min > 1 or already set |
| `branches.invalid` | "Send caller to" | Wrong key | Classic, One attempt (or wired) |
| `max_attempts` | Number "Attempts in total" | When attempts run out | Retry mode |
| `max_attempts_exceeded_*` | Segmented + box/picker | When attempts run out | Retry mode |
| `branches.max_attempts_exceeded` | "Send caller to" (marked recommended) | When attempts run out | Retry mode (or wired) |
| `allow_barge_in` | Toggle "Caller can interrupt the prompt" | Caller input | Retry, One attempt |
| `min_digits`, `max_digits` | Two numbers on one row | Caller input | always |
| `retry_mode` | Select "Failure handling" (Classic shown read-only) | Advanced | always |
| `reprompt_pause_ms` | Number, ms | Advanced | Retry mode |
| `terminators` | Select | Advanced | always |
| `inter_digit_timeout` | Number, seconds | Advanced | always |
| `variable_name` | Text | Advanced | always |
| `config_version`, `prompt_audio_file_id`, `label` | not shown, never written | — | — |

### 7.4 How the brief's interaction rules are met

1. **Speak text** shows the text box and variable picker. There is no language/voice control because Menu doesn't support one, and adding it would be new runtime behaviour.
2. **Audio file** shows the existing media library picker (search, preview).
3. **Turning a feature off** changes only its own switch. The settings under it are hidden, not deleted.
4. **Turning it back on** shows the same stored values again.
5. **Renaming the node** updates the canvas title immediately. Keeping it after reload needs the F1 fix.
6. **Editing menu options keeps connections.** Changing a key moves its destination to the new key. Remove deletes only that key. Add never reuses a taken key. Duplicate, reserved or invalid keys are refused with a message.
7. **Collapsing or expanding sections** never touches values, which live in the flow, not the panel.
8. **Switching nodes** keeps edits, which are already in the flow and autosaved, the same as today.
9. **Validation errors appear beside the field.** Messages that the backend doesn't tie to a field ("prompt_source_type=audio requires prompt_audio_url", "min_digits … must not exceed max_digits", the R1 message) are matched to their field, and sections with errors open automatically.
10. **Required fields** get a red ✱: menu options, prompt file when audio, announcement text/file when selected, attempts in Retry mode. The attempts-run-out destination is marked "recommended".

**No writes on open.** The panel computes what to display from the stored node and writes only when the administrator changes something. Values are written in the existing formats (`"yes"`/`"no"`).

### 7.5 Canvas card (Checkpoint 4)

- Header, status badge, output rows, wire positions, drag, select, zoom, pan and connect stay exactly as they are. The geometry is untouched.
- Summary line 1 (Menu only) shows:
  - the prompt type: Speak / Audio `file.wav` / No prompt;
  - the number of menu options;
  - the attempts, for example "Speak · 3 options · 3 tries".
  - Missing essentials show as a short warning instead, for example "No options yet".
- Line 2 stays the description.
- Destination names in lists keep today's naming rule, so pickers don't change.
- Limitation: a menu with many options still grows by one row per output, as today. Shrinking rows would mean changing the shared wire geometry. That's outside this task unless you want it.

---

## 8. Implementation plan (component level)

**Files**

| File | Change |
|---|---|
| `frontend/src/components/ivr/panels/menu/MenuInspector.jsx` | **New.** The Menu panel body (sections in 7.1–7.3). |
| `frontend/src/components/ivr/panels/menu/menuModel.js` | **New, pure logic, no React:**<ul><li>mode detection;</li><li>runtime values per mode;</li><li>visibility rules;</li><li>the change each control writes;</li><li>key helpers (next free key, rename, checks);</li><li>error-to-field matching;</li><li>section summaries.</li></ul> |
| `frontend/src/components/ivr/panels/inspectorControls.jsx` | **New.** Small shared pieces in the existing style: Switch (accessible `role="switch"`), Segmented, InfoTip, SectionHeader with summary. |
| `frontend/src/components/ivr/panels/inspectorFields.jsx` | **New, code moved unchanged** from `PropertyPanel.jsx`: text/number inputs, destination picker, media picker, text box with variable picker. Both panels use them. |
| `frontend/src/components/ivr/panels/PropertyPanel.jsx` | Uses `MenuInspector` for `type === 'gather'`. Every other node type renders exactly as today. `BranchRow` stays here (existing regression test). |
| `frontend/src/components/ivr/canvas/nodeSubtitle.js` (+ `FlowNode.jsx` only if needed) | Menu summary line (7.5). |
| `frontend/src/__tests__/menuModel.test.js`, `menuCanvasSummary.test.js` | **New regression tests** (below). |
| `docs/09-ivr-designer-user-manual.md`, `docs/10-ivr-node-reference.md` | Optional: describe the new panel and correct the outdated Menu reference. |

**Not touched:**
- `registry.js` (fields and Lua);
- `ivrValidator.js` (except the optional F1 line);
- `ivrGraphValidator.js`;
- the Lua/XML generators;
- the dialplan;
- other node types;
- the database and migrations;
- the published versions.

**New tests** (pure functions, matching how this repository tests the builder; there are no browser-based tests in the repo):
1. Mode detection for Classic, Retry, One attempt and Retry-without-attempts.
2. Runtime values per mode match the table in section 3.
3. Visibility per mode and per switch, including too-few-digits hidden when min = 1.
4. Each control writes exactly one field, never deletes others, and never writes retry-only fields outside Retry mode (R1).
5. Key helpers:
   - next free key;
   - rename keeps the destination;
   - remove touches one key;
   - duplicates, reserved names and bad characters are refused;
   - the F4 regression case.
6. **Panel/canvas agreement.** For a matrix of node shapes, the outputs shown in the panel equal `gatherBranchKeysFor()`.
7. **Field coverage.** Every Gather field in the backend `registry.js` is placed in the new panel or its "Show all fields" view, so a field added later can't silently disappear.
8. **No writes on open.** Building the view from a frozen node never modifies it, including real template nodes from `ivrTemplates.js` and Classic nodes.
9. Error-to-field matching.
10. Canvas summary strings.

**Verification** (Checkpoint 5):
- **Automated:**
  - all frontend tests;
  - backend unit tests;
  - `verify:lua`;
  - a production build into a temporary folder.
  These run in Ubuntu-FS against the laptop copy (reads only).
- **In the browser:**
  - The laptop copy is served by a temporary dev server inside Ubuntu-FS on port **8101**, separate from the lab's 8100. It talks to the lab backend, and you sign in yourself in the browser pane.
  - All work happens in **dedicated test flows named "ZZ UX TEST …"**, which are deleted afterwards.
  - Existing flows are **not opened**, because of F3.
  - Older-flow compatibility is checked two ways:
    - test flows created from the built-in templates, which contain Classic Menu nodes;
    - a **read-only** scan of all Menu nodes in the lab database through the new display logic, which reports any shape it can't show.
  - Your 16 scenarios are run, with screenshots in light and dark mode.
- **Published compatibility:**
  - publish a test flow;
  - compare its generated Lua with the same flow built before the change (expected: identical);
  - check the Lua syntax.
- **After your approval:** commit on the laptop, push to GitHub, `git pull --ff-only` on Ubuntu-FS, and repeat the browser checks there.

---

## 9. Risks and how they are contained

| Risk | Containment |
|---|---|
| A field becomes unreachable | Coverage test (7) and the "Show all fields" view |
| Opening a node changes it | The panel never writes on render; test (8) |
| Panel and canvas show different outputs | Both use `gatherBranchKeysFor()`; test (6) |
| Validation trap R1 | The panel never removes `max_attempts` and never writes retry-only fields outside Retry mode; test (4) |
| Classic nodes change behaviour | Shown as Classic; upgrading is an explicit button |
| Other node types affected | Only `type === 'gather'` uses the new panel; the generic panel code is moved, not changed |
| Lab data | Only "ZZ UX TEST" flows are written; existing flows are never opened; the database scan is read-only |

---

## 10. Decisions needed before Checkpoint 3

1. **Approve this layout and plan** (sections 7–8).
2. **F1, node names.** Add `nickname` to the saved fields (one line in `ivrValidator.js`). This lets names survive reload for all node types and has no effect on calls. *Recommended.*
3. **F4, menu keys.** Let administrators choose each option's key (0–9, `*`, `#`, multi-digit) instead of automatic numbering. *Recommended.*
4. **Lab testing.** Create and delete "ZZ UX TEST" flows on Ubuntu-FS's database, with you signing in in the browser pane. *Recommended.*
5. **Reference screenshots.** If you want closer visual alignment with Zoom, please attach them. Otherwise the brief's principles are followed.

F2/F3 (defaults written on save, save on open) are recommended as a separate fix after this work, because they change backend save behaviour.

---

## 11. Revision 2 — Zoom-style layout (approved 2026-11-20)

After Checkpoint 3 the owner compared the panel with the Zoom Contact Center *Collect Input* widget and approved a reorganisation. Everything below is presentation only: no runtime, Lua/XML, dialplan, field or schema change.

### 11.1 What changed from section 7

| Area | Section 7 design | Revision 2 |
|---|---|---|
| Layout | Seven sections in one scroll; destinations spread over four of them | Two tabs: **Settings** (Collect, Prompt, Digits, Input options, Retry messages, Advanced) and **Exits** (Menu options or Entry complete, If something goes wrong, Fallback connections) |
| Collect type | *Digits per entry* (moved to the top of Menu options after owner feedback) plus "Any complete entry" | **Collect: Menu / Digits (PIN, account)**, derived from stored fields: Digits = no option keys and `max_digits` > 1. Switching writes `min_digits`/`max_digits` only (and, to Digits, removes option keys after a confirmation) |
| Retries | *Attempts in total* | **Retries** (= `max_attempts` − 1, 0–9) with the total shown beside it; retry switches grouped in Input options |
| Exit names | Panel: "Any other key", sections; canvas: registry labels "Continue", "Max attempts", "Invalid option" | One vocabulary in the panel, on the canvas card and on wires: `1 · <destination>`, No input, Wrong key / Wrong entry, Too few digits, Retries used up, Any other key / Entry complete; "(fallback)" / "(unused)" for connections the mode doesn't use directly |
| Catch-all (`_default`) | Always drawn on the canvas | Always drawn when collecting digits (it is the success exit); in a key menu drawn only once connected, offered in the Exits tab as **+ Any other key** |
| Canvas card | Summary line (prompt · options · tries) above right-aligned port labels | Prompt preview line (summary on hover) above Zoom-style bordered exit rows; geometry unchanged |
| Node names | Header showed the internal id | Id hidden behind a copy button (all node types); new nodes get default names (*Menu 1*, *Say 2*); duplicates get the next number or *(copy)*; destination lists keep the config summary beside a default name |

### 11.2 Not copied from Zoom

Voice input, per-prompt language/voice, a prompt from a variable, multiple sequential prompts, a "Send audio failed" exit and a TTS Play preview need runtime or backend support the Menu node does not have. Orthogonal connectors would change every node type. All are possible follow-ups.

### 11.3 Existing behaviour noted during testing

A new Menu node cannot be saved until at least one exit is connected (backend: "gather node requires at least one branch"). The builder previously showed only "Save failed"; the Exits tab now says why.
