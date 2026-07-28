# ARCHITECTURE.md

This file is the authoritative design specification for the Enterprise FreeSWITCH Management Platform.

**Treat it as frozen.** Any proposal that conflicts with a decision documented here must be
explained and explicitly approved before it can be implemented. Claude Code must check this
file before suggesting architectural changes, and must not apply conflicting changes without
human approval.

---

## Platform Identity

This platform is an **Enterprise AI-Native Communications Platform**.

The current implementation — FreeSWITCH administration, ENS, ERS, IVR Builder — is the foundation. In scope and rigor it is equivalent to Avaya Aura System Manager, Avaya Communication Manager, and Cisco Unified CM Administration. The long-term identity is a full-stack enterprise communications platform that integrates communication services, platform services, and AI capabilities as native platform services, not as bolt-ons.

This is **not** a generic FreeSWITCH web GUI. Every architectural decision must be evaluated against the platform's long-term identity, not only its current module set.

See **Platform Vision** in `GOVERNANCE.md`, **AI-First Platform Design** principles in `GOVERNANCE.md`, and the **Platform Framework Registry** below.

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

## Platform Framework Registry

The platform is organized around named frameworks. Each framework has a status: implemented, in progress, planned, or reserved. Modules integrate through these frameworks rather than building parallel alternatives.

Registering a framework here reserves the architectural space. A registry entry alone requires no DIA. **Only the implementation of a framework requires a DIA and approval.**

| Framework | Status | Purpose |
|---|---|---|
| Platform Configuration Framework | ✓ Implemented | XML-based FreeSWITCH configuration: providers, catalog, registry, driver, deployment pipeline |
| Platform Deployment Framework | ✓ Implemented | 13-step atomic deployment pipeline, backup, version history, audit trail |
| Platform Provider Framework | ✓ Implemented | `ConfigurationProvider` base, `ProviderRegistry`, flat/hierarchical taxonomy |
| Platform Observability Framework | ⚡ In Progress | Structured logging, metrics (`metrics.js`), distributed tracing (deferred) |
| Platform Event Framework | ⚡ Partial | In-process event bus (`eventBus`); persistent event stream and external broker deferred |
| Platform Security Framework | Planned | Authentication, authorization, RBAC, tenant isolation, API key management |
| Platform Identity & Access Framework | Planned | IAM, SSO, directory integration, session lifecycle |
| Platform Workflow Framework | Planned | Workflow engine, rules engine, business process automation |
| Platform Integration Framework | Planned | API gateway, external system connectors, webhook management |
| Platform Notification Framework | Planned | Multi-channel notifications: email, SMS, push, in-app |
| Platform Analytics Framework | Planned | Reporting engine, dashboards, real-time analytics, data export |
| Platform Knowledge Framework | Planned | RAG, vector database, knowledge base, catalog expansion |
| Platform Automation Framework | Planned | AI automation engine, self-healing, predictive operations, capacity optimization |
### Framework Rules

1. **A module must never implement its own version of a registered framework capability.** Use the framework. If the framework cannot support a requirement, produce a DIA to extend it.
2. **A new framework may only be added to this registry after its DIA is approved.** The entry and status can be updated freely; implementation requires approval.
3. **The Platform AI Layer is reserved in full.** No sub-framework listed in the Platform AI Layer Architecture section may be implemented without its own approved DIA. When AI capabilities are required by a module, document the need as a Platform AI Layer requirement — not a module-level workaround.
4. **Frameworks exposed to the rest of the platform export through `src/infrastructure/index.js`.** Internal implementation files are not public API.

---

## Platform AI Layer Architecture

The Platform AI Layer is **not another row in the framework registry**. It is a **cross-cutting platform capability** — a horizontal layer that every other framework and module can leverage. No module builds its own AI logic. All AI capability comes from this layer.

All sub-frameworks below are **Reserved**. None are implemented. A sub-framework may only be implemented after its own approved DIA.

