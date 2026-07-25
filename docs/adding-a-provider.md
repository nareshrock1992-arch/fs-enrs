# Adding a Configuration Provider

This guide explains how to add a new provider to the Config Framework. **No frontend changes are required** — the existing React components (ConfigPage, ConfigSection, ConfigCard) work with any provider automatically.

---

## What a provider is

A provider manages one FreeSWITCH configuration file. It knows how to:
- Parse the file into an in-memory document
- Serialize the document back to file content
- Apply changes to the document
- Validate the document
- Locate the file on disk

The deploy pipeline, version history, backup, audit log, and drift detection all come for free. The provider supplies only domain knowledge.

---

## The four steps

### Step 1 — Parser

Create `backend/platform/configuration/parsers/SwitchParser.js`.

The parser must be pure (no I/O). It receives raw file content and returns a document object. The document must include:

```js
{
  entries: [{ key, value, enabled }],  // required
  checksum: string,                    // sha256 of rawContent
  // ... any other provider-specific fields (segments, index, etc.)
}
```

Export named functions matching the parser pattern:
```js
export function parse(rawContent)      { ... } // → { entries, checksum, ... }
export function serialize(doc)         { ... } // → string
export function applyChanges(doc, changes) { ... } // → new doc (immutable)
```

Reference implementation: [`parsers/VarsParser.js`](../backend/platform/configuration/parsers/VarsParser.js)

**Disabled entries**: If your file format supports commented-out entries, model them as `{ enabled: false }` in the entries array. VarsParser handles this for the vars.xml `<!-- <X-PRE-PROCESS .../> -->` pattern.

---

### Step 2 — Catalog

Create `backend/platform/configuration/catalogs/switchCatalog.js`.

The catalog maps known configuration keys to human-readable metadata. Unknown keys still appear in the UI under the "Custom" category with `visibility: 'advanced'`.

```js
// switchCatalog.js
export const switchCatalog = {
  'max-sessions': {
    label:       'Max Sessions',
    description: 'Maximum number of concurrent sessions.',
    category:    'Performance',
    group:       'Limits',
    visibility:  'basic',    // 'basic' | 'advanced' | 'expert' | 'hidden'
    type:        'integer',  // 'string' | 'integer' | 'boolean' | 'select' | 'ip' | 'port' | 'path' | 'password'
    riskLevel:   'medium',   // 'low' | 'medium' | 'high'
    restartRequired: false,
  },
  // ...
};

export function lookupSwitch(key) {
  const meta = switchCatalog[key] ?? {
    category:   'Custom',
    label:       key,
    visibility: 'advanced',
  };
  // Return both flat (for backward compat) and nested under `metadata`
  return { ...meta, metadata: meta };
}
```

Full field reference: [`metadata/metadataSchema.js`](../backend/platform/configuration/metadata/metadataSchema.js)

---

### Step 3 — Provider

Create `backend/platform/configuration/providers/SwitchProvider.js`.

```js
import { ConfigurationProvider } from '../ConfigurationProvider.js';
import { DeploymentStrategies }  from '../deploy/DeploymentStrategy.js';
import { parse, serialize, applyChanges } from '../parsers/SwitchParser.js';
import { switchCatalog, lookupSwitch }    from '../catalogs/switchCatalog.js';

export class SwitchProvider extends ConfigurationProvider {

  get id()          { return 'switch'; }
  get name()        { return 'Switch Core'; }
  get description() { return 'Core FreeSWITCH switch settings — switch.conf.xml'; }
  get deploymentStrategy() { return DeploymentStrategies.RELOAD_MODULE; }
  get catalog()     { return switchCatalog; }

  getFilePath() {
    return this.driver.resolveConfigPath('autoload_configs/switch.conf.xml');
  }

  parse(rawContent) {
    const { entries, checksum, ...rest } = parse(rawContent);
    return {
      ...rest,
      entries: entries.map(e => ({ ...e, ...lookupSwitch(e.key) })),
      checksum,
    };
  }

  serialize(doc)               { return serialize(doc); }
  applyChanges(doc, changes)   { return applyChanges(doc, changes); }

  validate(doc) {
    const errors = [], warnings = [];
    // Domain-specific validation here
    return { valid: errors.length === 0, errors, warnings };
  }
}
```

