# GOVERNANCE.md — Enterprise AI-Native Communications Platform Governance

**This file is a permanent mandatory instruction for all development on this repository.**
**Claude Code must read and follow this file before writing any code, in every session.**
**See also: ARCHITECTURE.md — the frozen architectural specification.**

---

## Platform Vision

This platform is an **Enterprise AI-Native Communications Platform**.

Current modules — ENS, ERS, IVR Builder, FreeSWITCH Configuration Center — are the foundation. The platform is designed to grow across three capability domains:

**Communication Services** — Contact Center, Outbound Campaigns, Queue Management, Routing Engine, Call Recording, Voice Gateway Management, Conferencing, IVR, Softphone, Operator Console, Reception Console, Workforce Management, Quality Monitoring, Messaging (SMS, WhatsApp, Email, Push), Presence, Fax Services.

**Platform Services** — Configuration Framework, Deployment Framework, Provider Framework, Security Framework, Identity & Access Management, Multi-Tenant Management, Licensing, Plugin Framework, Workflow Engine, Rules Engine, Event Bus, Scheduler, Reporting, Analytics, Observability Framework, Audit Framework, Notification Framework, API Gateway.

**AI & Intelligent Automation Services** — AI Voice Agents, AI Chat Agents, AI Copilots, AI Supervisors, AI Routing, AI Quality Monitoring, AI Speech Analytics, AI Sentiment Analysis, AI Intent Detection, AI Knowledge Assistant, AI Call Summarization, AI Conversation Intelligence, AI Translation, AI Voice Biometrics, AI Authentication, AI Predictive Analytics, AI Forecasting, AI Automation Engine, AI Workflow Orchestration, AI Decision Engine, AI Configuration Assistant, AI Operations Assistant, AI Infrastructure Diagnostics, AI Root Cause Analysis, AI Self-Healing Recommendations, AI Capacity Optimization, AI Security Anomaly Detection, AI Compliance Monitoring, Prompt Management, Model Management, MCP (Model Context Protocol) Integration, Multi-Model AI Provider Support, RAG Services, Vector Database Integration, Agentic AI Framework.

**Architectural implication:** Every platform service must be designed assuming AI will eventually consume it. See **AI-First Platform Design** below and the **Platform Framework Registry** in `ARCHITECTURE.md`.

---

## Project Status

The architecture of the Enterprise AI-Native Communications Platform is **approved and frozen** at the current implementation baseline.

From this point forward: **implement, do not redesign.**

---

## Primary Objective

Implement requested functionality while preserving:

- Existing architecture
- Existing coding patterns
- Existing reusable framework
- Existing APIs
- Existing deployment logic
- Existing UI behavior
- Existing provider architecture

Every implementation integrates into the existing framework. Nothing replaces it.

---

## Architecture Is Frozen

```
XML
  ↓ Parser
  ↓ Catalog
  ↓ Provider
  ↓ Provider Registry
  ↓ Configuration Manager
  ↓ Driver
  ↓ Deployment Strategy
  ↓ React Config Center
```

This pipeline shall **not** be redesigned. No new architectural layers may be introduced
without explicit written approval.

---

## Implementation Principle — Mandatory Decision Order

Before introducing ANY new class, abstraction, service, store, hook, renderer, manager,
registry, provider base class, or utility, work through this order:

1. **Reuse existing code.** If the existing framework already supports the requirement, use it.
2. **Extend existing generic code.** If extension without breaking compatibility is possible, do that.
3. **Create a new generic component only if reuse and extension are both impossible.** Justify fully (see below).
4. **Never create module-specific infrastructure** when a generic solution is feasible.

---

## Mandatory Decision Questions

**Question 1 — Can the existing framework already support this?**
If YES → Reuse it. Do NOT create anything new.

**Question 2 — Can the existing framework be extended without breaking compatibility?**
If YES → Extend it. Do NOT create a parallel implementation.

**Question 3 — Is a new component absolutely required?**
If YES → Explain all four of:
- Why the existing framework cannot support it
- Why extension is insufficient
- Why the new component is generic
- Which future modules (Dialplan, Directory, IVR, Call Center, AI Services, at minimum) will reuse it without modification

Only then create it.

**Question 4 — Is this AI-consumable?**
If introducing a new API, event schema, or data structure: confirm it satisfies AI-First Principles AI-1 through AI-5 (see below). If AI integration is not relevant to this component, state why.

---

## Strict Rules

| # | Rule |
|---|------|
| 1 | Do NOT redesign existing architecture |
| 2 | Do NOT refactor unrelated code |
| 3 | Do NOT rename existing APIs |
| 4 | Do NOT change existing interfaces |
| 5 | Do NOT change existing behavior |
| 6 | Do NOT introduce breaking changes |
| 7 | Do NOT create duplicate implementations |
| 8 | Do NOT create module-specific infrastructure unless absolutely unavoidable |
| 9 | Do NOT use `console.log()` in new modules — use the platform logger (`src/infrastructure/logger.js`) |
| 10 | Do NOT log passwords, tokens, secrets, private keys, or authentication credentials under any circumstances |

---

## Genericity Rule

Every new component must satisfy:
> "Can this component be reused without modification by Dialplan, Directory, IVR, Call Center, AI Services, and future platform modules?"

If the answer is NO → Do not create it. Extend something that can be made generic instead.

---

## Anti-Pattern Examples (What NOT to Do)

### Anti-Pattern 1 — Parallel Stores

```
Existing:  configChangesStore   (Map<key, change>)
Need:      hierarchical changes (ordered ops)

WRONG:     Create hierarchicalChangesStore  ← parallel infrastructure
CORRECT:   Determine whether configChangesStore can be extended to support
           both flat key-map changes AND ordered operation lists.
           If yes → extend it. If genuinely impossible → justify and create generic.
```

### Anti-Pattern 2 — Specific Path Methods

