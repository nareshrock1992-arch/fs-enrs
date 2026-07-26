# GOVERNANCE.md — Enterprise Platform Development Governance

**This file is a permanent mandatory instruction for all development on this repository.**
**Claude Code must read and follow this file before writing any code, in every session.**
**See also: ARCHITECTURE.md — the frozen architectural specification.**

---

## Project Status

The architecture of the Enterprise FreeSWITCH Management Platform is **approved and frozen**.

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
- Which future modules (Dialplan, Directory, IVR, Call Center, at minimum) will reuse it without modification

Only then create it.

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

---

## Genericity Rule

Every new component must satisfy:
> "Can this component be reused without modification by Dialplan, Directory, IVR, and Call Center?"

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
See ARCHITECTURE.md — "Path Resolution Rule".
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

### 7. Approval Gate
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

**See also:** `ARCHITECTURE.md` for the full platform governance rules including
Configuration Ownership, Configuration Authority, Deployment Responsibility,
Managed vs Generated XML, FreeSWITCH Platform Knowledge Catalog, XML Document
Contract, Path Resolution Rule, Discovery Rule, and Provider Constructor Guideline.

---

## Success Criteria

A successful implementation is measured by:

- Maximum reuse of existing framework
- Minimal code changes
- Zero regressions
- Backward compatibility preserved
- Generic, reusable solutions
- Clean integration into the approved architecture

**Not** by the number of new abstractions created.

---

## Final Instruction

> **The existing Config Center is a production-grade framework.**
> The default assumption is: "The existing framework is sufficient unless I can prove otherwise."
>
> Never introduce new infrastructure because it is cleaner or more elegant.
> Only introduce it when there is a demonstrated technical limitation that cannot be solved
> by extending the existing generic framework.
