# Gather DTMF node — audit (Phase 1)

Branch `feat/dtmf-node-redesign`, based on `main` at `d2c30ca` (the Zoom-style panel already shipped). No code was changed for this audit.

## 1. Files involved

| Concern | File |
|---|---|
| Node type definition, field schema (`configSchema`), port labels, **runtime Lua** (`exec_gather`) | `backend/src/nodeTypes/registry.js` |
| Executor script generation (embeds every `luaHandler`) | `backend/src/utils/luaGenerator.js` |
| Save / publish validation (Zod per-type schemas, `nodeRules`, draft vs publish graph schemas) | `backend/src/validators/ivrValidator.js` |
| Graph-level checks and lint warnings (catch-all warning, reachability) | `backend/src/utils/ivrGraphValidator.js` |
| Save / publish / lookup API | `backend/src/controllers/ivrController.js`, `backend/src/routes/v1/ivr.js` |
| Storage | `ivr_flows.graph` (JSONB draft) and `ivr_flow_versions.graph` (published, immutable) |
| Dialplan XML (routes numbers to the executor; does not read node fields) | `backend/src/utils/xmlGenerator.js` |
| New-node defaults, serialise/deserialise, autosave | `frontend/src/hooks/useIvrGraph.js`, `frontend/src/hooks/autosave.js` |
| Settings panel | `frontend/src/components/ivr/panels/menu/MenuInspector.jsx`, `menuModel.js`, `../inspectorControls.jsx`, `../PropertyPanel.jsx` |
| Canvas card and ports | `frontend/src/components/ivr/canvas/FlowNode.jsx`, `ConnectionDot.jsx`, `nodePorts.js`, `nodeSubtitle.js`, `nodeGeometry.js`, `FlowCanvas.jsx` |
| Toolbar save state | `frontend/src/components/ivr/toolbar/BuilderToolbar.jsx` |
| Existing tests | `frontend/src/__tests__/menuModel.test.js`, `nodeLabels.test.js`, `nodeIdentity.test.js`; `backend/src/__tests__/lua/executorHarness.js` (Fengari) |

## 2. Runtime paths in `exec_gather`

The Lua has three paths, chosen from stored fields only:

| Path | Selected when | Behaviour |
|---|---|---|
| **Classic** | no `max_attempts` and no `retry_mode` | 3 native tries; audio via `playAndGetDigits`, TTS via speak + `getDigits` (no barge-in); timeout default 10 s; routes `br[d] → _default → invalid`, no input `timeout → _default` |
| **External** | `retry_mode = "external"` | one attempt; no input → `timeout`; too short or unmatched → `invalid`; valid → `br[d]` or `_default` |
| **Internal** | `retry_mode = "internal"`, or `max_attempts` set | loop up to `max_attempts`; per-reason retry switches; reason-specific messages; exhaustion → `max_attempts_exceeded → timeout → _default` |

## 3. Field inventory

"Used" means the generated Lua reads it in at least one path. Tier is the proposal for the new panel.