```
Existing:  resolveSipProfilePath(relativePath)
Need:      dialplan path resolution

WRONG:     resolveDialplanPath(relativePath)  ← module-specific
CORRECT:   resolveConfigurationPath(type, relativePath)
           where type = 'sipProfile' | 'dialplan' | 'directory' | 'lua' | ...
           Reusable by every future module.
```

### Anti-Pattern 3 — Parallel Provider Hierarchies

```
Existing:  ConfigurationProvider (base class)
Need:      hierarchical document support

WRONG:     Create HierarchicalProvider extends ConfigurationProvider  ← new hierarchy
CORRECT:   Determine whether ConfigurationProvider already supports hierarchy.
           It has parse(), serialize(), applyChanges(), validate(), diff() — all generic.
           Extend with docType getter. That is all that is needed.
```

### Anti-Pattern 4 — Direct Path Access

```
Need:      path to a dialplan XML file

WRONG:     import { fsConfig } from '../config/fsConfig.js'; fsConfig.dialplanDir + '/default.xml'
WRONG:     import { fsPathService } from '../services/freeSwitchPathService.js'; fsPathService.getDialplanDir()
WRONG:     '/etc/freeswitch/dialplan/default.xml'   ← hardcoded path
CORRECT:   driver.resolveConfigurationPath('dialplan', 'default.xml')

All path resolution must go through the PlatformDriver chain.
See Platform Invariant: Path Resolution Rule (below) and ARCHITECTURE.md — "Path Resolution Rule".
```

### Anti-Pattern 5 — Parallel Knowledge Catalogs

```
Need:      application metadata for IVR module

WRONG:     Create ivrApplicationCatalog.js listing bridge, hangup, lua, transfer
           ← duplicates dialplanCatalog.js entries for the same FreeSWITCH applications
CORRECT:   Import lookupApplication() from dialplanCatalog.js
           The catalog is a platform knowledge catalog, not a Dialplan-only catalog.
           See ARCHITECTURE.md — "FreeSWITCH Platform Knowledge Catalog".
```

### Anti-Pattern 7 — Forensic Investigation Logs Left as Permanent Code

```
Investigation: ENS blast does not ring extensions. Temporary probes added.
After fix is confirmed:

WRONG:  Leave [ENS-DEBUG] console.log probes in production code.
        Leave evt.serialize() calls running on every ESL event.
        Leave full SQL result dumps in the tick loop.

CORRECT: Promote each probe to one of:
           (a) Permanent operational log   — logger.info({ campaignId }, 'Campaign started')
           (b) Permanent debug log         — logger.debug({ callUuid }, 'Originate dispatched')
           (c) Removed                     — if no permanent observability value
         No forensic probe survives a merge to main.
```

### Anti-Pattern 6 — Provider Registered for Generated XML

```
Need:      IVR Builder output (enrs_ivr.xml) visible in Config Center

WRONG:     Register a DialplanFileProvider for enrs_ivr.xml
           ← gives Config Center edit ownership of an IVR Builder artifact
CORRECT:   Exclude enrs_ivr.xml from provider discovery.
           Config Center may deploy it; it must never become its editor.
           See ARCHITECTURE.md — "Managed XML vs Generated XML".
```

---

## Platform Technical Invariants

These rules apply to every module, every session, and every developer without exception.
They are stated as invariants — not examples — because no business justification, time
pressure, or architectural convenience overrides them.

---

### Path Resolution Rule (Platform Invariant)

Platform modules **must never** construct FreeSWITCH filesystem paths.

The only approved resolution mechanism is:

```
Provider
    ↓
Platform Driver (FreeSwitchDriver)
    ↓
FreeSwitchPathService
    ↓
Environment Configuration (FS_* env vars)
    ↓
Filesystem
```

**Forbidden in all module code — providers, parsers, catalogs, discovery, deployment:**

| Forbidden | Reason |
|---|---|
| `'/etc/freeswitch/...'` | Hardcoded path — breaks Docker, custom installs, non-Debian packages |
| `path.join('/etc/freeswitch', ...)` | Path construction — same as hardcoding |
| `fsConfig.dialplanDir` | Direct config access — bypasses the driver chain |
| `fsConfig.gatewayDir` | Direct config access — bypasses the driver chain |
| `process.env.FS_DIALPLAN_DIR` | Direct env access — bypasses the driver chain |
| `import freeSwitchPathService` | Direct service import — bypasses PlatformDriver |

**Allowed — driver methods are the only public API for path resolution:**

```js
driver.resolveConfigurationPath('dialplan', 'default.xml')    // → absolute path to file
driver.resolveConfigurationPath('dialplan', 'default/cc.xml') // → subdirectory file
driver.resolveConfigurationPath('dialplan')                   // → directory path
driver.resolveSipProfilePath('external/avaya.xml')            // → gateway file
driver.resolveGatewayPath(...)                                // → future driver methods
```

The Driver is the **only** public API for path resolution. This rule guarantees
environment independence, Docker portability, custom installation support, and future
driver replaceability.

**This rule applies equally to test code.** Tests must mock the driver and derive all
path comparisons from the driver's return values — never from hardcoded string literals.
A test that hardcodes `/etc/freeswitch/...` is as much a violation as production code.

Violation of this rule is an architectural defect.
See also: Anti-Pattern 4. Full chain rationale: ARCHITECTURE.md §Path Resolution Rule.

---

### Filesystem Discovery Rule (Platform Invariant)

Dynamic provider discovery is **always data-driven**. No module may enumerate
configuration by hardcoded filename lists or hardcoded directory paths.

Every discovery implementation must:

1. Obtain all root directories exclusively from `driver` — never from `fsConfig`,
   `freeSwitchPathService`, or environment variables directly.
2. Be fully data-driven — no hardcoded filenames, context names, or subdirectory names
   in the enumeration logic itself. (Exclusions for known Generated XML files are
   permitted as exact-basename matches with documented ownership reasons.)
3. Skip **hidden files** (basename starts with `.`) and **temporary files** (basename
   starts with `_`) at every tier of enumeration.
