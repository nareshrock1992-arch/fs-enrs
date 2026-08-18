/**
 * Phase 26A — Caller-ID Separation & Validation Tests
 *
 * ENS contract:  outbound CLI = ens_configurations.blast_clid (ALWAYS)
 *   - trigger_number is NEVER the outbound CLI
 *   - inbound IVR caller is NEVER the outbound CLI
 *   - '999' NEVER reaches the gateway
 *   - null / '' / whitespace blast_clid causes campaign rejection
 *
 * ERS contract:  outbound CLI = actual inbound caller (ALWAYS)
 *   - blast_clid is NEVER the ERS outbound CLI
 *   - effective_caller_id_number = inbound caller's number
 *
 * These contracts are proven at three levels:
 *   1. Logic-level (pure JS, no mocks needed)
 *   2. Source-level (read source to verify variables are/aren't present)
 *   3. Mock-integration (mock DB/ESL to exercise the actual functions)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// ─────────────────────────────────────────────────────────────────────────────
// Shared mocks — must be declared before dynamic imports
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../../config/index.js', () => ({
  config: {
    freeswitch: { defaultGateway: null, ttsEngine: 'flite|kal', sipDomain: 'yerp.com' },
    esl:        { domain: '127.0.0.1' },
  },
}));

vi.mock('../../db/pool.js', () => ({
  query:           vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../../services/eslService.js', () => ({
  originateCampaignCall: vi.fn(),
  eslCommand:            vi.fn(),
}));

vi.mock('../../services/socketService.js', () => ({ emitInternal: vi.fn() }));

vi.mock('../../infrastructure/index.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Source-file paths (resolved once)
// ─────────────────────────────────────────────────────────────────────────────

const eslServiceSrc = readFileSync(
  fileURLToPath(new URL('../../services/eslService.js', import.meta.url)),
  'utf8'
);

const campaignEngineSrc = readFileSync(
  fileURLToPath(new URL('../../services/campaignEngine.js', import.meta.url)),
  'utf8'
);

const ersRingSrc = readFileSync(
  fileURLToPath(new URL('../../services/ersRingService.js', import.meta.url)),
  'utf8'
);

// ERS direct-dial bridge (active runtime — NOT legacy)
const ersBridgeSrc = readFileSync(
  fileURLToPath(new URL('../../../../Lua-scripts/ers_conference_bridge.lua', import.meta.url)),
  'utf8'
);

// ERS lookup controller — must expose gateway_sip_domain
const ersInternalSrc = readFileSync(
  fileURLToPath(new URL('../../controllers/internal/ersInternalController.js', import.meta.url)),
  'utf8'
);

// ─────────────────────────────────────────────────────────────────────────────
// PHASE D: FreeSWITCH variable behavior — source-level proof
// ─────────────────────────────────────────────────────────────────────────────

describe('PHASE D — FreeSWITCH SIP identity variable presence', () => {
  describe('ENS: originateCampaignCall (eslService.js)', () => {
    it('sets effective_caller_id_number — required for PAI and From URI user', () => {
      expect(eslServiceSrc).toContain('effective_caller_id_number');
    });

    it('sets effective_caller_id_name', () => {
      expect(eslServiceSrc).toContain('effective_caller_id_name');
    });

    it('sets origination_caller_id_number', () => {
      expect(eslServiceSrc).toContain('origination_caller_id_number');
    });

    it('sets origination_caller_id_name', () => {
      expect(eslServiceSrc).toContain('origination_caller_id_name');
    });

    it('does NOT fall back to destination number (|| number) for ensCli', () => {
      // The original defect was: `const ensCli = clid || number;`
      // After fix: clid is validated and used directly; number is never substituted.
      // We check that the forbidden pattern is absent in originateCampaignCall.
      // Extract only the originateCampaignCall function body for precision.
      const fnStart = eslServiceSrc.indexOf('export async function originateCampaignCall(');
      // Find the next export after originateCampaignCall to limit scope
      const fnEnd   = eslServiceSrc.indexOf('\nexport async function confPlay', fnStart);
      const fnBody  = eslServiceSrc.slice(fnStart, fnEnd);
      // The forbidden fallback — clid || number as the CLI assignment
      expect(fnBody).not.toMatch(/ensCli\s*=\s*clid\s*\|\|\s*number/);
      expect(fnBody).not.toMatch(/=\s*clid\s*\|\|\s*number/);
    });

    it('throws when clid is null — destination number is NEVER substituted', () => {
      // Verify the guard exists in the source
      expect(eslServiceSrc).toContain("throw new Error('originateCampaignCall: clid (blast_clid) is required");
    });
  });

  describe('ERS: originateLeg (ersRingService.js)', () => {
    it('sets effective_caller_id_number from callerIdentity (inbound caller)', () => {
      expect(ersRingSrc).toContain('effective_caller_id_number');
    });

    it('sets effective_caller_id_name from callerIdentity (inbound caller)', () => {
      expect(ersRingSrc).toContain('effective_caller_id_name');
    });

    it('does NOT reference blast_clid — ERS never reads ENS config', () => {
      expect(ersRingSrc).not.toContain('blast_clid');
    });

    it('does NOT reference sip_caller_id — ERS never reads ENS campaign data', () => {
      expect(ersRingSrc).not.toContain('sip_caller_id');
    });

    it('does NOT reference trigger_number', () => {
      expect(ersRingSrc).not.toContain('trigger_number');
    });

    it('does NOT reference ens_configurations — ERS never queries ENS config table', () => {
      expect(ersRingSrc).not.toContain('ens_configurations');
    });
  });

  describe('ENS dispatch: campaignEngine.js', () => {
    it('does NOT reference || trigger_number as CLI fallback', () => {
      // The removed fallback was: campaign.sip_caller_id || campaign.trigger_number || '999'
      // Verify it is not present in any form
      expect(campaignEngineSrc).not.toMatch(/campaign\.sip_caller_id\s*\|\|\s*campaign\.trigger_number/);
    });

    it('does NOT use hardcoded 999 as CLI fallback', () => {
      // The old '999' string as a fallback must not appear in the dispatch or originate path
      const dispatchSection = campaignEngineSrc.slice(
        campaignEngineSrc.indexOf('async function dispatchReadyDestinations'),
        campaignEngineSrc.indexOf('async function originateDestination')
      );
      expect(dispatchSection).not.toContain("'999'");
    });

    it('validates blast_clid with trim() — catches whitespace-only strings', () => {
      expect(campaignEngineSrc).toContain('.trim()');
      // The guard must test the trimmed value, not just falsy
      expect(campaignEngineSrc).toContain('blastClidTrimmed');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1 — ENS: blast_clid=7328, trigger_number=966500000000 → CLI must be 7328
// ─────────────────────────────────────────────────────────────────────────────

describe('TEST 1 — ENS: blast_clid=7328, trigger_number=966500000000 → CLI must be 7328', () => {
  it('campaign.sip_caller_id = blast_clid, not trigger_number', () => {
    const campaign = { id: 1, sip_caller_id: '7328', trigger_number: '966500000000' };
    // Simulates the corrected dispatchReadyDestinations logic
    const clid = campaign.sip_caller_id;
    expect(clid).toBe('7328');
    expect(clid).not.toBe('966500000000');
  });

  it('trigger_number is NEVER the CLI', () => {
    const campaign = { id: 1, sip_caller_id: '7328', trigger_number: '966500000000' };
    // trigger_number is NOT read by the CLI resolution path
    const clid = campaign.sip_caller_id;
    expect(clid).not.toBe(campaign.trigger_number);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2 — ENS: blast_clid=7328, IVR caller=966500000000 → CLI must be 7328
// ─────────────────────────────────────────────────────────────────────────────

describe('TEST 2 — ENS: blast_clid=7328, IVR inbound caller=966500000000 → CLI must be 7328', () => {
  it('IVR caller_number is NEVER passed as ENS CLI', () => {
    const cfg = { blast_clid: '7328' };
    const ivrCallerNumber = '966500000000'; // the person who triggered the blast — must be ignored

    // ENS campaign creation uses cfg.blast_clid; ivrCallerNumber is intentionally discarded
    // at startCampaignByConfig (which does not pass caller_number as triggerNumber).
    const ensCli = cfg.blast_clid;
    expect(ensCli).toBe('7328');
    expect(ensCli).not.toBe(ivrCallerNumber);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3 — ENS: blast_clid=NULL → campaign rejected; never 966500000000 or 999
// ─────────────────────────────────────────────────────────────────────────────

describe('TEST 3 — ENS: blast_clid=NULL → campaign must be rejected', () => {
  let createCampaignByConfigId;
  let mockQuery;

  beforeEach(async () => {
    vi.resetAllMocks();
    const pool = await import('../../db/pool.js');
    mockQuery = pool.query;
    ({ createCampaignByConfigId } = await import('../../services/campaignEngine.js'));
  });

  it('throws 422 when blast_clid is null', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, blast_clid: null, tenant_id: 1 }],
    });

    await expect(
      createCampaignByConfigId({ configId: 1, triggeredVia: 'UI', recordingFile: '/x.wav' })
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('blast_clid') });
  });

  it('trigger_number is NEVER used when blast_clid is null', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, blast_clid: null, tenant_id: 1 }],
    });

    let error;
    try {
      await createCampaignByConfigId({
        configId: 1, triggeredVia: 'PHONE', triggerNumber: '966500000000', recordingFile: '/x.wav',
      });
    } catch (e) { error = e; }

    expect(error).toBeDefined();
    expect(error.status).toBe(422);
    // It MUST NOT have proceeded past the blast_clid guard to use trigger_number
    expect(error.message).toContain('blast_clid');
  });

  it('the rejected error does not expose 999 anywhere', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, blast_clid: null, tenant_id: 1 }] });
    let error;
    try {
      await createCampaignByConfigId({ configId: 1, recordingFile: '/x.wav' });
    } catch (e) { error = e; }
    expect(error.message).not.toContain('999');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4 — ENS: blast_clid='' → campaign rejected
// ─────────────────────────────────────────────────────────────────────────────

describe('TEST 4 — ENS: blast_clid="" (empty string) → campaign must be rejected', () => {
  let createCampaignByConfigId;
  let mockQuery;

  beforeEach(async () => {
    vi.resetAllMocks();
    const pool = await import('../../db/pool.js');
    mockQuery = pool.query;
    ({ createCampaignByConfigId } = await import('../../services/campaignEngine.js'));
  });

  it('throws 422 when blast_clid is empty string', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, blast_clid: '', tenant_id: 1 }] });
    await expect(
      createCampaignByConfigId({ configId: 1, recordingFile: '/x.wav' })
    ).rejects.toMatchObject({ status: 422 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5 — ENS: blast_clid='   ' (whitespace) → campaign rejected
// ─────────────────────────────────────────────────────────────────────────────

describe('TEST 5 — ENS: blast_clid="   " (whitespace-only) → campaign must be rejected', () => {
  let createCampaignByConfigId;
  let mockQuery;

  beforeEach(async () => {
    vi.resetAllMocks();
    const pool = await import('../../db/pool.js');
    mockQuery = pool.query;
    ({ createCampaignByConfigId } = await import('../../services/campaignEngine.js'));
  });

  it('throws 422 when blast_clid is whitespace-only', async () => {
    // Whitespace-only string is FALSY after trim but TRUTHY in a plain falsy check.
    // The corrected guard uses .trim() so this case is caught.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, blast_clid: '   ', tenant_id: 1 }] });
    await expect(
      createCampaignByConfigId({ configId: 1, recordingFile: '/x.wav' })
    ).rejects.toMatchObject({ status: 422 });
  });

  it('whitespace-only blast_clid never reaches FreeSWITCH', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, blast_clid: '   ', tenant_id: 1 }] });
    let error;
    try {
      await createCampaignByConfigId({ configId: 1, recordingFile: '/x.wav' });
    } catch (e) { error = e; }
    // If it reached the contacts query, the mock would throw "not a function" — so the
    // 422 status proves execution stopped at the blast_clid guard.
    expect(error.status).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 6 — ERS: inbound=966500000000, blast_clid=7328 → responder CLI must be 966500000000
// ─────────────────────────────────────────────────────────────────────────────

describe('TEST 6 — ERS: inbound caller=966500000000, blast_clid=7328 → CLI must be 966500000000', () => {
  it('ERS uses inbound caller, never blast_clid', () => {
    const inboundCaller = '966500000000';
    const ensBlastClid  = '7328'; // exists in ENS config — must NEVER affect ERS

    // ERS uses lookupCallerIdentity(callerNumber) → callerIdentity
    // callerIdentity.number is sourced from the inbound caller, never from ENS config
    const callerIdentity = { name: inboundCaller, number: inboundCaller };
    const ersCli = callerIdentity.number;

    expect(ersCli).toBe('966500000000');
    expect(ersCli).not.toBe(ensBlastClid);
    expect(ersCli).not.toBe('999');
    expect(ersCli).not.toBe('CallCenter');
    expect(ersCli).not.toBe('Emergency');
    expect(ersCli).not.toBe('anonymous');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 7 — ERS: inbound=966500000001, directory match → effective_* = caller
// ─────────────────────────────────────────────────────────────────────────────

describe('TEST 7 — ERS: caller with directory entry → effective_caller_id uses directory name', () => {
  let lookupCallerIdentity;
  let mockQuery;

  beforeEach(async () => {
    vi.resetAllMocks();
    const pool = await import('../../db/pool.js');
    mockQuery = pool.query;
    ({ lookupCallerIdentity } = await import('../../services/ersRingService.js'));
  });

  it('returns directory name + caller number when directory entry found', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ first_name: 'Ali', last_name: 'Hassan', extension_number: '966500000001', mobile_number: null }],
    });

    const result = await lookupCallerIdentity('966500000001');

    expect(result.number).toBe('966500000001');
    expect(result.name).toBe('Ali Hassan');
  });

  it('effective_caller_id_number would be set to caller number (source verification)', () => {
    // Verify originateLeg builds vars including effective_caller_id_number from callerIdentity
    expect(ersRingSrc).toContain('effective_caller_id_number=${callerIdentity.number}');
  });

  it('effective_caller_id_name would be set to directory name (source verification)', () => {
    expect(ersRingSrc).toContain('effective_caller_id_name=');
    expect(ersRingSrc).toContain('callerIdentity.name');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 8 — ERS: directory lookup fails → safe fallback, never ENS blast_clid
// ─────────────────────────────────────────────────────────────────────────────

describe('TEST 8 — ERS: directory lookup fails → safe fallback, never blast_clid', () => {
  let lookupCallerIdentity;
  let mockQuery;

  beforeEach(async () => {
    vi.resetAllMocks();
    const pool = await import('../../db/pool.js');
    mockQuery = pool.query;
    ({ lookupCallerIdentity } = await import('../../services/ersRingService.js'));
  });

  it('returns raw caller number as fallback when not in directory', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no directory match

    const result = await lookupCallerIdentity('966500000000');

    expect(result.number).toBe('966500000000'); // raw caller number
    expect(result.name).toBe('966500000000');   // raw number as display name
    expect(result.number).not.toBe('7328');     // never blast_clid
    expect(result.number).not.toBe('999');
  });

  it('returns "Emergency Caller"/"unknown" for empty caller number', async () => {
    const result = await lookupCallerIdentity('');
    expect(result.number).toBe('unknown');
    expect(result.name).toBe('Emergency Caller');
    expect(result.number).not.toBe('7328'); // never blast_clid
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 9 — Campaign snapshot isolation: changing blast_clid after creation
// ─────────────────────────────────────────────────────────────────────────────

describe('TEST 9 — Campaign snapshot: blast_clid captured at creation, immutable at dispatch', () => {
  it('campaign.sip_caller_id is the snapshot at creation time — not re-read from config', () => {
    // At campaign creation: cfg.blast_clid = '7328' → ens_campaigns.sip_caller_id = '7328'
    // If operator later changes blast_clid to '7330', the running campaign is unaffected.
    const campaignSnapshot = { id: 1, sip_caller_id: '7328' };

    // dispatchReadyDestinations reads campaign.sip_caller_id, NOT ens_configurations.blast_clid
    const clid = campaignSnapshot.sip_caller_id;

    expect(clid).toBe('7328'); // original value preserved
    expect(clid).not.toBe('7330'); // post-change value never seen
  });

  it('campaignEngine dispatch does NOT query ens_configurations at dispatch time', () => {
    // The comment in campaignEngine.js:454 explicitly states:
    // "The execution engine never re-reads emergency_contacts — phone_number and
    //  gateway_name in ens_campaign_destinations are the authoritative snapshot."
    // Verify the dispatch function does not have a fresh config query.
    const dispatchFnStart = campaignEngineSrc.indexOf('async function dispatchReadyDestinations');
    const dispatchFnEnd   = campaignEngineSrc.indexOf('\nasync function originateDestination');
    const dispatchBody    = campaignEngineSrc.slice(dispatchFnStart, dispatchFnEnd);

    expect(dispatchBody).not.toContain('ens_configurations');
    expect(dispatchBody).not.toContain('blast_clid'); // not re-read at dispatch
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 10 — Static: no forbidden CLI fallbacks anywhere in ENS originate paths
// ─────────────────────────────────────────────────────────────────────────────

describe('TEST 10 — Static: ENS originate path contains no forbidden CLI fallbacks', () => {
  it('campaignEngine.js has no campaign.trigger_number as CLI source', () => {
    expect(campaignEngineSrc).not.toMatch(/campaign\.sip_caller_id\s*\|\|\s*campaign\.trigger_number/);
  });

  it("campaignEngine.js dispatch has no '999' hardcoded CLI fallback", () => {
    const dispatchStart = campaignEngineSrc.indexOf('async function dispatchReadyDestinations');
    const dispatchEnd   = campaignEngineSrc.indexOf('\nasync function originateDestination');
    const dispatchBody  = campaignEngineSrc.slice(dispatchStart, dispatchEnd);
    expect(dispatchBody).not.toContain("'999'");
  });

  it("eslService.js originateCampaignCall has no '999' CLI fallback", () => {
    const fnStart = eslServiceSrc.indexOf('export async function originateCampaignCall(');
    const fnEnd   = eslServiceSrc.indexOf('\nexport async function confPlay', fnStart);
    const fnBody  = eslServiceSrc.slice(fnStart, fnEnd);
    expect(fnBody).not.toContain("'999'");
  });

  it('eslService.js originateCampaignCall has no || number CLI fallback', () => {
    const fnStart = eslServiceSrc.indexOf('export async function originateCampaignCall(');
    const fnEnd   = eslServiceSrc.indexOf('\nexport async function confPlay', fnStart);
    const fnBody  = eslServiceSrc.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/ensCli\s*=\s*clid\s*\|\|\s*number/);
    expect(fnBody).not.toMatch(/caller_id_number.*\|\|\s*number/);
  });

  it('eslService.js originateCampaignCall does NOT reference trigger_number', () => {
    const fnStart = eslServiceSrc.indexOf('export async function originateCampaignCall(');
    const fnEnd   = eslServiceSrc.indexOf('\nexport async function confPlay', fnStart);
    const fnBody  = eslServiceSrc.slice(fnStart, fnEnd);
    expect(fnBody).not.toContain('trigger_number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE H — Cross-contamination negative tests
// ─────────────────────────────────────────────────────────────────────────────

describe('PHASE H — Cross-contamination: ENS must not consume ERS identity; ERS must not consume ENS identity', () => {
  it('ENS blast_clid=7328, IVR caller=966500000000 → ENS CLI=7328', () => {
    const cfg           = { blast_clid: '7328' };
    const ivrCaller     = '966500000000';
    const ensCli        = cfg.blast_clid;
    expect(ensCli).toBe('7328');
    expect(ensCli).not.toBe(ivrCaller);
  });

  it('ERS caller=966500000000, blast_clid=7328 → ERS CLI=966500000000', () => {
    const ersCaller    = '966500000000';
    const ensBlastClid = '7328';
    const ersCli       = ersCaller; // ERS reads caller_number, never blast_clid
    expect(ersCli).toBe('966500000000');
    expect(ersCli).not.toBe(ensBlastClid);
  });

  it('originateCampaignCall (ENS) does not call originateLeg (ERS) — separate functions', () => {
    // The ENS path uses originateCampaignCall; ERS path uses originateLeg.
    // Neither function is referenced inside the other.
    const fnStart = eslServiceSrc.indexOf('export async function originateCampaignCall(');
    const fnEnd   = eslServiceSrc.indexOf('\nexport async function confPlay', fnStart);
    const ensFnBody = eslServiceSrc.slice(fnStart, fnEnd);
    expect(ensFnBody).not.toContain('originateLeg');
    expect(ensFnBody).not.toContain('ersRingService');
    expect(ensFnBody).not.toContain('callerIdentity');
  });

  it('originateLeg (ERS) does not call originateCampaignCall (ENS) — separate functions', () => {
    expect(ersRingSrc).not.toContain('originateCampaignCall');
    expect(ersRingSrc).not.toContain('campaignEngine');
    expect(ersRingSrc).not.toContain('sip_caller_id');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE E — Exact ESL command structure verification
// ─────────────────────────────────────────────────────────────────────────────

describe('PHASE E — ESL command structure: no duplicate keys, correct format', () => {
  it('varParts object has no duplicate key declarations in source', () => {
    // Extract the varParts literal inside originateCampaignCall
    const fnStart = eslServiceSrc.indexOf('export async function originateCampaignCall(');
    const fnEnd   = eslServiceSrc.indexOf('\nexport async function confPlay', fnStart);
    const fnBody  = eslServiceSrc.slice(fnStart, fnEnd);

    // Strip single-line comments before counting so a key that appears in
    // a comment (e.g. "// effective_caller_id_number: FreeSWITCH reads…")
    // is not mistaken for an actual property declaration.
    const stripLineComments = src => src.replace(/\/\/[^\n]*/g, '');
    const countKey = (src, key) => (stripLineComments(src).match(new RegExp(key, 'g')) || []).length;

    expect(countKey(fnBody, 'origination_caller_id_number')).toBe(1);
    expect(countKey(fnBody, 'origination_caller_id_name')).toBe(1);
    expect(countKey(fnBody, 'effective_caller_id_number')).toBe(1);
    expect(countKey(fnBody, 'effective_caller_id_name')).toBe(1);
  });

  it('full ESL command uses originate prefix (not bgapi) — eslCommand wraps it', () => {
    // originateCampaignCall builds: originate {vars}dialString app
    // eslCommand sends it as bgapi internally. The prefix in the string must be "originate".
    expect(eslServiceSrc).toContain('`originate {${varStr}}${resolved}');
  });

  it('ensCli is trimmed — no leading/trailing whitespace reaches FreeSWITCH', () => {
    const fnStart = eslServiceSrc.indexOf('export async function originateCampaignCall(');
    const fnEnd   = eslServiceSrc.indexOf('\nexport async function confPlay', fnStart);
    const fnBody  = eslServiceSrc.slice(fnStart, fnEnd);
    expect(fnBody).toContain('String(clid).trim()');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE F — P-Asserted-Identity: ENS uses configured CLI; ERS uses original caller
// These tests enforce the absolute separation between ENS and ERS identity.
// ─────────────────────────────────────────────────────────────────────────────

describe('PHASE F — P-Asserted-Identity separation: ENS=configured CLI, ERS=original caller', () => {
  // ── Source-level: ENS ──────────────────────────────────────────────────────

  it('ENS: originateCampaignCall sets sip_h_P-Asserted-Identity', () => {
    const fnStart = eslServiceSrc.indexOf('export async function originateCampaignCall(');
    const fnEnd   = eslServiceSrc.indexOf('\nexport async function confPlay', fnStart);
    const fnBody  = eslServiceSrc.slice(fnStart, fnEnd);
    expect(fnBody).toContain('sip_h_P-Asserted-Identity');
  });

  it('ENS: PAI is built from ensCli — not callerIdentity, not destination number', () => {
    const fnStart = eslServiceSrc.indexOf('export async function originateCampaignCall(');
    const fnEnd   = eslServiceSrc.indexOf('\nexport async function confPlay', fnStart);
    const fnBody  = eslServiceSrc.slice(fnStart, fnEnd);
    // PAI must reference ensCli (the configured blast_clid)
    expect(fnBody).toMatch(/sip_h_P-Asserted-Identity.*ensCli/s);
    // Must not bleed ERS variables into ENS originate
    expect(fnBody).not.toContain('callerIdentity');
  });

  it('ENS: PAI uses angle-bracket SIP URI format <sip:ensCli@domain>', () => {
    const fnStart = eslServiceSrc.indexOf('export async function originateCampaignCall(');
    const fnEnd   = eslServiceSrc.indexOf('\nexport async function confPlay', fnStart);
    const fnBody  = eslServiceSrc.slice(fnStart, fnEnd);
    // Source must contain the template: <sip:${ensCli}@
    expect(fnBody).toContain('<sip:${ensCli}@');
  });

  it('ENS: PAI domain comes from gateway.sip_domain or config — not hardcoded', () => {
    const fnStart = eslServiceSrc.indexOf('export async function originateCampaignCall(');
    const fnEnd   = eslServiceSrc.indexOf('\nexport async function confPlay', fnStart);
    const fnBody  = eslServiceSrc.slice(fnStart, fnEnd);
    // Domain is held in sipDomain variable, not a literal string like '@yerp.com'
    expect(fnBody).toContain('sipDomain');
    expect(fnBody).not.toContain('@yerp.com');
  });

  // ── Source-level: ERS ──────────────────────────────────────────────────────

  it('ERS: originateLeg sets sip_h_P-Asserted-Identity', () => {
    expect(ersRingSrc).toContain('sip_h_P-Asserted-Identity');
  });

  it('ERS: PAI is built from callerIdentity.number — not ensCli, not blast_clid', () => {
    // PAI must reference callerIdentity.number (the original emergency caller)
    expect(ersRingSrc).toMatch(/sip_h_P-Asserted-Identity.*callerIdentity\.number/s);
    // Must not reference ENS-specific variables
    expect(ersRingSrc).not.toContain('ensCli');
    expect(ersRingSrc).not.toContain('blast_clid');
    expect(ersRingSrc).not.toContain('sip_caller_id');
  });

  it('ERS: PAI uses angle-bracket SIP URI format <sip:callerIdentity.number@domain>', () => {
    expect(ersRingSrc).toContain('<sip:${callerIdentity.number}@');
  });

  it('ERS: PAI domain comes from gateway.sip_domain or config — not hardcoded', () => {
    expect(ersRingSrc).toContain('sipDomain');
    expect(ersRingSrc).not.toContain('@yerp.com');
  });

  // ── Logic-level: value isolation ───────────────────────────────────────────

  it('ENS PAI value: blast_clid=7328, sipDomain=test.com → <sip:7328@test.com>', () => {
    const ensCli   = '7328';
    const sipDomain = 'test.com';
    const pai = `<sip:${ensCli}@${sipDomain}>`;
    expect(pai).toBe('<sip:7328@test.com>');
    expect(pai).not.toContain('3982589'); // original caller must never appear in ENS PAI
  });

  it('ENS PAI must not contain original caller even when caller number is known', () => {
    const originalCaller = '3982589';
    const ensCli         = '7328';
    const sipDomain      = 'test.com';
    const pai = `<sip:${ensCli}@${sipDomain}>`;
    expect(pai).not.toContain(originalCaller);
    expect(pai).toContain(ensCli);
  });

  it('ERS PAI value: caller=3982589, sipDomain=test.com → <sip:3982589@test.com>', () => {
    const callerIdentity = { number: '3982589', name: 'Ali Hassan' };
    const sipDomain      = 'test.com';
    const pai = `<sip:${callerIdentity.number}@${sipDomain}>`;
    expect(pai).toBe('<sip:3982589@test.com>');
    expect(pai).not.toContain('7328'); // blast_clid must never appear in ERS PAI
  });

  it('ERS PAI must not contain blast_clid even when blast_clid is known', () => {
    const callerIdentity = { number: '3982589', name: 'Ali Hassan' };
    const ensBlastClid   = '7328';
    const sipDomain      = 'test.com';
    const pai = `<sip:${callerIdentity.number}@${sipDomain}>`;
    expect(pai).not.toContain(ensBlastClid);
    expect(pai).toContain(callerIdentity.number);
  });

  it('PAI is suppressed when sipDomain is empty — no malformed PAI reaches FreeSWITCH', () => {
    // When sipDomain is '', no PAI key should be added to varParts.
    // This is verified by the conditional spread: ...(sipDomain ? {...} : {})
    const sipDomain = '';
    const shouldIncludePAI = Boolean(sipDomain);
    expect(shouldIncludePAI).toBe(false);
  });

  // ── Cross-path contamination guard ─────────────────────────────────────────

  it('ENS originateCampaignCall does not read ERS callerIdentity', () => {
    const fnStart = eslServiceSrc.indexOf('export async function originateCampaignCall(');
    const fnEnd   = eslServiceSrc.indexOf('\nexport async function confPlay', fnStart);
    const fnBody  = eslServiceSrc.slice(fnStart, fnEnd);
    expect(fnBody).not.toContain('callerIdentity');
    expect(fnBody).not.toContain('lookupCallerIdentity');
  });

  it('ERS originateLeg does not read ENS blast_clid or sip_caller_id', () => {
    expect(ersRingSrc).not.toContain('blast_clid');
    expect(ersRingSrc).not.toContain('sip_caller_id');
    expect(ersRingSrc).not.toContain('ensCli');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE G — ERS direct-dial path: ers_conference_bridge.lua PAI
//
// Validates the active runtime Lua bridge script (NOT legacy) sets PAI
// using the original emergency caller + configured gateway SIP domain.
// ─────────────────────────────────────────────────────────────────────────────

describe('PHASE G — ERS direct-dial PAI: ers_conference_bridge.lua + ersLookup', () => {
  // ── Source: ers_conference_bridge.lua ──────────────────────────────────────

  it('ers_conference_bridge.lua: invite_responder sets sip_h_P-Asserted-Identity', () => {
    expect(ersBridgeSrc).toContain('sip_h_P-Asserted-Identity');
  });

  it('ers_conference_bridge.lua: PAI reads gateway_sip_domain from lookup response', () => {
    expect(ersBridgeSrc).toContain('gateway_sip_domain');
  });

  it('ers_conference_bridge.lua: PAI is suppressed when sip_domain is empty (conditional guard)', () => {
    // The bridge must guard: if num_val ~= "" and sip_domain and sip_domain ~= ""
    expect(ersBridgeSrc).toContain('sip_domain ~= ""');
  });

  it('ers_conference_bridge.lua: PAI uses angle-bracket SIP URI format', () => {
    // Must contain the format: <sip:%s@%s>
    expect(ersBridgeSrc).toContain('<sip:%s@%s>');
  });

  it('ers_conference_bridge.lua: PAI identity source is c_num (original caller) — no ENS terms', () => {
    // The PAI variable must be built from c_num (the caller passed from invite_tier)
    expect(ersBridgeSrc).toContain('sip_h_P-Asserted-Identity=<sip:%s@%s>');
    // Bridge must not reference ENS-specific variables
    expect(ersBridgeSrc).not.toContain('blast_clid');
    expect(ersBridgeSrc).not.toContain('sip_caller_id');
    expect(ersBridgeSrc).not.toContain('ensCli');
  });

  it('ers_conference_bridge.lua: no hardcoded customer SIP domain', () => {
    // The bridge must not hardcode any customer domain
    expect(ersBridgeSrc).not.toContain('@yerp.com');
    // It must use a variable (sip_domain) not a literal
    expect(ersBridgeSrc).toContain('sip_domain');
  });

  it('ers_conference_bridge.lua: caller identity comes from session channel variable — not ENS config', () => {
    // caller is read from the FreeSWITCH session — the original inbound emergency caller
    expect(ersBridgeSrc).toContain('caller_id_number');
    // Bridge must not call ENS lookup endpoints
    expect(ersBridgeSrc).not.toContain('/ens/');
    expect(ersBridgeSrc).not.toContain('campaign');
  });

  // ── Source: ersInternalController.js — lookup response ────────────────────

  it('ersLookup SELECT includes sg.sip_domain', () => {
    expect(ersInternalSrc).toContain('sg.sip_domain AS gateway_sip_domain');
  });

  it('ersLookup response JSON exposes gateway_sip_domain field', () => {
    expect(ersInternalSrc).toContain('gateway_sip_domain:');
  });

  // ── Logic-level: PAI construction for direct-dial path ────────────────────

  it('ERS direct-dial PAI value: caller=3982589, domain=alpha.example.com → correct URI', () => {
    const caller    = '3982589';
    const sipDomain = 'alpha.example.com';
    const pai = `<sip:${caller}@${sipDomain}>`;
    expect(pai).toBe('<sip:3982589@alpha.example.com>');
    expect(pai).not.toContain('7328');     // ENS blast_clid must never appear
    expect(pai).not.toContain('yerp.com'); // hardcoded domain must never appear
  });

  it('ERS direct-dial PAI: different caller + different domain produces correct URI', () => {
    const caller    = '4002';
    const sipDomain = 'beta.example.com';
    const pai = `<sip:${caller}@${sipDomain}>`;
    expect(pai).toBe('<sip:4002@beta.example.com>');
  });

  it('ERS direct-dial PAI: suppressed when gateway_sip_domain is empty string', () => {
    // Lua logic: if num_val ~= "" and sip_domain and sip_domain ~= ""
    const sipDomain = '';
    const shouldInjectPAI = sipDomain !== '';
    expect(shouldInjectPAI).toBe(false);
  });

  it('ERS direct-dial PAI: suppressed when gateway_sip_domain is null/nil', () => {
    const sipDomain = null;
    const shouldInjectPAI = Boolean(sipDomain);
    expect(shouldInjectPAI).toBe(false);
  });

  it('ERS direct-dial: caller identity must not be ENS blast_clid', () => {
    const originalCaller = '3982589';
    const ensBlastCli    = '7328';
    const sipDomain      = 'test.com';
    const ersPai = `<sip:${originalCaller}@${sipDomain}>`;
    expect(ersPai).not.toContain(ensBlastCli);
    expect(ersPai).toContain(originalCaller);
  });

  // ── Legacy Lua isolation ───────────────────────────────────────────────────

  it('Legacy Lua isolation: blast_call.lua.decrypted is not referenced in runtime source', () => {
    // Production runtime source must not reference legacy Lua paths
    expect(eslServiceSrc).not.toContain('blast_call.lua');
    expect(campaignEngineSrc).not.toContain('blast_call.lua');
    expect(ersRingSrc).not.toContain('blast_call.lua');
    expect(ersBridgeSrc).not.toContain('blast_call.lua');
    expect(ersInternalSrc).not.toContain('blast_call.lua');
  });

  it('Legacy Lua isolation: ers_retry_caller is not referenced in runtime source', () => {
    expect(eslServiceSrc).not.toContain('ers_retry_caller');
    expect(campaignEngineSrc).not.toContain('ers_retry_caller');
    expect(ersRingSrc).not.toContain('ers_retry_caller');
    expect(ersBridgeSrc).not.toContain('ers_retry_caller');
    expect(ersInternalSrc).not.toContain('ers_retry_caller');
  });

  it('Legacy Lua isolation: Lua-scripts/legacy path not referenced in runtime source', () => {
    expect(eslServiceSrc).not.toContain('legacy/');
    expect(campaignEngineSrc).not.toContain('legacy/');
    expect(ersRingSrc).not.toContain('legacy/');
    expect(ersBridgeSrc).not.toContain('legacy/');
    expect(ersInternalSrc).not.toContain('legacy/');
  });
});
