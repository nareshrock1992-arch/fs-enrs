# Extending Node Types

Every IVR node type — what it's called, what fields it has, what Lua it
generates, which API endpoint it calls — is defined in exactly one place:
[`backend/src/nodeTypes/registry.js`](../backend/src/nodeTypes/registry.js).
Before Phase 3, adding a node type meant editing three separate files by
hand (the generated Lua string in `luaGenerator.js`, the Zod schema in
`ivrValidator.js`, and a hand-built React form in `PropertyPanel.jsx`) —
missing one was a silent bug, not an error. This doc walks through adding
a real node type end to end, using the exact "webhook" type already
shipped in the registry as a worked example — not a hypothetical.

## What a webhook node does

POSTs an arbitrary JSON body to a configurable URL, fire-and-forget, then
continues to the next node. Useful for notifying an external system
(a paging service, a Slack webhook, a customer's own alerting) without
building a first-class integration for it.

## The steps

### 1. Add one entry to the registry

Every field is documented in `registry.js`'s header comment. The webhook
entry:

```js
{
  type: 'webhook',
  label: 'Webhook',
  icon: '🪝',
  bg: '#1e1e3b', border: '#4a4a8a', color: '#c7c7fa',
  category: 'Integrations',
  description: 'POST JSON to an external URL',
  ports: 'next',
  configSchema: [
    { key: 'url', label: 'Webhook URL', fieldType: 'mono_text', required: true, placeholder: 'https://example.com/hooks/emergency' },
    { key: 'body_template', label: 'Body (JSON, supports ${var})', fieldType: 'textarea', placeholder: '{"caller": "${caller_id_number}"}' },
    { key: 'next', label: 'Next Node', fieldType: 'node_ref', required: true, hint: '...' },
  ],
  luaHandler: `
local function exec_webhook(s, node)
  local url = interp(s, node.url) or ""
  if url == "" then
    freeswitch.consoleLog("ERR", "[ivr_executor] webhook node: empty url — skipping\\n")
    return node.next
  end
  local body = interp(s, node.body_template) or "{}"
  local safe_body = body:gsub("'", "'\\\\''")
  local cmd = string.format(
    "curl -s -m %d -X POST -H 'Content-Type: application/json' -d '%s' '%s' 2>/dev/null",
    HTTP_TIMEOUT, safe_body, url)
  local h = io.popen(cmd)
  if h then h:close() end
  return node.next
end`,
  apiEndpoint: null, // this calls an arbitrary external URL, not our own internal API
},
```

Notes on writing a `luaHandler`:
- It's a JS template literal, not the array-of-strings format the rest of
  `luaGenerator.js`'s shared infra uses — **the escaping rules are
  different**. A template literal only treats `\\`, `` \` ``, and `${...}`
  specially; everything else (including a single `\n`) is literal. To get
  a literal `\n` in the *output* Lua (so Lua itself interprets it as a
  newline at runtime), write `\\n` in the template literal. To get two
  literal backslashes in the output (needed for the standard shell
  single-quote-escaping idiom `'\\''`), write `\\\\` in the template
  literal. Get this wrong and you get a shell-escaping bug that only
  shows up when a caller's or operator's data happens to contain a quote
  — exactly the kind of thing `npm run verify:lua` (Phase 2's syntax
  gate) exists to catch before it reaches a real call.
- `HTTP_TIMEOUT`, `interp()`, and every other shared helper (`get`,
  `post`, `resolve_audio`, `speak`, `url_encode`) are already in scope —
  they're declared once in the generated file's shared preamble, and
  every handler function (yours included) closes over them.
- If your node type calls this app's own internal API (like `ers` or
  `ens` do), set `apiEndpoint: { method, path }` — Phase 3's boot-time
  self-check (`backend/src/nodeTypes/selfCheck.js`) will warn loudly if
  that path is ever not actually registered. Webhook calls an arbitrary
  external URL, not our API, so it's `apiEndpoint: null`.

### 2. Add a Zod schema (the registry is not yet the source of truth for validation)

In `backend/src/validators/ivrValidator.js`:

```js
const WebhookNodeSchema = z.object({
  type:          z.literal('webhook'),
  url:           z.string().min(1).max(2048),
  body_template: z.string().max(4000).optional(),
  next:          nodeId,
});
```