| Field key | UI label (current) | Default | What the Lua does with it | Used at runtime | Proposed tier |
|---|---|---|---|---|---|
| `prompt_source_type` | Prompt: Text to speech / Audio file / None | `tts` (classic), `none` (internal/external) | selects the prompt player | yes | **Basic** |
| `prompt_text` | Prompt text | `''` | spoken via Piper (variables interpolated) | yes | **Basic** |
| `prompt_audio_url` | Audio file | — | resolved and played | yes | **Basic** |
| `prompt_audio_file_id` | (hidden, written by media picker) | — | not read (Lua uses the URL) | no — media-lock bookkeeping only | keep, hidden |
| `branches` | Exits tab | `{}` | routing table | yes | **Basic** (options/routes) |
| `min_digits` | Digits: Number of digits (from) | 1 | classic: retry when short; internal/external: `invalid_length` | yes | **Basic** (Digits mode) |
| `max_digits` | Number of digits (to) / Digits per entry | 1 | collection length | yes | **Basic** (Digits); Menu derives it from the longest key |
| `terminators` | End key | `''` | ends collection early | yes | **Basic** (Digits) |
| `variable_name` | Save digits as | `gather_result` | channel variable set with the entry | yes | **Basic** (Digits); Advanced in Menu |
| `timeout_seconds` | Wait for input | 10 classic / 5 other | first-digit timeout | yes | **Advanced** (shown in summary line) |
| `inter_digit_timeout` | Pause allowed between digits | 2 | between-digit timeout (classic TTS path ignores it) | yes (not classic TTS) | **Advanced** |
| `max_attempts` | Retries (shown as attempts − 1) | 3 | loop count (internal) | yes (internal only) | **Advanced** (in summary line) |
| `retry_mode` | Advanced › Failure handling | absent / `internal` for new nodes | selects internal vs external path | yes | **Remove** from UI (retry-in-node is the only offered behaviour; external nodes keep working, shown as an older setting) |
| `allow_barge_in` | Keys interrupt the prompt | on | `playAndGetDigits` vs play-then-collect | yes (not classic) | **Advanced** (in summary line) |
| `reprompt_pause_ms` | Pause before replaying the prompt | 700 | silence before a retry | yes (internal only) | **Advanced** |
| `retry_on_no_input` | Retry on no input | on | retry or exit `no_input` at once | yes | **Merge** into "Separate exits" (see design) |
| `retry_on_invalid_option` | Retry on wrong key | **off** | retry or exit `invalid_option` at once | yes | **Merge** into "Separate exits"; new nodes default **on** |
| `retry_on_invalid_length` | Retry on too few digits | on | retry or exit `invalid_length` at once | yes | **Merge** into "Separate exits" |
| `no_input_source_type` / `_text` / `_audio_url` | Retry messages › No input | none | message before a no-input retry | yes | **Advanced** ("No-input prompt") |
| `no_input_replay_menu` | Replay the prompt afterwards | on | replay main prompt after the message | yes | **Advanced** (part of No-input prompt) |
| `invalid_option_*` (4 fields) | Retry messages › Wrong key | none / replay on | message before a wrong-key retry | yes | **Advanced** ("Invalid prompt") |
| `invalid_length_*` (4 fields) | Retry messages › Too few digits | none / replay on | message before a too-short retry | yes | **Merge** into "Invalid prompt" (one control writes both slots) |
| `max_attempts_exceeded_source_type` / `_text` / `_audio_url` | Retry messages › When retries run out | none | message before the Failed exit | yes | **Advanced** ("Failed prompt") |
| `config_version` | — | 2 on new nodes | not read (marker only) | no | keep, hidden |
| `nickname`, `description` | Header name / description | — | not read | no (cosmetic) | Basic (header) |

### Shown in the UI but ignored at runtime
- **Classic nodes:** `allow_barge_in`, `reprompt_pause_ms`, every retry switch and message, and `inter_digit_timeout` on the TTS path. The current panel already hides most of these for classic nodes.
- **External nodes:** `max_attempts`, the retry switches, the messages and `reprompt_pause_ms`.
- **`max_digits` in Menu mode** is a technical detail: it only needs to be at least the longest option key.

### Runtime behaviour with no UI field
- **Classic:** fixed 3 tries; on the TTS path, a hard-coded spoken reminder "Please enter at least N digits".
- **`_default` precedence:** when "Any other key" is connected, unmatched entries go there before any wrong-key handling.
- **Retry-start flush:** `flushDigits()` runs at the start of each retry.
- **Exhaustion fallback:** `max_attempts_exceeded → timeout → _default`. A reason with retry off falls back `reason → _default → timeout → invalid`.
- **No routing by entered value:** apart from exact key matches there is none, so multi-digit entries need a Condition node.

## 4. Problems found

### "Save failed" with no explanation
1. Draft save (`PUT /ivr/flows/:uuid`) validates every node against the per-type Zod schemas (`AnyNodeSchemaDraft`):
   - **Gather:** has `branches.refine(≥1)`, so a brand-new Menu node fails with *"gather node requires at least one branch"* until an exit is connected.
   - **Say:** a new node fails with an empty `next` or `text`.
2. The API answers `400 {error:"Validation failed", issues:[…]}`. `autosave.describeSaveFailure()` reads only `data.errors[0]` or `data.message`, so the detail is lost. The toolbar shows "Save failed" with only a hover tooltip, and the node is not flagged.

### "No prompt text" but a green tick
The canvas status icon (`FlowNode`) reflects only `graph.nodeErrors` / `nodeWarnings`, which are filled by the server **Validate** call. A node never validated, or changed since, shows the green tick whatever its state.

Separately, `nodeRules` requires text only when a *retry message* source is TTS. It does not check the **main** prompt, so a TTS prompt with empty text passes validation (the call is silent).

### Exit naming
The same concept has different names: canvas "Wrong entry" / "Wrong key", "Retries used up", "Entry complete", "Any other key"/"Any other entry". The legacy keys `timeout` / `invalid` and the v2 keys `no_input` / `invalid_option` / `invalid_length` describe the same outcomes.

### Panel layout
Segmented controls and inline labels truncate at the default panel width, for example "Digits (PIN, ac…", "Text to …" and "Pause allowe…". The causes are `truncate` on `Segmented` options and fixed `InlineRow` label widths, with every option on one line.

### Digits mode routing
Digits mode has only `_default` (Entry complete). Branching on the entered value needs an extra Condition node.