```
Communications Modules       Platform Modules        AI-Powered Features
  ENS  ERS  IVR  CC  ...     Config  Deploy  ...     AIOps  Assistants  ...
    │    │    │    │              │       │                │        │
    └────┴────┴────┴──────────────┴───────┴────────────────┴────────┘
                                  │
                    ┌─────────────▼─────────────────┐
                    │      Platform AI Layer          │
                    │  (cross-cutting capability)     │
                    │                                 │
                    │  AI Runtime · Model Management  │
                    │  Agent Framework · MCP Layer    │
                    │  Memory · Security · AIOps      │
                    └─────────────────────────────────┘
```

| Sub-Framework | Status | Responsibility |
|---|---|---|
| **AI Runtime** | Reserved | Multi-provider abstraction: routes AI requests to OpenAI, Anthropic, Azure OpenAI, AWS Bedrock, Google Vertex, Ollama, vLLM, or any future provider. Switching providers is a configuration change, not a code change |
| **AI Model Management** | Reserved | Model registry: registers, versions, and routes models. Supports simultaneous use of different models for different operation types. Records model/provider/version on every interaction |
| **AI Agent Framework** | Reserved | Orchestrates autonomous AI agents with defined scope, permissions, tool access, lifecycle management, and audit footprint |
| **AI Context Framework** | Reserved | Supplies structured context to AI interactions: tenant context, operation context, call session, user session, conversation history |
| **AI MCP Layer** | Reserved | MCP Server (exposes platform to AI agents), MCP Client (calls external MCP servers), Tool Registry, Tool Execution Framework (with auth + audit + rate limiting), Resource Registry, Prompt Registry, Context Providers |
| **AI Memory Framework** | Reserved | Session Memory, User Memory, Organization Memory, Platform Knowledge, Configuration Knowledge, Operational History, Incident History, Documentation Knowledge, Vector Knowledge Base |
| **AI Security & Governance** | Reserved | Prompt versioning, model versioning, tool permissions, AI audit logs, AI action approval, per-tenant AI policy enforcement, human approval workflows, AI explainability, AI safety controls |
| **AI Observability Extension** | Reserved | AI-specific telemetry extending the Platform Observability Framework: model latency, token usage, cost, tool execution history, AI decision traces, model accuracy, failure analysis |
| **AI Plugin Framework** | Reserved | Extension points for AI Skills, Agents, Workflows, Models, Tools, Prompts, Connectors, Knowledge Providers — registered dynamically without core code changes |
| **AI AIOps** | Reserved | Incident detection, failure prediction, root cause analysis, capacity planning, performance optimization, configuration validation, security anomaly detection, self-healing recommendations |

---

## Out of Scope (Never Implement)

- Visual dialplan designer / drag-and-drop flow builder
- AI-generated dialplan within Config Center (AI capabilities are a Platform AI Framework concern, not a Config Center feature)
- Call flow diagrams
- Multi-node FreeSWITCH clustering
- Full dependency graph (prepare architecture for it; do not implement)
- Workflow approvals
- Configuration database (separate from the operational DB)
- Module-specific AI integration layers before the Platform AI Framework DIA is approved (see Platform Framework Registry)

---

## Implementation Phasing: Dialplan Module

| Phase | Deliverable                        | Status      |
|-------|------------------------------------|-------------|
| 1     | Framework adjustments (generic)    | Complete    |
| 2     | DialplanParser                     | Complete    |
| 3     | DialplanCatalog                    | Complete    |
| 4     | DialplanFileProvider               | Complete    |
| 5     | Provider discovery                 | Pending     |
| 6     | ConfigurationManager integration   | Pending     |
| 7     | Frontend: tree renderer + page     | Pending     |
| 8     | Deployment integration             | Pending     |
| 9     | Testing                            | Pending     |

Each phase must compile, pass existing tests, and not break existing modules
before the next phase begins.

---

## Configuration Governance

These rules apply to every module on the platform — current and future.

### Configuration Ownership

Every configuration artifact has exactly one owning module. Ownership is
declared at artifact creation time and does not change.

| Artifact | Owning Module |
|---|---|
| `vars.xml` | Configuration Center |
| `switch.conf.xml` | Configuration Center |
| `acl.conf.xml` | Configuration Center |
| `sofia.conf.xml` | Configuration Center |
| `conference.conf.xml` | Configuration Center |
| `gateway/*.xml` | Configuration Center |
| `dialplan/*.xml` (managed) | Configuration Center |
| `enrs_ivr.xml` | IVR Builder |
| Future generated call center XML | Call Center module |

