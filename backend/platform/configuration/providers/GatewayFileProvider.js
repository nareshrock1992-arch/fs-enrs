import { ConfigurationProvider } from '../ConfigurationProvider.js';
import {
  parse    as gpParse,
  serialize as gpSerialize,
  buildIndex,
  groupByKey,
  applyChanges as gpApplyChanges,
  toEntries,
  diffEntries,
} from '../parsers/GatewayParser.js';
import { lookupGatewayParam } from '../catalogs/gatewayCatalog.js';

/**
 * GatewayFileProvider — manages one FreeSWITCH gateway XML file.
 *
 * A gateway file lives at:
 *   ${sipProfileDir}/${profileName}/${fileBasename}.xml
 *
 * Provider ID convention:  'gateway:${profileName}:${fileBasename}'
 * Example:  gateway:external:avaya   →  sip_profiles/external/avaya.xml
 *           gateway:internal:sbc     →  sip_profiles/internal/sbc.xml
 *
 * Instances are created dynamically by the gateway discovery logic in
 * providers/index.js.  No profile name or gateway name is hardcoded here.
 *
 * Deployment: reloadxml then sofia profile <profileName> rescan.
 * Only the specific SIP profile is rescanned — unrelated profiles are not
 * touched and active calls are not interrupted.
 */
export class GatewayFileProvider extends ConfigurationProvider {

  #profileName;
  #fileBasename;

  /**
   * @param {PlatformDriver} driver
   * @param {string}         profileName  — SIP profile directory name (e.g. 'external')
   * @param {string}         fileBasename — filename without .xml extension (e.g. 'avaya')
   */
  constructor(driver, profileName, fileBasename) {
    super(driver);
    if (!profileName || typeof profileName !== 'string') {
      throw new Error('GatewayFileProvider: profileName is required');
    }
    if (!fileBasename || typeof fileBasename !== 'string') {
      throw new Error('GatewayFileProvider: fileBasename is required');
    }
    this.#profileName  = profileName;
    this.#fileBasename = fileBasename;
  }

  // ── Identity ──────────────────────────────────────────────────────────────────

  get id() {
    return `gateway:${this.#profileName}:${this.#fileBasename}`;
  }

  get name() {
    return `${this.#fileBasename} (${this.#profileName})`;
  }

  get description() {
    return `SIP gateway ${this.#fileBasename} in profile ${this.#profileName}`;
  }

  /** Per-instance deployment strategy: rescan only the affected SIP profile. */
  get deploymentStrategy() {
    const profileName = this.#profileName;
    return {
      id:                   'sofia_rescan',
      label:                `Rescan SIP Profile (${profileName})`,
      description:
        `Writes gateway XML, runs reloadxml, then rescans the '${profileName}' ` +
        'SIP profile. Active calls on other profiles are not affected.',
      riskLevel:            'medium',
      requiresConfirmation: false,
      steps: [
        {
          name:    'Reload XML',
          execute: async (driver) => driver.reloadXml(),
        },
        {
          name:    `Rescan ${profileName}`,
          execute: async (driver) => driver.rescanSofiaGateway(profileName),
        },
      ],
    };
  }

  get deploymentMeta() {
    return {
      action:               'sofia_rescan',
      actionLabel:          `Rescan ${this.#profileName}`,
      description:
        `Writes ${this.#fileBasename}.xml and rescans the '${this.#profileName}' SIP profile. ` +
        'Active calls are not interrupted.',
      affectedServices:     [`mod_sofia/${this.#profileName}`, `Gateway ${this.#fileBasename}`],
      restartRequired:      false,
      estimatedDowntime:    'None — only the named gateway is reloaded.',
      riskLevel:            'medium',
      requiresConfirmation: false,
    };
  }

  // ── Path ──────────────────────────────────────────────────────────────────────

  getFilePath() {
    return this.driver.resolveSipProfilePath(
      `${this.#profileName}/${this.#fileBasename}.xml`
    );
  }

  // ── Parse ─────────────────────────────────────────────────────────────────────

  parse(rawContent) {
    const { segments, index, checksum, gatewayMeta } = gpParse(rawContent);
    const entries = this._buildEntries(segments, gatewayMeta);
    return { segments, index, entries, checksum, gatewayMeta };
  }

  // ── Serialize ─────────────────────────────────────────────────────────────────

  serialize(doc) {
    return gpSerialize(doc.segments);
  }

  // ── Apply changes ─────────────────────────────────────────────────────────────