4. **Continue boot** when a directory is inaccessible — `ENOENT`, `EACCES`, or similar.
   Log a warning. Never throw. Never prevent other providers from registering.
5. **Log the registration count** after discovery completes, when at least one provider
   was registered. Log nothing when the directory is empty or absent.
6. Handle **duplicate provider IDs** without throwing — log a warning per duplicate;
   continue registration of the remaining providers.
7. **Skip Generated XML files** by exact basename when the owning module is known.
   Every skip rule must be documented inline with its ownership reason and a reference
   to the Configuration Ownership table in ARCHITECTURE.md.

The reference implementation is `discoverGatewayProviders` in `providers/index.js`.
All new discovery functions must mirror its structure and error-handling.
See also: ARCHITECTURE.md §Discovery Rule.

---

### Discovery Before Configuration Rule (Platform Invariant)

Provider discovery must **complete before** any configuration API is exposed to
request handlers.

- `registerAll(registry, driver)` must be `await`ed to completion before route
  handlers are mounted. No configuration route may be reachable during discovery.
- A partially-populated registry (some providers registered, others skipped due to
  inaccessible directories) is a valid but warned state. It is **not** a reason to
  abort the server. Platform boot continues; the missing providers are simply
  unavailable until the underlying filesystem issue is resolved.
- Discovery errors that propagate as uncaught exceptions are defects. Every
  discovery function must handle its own errors and return cleanly.
- **Test code** that calls `registerAll()` must supply a complete mock driver and
  mock filesystem. A partially-wired test that leaves the registry inconsistent
  produces false test results and is itself a governance violation.

---

### Provider Identity Rule (Platform Invariant)

Every provider must have a **unique, deterministic, logical ID** that is stable
across server restarts.

**ID format:**

```
<type>:<identifier>[:<sub-identifier>]
```

| Provider | ID |
|---|---|
| `dialplan/default.xml` | `dialplan:default` |
| `dialplan/public.xml` | `dialplan:public` |
| `dialplan/default/cc.xml` | `dialplan:default:cc` |
| `sip_profiles/external/avaya.xml` | `gateway:external:avaya` |

**Rules:**

1. **Uniqueness** — no two registered providers may share an ID. The registry
   throws on duplicate registration. Discovery functions must catch the throw,
   log a warning, and continue — never propagate the exception.
2. **No filesystem characters** — IDs must never contain `/`, `\`, or `.`
   (the suffix separator). These characters imply a filesystem path interpretation,
   which violates the logical-identifier contract. Path separators in relative
   paths are replaced with `:` before becoming part of the ID.
3. **Determinism** — an ID must be derivable from the provider's relative filesystem
   path alone, without runtime state. The same file must always produce the same ID.
4. **Stability** — an ID must not change between server restarts for the same file.
   A changed ID for a stable file is a breaking change: it invalidates stored history,
   audit records, and frontend state. Such a change requires a DIA and explicit approval.
5. **Namespace prefix** — IDs are prefixed by configuration type (`dialplan:`,
   `gateway:`, `vars`, `switch-core`, etc.) to prevent cross-type collisions.

---

## Platform Observability & Logging Governance

**This section is a permanent mandatory governance rule.**
It applies to every existing module (ENS, ERS, Config Center, Deployment, FreeSWITCH Integration, ESL Services, Media Services, Database Layer, Monitoring, Reporting) and every future module (Contact Center, IVR Builder, Dialplan Management, Directory, SIP & Gateway Management, Recording Management, AI Services, Agent Desktop, Supervisor Console, Campaign Manager, Outbound Dialer, Voice Bot, Chat, Email, SMS, WhatsApp, Fax, Notification Services, Analytics, Reporting, REST APIs, Platform Administration, and any others added to the roadmap).

No session, no feature, no module is exempt.

---

### Rule O-1 — Observability Is a Delivery Requirement

A feature is not complete until its execution can be traced through logs.

Observability is part of the implementation scope, not a follow-up enhancement. Every new feature must include its observability plan before code is written. The DIA (§ Design Impact Assessment below) requires an Observability Plan section for this reason.

The default assumption in software is to add logging "later." On this platform, later does not exist.

---

### Rule O-2 — Platform Logging Framework

The platform logger is `src/infrastructure/logger.js` (built in Sprint 0).

**All new code must import and use the platform logger. `console.log()` is not permitted in new modules.**

```js
import { logger } from '../infrastructure/index.js';