**Rules:**
- No module may modify an artifact it does not own.
- Configuration Center may **deploy** artifacts owned by other modules, but
  must never become their **editor**.
- A `ConfigurationProvider` must never be registered for an artifact owned by
  another module. Registering a Provider implies edit ownership.

### Configuration Authority

Every artifact has exactly one authoritative source — the representation
managed by its owning module. All other representations are derived artifacts.

| Module | Authority | Derived Artifact |
|---|---|---|
| Configuration Center | XML file on disk | — (XML is the end form) |
| IVR Builder | Database graph (`ivr_flows` table) | `enrs_ivr.xml` |
| Future Call Center | Database queue config | Generated queue XML |

**Rules:**
- When a derived artifact conflicts with its authoritative source, the authority
  wins. Regenerate the artifact; never edit it directly.
- The Configuration Center's XML files are authoritative for the modules it
  owns. Do not bypass them by writing directly to disk outside the Provider
  lifecycle.

### Deployment Responsibility

Deployment is a **platform service**, not a module service.

- **Generation** belongs to the owning module (IVR Builder generates
  `enrs_ivr.xml`; Configuration Center generates managed XML via
  `serialize()`).
- **Deployment** belongs to `DeploymentManager` for all artifact types.
- No module implements its own deployment pipeline. Every artifact — Managed
  or Generated — is deployed through `DeploymentManager`.

### Managed XML vs Generated XML

The platform recognises two categories of XML artifact:

**Managed XML**
- A `ConfigurationProvider` is registered.
- The Configuration Center editing UI is enabled.
- XML on disk is the authoritative source.
- Changes flow through: `configChangesStore → applyChanges → serialize → DeploymentManager`.
- Examples: `vars.xml`, `sofia.conf.xml`, `dialplan/default.xml`.

**Generated XML**
- No `ConfigurationProvider` is registered.
- No Configuration Center editing UI.
- Generated by an upstream module from an authoritative source (database, graph).
- The platform's role is deployment only: receive the artifact, write it,
  trigger reload.
- Provider discovery **must** skip Generated XML files by name.
- Reference implementation: `enrs_ivr.xml` (owned by IVR Builder; excluded in
  `providers/index.js` by exact filename match).

---

## FreeSWITCH Platform Knowledge Catalog

The platform maintains one shared knowledge catalog for FreeSWITCH concepts,
available to all modules. Modules must consume existing catalog knowledge
rather than creating parallel catalogs for the same concepts.

**Current implementation:** `dialplanCatalog.js` — the first catalog file.
Despite its name, it catalogs FreeSWITCH **applications** (bridge, lua,
transfer, hangup, etc.) that are reusable across Dialplan, IVR, Call Center,
and any future module that invokes FreeSWITCH applications. Future modules that
need application metadata consume this catalog; they do not duplicate it.

**Future catalog scope (incremental — add only when a module requires it):**
Applications, Channel Variables, SIP Headers, ESL Events, ESL Commands,
CLI Commands, Lua APIs, Conference APIs, Recording APIs, Codecs.

### Catalog Rules (permanent)

These rules apply to every catalog file on the platform:

1. Catalogs declare **metadata only** — labels, descriptions, categories,
   tooltips, examples, risk levels.
2. Catalogs **never validate**, never throw based on values, never enforce
   business rules.
3. Catalogs **never import** from other catalogs.
4. Catalogs **never depend on Providers**, Parsers, or the framework.
5. Validation belongs exclusively to Providers.
6. A catalog lookup function must **always return a value** — never throw,
   never return null. Unknown entries receive a graceful fallback.
7. No module creates a parallel catalog for concepts already present in an
   existing catalog. Extend the existing catalog instead.

### Platform Metadata Vocabulary

Every catalog entry uses this shared vocabulary. Future catalogs must use
the same field names and types.

