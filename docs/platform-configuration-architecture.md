# Platform Configuration Architecture

Reference document for the FreeSWITCH configuration engine in `backend/platform/configuration/`.

---

## Overview

The configuration engine provides a generic, parser-agnostic framework for reading, editing, previewing, and deploying FreeSWITCH configuration files from a React UI. Adding support for a new configuration file requires three new files and two lines in a registry — no frontend changes.

---

## Folder Structure

```
backend/platform/configuration/
├── parsers/
│   └── VarsParser.js          # vars.xml parser (first implementation)
├── providers/
│   ├── ConfigurationProvider.js   # abstract base class
│   ├── VarsProvider.js            # vars.xml provider
│   └── index.js                   # provider registry (add new providers here)
├── metadata/
│   ├── metadataSchema.js          # canonical typedefs + applyMetaDefaults()
│   └── catalogs/
│       └── varsCatalog.js         # known-variable catalog for vars.xml
├── managers/
│   ├── ConfigurationManager.js    # read/apply/serialize orchestration
│   └── DeploymentManager.js       # 13-step deploy pipeline
├── strategies/
│   └── DeploymentStrategy.js      # RELOAD_XML, SOFIA_RESCAN, etc.
└── utils/
    └── freeSwitchPathService.js   # FS filesystem paths from env vars
```

---

## Layer Responsibilities

```
Frontend (React)
  ↓ HTTP (GET /read, POST /apply, POST /deploy)
ConfigurationRouter (Express routes)
  ↓
ConfigurationManager          — orchestrates read/apply/diff/serialize
  ↓ parse() / serialize() / applyChanges()
ConfigurationProvider         — abstract: translate between API and parser
  ↓
Parser (VarsParser, ...)      — pure text → segments → text
  ↓ catalog lookup
Catalog (varsCatalog, ...)    — metadata enrichment per key
  ↓
metadataSchema.applyMetaDefaults()  — normalize partial catalog entries
```

---

## Parser Layer

### Segment model

Every parser produces a flat array of **segments** — the serialization primitive:

```js
// Entry segment (one X-PRE-PROCESS directive)
{ type: 'entry', key, value, enabled, indent, original, modified, disabledForm? }

// Non-entry segment (XML declaration, whitespace, comments, close tag)
{ type: 'other', content }
```

- `original` — verbatim source text. Used by the serializer for lossless round-trip of unmodified entries.
- `modified` — set to `true` by `applyChanges` when the entry is touched. Once `modified`, the serializer regenerates the line instead of using `original`.
- `disabledForm` — parser-internal enum: `'xml-comment'` | `'multi-line'` | `'z-tag'` | `'xx-tag'`. **Never exposed to the frontend.** The provider translates it to `disabledHint` (a display string) at the API boundary.

### VarsParser exports

| Function | Purpose |
|---|---|
| `parse(rawContent)` | Text → `{ segments, checksum }` |
| `serialize(segments)` | Segments → text (lossless for unmodified entries) |
| `applyChanges(segments, index, changes)` | Apply change array, returns new segments |
| `buildIndex(segments)` | `Map<key → segIdx>`, prefers enabled definitions |
| `buildGroupMap(segments)` | `Map<key → segIdx[]>`, all definitions per key |
| `groupByKey(segments)` | View transform: segments → `[{key, primary, alternatives}]` |
| `toEntries(segments)` | Flat array of entry segments only |

`groupByKey` is a **view transform** — it reads segments but is never the serialization source. Only `serialize(segments)` writes files.

### Disable conventions

VarsParser recognizes all four FreeSWITCH disable conventions and preserves them losslessly:

| Convention | Syntax | `disabledForm` |
|---|---|---|
| XML comment (canonical) | `<!--<X-PRE-PROCESS .../>-->` | `'xml-comment'` |
| Multi-line block | `<!--\n  <X-PRE-PROCESS .../>\n  -->` | `'multi-line'` |
| Z-tag | `<!--<Z-PRE-PROCESS .../>-->` | `'z-tag'` |
| XX-tag | `<XX-PRE-PROCESS .../>` | `'xx-tag'` |