logger.info({ module: 'ENS', campaignId, tenantId }, 'Campaign started');
logger.debug({ module: 'ESL', callUuid, destId }, 'Originate command dispatched');
logger.warn({ module: 'dialResolver', contactId }, 'No gateway found — falling back to user/');
logger.error({ module: 'campaignEngine', campaignId, err: e.message }, 'Originate failed');
```

**Existing `console.log()` in legacy code** is technical debt, not a governance violation. When a file is modified for any reason, its `console.log` calls must be migrated to the platform logger. Do not migrate files that are not being touched — that is refactoring for its own sake (Strict Rule 2).

The logger supports four levels: `DEBUG`, `INFO`, `WARN`, `ERROR`.

---

### Rule O-3 — Configurable Log Verbosity

Log verbosity must never require code changes to adjust.

Verbosity is controlled by environment configuration:

```
LOG_LEVEL=info                 # production default (INFO / WARN / ERROR only)
LOG_LEVEL_ENS=debug            # enable DEBUG for ENS module only
LOG_LEVEL_ESL=debug            # enable DEBUG for ESL module only
LOG_LEVEL_DB=debug             # enable DEBUG for database layer
```

Supported module keys: `platform`, `database`, `freeswitch`, `esl`, `media`, `deployment`,
`ens`, `ers`, `ivr`, `contact-center`, `sip`, `recording`, `ai`, `campaign`, `dialer`, `chat`.

**Production** defaults to `INFO`. **Development** may enable `DEBUG` per module.

Heavy forensic operations (SQL dumps, ESL event serialization, complete XML, SIP headers, channel variable dumps) must be guarded:

```js
if (logger.isLevelEnabled('debug')) {
  logger.debug({ module: 'ESL', rawEvent: evt.serialize() }, 'Full ESL event');
}
```

This ensures expensive serialization never executes in production even when the log call is present.

---

### Rule O-4 — Correlation IDs

Every log entry for a multi-step operation must carry the correlation identifiers of that operation. A developer must be able to reconstruct the entire execution timeline using correlation IDs and timestamps alone, without reading source code.

| Operation | Required Correlation IDs |
|---|---|
| ENS Campaign | `campaignId`, `destId`, `callUuid`, `tenantId` |
| ERS Incident | `incidentId`, `conferenceId`, `callUuid` |
| IVR Call | `callUuid`, `sessionId`, `flowId`, `tenantId` |
| Outbound Call | `callUuid`, `campaignId`, `destId`, `tenantId` |
| Inbound Call | `callUuid`, `sessionId`, `tenantId` |
| Deployment | `deploymentId`, `providerId`, `tenantId` |
| Configuration Change | `providerId`, `requestId`, `tenantId` |
| Conference | `conferenceId`, `incidentId`, `callUuid` |

Correlation IDs are passed as the first structured argument to the logger, not embedded in the message string.

---

### Rule O-5 — Structured Log Format

The platform logger emits structured JSON. Every log entry must carry:

```json
{
  "timestamp": "<ISO-8601>",
  "level": "info|debug|warn|error",
  "module": "<ENS|ESL|ERS|deployment|...>",
  "component": "<campaignEngine|eslService|...>",
  "operation": "<originateCampaignCall|resolveDialString|...>",
  "<correlationId>": "<value>",
  "msg": "<human-readable message>",
  "elapsed_ms": 143
}
```

Free-form string concatenation (`console.log('foo: ' + x)`) is legacy technical debt. All new code passes a structured object as the first argument to the logger.

---

### Rule O-6 — Log Categories

Every log statement belongs to one of four categories. Choose deliberately.

#### Operational Logs — always on, always committed

Permanent, production-grade business events. Always enabled regardless of log level.

Examples:
- `Campaign 42 started — 18 destinations queued`
- `Conference ers_3_p created — incident #7`
- `Deployment completed — 3 files updated, 0 errors`
- `Configuration changed — dialplan:default modified by admin@enrs.local`
- `Gateway registered — avaya (sip.avaya.local:5060)`

#### Debug Logs — development only, off in production by default

Execution tracing: method entry/exit, decision points, intermediate values, state transitions. Disabled by default in production environments. Enabled per-module via `LOG_LEVEL_<MODULE>=debug`.

Examples:
- `resolveDialString ENTER — contactId=14 tenantId=1`
- `Gateway lookup by name "avaya" — not found in sip_gateways, using raw name`
- `originateCampaignCall — dial string resolved: user/1001`

#### Performance Logs — always on for slow-path violations, debug for all paths

Duration measurements for operations with latency budgets. Log at `INFO` when a threshold is exceeded; at `DEBUG` always.

Examples:
- `SQL duration 143ms — ens_campaign_destinations INSERT (threshold: 100ms)`
- `ESL command duration 2.1s — conference list (threshold: 500ms)`
- `Deployment pipeline duration 8.2s — dialplan reload`

#### Forensic Logs — investigation only, never committed to main

Temporary investigation instrumentation: full SQL result sets, serialized ESL events, raw XML documents, complete SIP headers, channel variable dumps. These exist only during an active investigation and must be removed or promoted before merging.

See Rule O-11 for the investigation protocol.

---

### Rule O-7 — Sensitive Information Protection

The platform must never log:

| Category | Examples |
|---|---|
| Credentials | Passwords, API keys, secrets, private keys |
| Authentication | JWT tokens, session tokens, refresh tokens, auth headers |
| System credentials | `INTERNAL_API_KEY`, `ESL_PASSWORD`, database passwords |

When a structure containing sensitive fields must be logged, sanitize it first:

```js
const safe = { ...payload, password: '[REDACTED]', token: '[REDACTED]' };
logger.debug({ module: 'auth', payload: safe }, 'Login request');
```

This rule is an absolute constraint. No business justification, debugging urgency, or incident severity overrides it. Sensitive data logged to any destination (file, stdout, monitoring system) is a security defect.

---

### Rule O-8 — Logging Must Not Alter Business Behavior

Logging must remain passive. Adding or removing a log statement must never alter application behavior or outcome.

Violations (all are defects):
- Catching an exception inside a log statement that would otherwise propagate
- Modifying a variable solely to make it loggable
- Changing a query to add a logging-friendly column
- Short-circuiting logic to simplify a log message

If a log statement requires a code change to produce meaningful output, the application code needs better structure — not a cleverer log. Fix the structure; then write a clean log against it.

---

### Rule O-9 — Logging Must Not Introduce Overhead

Logging must not make the application meaningfully slower.

- Heavy operations (`evt.serialize()`, full XML parsing, large DB fetches) must be guarded by `logger.isLevelEnabled('debug')` so they never execute at INFO/WARN/ERROR levels.
- The tick loop, ESL event handlers, and hot call paths must not perform expensive operations for logging purposes in production.
- Forensic logging (rule O-6) must never be in the normal execution path.

---

### Rule O-10 — Platform Timeline Reconstruction

A developer must be able to reconstruct a complete operation timeline from logs using correlation IDs and timestamps alone.

Required trace coverage for each major workflow:

| Workflow | Timeline must cover |
|---|---|
| ENS Campaign | Creation → contacts resolved → destinations inserted → claim → dial string → originate → FS events → answer → playback → hangup |
| ERS Incident | Incoming call → config lookup → responders resolved → originate → conference join → recording start → completion |
| IVR Call | Entry → node traversal → each application executed → transfers → hangup |
| Outbound Call | Claim → dial → CHANNEL_CREATE → answer → media → hangup cause |
| Deployment | Trigger → file generation → write → reload → verification |
| Config Change | Request → validation → diff → apply → version stored → audit log |

