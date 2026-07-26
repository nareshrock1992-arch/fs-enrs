# ARCHITECTURE.md

This file is the authoritative design specification for the Enterprise FreeSWITCH Management Platform.

**Treat it as frozen.** Any proposal that conflicts with a decision documented here must be
explained and explicitly approved before it can be implemented. Claude Code must check this
file before suggesting architectural changes, and must not apply conflicting changes without
human approval.

---

## Platform Identity

This is **not** a generic FreeSWITCH web GUI. It is an enterprise administration platform
for FreeSWITCH, philosophically equivalent to Avaya Aura System Manager, Avaya Communication
Manager, and Cisco Unified CM Administration.

---

## Core Pipeline (Frozen)

Every configuration file — flat or hierarchical — flows through exactly this pipeline.
No layer may be bypassed, replaced, or redesigned.

```
XML File on Disk
      │
      ▼
Parser              — pure: XML string → internal object model
      │
      ▼
Catalog             — metadata: display names, validation rules, help text
      │
      ▼
Provider            — orchestrates parse / serialize / validate / diff / applyChanges
      │
      ▼
Provider Registry   — ID → provider instance map; populated at bootstrap
      │
      ▼
Configuration Manager — top-level API: read, preview, deploy, rollback, history, audit
      │
      ▼
Driver              — platform abstraction: path resolution, ESL commands
      │
      ▼
Deployment Strategy — what happens after the file is written (reloadxml, sofia rescan …)
      │
      ▼
React Config Center — UI: reads metadata, emits change ops, never contains business logic
```

---

## Non-Negotiable Invariants

### XML is the Single Source of Truth
- Never introduce a configuration database for FreeSWITCH config.
- Never duplicate configuration in application tables.
- Always read from XML. Always write back to XML.
- The UI represents XML state; it does not own it.

### One XML File = One Provider
- Every FreeSWITCH XML file has exactly one Provider.
- No file may be managed by more than one provider.
- No provider may manage more than one file.

### Dynamic Discovery
Never hardcode XML filenames, context names, paths, or directories anywhere in the
application. Every discovery path goes through the FreeSwitchPathService or
FreeSwitchDriver. New files discovered on disk must be automatically registered;
they must never require a code change.

### Environment Independence
Never assume `/etc/freeswitch`, `/usr/local/freeswitch`, Docker paths, or any
specific installation layout. All paths are resolved exclusively through
`FreeSwitchPathService` and exposed to the platform via `FreeSwitchDriver`.

### Generic Framework
The Config Center framework is generic. Dialplan is not a special case. Any
framework addition (renderer, store, hook, base class, service) must be usable
by Directory, IVR, Call Center, Recording, Time Conditions, Lua, and future
modules without modification.

---

## Provider Taxonomy

### Flat Providers (`docType: 'flat'`)
Manage `<param name="K" value="V"/>` style files. The internal document model
is a flat array of `ConfigEntry` objects. Examples: vars.xml, switch.conf.xml,
event_socket.conf.xml, acl.conf.xml, sofia.conf.xml, conference.conf.xml,
gateway files.

### Hierarchical Providers (`docType: 'hierarchical'`)
Manage tree-structured configuration where nodes have type, parent/child
relationships, and ordered siblings. Examples: dialplan/*.xml, directory/*.xml,
future IVR, Call Center, Time Conditions providers.

**Hierarchical providers differ from flat providers only in:**
1. `get docType()` returns `'hierarchical'`
2. The parsed doc's `entries` field carries a `ConfigNode[]` tree instead of a
   flat `ConfigEntry[]` array
3. The frontend routes to a tree renderer instead of the flat `ConfigPage`
4. Change operations are ordered (`ChangeOp[]`), enabling undo/redo

Everything else — deployment pipeline, history, audit, backup, version management,
driver, strategy — is identical.

---

## Approved Object Model: Dialplan

```
DialplanDoc {
  contextName:  string
  contextAttrs: {}
  nodes:        DialplanNode[]    ← set as 'entries' in the API response
  checksum:     string
}

DialplanNode (union on .type):
  { type:'extension', id, name, continue, attrs, enabled, conditions[] }
  { type:'comment',   id, text }
  { type:'directive', id, raw  }

Condition { id, field, expression, expressionCdata, expressionIsChild,
            break, attrs, enabled, actions[], antiActions[] }

Action { id, application, data, enabled }
```

IDs are **ephemeral** — generated per `parse()` call, never written to XML.
The UI must discard stale IDs after every reload or deploy.

---

## Approved Change Operation Contract

Hierarchical providers use an ordered `ChangeOperation[]` (not a key-map).
Every op is a plain JSON object with `{ op, ... }`. Operations are applied in
order by `provider.applyChanges(doc, ops[])`. The store must support undo/redo
by maintaining a pointer into the ordered list.

Dialplan operations: `update_context`, `add/update/delete/move_extension`,
`add/update/delete/move_condition`, `add/update/delete/move_action`,
`add/delete_comment`, `add/delete_directive`.

---

## Deployment Philosophy

- Deploy only what changed.
- Never restart FreeSWITCH unnecessarily.
- Dialplan deployment uses `RELOAD_XML` strategy (existing).
- Pipeline: Read → Drift check → Parse → Apply → Validate → Serialize →
  Diff → Pre-deploy hook → Backup → Atomic write → Strategy steps →
  Version snapshot → Verify → Post-deploy hook → Audit.
- On failure: auto-restore from backup; re-execute strategy; log.

---

## Out of Scope (Never Implement)

- Visual dialplan designer / drag-and-drop flow builder
- AI dialplan generator
- Call flow diagrams
- Multi-node FreeSWITCH clustering
- Full dependency graph (prepare architecture for it; do not implement)
- Workflow approvals
- Configuration database (separate from the operational DB)

---

## Implementation Phasing: Dialplan Module

| Phase | Deliverable                        | Status      |
|-------|------------------------------------|-------------|
| 1     | Framework adjustments (generic)    | In Progress |
| 2     | DialplanParser (already written)   | Complete    |
| 3     | DialplanCatalog                    | Pending     |
| 4     | DialplanFileProvider               | Pending     |
| 5     | Provider discovery                 | Pending     |
| 6     | ConfigurationManager integration   | Pending     |
| 7     | Frontend: tree renderer + page     | Pending     |
| 8     | Deployment integration             | Pending     |
| 9     | Testing                            | Pending     |

Each phase must compile, pass existing tests, and not break existing modules
before the next phase begins.