When an entry is modified (`modified: true`), the serializer regenerates it using the appropriate convention for its current `disabledForm`. An entry that was Z-tag and gets re-disabled after being enabled regenerates as canonical XML comment (since it was enabled, `disabledForm` was cleared).

---

## Grouped Definition Model

A single configuration key can appear multiple times in a file (e.g. two `sound_prefix` entries, one enabled and one disabled as an alternative). The engine surfaces this as one UI card with a primary definition and alternatives.

### `groupByKey(segments)` → `Group[]`

```js
Group = {
  key:          string,
  primary:      DefinitionView,   // enabled def, or first if all disabled
  alternatives: DefinitionView[], // all other defs of the same key
}

DefinitionView = {
  key, value, enabled, indent, original, modified, disabledForm?,
  definitionId: number,  // 0-based occurrence index within this key's defs, in file order
}
```

`definitionId` is a stable identifier — `0` for first occurrence, `1` for second, etc. The raw segment array index is never exposed. The backend maps `(key, definitionId)` → segment index via `siblings[definitionId]` inside `applyChanges`.

### `buildIndex` prefer-enabled rule

When the same key appears multiple times, `buildIndex` prefers the **enabled** definition over disabled ones. This prevents `applyChanges` from targeting the wrong segment when a no-argument `enable` op is sent.

---

## Provider Layer

`ConfigurationProvider` (abstract base class) defines the contract:

```js
class ConfigurationProvider {
  parse(rawContent)                    // → { segments, index, entries, checksum }
  serialize(segments)                  // → string
  applyChanges(segments, index, changes) // → segments
  validate(segments)                   // → { warnings, errors }
  diff(before, after)                  // → { summary, details }
  beforeDeploy(context)               // hook
  afterDeploy(context)                // hook
}
```

The provider is the **only** place where parser-internal fields are translated to API-safe equivalents:

- `disabledForm` → `disabledHint` (display string, via `toDisabledHint()`)
- Raw segment index → never exposed; `definitionId` is the stable external identifier

### `VarsProvider.parse()` output shape (per entry)

```js
{
  key:          string,
  value:        string | null,
  enabled:      boolean,
  definitionId: number,         // 0-based occurrence index of the primary definition
  ...catalogMetadata,           // spread from varsCatalog via lookupVar()
  alternatives: [{
    value:        string,
    enabled:      false,        // always false for alternatives
    definitionId: number,
    disabledHint: string,       // 'XML comment' | 'Z-tag convention' | 'XX-tag convention'
  }],
}
```

---

## Change Operations (Universal Contract)

All providers accept the same change operations. The frontend sends these; providers apply them via `applyChanges`.

```js
{ op: 'set',    key, value, enabled? }  // update primary definition (add if absent)
{ op: 'enable', key, definitionId? }   // enable a definition; absent = primary
{ op: 'disable', key }                 // disable all definitions for key
{ op: 'delete',  key }                 // remove all definitions for key
```

**`enable` + `definitionId`**: activates the definition at occurrence index `definitionId` and disables all others. Used when the user clicks "Use this" on an alternative in the UI.

**Last-write-wins**: if the changes array contains two operations for the same key, only the last one is applied. The Zustand `configChangesStore` enforces this at the frontend level too.

---

## Deployment Pipeline

`DeploymentManager` executes a 13-step pipeline. It has no parser knowledge — it calls the provider's abstract methods.

```
1.  read()           — read raw file from disk
2.  drift check      — compare SHA-256 to stored checksum; 409 if changed
3.  parse()          — segments from raw content
4.  applyChanges()   — apply pending changes to segments
5.  validate()       — warnings/errors (e.g. weak default_password)
6.  serialize()      — segments → text
7.  diff()           — human-readable change summary
8.  beforeDeploy()   — provider hook (e.g. create backup)
9.  backup           — atomic copy of current file
10. write            — atomic write of new content
11. strategy         — RELOAD_XML / SOFIA_RESCAN / RELOAD_MODULE / RESTART_MODULE
12. DB snapshot      — store versioned snapshot in PostgreSQL
13. afterDeploy()    — provider hook (e.g. emit Socket.IO event)
```