If the logs of a workflow do not reconstruct this timeline, the observability implementation is incomplete.

---

### Rule O-11 — Investigation Logging Protocol

During active bug investigations, temporary forensic instrumentation may be added.

**Rules:**
1. **No business logic may change** — add only `logger.debug` / `console.log` calls.
2. **Mark every temporary probe** with `// DEBUG-PROBE` at the end of the line.
3. **Scope to the investigation** — do not add permanent forensic logs.
4. **Resolve before merging**: after the root cause is confirmed and the fix applied, each probe is either:
   - **Promoted** to a permanent operational or debug log using the platform logger, or
   - **Removed** entirely.
5. **No forensic log survives a merge to main.** The `[ENS-DEBUG]` probes currently in `campaignEngine.js`, `eslService.js`, and `dialResolver.js` must be cleaned up after the ENS investigation concludes.

---

### Rule O-12 — Applies to Every Future Module

No future module may introduce its own logging style, custom logger wrapper, or ad hoc `console.log` pattern.

Every module added to the platform — current and future — must comply with Rules O-1 through O-11. This applies at code review, at DIA approval, and at feature completion verification.

The platform logging framework (`src/infrastructure/logger.js`) is the only approved logging mechanism. It is a generic platform component, not a module-specific one. Requests to create a module-specific logger wrapper are rejections of this rule.

---

## AI-First Platform Design

**This section is a permanent mandatory governance principle.**
It applies to every API, event schema, data structure, and platform service introduced to the platform, now and in the future. No module is exempt.

---

### AI Is a Platform Citizen, Not a Module

AI must not be treated as another service alongside ENS, ERS, or Contact Center. AI is a **cross-cutting platform capability** — a horizontal layer that every framework can leverage, and through which the platform exposes capabilities to AI agents.

```
Wrong model:
  ENS ──────── builds its own AI
  ERS ──────── builds its own AI
  Contact Center ─ builds its own AI

Correct model:
  ENS ──────────── Platform AI Layer
  ERS ──────────── Platform AI Layer
  Contact Center ── Platform AI Layer
                           │
                    Platform AI Layer
              (cross-cutting — serves all modules)
```

No module builds its own AI logic. The Platform AI Layer provides AI capabilities to every module through standard, versioned interfaces — exactly as the Platform Observability Framework provides logging, and the Platform Deployment Framework provides deployment.

---

### Principle AI-0 — Long-Term Platform Statement

> **The platform shall be designed so that every capability — communication, configuration, administration, monitoring, automation, and future services — can be consumed by both human users and AI agents through stable, secure, versioned interfaces. AI is treated as a first-class architectural capability, not as an application feature.**

This principle governs every future DIA, API, event schema, and data structure. When a component is designed so that only a human can use it, it is incomplete.

---

### Principle AI-1 — Every API Must Be AI-Consumable

APIs must be designed for machine consumption, not only for human-facing UIs.

- API responses return structured JSON with consistent, predictable, stable field names.
- No response may require string parsing to extract machine-readable data (e.g. embedding structured data in a human-readable message string).
- Pagination, filtering, and field projection must be available for bulk access patterns that AI agents require.
- Every API must be describable with a machine-readable schema (OpenAPI / JSON Schema).

A UI that works does not prove an API is AI-consumable. An AI agent that can integrate without human assistance does.

---

### Principle AI-2 — Every Event Must Be Machine-Readable

The event bus, ESL events, Socket.IO events, and all inter-module notifications must carry structured, typed payloads.

- No event payload may require string parsing to extract business-relevant data.
- Every event must carry: event type, timestamp, source module, tenant ID, and all relevant correlation IDs.
- Event schemas must be stable across minor platform versions.
- New event names and payload schemas are part of the DIA for the feature that introduces them.

---

### Principle AI-3 — Every Audit Record Must Be Available for AI Analysis

Audit records are not only for human compliance review. AI systems will analyse audit trails for anomaly detection, compliance monitoring, and behavioral analytics.

- Every audit record must be queryable by time range, actor, resource type, operation type, and tenant.
- Audit records must be structured JSON — never formatted text.
- Audit records must never be permanently deleted (soft-delete or archive only).
- The audit API must support bulk export for AI training and analytics pipelines.

---

### Principle AI-4 — Every Configuration Object Must Expose Structured Metadata

Configuration objects must expose typed, structured metadata that AI can consume without human interpretation.

- Every configuration schema must be describable as a machine-readable structure: field names, types, valid values, constraints, defaults.
- The platform catalog system is the authoritative metadata registry for FreeSWITCH concepts.
- AI configuration assistants will use catalog metadata to generate, validate, and explain configurations.

---

### Principle AI-5 — Every Workflow Must Be Automatable

No business workflow may be designed so that programmatic execution is structurally impossible.

- Workflows that today require human interaction must accept programmatic input from AI agents through the same API surface used by human callers.
- Authentication, authorization, and rate limiting apply equally to human and AI callers.
- Workflow state must be queryable at every step.

---

### Principle AI-6 — Platform AI Layer Is Reserved

The **Platform AI Layer** is a reserved architectural space. It is not yet implemented. No module may implement its own AI integration layer before the Platform AI Layer DIA is approved.

Until a sub-framework DIA is approved and implemented, no module may:
- Build a module-specific AI integration layer.
- Create a module-specific prompt management system.
- Create a module-specific model client.
- Create a module-specific vector database integration.
- Create a module-specific agent orchestration component.

When a module requires AI capabilities, the requirement is documented as a Platform AI Layer backlog item — not resolved with a module-level workaround. This is the same principle that prevents modules from implementing their own deployment pipeline (they use `DeploymentManager`) or their own logging (they use the platform logger).

See **Platform AI Layer Architecture** in `ARCHITECTURE.md`.