  applyChanges(doc, changes) {
    const newSegments = gpApplyChanges(doc.segments, doc.index, changes);
    const newIndex    = buildIndex(newSegments);
    const newEntries  = this._buildEntries(newSegments, doc.gatewayMeta);
    return { segments: newSegments, index: newIndex, entries: newEntries, checksum: null, gatewayMeta: doc.gatewayMeta };
  }

  // ── Validate ──────────────────────────────────────────────────────────────────

  validate(doc) {
    const errors   = [];
    const warnings = [];
    const { entries = [], gatewayMeta = {} } = doc;

    // Warn when the gateway container tag itself is commented out.
    if (gatewayMeta.gatewayEnabled === false && gatewayMeta.name) {
      warnings.push(
        `Gateway '${gatewayMeta.name}' container tag is commented out. ` +
        'Params cannot take effect until the <gateway> tag itself is uncommented.'
      );
    }

    const activeEntries = new Map(
      entries
        .filter(e => e.enabled)
        .map(e => [e.key, e.value])
    );

    // proxy is required for any gateway that will carry traffic.
    if (!activeEntries.has('proxy')) {
      warnings.push(
        "'proxy' is not set. FreeSWITCH cannot route calls through a gateway without a proxy address."
      );
    }

    // transport must be one of: udp, tcp, tls (when present).
    const transport = activeEntries.get('transport') ?? activeEntries.get('register-transport');
    if (transport && !['udp', 'tcp', 'tls'].includes(transport.toLowerCase())) {
      errors.push(`'transport' value '${transport}' is not valid. Must be udp, tcp, or tls.`);
    }

    // register must be a boolean string.
    const reg = activeEntries.get('register');
    if (reg !== undefined && reg !== 'true' && reg !== 'false') {
      errors.push(`'register' value '${reg}' is not valid. Must be 'true' or 'false'.`);
    }

    // When register is true, username and password are required.
    if (reg === 'true') {
      if (!activeEntries.has('username')) {
        errors.push("'username' is required when register is true.");
      }
      if (!activeEntries.has('password')) {
        errors.push("'password' is required when register is true.");
      }
    }

    // Warn when credentials are present but register is false.
    if (reg === 'false' && activeEntries.has('password')) {
      warnings.push(
        "'password' is set but register is false. Credentials are not used for non-registering gateways."
      );
    }

    // Integer range checks.
    const intRanges = {
      'expire-seconds': { min: 60,  max: 86400 },
      'retry-seconds':  { min: 5,   max: 3600  },
      'ping':           { min: 5,   max: 300   },
      'ping-max':       { min: 1,   max: 20    },
      'ping-min':       { min: 1,   max: 20    },
      'reg-id':         { min: 1,   max: 100   },
    };
    for (const [param, range] of Object.entries(intRanges)) {
      const val = activeEntries.get(param);
      if (val !== undefined) {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < range.min || n > range.max) {
          errors.push(
            `'${param}' value '${val}' must be an integer from ${range.min} to ${range.max}.`
          );
        }
      }
    }

    // Boolean params.
    for (const boolParam of ['extension-in-contact', 'caller-id-in-from', 'rfc-5626']) {
      const val = activeEntries.get(boolParam);
      if (val !== undefined && val !== 'true' && val !== 'false') {
        errors.push(`'${boolParam}' value '${val}' must be 'true' or 'false'.`);
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  // ── Diff ──────────────────────────────────────────────────────────────────────

  diff(oldRaw, newRaw) {
    const { segments: oldSeg } = gpParse(oldRaw);
    const { segments: newSeg } = gpParse(newRaw);
    return diffEntries(toEntries(oldSeg), toEntries(newSeg)) || '(no parameter changes)';
  }

  // ── Accessors for discovery metadata ─────────────────────────────────────────

  /** The SIP profile this gateway belongs to (e.g. 'external'). */
  get profileName()  { return this.#profileName; }

  /** The file basename without .xml (e.g. 'avaya'). */
  get fileBasename() { return this.#fileBasename; }

  // ── Private ───────────────────────────────────────────────────────────────────

  _buildEntries(segments, gatewayMeta = {}) {
    return groupByKey(segments).map(({ key, primary, alternatives }) => ({
      key,
      value:          primary.value,
      enabled:        primary.enabled,
      definitionId:   primary.definitionId,
      gatewayName:    gatewayMeta.name    ?? null,
      gatewayEnabled: gatewayMeta.gatewayEnabled ?? true,
      profileName:    this.#profileName,
      ...lookupGatewayParam(key),
      alternatives: alternatives.map(alt => ({
        value:        alt.value,
        enabled:      alt.enabled,
        definitionId: alt.definitionId,
        disabledHint: 'XML comment',
      })),
    }));
  }
}
