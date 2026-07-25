import { ConfigurationProvider } from '../ConfigurationProvider.js';
import { DeploymentStrategies }  from '../deploy/DeploymentStrategy.js';
import {
  parse    as cpParse,
  serialize as cpSerialize,
  buildIndex,
  groupByKey,
  applyChanges as cpApplyChanges,
  toEntries,
  diffEntries,
  splitKey,
} from '../parsers/ConferenceParser.js';
import { lookupConferenceParam } from '../catalogs/conferenceCatalog.js';

/**
 * ConferenceProvider — manages FreeSWITCH conference.conf.xml.
 *
 * conference.conf.xml defines multiple named conference profiles (default,
 * wideband, ultrawideband, cdquality, sla, video-mcu-stereo, …).  Each profile
 * contains <param name="K" value="V"/> entries.
 *
 * Entries are keyed as 'profileName___paramName' so the segment index can
 * distinguish same-named params across different profiles.
 *
 * The <advertise> and <caller-controls> sections are preserved verbatim —
 * they use different XML element types (room, group, control) and are not
 * managed by this provider.
 */
export class ConferenceProvider extends ConfigurationProvider {

  constructor(driver) {
    super(driver);
  }

  // ── Identity ──────────────────────────────────────────────────────────────────

  get id()          { return 'conference'; }
  get name()        { return 'Conference Profiles'; }
  get description() { return 'mod_conference profile settings — conference.conf.xml'; }

  get deploymentStrategy() { return DeploymentStrategies.RELOAD_XML; }

  get deploymentMeta() {
    return {
      action:               'reloadxml',
      actionLabel:          'Reload XML Configuration',
      description:
        'Writes conference.conf.xml and runs reloadxml. ' +
        'Changes take effect for new conference rooms; existing active rooms ' +
        'continue with their previous settings until they end.',
      affectedServices:     ['mod_conference', 'Conference Rooms'],
      restartRequired:      false,
      estimatedDowntime:    'None — active conferences are not affected.',
      riskLevel:            'low',
      requiresConfirmation: false,
    };
  }

  // ── Path ──────────────────────────────────────────────────────────────────────

  getFilePath() {
    return this.driver.resolveConfigPath('autoload_configs/conference.conf.xml');
  }

  // ── Parse ─────────────────────────────────────────────────────────────────────

  parse(rawContent) {
    const { segments, checksum } = cpParse(rawContent);
    const index   = buildIndex(segments);
    const entries = this._buildEntries(segments);
    return { segments, index, entries, checksum };
  }

  // ── Serialize ─────────────────────────────────────────────────────────────────

  serialize(doc) {
    return cpSerialize(doc.segments);
  }

  // ── Apply changes ─────────────────────────────────────────────────────────────

  applyChanges(doc, changes) {
    let newSegments = cpApplyChanges(doc.segments, doc.index, changes);

    // Patch any new segments (created by applyChanges for unknown keys) to
    // inject _profileName and _paramName so serialize() can reconstruct them.
    newSegments = newSegments.map(seg => {
      if (seg.type === 'entry' && !seg._profileName && seg.key) {
        const { profileName, paramName } = splitKey(seg.key);
        return { ...seg, _profileName: profileName, _paramName: paramName };
      }
      return seg;
    });

    const newIndex   = buildIndex(newSegments);
    const newEntries = this._buildEntries(newSegments);
    return { segments: newSegments, index: newIndex, entries: newEntries, checksum: null };
  }

  // ── Validate ──────────────────────────────────────────────────────────────────

  validate(doc) {
    const errors   = [];
    const warnings = [];

    for (const entry of doc.entries ?? []) {
      if (!entry.key || typeof entry.key !== 'string') {
        errors.push('Found a parameter with an empty or invalid name.');
        continue;
      }

      if (!entry.enabled) continue;

      const { paramName } = splitKey(entry.key);

      // Integer range checks
      const intParams = {
        rate:              { min: 8000,  max: 48000 },
        interval:          { min: 10,    max: 60    },
        'energy-level':    { min: 0,     max: 1800  },
        channels:          { min: 1,     max: 2     },
        'pin-retries':     { min: 1,     max: 10    },
        'video-fps':       { min: 1,     max: 60    },
        'video-auto-floor-msec': { min: 0, max: 10000 },
        'ivr-dtmf-timeout':     { min: 100, max: 5000 },
        'ivr-input-timeout':    { min: 0,   max: 60000 },
        'endconf-grace-time':   { min: 0,   max: 3600  },
      };

      if (intParams[paramName] !== undefined) {
        const n = parseInt(entry.value, 10);
        const { min, max } = intParams[paramName];
        if (isNaN(n) || n < min || n > max) {
          errors.push(
            `'${entry.key}': value '${entry.value}' must be an integer from ${min} to ${max}.`
          );
        }
      }

      // Boolean params
      if (paramName === 'comfort-noise' && entry.value !== '' &&
          entry.value !== 'true' && entry.value !== 'false') {
        errors.push(`'${entry.key}': value must be 'true' or 'false'.`);
      }

      // Warn when PIN is set (operational note)
      if (paramName === 'pin' && entry.value) {
        warnings.push(
          `Profile '${splitKey(entry.key).profileName}' has a PIN set. ` +
          'Verify PIN is intentional — it will block all callers who do not know it.'
        );
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  // ── Diff ──────────────────────────────────────────────────────────────────────

  diff(oldRaw, newRaw) {
    const { segments: oldSeg } = cpParse(oldRaw);
    const { segments: newSeg } = cpParse(newRaw);
    return diffEntries(toEntries(oldSeg), toEntries(newSeg)) || '(no parameter changes)';
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _buildEntries(segments) {
    return groupByKey(segments).map(({ key, primary, alternatives }) => {
      const { profileName, paramName } = splitKey(key);
      return {
        key,
        value:        primary.value,
        enabled:      primary.enabled,
        definitionId: primary.definitionId,
        profileName,
        paramName,
        ...lookupConferenceParam(key),
        alternatives: alternatives.map(alt => ({
          value:        alt.value,
          enabled:      alt.enabled,
          definitionId: alt.definitionId,
          disabledHint: 'XML comment',
        })),
      };
    });
  }
}