---

### Principle AI-7 — Multi-Provider Abstraction

The platform must never be coupled to a single AI model or vendor.

Every AI interaction must go through a provider abstraction layer (Platform AI Runtime). Supported provider classes:

| Provider Class | Examples |
|---|---|
| Commercial API providers | OpenAI, Anthropic Claude, Google Gemini |
| Cloud AI services | Azure OpenAI, AWS Bedrock, Google Vertex AI |
| Local / self-hosted | Ollama, vLLM, llama.cpp, LM Studio |
| Future providers | Any provider conforming to the abstraction contract |

**Rules:**
- No platform module may import an AI provider SDK directly. All AI calls go through the Platform AI Runtime.
- Switching providers is a configuration change, not a code change.
- Different models may be used simultaneously for different use cases (fast model for routing, larger model for summarization).
- Every AI interaction must record the model name, provider, and version used.

---

### Principle AI-8 — MCP Layer Architecture

The Model Context Protocol (MCP) is the standardized interface between AI agents and platform capabilities. The platform shall reserve architecture for a complete MCP layer.

| MCP Component | Purpose |
|---|---|
| MCP Server | Exposes platform capabilities as MCP-compatible resources and tools |
| MCP Client | Enables the platform's AI agents to call external MCP servers |
| Tool Registry | Registers platform capabilities as invokable AI tools |
| Tool Execution Framework | Executes tool calls with authentication, authorization, audit, and rate limiting |
| Resource Registry | Exposes platform data (configurations, incidents, campaigns, contacts) as MCP resources |
| Prompt Registry | Versioned prompt templates, reusable across all modules |
| Context Providers | Supply structured context: tenant, operation, call session, user |

MCP enables any AI agent — internal or external — to interact with platform capabilities through a standardized protocol, without custom per-module integrations.

---

### Principle AI-9 — AI Memory Architecture

AI interactions require access to multiple distinct memory types. These are separate services, not a single context object.

| Memory Type | Scope | Content |
|---|---|---|
| Session Memory | Single call or conversation | Current call state, conversation turns, in-progress decisions |
| User Memory | Per user, persistent | Preferences, past interactions, learned behaviors |
| Organization Memory | Per tenant, persistent | Tenant policies, customizations, domain-specific knowledge |
| Platform Knowledge | Platform-wide | FreeSWITCH knowledge, SIP standards, codec knowledge |
| Configuration Knowledge | Platform-wide, structured | Current configurations, templates, valid values, constraints |
| Operational History | Platform-wide, time-series | Past incidents, campaigns, deployments, outcomes |
| Incident History | Platform-wide | ERS incident patterns, resolution actions, responder behaviors |
| Documentation Knowledge | Platform-wide | Platform documentation, runbooks, best practices |
| Vector Knowledge Base | All scopes | Semantic search across all knowledge types |

These memory types will be implemented as services within the Platform AI Layer, reusable by all AI-powered modules.

---

### Principle AI-10 — AI Security & Governance

As AI becomes embedded in platform operations, governance must be explicit and enforceable.

| Concern | Requirement |
|---|---|
| Prompt Management | Prompts are versioned artifacts in the Prompt Registry, not embedded in code |
| Prompt Versioning | Prompt changes follow the same DIA and approval process as code changes |
| Model Versioning | The model and version used for every AI decision is recorded in the AI audit log |
| Tool Permissions | AI tools require explicit permission grants, scoped to tenant and role |
| AI Audit Logs | Every AI request, tool invocation, and AI-driven action is permanently logged |
| AI Action Approval | High-consequence AI actions (configuration changes, campaign triggers) require human approval |
| AI Policy Enforcement | Per-tenant AI policies govern what AI agents may and may not do |
| Human Approval Workflows | AI recommendations that modify system state require a configurable approval gate |
| AI Explainability | AI decisions that affect business operations must produce a human-readable rationale |
| AI Safety Controls | Rate limiting, cost caps, and output validation are platform-enforced, not per-module |

---

### Principle AI-11 — AI Observability

The Platform Observability Framework (Rules O-1 through O-12) applies to AI interactions exactly as it applies to every other platform operation. AI introduces additional telemetry dimensions that extend — not replace — the existing framework.

AI-specific telemetry (flows through the Platform Observability Framework):

| Metric | Purpose |
|---|---|
| Model latency | Time from request dispatch to first token and to full response |
| Token usage | Input and output tokens per request, per model, per tenant |
| Prompt execution time | Time to compose the prompt from templates and context |
| Tool execution history | Every tool invoked, its inputs, outputs, and duration |
| AI decision traces | The reasoning chain for multi-step AI agent operations |
| Cost monitoring | Token cost per request, per operation type, per tenant, per model |
| Model accuracy metrics | Measurable accuracy for deterministic AI tasks (routing, classification) |
| AI failure analysis | Failed requests, retries, fallbacks, model errors, and causes |

---

### Principle AI-12 — AI Event Model

Every AI action that produces a business-relevant outcome must emit a platform event. These events integrate with the Platform Event Framework and are consumable by the Observability Framework, audit trail, and future AI analytics.

| Event | When emitted |
|---|---|
| `ai.request.started` | An AI request is dispatched to a model |
| `ai.prompt.generated` | A prompt is composed from templates and context |
| `ai.model.selected` | A model is selected (static or dynamic routing) |
| `ai.tool.invoked` | An MCP tool call is dispatched |
| `ai.tool.completed` | An MCP tool call returns a result |
| `ai.recommendation.produced` | AI produces a recommendation for a platform operation |
| `ai.approval.requested` | A high-consequence action awaits human approval |
| `ai.approval.granted` | Human approves the AI recommendation |
| `ai.approval.rejected` | Human rejects the AI recommendation |
| `ai.workflow.executed` | An AI-driven workflow completes |
| `ai.failure` | An AI interaction fails after retries |

Payload must include: `model`, `provider`, `tenantId`, `userId` (if applicable), correlation IDs, `latency_ms`, `tokens_used`.