| Field | Type | Definition |
|---|---|---|
| `label` | string | Human-readable display name. Never empty. |
| `description` | string | Prose explanation. Full sentences. |
| `category` | string | Grouping identifier for UI pickers. |
| `tooltip` | string | Compact single-line help (≤ 120 chars). |
| `riskLevel` | `'low'│'medium'│'high'` | Operational risk classification. |
| `examples` | string[] | Concrete illustrative values. Always an array. |
| `deprecated` | boolean | True if the concept should be avoided. |
| `replacedBy` | string│null | Successor name when deprecated is true. |

---

## XML Document Contract

Every XML document managed by the platform satisfies the same behavioral
contract, regardless of document type:

```
Parser    — pure: XML string → typed internal object model → back to XML string
Catalog   — metadata: labels, descriptions, risk, examples for the document's concepts
Provider  — lifecycle: read, parse, validate, applyChanges, serialize, deploy, diff
```

- **Parsers only transform.** No I/O, no imports from Provider or Catalog layers.
- **Providers orchestrate lifecycle.** They delegate transformation to parsers
  and metadata lookups to catalogs. They own all validation logic.
- **No inheritance hierarchy is required.** The contract is behavioral —
  every Provider extends `ConfigurationProvider` and implements the same
  interface. `DialplanParser` is the reference implementation of the XML
  document parser contract.

---

## Path Resolution Rule

**This is a mandatory platform governance rule. No exceptions.**

All filesystem paths must be resolved exclusively through the
`PlatformDriver` / `FreeSwitchDriver` abstraction chain:

```
PlatformDriver
      ↓
FreeSwitchDriver
      ↓
FreeSwitchPathService
      ↓
fsConfig (reads FS_* env vars)
```

Providers, discovery logic, parsers, catalogs, and deployment components
**must never:**
- Hardcode FreeSWITCH paths (`/etc/freeswitch`, `/usr/local/freeswitch`, etc.)
- Import `fsConfig` directly
- Import `freeSwitchPathService` directly
- Manually concatenate FreeSWITCH filesystem paths
- Assume any specific installation layout

**Correct patterns:**
- `driver.resolveConfigurationPath('dialplan', 'default.xml')`
- `driver.resolveSipProfilePath('external/avaya.xml')`
- `driver.resolveConfigurationPath('dialplan')` — returns the directory

This guarantees portability across Linux distributions, Docker deployments,
custom `FS_BASE_DIR`, custom `FS_DIALPLAN_DIR`, and future platform drivers.

---

## Discovery Rule

Dynamic provider discovery must follow the existing gateway discovery
architecture (`discoverGatewayProviders` in `providers/index.js`).

Every discovery implementation must:
1. Obtain the root directory from `driver` — never from `fsConfig` or env directly.
2. Be **data-driven** — no hardcoded filenames or context names.
3. Skip **hidden files** (`startsWith('.')`) and **temp files** (`startsWith('_')`).
4. **Continue boot** when a directory is inaccessible (`ENOENT`, `EACCES`) —
   log a warning; never throw; never prevent other providers from registering.
5. **Log registration counts** on success.
6. **Continue on duplicate provider IDs** — log a warning per duplicate; never throw.
7. **Skip Generated XML files** by exact filename when the filename is known
   (e.g. `enrs_ivr.xml`). Document each skip rule with its ownership reason.

A new discovery mechanism is only justified when the existing pattern
demonstrably cannot support the requirement — document the reason in the DIA.

---

## Provider Constructor Guideline

Providers that represent individual filesystem objects should prefer receiving
a **single relative path** rather than separate directory and filename
parameters.

**Preferred:**
```
new DialplanFileProvider(driver, 'default.xml')
new DialplanFileProvider(driver, 'default/cc.xml')
new DialplanFileProvider(driver, 'public/00_inbound_did.xml')
```

**Avoid (unless architecturally justified):**
```
new DialplanFileProvider(driver, 'default', 'cc.xml')
```

A single relative path keeps the provider independent of directory depth,
simplifies ID derivation, and is consistent with how `driver.resolveConfigurationPath`
accepts sub-paths (`'default/cc.xml'` rather than `('default', 'cc.xml')`).

The `GatewayFileProvider(driver, profileName, fileBasename)` pre-dates this
guideline and is kept as-is. New providers follow the single-relative-path
convention.