On any step failure, the manager attempts rollback from backup before returning the error.

### Deployment strategies

| Strategy | When to use |
|---|---|
| `RELOAD_XML` | vars.xml, most XML config files |
| `SOFIA_RESCAN` | SIP profile changes |
| `RELOAD_MODULE` | Module-specific config |
| `RESTART_MODULE` | Changes that require module restart |

---

## Checksum / Drift Detection

The `checksum` (SHA-256 of raw file content) is returned in the `GET /read` response and echoed back by the frontend in deploy/preview requests. The DeploymentManager rejects with HTTP 409 if the current file checksum differs from the submitted one — preventing overwrite of concurrent edits.

---

## Frontend Integration

The frontend never knows which parser was used. It only sees:

- `GET /api/v1/platform/config/:providerId` → `ConfigurationSnapshot`
- `POST /api/v1/platform/config/:providerId/preview` → diff preview
- `POST /api/v1/platform/config/:providerId/deploy` → deploy result

### State management

- `configChangesStore` (Zustand): `Map<providerId → Map<key, change>>`. Pending changes keyed by `change.key`. Last-write-wins per key.
- `useConfigProvider`: loads entries from the read API, exposes `entries`, `loading`, `error`, `checksum`.
- `useDeployment`: orchestrates preview → confirm → deploy flow, tracks `isDrift`.

### `ConfigPage` → `ConfigSection` → `ConfigCard`

`ConfigPage` is a generic template. Any provider page is:

```jsx
<ConfigPage providerId="vars" title="System Variables" subtitle="vars.xml" />
```

No provider-specific frontend code is needed.

---

## Adding a New Provider

To add support for a new FreeSWITCH config file (e.g. `switch.conf.xml`):

1. **Parser** — `parsers/SwitchParser.js`
   - Export `parse(rawContent)`, `serialize(segments)`, `applyChanges(segments, index, changes)`, `buildIndex(segments)`, `buildGroupMap(segments)`
   - Produce the same segment shape (`{type, key, value, enabled, indent, original, modified}`)

2. **Catalog** — `metadata/catalogs/switchCatalog.js`
   - Export `lookupVar(key)` returning a partial `ConfigurationEntry` (passed through `applyMetaDefaults`)

3. **Provider** — `providers/SwitchProvider.js`
   - Extend `ConfigurationProvider`
   - Implement `parse()`, `serialize()`, `applyChanges()`, `validate()`, `diff()`
   - Translate any parser-internal fields to API-safe equivalents in `parse()`

4. **Register** — `providers/index.js`
   ```js
   import SwitchProvider from './SwitchProvider.js';
   registry.register('switch', new SwitchProvider());
   ```

No frontend changes required.

---

## Metadata Schema

`metadataSchema.js` defines the canonical typedefs and `applyMetaDefaults(raw)`:

- Every catalog entry passes through `applyMetaDefaults` before reaching the UI.
- All fields are guaranteed present after normalization — UI components never null-check metadata fields.
- Backward-compat aliases resolved: `entry.min/max/options/required` → `validation.*`; `entry.advanced = true` → `visibility: 'advanced'`.

Key typedef: `ConfigurationObject` (per-entry API shape) and `AlternativeDefinition` (alternatives array element).

---

## Coding Conventions

- **Serializer operates on segments only.** Never serialize from a grouped view.
- **`definitionId` is the stable external identifier.** Never pass raw segment indices across the API or provider boundary.
- **`disabledHint` is the only disable-convention surface.** Frontend never branches on parser-internal `disabledForm` values.
- **`req.user.tenantId` for all tenant-scoped inserts** — never trust the request body for tenant ID.
- **`buildIndex` result is consumed, not mutated.** Callers do not reuse the index after `applyChanges` (segments may have changed length due to inserts).
- **All `applyChanges` implementations must clone segments** — never mutate the parsed state.