---

### Principle AI-13 — AI Plugin Ecosystem

AI capabilities must be extensible without modifying the Platform AI Layer core.

| Extension Point | Purpose |
|---|---|
| AI Skills | Reusable capability packages (summarize, classify, extract, translate, route) |
| AI Agents | Autonomous agents with defined scope, permissions, tool access, and audit footprint |
| AI Workflows | Multi-step AI-driven processes with human checkpoints |
| AI Models | New model registrations without code changes |
| AI Tools | New MCP-compatible tool registrations |
| AI Prompts | New versioned prompt templates |
| AI Connectors | Integrations with external AI services and data sources |
| AI Knowledge Providers | New sources of knowledge for the Vector Knowledge Base |

Adding a new Skill, Tool, or Prompt does not require a core code change. Extension follows the same principle as Provider registration — capabilities are discovered and registered dynamically.

---

### Principle AI-14 — Autonomous Operations (AIOps)

AI should operate the platform, not only serve its users. Future AI must include platform-level autonomous operations.

| Capability | Purpose |
|---|---|
| Incident Detection | Detect anomalies in platform metrics and events before human operators |
| Failure Prediction | Predict component failures from degradation trends |
| Root Cause Analysis | Correlate events, logs, and metrics to identify failure cause |
| Capacity Planning | Recommend resource adjustments from usage trends |
| Performance Optimization | Identify configuration changes that would improve performance |
| Configuration Validation | Detect invalid or suboptimal configurations before deployment |
| Security Anomaly Detection | Identify unusual access patterns, authentication failures, data exfiltration |
| Self-Healing Recommendations | Recommend or automatically execute approved remediation actions |

AIOps capabilities consume the same platform APIs, events, and audit records as any other AI agent — they are an application of the Platform AI Layer, not separate infrastructure.

---

### AI-First DIA Requirement

Every Design Impact Assessment (Section 4 — New Components Proposed) must include:

> **AI-First Statement:** Confirm that the component's API, event schema, and data structures satisfy Principles AI-0 through AI-5. For components that directly involve AI, also confirm compliance with AI-7 through AI-12 where applicable. If any principle is not applicable, state why.

---

## Required Output: Design Impact Assessment

**No code may be written until a Design Impact Assessment has been produced and approved.**

The assessment must contain:

### 1. Objective
What feature is being implemented?

### 2. Existing Components Reused (unchanged)
List every class, store, service, hook, renderer, provider, or manager reused as-is.

### 3. Existing Components Extended
List every component requiring extension. Explain why. Show the exact addition is additive.

### 4. New Components Proposed
For every proposed new component:
- Why existing code cannot support the requirement
- Why extension is insufficient
- Which future modules will reuse it (must include Dialplan, Directory, IVR, Call Center)
- Why it belongs in the generic framework, not in a module

### 5. Regression Analysis
For each existing module, state explicitly that it is unaffected and why.
Modules: vars.xml, switch.conf.xml, event_socket.conf.xml, acl.conf.xml,
sofia.conf.xml, conference.conf.xml, all gateway providers.

### 6. Files Changed
- Files modified: file path + one-line justification
- Files created: file path + one-line justification

### 7. Observability Plan

For every new feature, answer all of the following:

**Operational logs (INFO — always on):**
List the business events that will be logged and what correlation IDs they carry.

**Debug logs (DEBUG — off in production):**
List the execution checkpoints that will be traceable in development.

**Performance logs:**
Identify any operations with a latency budget that will be measured.

**Sensitive data audit:**
Confirm no passwords, tokens, secrets, or credentials appear in any log path.

**Module name:**
State the `module` value used in all log entries for this feature.

A feature with no Observability Plan is incomplete. Do not proceed without it.

### 8. Approval Gate
**Stop here. Do not write code until the assessment is reviewed and approved.**

---

## Development Process Per Phase

1. Analyze the requirement
2. Produce Design Impact Assessment
3. Wait for approval — **do not proceed without it**
4. Implement only the approved scope
5. Verify no regression in existing providers
6. Stop — do not automatically continue to the next phase

---

## Backward Compatibility Contract

The following modules are production code. Any change that alters their behavior,
API, or file output is a regression and must be stopped immediately:

- `vars.xml` / `VarsProvider`
- `switch.conf.xml` / `SwitchCoreProvider`
- `event_socket.conf.xml` / `EventSocketProvider`
- `acl.conf.xml` / `AclProvider`
- `sofia.conf.xml` / `SofiaProvider`
- `conference.conf.xml` / `ConferenceProvider`
- All `gateway:*` providers / `GatewayFileProvider`

---

## Existing Framework Capabilities (Already Available)

The framework already provides. Your first assumption must be that these are sufficient:

- **Platform logger**: `logger` from `src/infrastructure/index.js` — structured JSON, level-based (DEBUG/INFO/WARN/ERROR), configurable per-module via environment variables. **Use this. Do not create alternatives.**
- **Metrics**: `metrics` from `src/infrastructure/index.js` — prom-client v15 counters, histograms, gauges.
- **Event bus**: `eventBus` from `src/infrastructure/index.js` — in-process event bus for decoupled module communication.
- **Health checks**: `getHealthStatus`, `getLivenessStatus` from `src/infrastructure/index.js` — `/health/live`, `/health/ready`, `/health/full`, `/metrics` endpoints.
- XML parsing: `XmlParser`, `SegmentUtils`, module-specific parsers, `DialplanParser`
- Catalogs: `dialplanCatalog` (FreeSWITCH platform knowledge), per-provider metadata catalogs
- Providers: `ConfigurationProvider` base class with `parse / serialize / applyChanges / validate / diff`; `docType` getter for flat vs hierarchical routing
- Registry: `ProviderRegistry` with `register / get / has / list`
- Configuration Manager: `read / preview / deploy / rollback / getHistory / getAuditLog`
- Driver: `FreeSwitchDriver` with `resolveConfigurationPath(type, relativePath)` (generic, covers all modules)
- Deployment: `DeploymentManager` 13-step pipeline, `AtomicWriter`, `BackupManager`
- Deployment strategies: `DeploymentStrategy` (RELOAD_XML, SOFIA_RESCAN, RELOAD_MODULE, RESTART_MODULE)
- History: `VersionManager`
- Audit: `AuditLogger`
- Frontend hooks: `useConfigProvider`, `useDeployment`
- Frontend stores: `configChangesStore` (flat mode + ordered-ops mode for hierarchical providers)
- Frontend pages: `ConfigPage`, `ConfigCenter`, `ConfigHistory`, `ConfigAudit`, `DeployModal`
- Provider discovery: `discoverGatewayProviders` pattern — reuse for all future dynamic discovery