Contract reference: [`ConfigurationProvider.js`](../backend/platform/configuration/ConfigurationProvider.js)

The provider **never touches the filesystem** — all I/O is handled by `DeploymentManager`.

---

### Step 4 — Registration

Open `backend/platform/configuration/providers/index.js` and add **two lines**:

```js
import { SwitchProvider } from './SwitchProvider.js';   // ← add import

export function registerAll(registry, driver) {
  registry.register(new VarsProvider(driver));
  registry.register(new SwitchProvider(driver));         // ← add registration
}
```

That is the only file outside the provider package that needs to change.

---

## Architecture proof

The claim: _SwitchProvider requires only Parser + Catalog + Provider + Registration, and no frontend changes_.

| Layer | Change needed? | Why |
|-------|---------------|-----|
| Parser (`SwitchParser.js`) | Yes — new file | Domain-specific parse/serialize logic |
| Catalog (`switchCatalog.js`) | Yes — new file | Human-readable metadata for UI |
| Provider (`SwitchProvider.js`) | Yes — new file | Wires parser + catalog into the framework contract |
| Provider manifest (`providers/index.js`) | 2 lines | `import` + `registry.register()` |
| Route handler (`platformConfig.js`) | No change | Uses `registerAll()` |
| ConfigurationManager | No change | Generic — works with any provider |
| DeploymentManager | No change | Generic — all I/O, no provider awareness |
| Frontend (ConfigPage, ConfigSection, ConfigCard) | No change | Driven entirely by the API response shape |
| Frontend (api/client.js, hooks) | No change | Provider ID is a URL segment parameter |
| Database migrations | No change | Existing `config_versions` / `config_audit_log` tables are provider-agnostic |

The frontend renders whatever the API returns. Adding `SwitchProvider` causes a new entry to appear in the provider list, and navigating to `/platform/config/switch` loads and renders it using the exact same React components as `vars`.

---

## Deployment strategies

| Strategy | When to use | Risk | Requires confirmation |
|----------|------------|------|-----------------------|
| `RELOAD_XML` | Global variables, dialplan | Low | No |
| `SOFIA_RESCAN` | SIP profiles, gateways | Medium | No |
| `RELOAD_MODULE` | Module-specific config | Medium | No |
| `RESTART_MODULE` | Config only applied at module restart | High | Yes |

---

## Adding tests

Use the generic contract suite to cover your provider in minutes:

```js
// backend/src/__tests__/unit/SwitchProvider.contract.test.js
import { runProviderContractTests } from './providerContractSuite.js';
import { SwitchProvider } from '../../../platform/configuration/providers/SwitchProvider.js';

const STUB_DRIVER = { resolveConfigPath: () => '/dev/null' };

runProviderContractTests(
  () => new SwitchProvider(STUB_DRIVER),
  {
    validContent:      '...minimal valid switch.conf.xml...',
    sampleChangeKey:   'max-sessions',
    sampleChangeValue: '2000',
    knownKeys:         ['max-sessions', 'sessions-per-second'],
  }
);
```

The suite runs 20+ assertions covering parse, serialize, round-trip, applyChanges, validate, and hooks. Add provider-specific tests on top for domain rules (invalid values, dangerous defaults, etc.).

---

## Checklist

- [ ] `parsers/SwitchParser.js` — `parse()`, `serialize()`, `applyChanges()` (all pure)
- [ ] `catalogs/switchCatalog.js` — metadata for known keys + `lookupSwitch()`
- [ ] `providers/SwitchProvider.js` — extends `ConfigurationProvider`
- [ ] `providers/index.js` — import + `registry.register()`
- [ ] `src/__tests__/unit/SwitchProvider.contract.test.js` — passes `runProviderContractTests`
- [ ] Validate: `npm test` passes