...and add it to the `AnyNodeSchema` discriminated union list. This is
the one step that genuinely can't be skipped — a saved graph containing
a node type Zod doesn't recognize fails validation on save/publish with a
clear error, by design (this is what actually blocks the "field exists
in state but the backend silently ignores it" bug class, not something
to route around).

### 3. That's it — the pattern is generic

**Nothing else changes.** Specifically, none of these needed a single
line touched:
- `luaGenerator.js` — its dispatch-table loop and handler-concatenation
  loop iterate the registry array; a 12th entry produces a 12th handler
  and dispatch line automatically.
- `NodePalette.jsx` — fetches `GET /api/v1/ivr/node-types`, groups by
  `category`, renders a button per entry. Webhook appeared under a new
  "Integrations" category the first time this file's `CATEGORY_ORDER`
  list was consulted (unlisted categories just sort last — no edit
  needed there either, though you may want to add "Integrations" to that
  list if you want a specific position).
- `PropertyPanel.jsx` — renders the property form from `configSchema`
  generically (`GenericField` dispatches on `fieldType`, not on
  `node.type`). All three of webhook's fields (`mono_text`, `textarea`,
  `node_ref`) already exist as field types other node types use.
- `FlowNode.jsx` — reads `icon`/`bg`/`border`/`color` from the fetched
  registry data for the canvas card, and picks a port-drawing strategy
  from the small fixed set (`ports: 'next'` — the same strategy `play`/
  `say`/`record_message`/`set_variable` use).

This is proven by `backend/src/__tests__/unit/nodeTypeRegistry.test.js`
— it asserts the generated Lua contains exactly one handler + dispatch
entry per registry entry (a count, not a hardcoded list), so a 13th node
type added the same way is covered by the same test with zero edits to
it either.

## When you'd need a new port strategy

The `ports` field picks from a **closed set** FlowNode.jsx already knows
how to draw (`next`, `next_optional`, `true_false`, `branches`,
`goto_target`, `none` — see `registry.js`'s header comment for exactly
what each means). This is deliberate: canvas connection-dragging is
stateful UI code that can't be verified without a real browser, so new
node types are asked to fit an existing, already-working shape rather
than inventing a new one casually. If your node type's connection shape
is genuinely novel (not "one next node," not "true/false," not "one port
per dynamic key," not "no ports at all"), that's the one case where
`FlowNode.jsx` needs a new `case` added to its port-strategy dispatcher —
budget real testing time for that change specifically, on a real
FreeSWITCH box with a real browser, since it's the one part of this
system that can't be proven correct by a script.

## Known gap: default field values on first drop

When a node is first dragged onto the canvas, `frontend/src/hooks/
useIvrGraph.js`'s `NODE_DEFAULTS` table supplies sensible starting values
for the 11 pre-existing types (e.g. gather pre-populates `_default`/
`timeout`/`invalid` branch keys; condition defaults its operator to
`==`). This table is **not yet** sourced from the registry — a new type
like webhook gets no pre-filled defaults, just empty fields, on first
drop. This is a UX rough edge, not a correctness bug: `PropertyPanel.jsx`
renders every field from `configSchema` regardless, so nothing is hidden
or unreachable, it just starts blank instead of pre-filled. Wiring
`NODE_DEFAULTS` to read from the registry's data (adding a `defaults`
field per entry, threaded through `NodePalette` → `IvrBuilder.jsx` →
`addNode()`) is a reasonable follow-up, deliberately deferred here to
keep this refactor's risk surface to pieces that could be reasoned about
without a live browser to verify against.

## Checklist for a new node type

1. Add one entry to `backend/src/nodeTypes/registry.js` (`luaHandler`,
   `configSchema`, `ports`, visual fields, `apiEndpoint` if it calls this
   app's own internal API).
2. Add a matching Zod schema to `ivrValidator.js`'s `AnyNodeSchema` union.
3. Run `npm run verify:lua` (Phase 2) — confirms your `luaHandler` is
   syntactically valid Lua 5.2 before it ever reaches FreeSWITCH.
4. Run `node scripts/verify-api-contracts.js` if your node type calls an
   internal API endpoint — confirms the path, method, and every field
   name you send match the real route and schema.
5. Restart the backend — `checkNodeTypeApiEndpoints()` runs at boot and
   warns if `apiEndpoint` doesn't match a real registered route.
6. Add it to a flow in the IVR Builder UI and place one real test call —
   the canvas/property-panel pieces are covered by the tests above, but a
   real call through FreeSWITCH is the only thing that proves the Lua
   actually does what you intended at runtime.