**See also:**
- `ARCHITECTURE.md` for the full architectural specifications: Configuration Ownership,
  Configuration Authority, Deployment Responsibility, Managed vs Generated XML,
  FreeSWITCH Platform Knowledge Catalog + Catalog Rules + Metadata Vocabulary,
  XML Document Contract, Path Resolution Rule rationale, Discovery Rule, and Provider
  Constructor Guideline.
- Platform Technical Invariants section (above) for enforcement rules: Path Resolution Rule,
  Filesystem Discovery Rule, Discovery Before Configuration Rule, Provider Identity Rule.

---

## Success Criteria

A successful implementation is measured by:

- Maximum reuse of existing framework
- Minimal code changes
- Zero regressions
- Backward compatibility preserved
- Generic, reusable solutions
- Clean integration into the approved architecture
- Observable execution path — operational events logged with correlation IDs, sensitive data absent, no forensic probes remaining

**Not** by the number of new abstractions created, and **not** by features that cannot be traced through logs.

---

## Final Instruction

> **The existing Config Center is a production-grade framework.**
> The default assumption is: "The existing framework is sufficient unless I can prove otherwise."
>
> Never introduce new infrastructure because it is cleaner or more elegant.
> Only introduce it when there is a demonstrated technical limitation that cannot be solved
> by extending the existing generic framework.

---

## Multi-Repository Governance

This project consists of three repositories with strictly defined, non-overlapping responsibilities.

### Repository Roles

| Repository | Role | Authoritative For |
|---|---|---|
| **fs-enrs** | ENRS application development | All ENRS backend, frontend, migrations, tests, business logic, APIs, auth, UI |
| **fs-cc** | Contact Center development | All CC backend, frontend, migrations, tests, business logic, APIs, auth, UI |
| **fs-cp** | Integration + deployment ONLY | Docker Compose, Nginx, production Dockerfiles, deployment scripts, integration environment config |

### Direction of Flow — Non-Negotiable

```
fs-enrs  ────────────────► fs-cp/fs-enrs   (development → integration)
fs-cc    ────────────────► fs-cp/fs-cc     (development → integration)
```

**This direction is never reversed.** fs-cp is a consumer of tested application code, never a producer.

### Source-of-Truth Priority

```
ENRS application code:       fs-enrs  > fs-cp
CC application code:         fs-cc    > fs-cp
Integration/deployment code: fs-cp    (authoritative)
```

If fs-cp contains application code that differs from fs-enrs or fs-cc, **fs-enrs or fs-cc wins**, unless the difference is explicitly identified as an fs-cp-specific deployment modification.

### Prohibited Actions

- Do NOT author or modify ENRS application code in fs-cp.
- Do NOT author or modify CC application code in fs-cp.
- Do NOT copy fs-cp application code back into fs-enrs or fs-cc without explicit review and approval as source-recovery work.
- Do NOT assume fs-cp is the authoritative version of any application file merely because it is present there or appears newer there.

### Bug Fix Rule

If an application bug is discovered during fs-cp integration testing:

1. Identify whether the bug belongs to ENRS (`fs-enrs`) or CC (`fs-cc`).
2. Fix it in the authoritative source repository.
3. Test and commit it there.
4. Promote that commit into fs-cp.
5. Rebuild the integrated Docker image.
6. Test again.

Never fix application code directly in fs-cp.

### Drift Classification

When fs-cp differs from the authoritative source, every difference must be classified before any file is modified:

| Category | Description | Authoritative Source |
|---|---|---|
| A — ENRS application source | Controllers, routes, middleware, services, migrations, frontend pages, tests, auth, ENRS config | fs-enrs |
| B — CC application source | CC controllers, routes, services, migrations, frontend, CC config | fs-cc |
| C — Deployment / integration | docker-compose.yml, Nginx config, production Dockerfiles, deployment scripts, integration env templates | fs-cp |
| D — Unknown / ambiguous | Do NOT modify; report for manual approval | — |

### Integration Sequence

Only after source repositories are verified and committed:

1. Copy fs-enrs HEAD into `fs-cp/fs-enrs/`.
2. Copy fs-cc HEAD into `fs-cp/fs-cc/`.
3. Preserve all `fs-cp`-authoritative deployment files (docker-compose, Nginx, scripts).
4. Commit the integration update to fs-cp.
5. Build Docker images.
6. Run integration tests.

### Phase Protocol for Multi-Repo Work

Any task touching more than one repository must proceed in phases:

- **Phase 0 — Read-only audit:** Inspect all three repos. Collect HEAD SHAs, working tree status, branch states. Do not modify anything.
- **Phase 1 — Classify differences:** Determine ownership of every difference. Produce LIST 1 (safe to sync), LIST 2 (must move to source repo first), LIST 3 (do not touch).
- **Phase 2 — Source-repo commits:** Make all application changes in fs-enrs and/or fs-cc. Test there.
- **Phase 3 — fs-cp integration:** Promote tested source commits into fs-cp. Preserve deployment files.
- **Phase 4 — Build and test:** Docker build, integration test, report results.

**Stop at the end of each phase. Do not proceed to the next phase without explicit approval.**
