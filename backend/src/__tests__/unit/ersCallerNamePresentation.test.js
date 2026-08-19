/**
 * ERS Caller Name Presentation — Regression + Edge-Case Tests
 *
 * Root cause: startRingAll() had no callerName param; lookupCallerIdentity()
 * had no sipName hint; its fallback was `name: raw` (number-string as name),
 * which also caused a crash in originateLeg when any code path ever returned
 * name: null (because .replace() on null throws TypeError).
 *
 * Fixes applied:
 *   1. lookupCallerIdentity(callerNumber, sipName?) — normalises whitespace/empty
 *      sipName to null; returns { name: null } when no name is available
 *      (no DB match, no SIP name) so FreeSWITCH shows just the number.
 *   2. originateLeg — computes safeName; omits name vars when null so no
 *      fabricated display names reach the SIP INVITE.
 *   3. startRingAll({ callerName }) — accepts and forwards SIP name.
 *   4. ersRingAll controller — passes d.caller_name to startRingAll.
 *   5. ersOverflowPoll controller — passes entry.caller_name to startRingAll.
 *   6. xmlGenerator — adds effective_caller_id_name at IVR entry (framework).
 *
 * Caller name is PRESENTATION METADATA ONLY. Its absence must never block
 * ERS Ring All, incident creation, conference creation, or responder dialling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// ── Source files ───────────────────────────────────────────────────────────────

const ersRingSrc = readFileSync(
  fileURLToPath(new URL('../../services/ersRingService.js', import.meta.url)),
  'utf8'
);

const ersInternalSrc = readFileSync(
  fileURLToPath(new URL('../../controllers/internal/ersInternalController.js', import.meta.url)),
  'utf8'
);

const xmlGeneratorSrc = readFileSync(
  fileURLToPath(new URL('../../utils/xmlGenerator.js', import.meta.url)),
  'utf8'
);

const eslServiceSrc = readFileSync(
  fileURLToPath(new URL('../../services/eslService.js', import.meta.url)),
  'utf8'
);

// ── Mocks ─────────────────────────────────────────────────────────────────────

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
  eslCommand:               vi.fn(),
  getConferenceMemberCount: vi.fn(),
  seedConferenceRegistry:   vi.fn(),
}));

vi.mock('../../services/socketService.js',  () => ({ emitInternal: vi.fn() }));
vi.mock('../../services/dialResolver.js',   () => ({ resolveDialString: vi.fn() }));
vi.mock('../../services/conferenceManager.js', () => ({
  resolveConferenceRoom: vi.fn(),
  getConferenceProfile:  vi.fn(),
}));
vi.mock('../../services/freeSwitchPathService.js', () => ({
  fsPathService: { getErsRecordingDir: vi.fn(() => '/var/lib/freeswitch/recordings/ers') },
}));
vi.mock('../../infrastructure/index.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE-LEVEL REGRESSIONS
// ═══════════════════════════════════════════════════════════════════════════════

describe('SOURCE — ersRingService.js: lookupCallerIdentity', () => {
  it('accepts sipName as second parameter with default null', () => {
    expect(ersRingSrc).toContain('lookupCallerIdentity(callerNumber, sipName = null)');
  });

  it('normalises whitespace/empty sipName to null via cleanSipName', () => {
    expect(ersRingSrc).toContain('cleanSipName');
  });

  it('returns { name: cleanSipName, number: raw } as the fallback (null-safe)', () => {
    // The fallback must use cleanSipName (which can be null), never `sipName || raw`
    expect(ersRingSrc).toContain('name: cleanSipName');
    expect(ersRingSrc).not.toContain('name: sipName || raw');
    expect(ersRingSrc).not.toContain("name: raw");  // bare raw fallback removed
  });
});

describe('SOURCE — ersRingService.js: originateLeg null-safe name handling', () => {
  it('computes safeName with null guard before calling .replace()', () => {
    expect(ersRingSrc).toContain('callerIdentity.name ? callerIdentity.name.replace');
  });

  it('omits origination_caller_id_name when safeName is null', () => {
    expect(ersRingSrc).toContain("safeName !== null ? `origination_caller_id_name");
  });

  it('omits effective_caller_id_name when safeName is null', () => {
    expect(ersRingSrc).toContain("safeName !== null ? `effective_caller_id_name");
  });

  it('always sets origination_caller_id_number regardless of name', () => {
    expect(ersRingSrc).toContain('`origination_caller_id_number=${callerIdentity.number}`');
  });

  it('always sets effective_caller_id_number regardless of name', () => {
    expect(ersRingSrc).toContain('`effective_caller_id_number=${callerIdentity.number}`');
  });
});

describe('SOURCE — ersRingService.js: startRingAll callerName propagation', () => {
  it('accepts callerName parameter', () => {
    expect(ersRingSrc).toContain('callerName = null');
  });

  it('passes callerName to lookupCallerIdentity as sipName', () => {
    expect(ersRingSrc).toContain('lookupCallerIdentity(callerNumber, callerName)');
  });
});

describe('SOURCE — ersInternalController.js: callerName forwarding', () => {
  it('ersRingAll passes d.caller_name to startRingAll', () => {
    const fnStart = ersInternalSrc.indexOf('export const ersRingAll =');
    const fnEnd   = ersInternalSrc.indexOf('\nexport const', fnStart + 10);
    expect(ersInternalSrc.slice(fnStart, fnEnd)).toContain('callerName:         d.caller_name ?? null');
  });

  it('ersOverflowPoll passes entry.caller_name to startRingAll', () => {
    const fnStart = ersInternalSrc.indexOf('export const ersOverflowPoll =');
    const fnEnd   = ersInternalSrc.indexOf('\nexport const', fnStart + 10);
    expect(ersInternalSrc.slice(fnStart, fnEnd)).toContain('callerName:         entry.caller_name ?? null');
  });
});

describe('SOURCE — xmlGenerator.js: IVR entry framework', () => {
  it('sets effective_caller_id_name from caller_id_name at IVR entry', () => {
    expect(xmlGeneratorSrc).toContain('effective_caller_id_name=\\${caller_id_name}');
  });

  it('sets effective_caller_id_number from caller_id_number at IVR entry', () => {
    expect(xmlGeneratorSrc).toContain('effective_caller_id_number=\\${caller_id_number}');
  });

  it('name var appears before number var in generated output', () => {
    const namePos   = xmlGeneratorSrc.indexOf('effective_caller_id_name');
    const numberPos = xmlGeneratorSrc.indexOf('effective_caller_id_number');
    expect(namePos).toBeGreaterThan(0);
    expect(namePos).toBeLessThan(numberPos);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTIONAL TESTS — lookupCallerIdentity
// ═══════════════════════════════════════════════════════════════════════════════

describe('TEST A — Directory match: DB name used, sipName ignored', async () => {
  const { query }              = await import('../../db/pool.js');
  const { lookupCallerIdentity } = await import('../../services/ersRingService.js');

  beforeEach(() => vi.clearAllMocks());

  it('returns DB name when caller is in emergency_contacts (sipName irrelevant)', async () => {
    query.mockResolvedValueOnce({
      rows: [{ first_name: 'Naresh', last_name: 'Babu', extension_number: '1821', mobile_number: null }],
    });
    const r = await lookupCallerIdentity('1821', 'Naresh Babu');
    expect(r.name).toBe('Naresh Babu');
    expect(r.number).toBe('1821');
  });

  it('DB name still wins even when sipName differs from directory name', async () => {
    query.mockResolvedValueOnce({
      rows: [{ first_name: 'John', last_name: 'Doe', extension_number: '1821', mobile_number: null }],
    });
    const r = await lookupCallerIdentity('1821', 'Caller From Avaya');
    expect(r.name).toBe('John Doe');
    expect(r.number).toBe('1821');
  });
});

describe('TEST B — No directory match, SIP name present', async () => {
  const { query }              = await import('../../db/pool.js');
  const { lookupCallerIdentity } = await import('../../services/ersRingService.js');

  beforeEach(() => vi.clearAllMocks());

  it('1821 / Naresh Babu: SIP name used when DB has no match', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const r = await lookupCallerIdentity('1821', 'Naresh Babu');
    expect(r.name).toBe('Naresh Babu');
    expect(r.number).toBe('1821');
  });

  it('1832 / John Smith: SIP name used when DB has no match', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const r = await lookupCallerIdentity('1832', 'John Smith');
    expect(r.name).toBe('John Smith');
    expect(r.number).toBe('1832');
  });
});

describe('TEST C — No directory match, no SIP name (mobile/PSTN caller)', async () => {
  const { query }              = await import('../../db/pool.js');
  const { lookupCallerIdentity } = await import('../../services/ersRingService.js');

  beforeEach(() => vi.clearAllMocks());

  it('returns name: null (not "undefined", not "+9665..." as name) when no name available', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const r = await lookupCallerIdentity('+966512345678', null);
    expect(r.name).toBeNull();
    expect(r.number).toBe('+966512345678');
  });

  it('number is preserved exactly — not mangled or dropped', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const r = await lookupCallerIdentity('+966512345678', null);
    expect(r.number).toBe('+966512345678');
  });

  it('result has exactly {name, number} shape — no extra fabricated fields', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const r = await lookupCallerIdentity('+966512345678', null);
    expect(Object.keys(r)).toEqual(['name', 'number']);
  });
});

describe('TEST D — SIP name is empty string: treated as absent', async () => {
  const { query }              = await import('../../db/pool.js');
  const { lookupCallerIdentity } = await import('../../services/ersRingService.js');

  beforeEach(() => vi.clearAllMocks());

  it('empty string sipName → name: null (no empty-string display name injected)', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const r = await lookupCallerIdentity('1821', '');
    expect(r.name).toBeNull();
    expect(r.number).toBe('1821');
  });
});

describe('TEST E — SIP name is whitespace-only: treated as absent', async () => {
  const { query }              = await import('../../db/pool.js');
  const { lookupCallerIdentity } = await import('../../services/ersRingService.js');

  beforeEach(() => vi.clearAllMocks());

  it('whitespace-only sipName → name: null', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const r = await lookupCallerIdentity('1821', '   ');
    expect(r.name).toBeNull();
    expect(r.number).toBe('1821');
  });

  it('tab-only sipName → name: null', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const r = await lookupCallerIdentity('1821', '\t');
    expect(r.name).toBeNull();
    expect(r.number).toBe('1821');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST F — originateLeg: actual ESL command content
// Named caller: name vars present. Unnamed caller: name vars absent, number present.
// ═══════════════════════════════════════════════════════════════════════════════

async function runOriginateLeg(callerIdentity) {
  const { resolveDialString }   = await import('../../services/dialResolver.js');
  const { eslCommand, getConferenceMemberCount } = await import('../../services/eslService.js');
  const { startRingAll }        = await import('../../services/ersRingService.js');
  const { query }               = await import('../../db/pool.js');

  vi.clearAllMocks();

  resolveDialString.mockResolvedValue({
    dialString: 'sofia/gateway/avaya/1415',
    gateway:    { sip_domain: 'yerp.com', name: 'avaya' },
  });
  eslCommand.mockResolvedValue('+OK uuid-test');
  // lookupCallerIdentity DB call
  query.mockResolvedValueOnce({ rows: [] });
  // resolveTierResponders
  query.mockResolvedValueOnce({
    rows: [{ id: 1, first_name: 'Guard', last_name: 'One', mobile_number: '1415', extension_number: null }],
  });
  // INVITED pre-insert
  query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
  // dial_attempts update
  query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

  getConferenceMemberCount.mockResolvedValueOnce(0); // wave 0 — room empty, start ringing
  getConferenceMemberCount.mockResolvedValue(2);     // after first originate — someone answered

  startRingAll({
    incidentId:    1,
    incidentUuid:  'uuid-f',
    configId:      10,
    tier:          'primary',
    room:          'ers_10_primary',
    tenantId:      5,
    callerNumber:  callerIdentity.number,
    callerName:    callerIdentity.name,
    configGatewayId:   null,
    configGatewayName: 'avaya',
  });

  // Wait for async loop to fire the first originate wave
  await new Promise(r => setTimeout(r, 150));

  return eslCommand.mock.calls.length > 0 ? eslCommand.mock.calls[0][0] : null;
}

describe('TEST F — Mobile/PSTN caller: ERS Ring All completes without caller name', () => {
  it('eslCommand is called even when callerName is null (ring-all not blocked)', async () => {
    const cmd = await runOriginateLeg({ number: '+966512345678', name: null });
    expect(cmd).not.toBeNull();
    expect(cmd).toContain('bgapi originate');
  });

  it('originate command contains caller number even without a name', async () => {
    const cmd = await runOriginateLeg({ number: '+966512345678', name: null });
    expect(cmd).toContain('origination_caller_id_number=+966512345678');
    expect(cmd).toContain('effective_caller_id_number=+966512345678');
  });

  it('originate command does NOT contain an empty or fabricated caller name', async () => {
    const cmd = await runOriginateLeg({ number: '+966512345678', name: null });
    // Must NOT have name vars at all — not empty string, not "null", not the number
    expect(cmd).not.toContain("origination_caller_id_name=''");
    expect(cmd).not.toContain("effective_caller_id_name=''");
    expect(cmd).not.toContain("origination_caller_id_name='null'");
    expect(cmd).not.toContain("origination_caller_id_name='+966512345678'");
    expect(cmd).not.toMatch(/origination_caller_id_name='[^']*'/);
    expect(cmd).not.toMatch(/effective_caller_id_name='[^']*'/);
  });

  it('originate command still contains conference bridge target', async () => {
    const cmd = await runOriginateLeg({ number: '+966512345678', name: null });
    expect(cmd).toContain('&conference(ers_10_primary@');
  });
});

describe('TEST F — Named caller: name vars present in originate command', () => {
  it('origination_caller_id_name is set for named caller (Naresh Babu)', async () => {
    const cmd = await runOriginateLeg({ number: '1821', name: 'Naresh Babu' });
    expect(cmd).toContain("origination_caller_id_name='Naresh Babu'");
    expect(cmd).toContain("effective_caller_id_name='Naresh Babu'");
    expect(cmd).toContain('origination_caller_id_number=1821');
    expect(cmd).toContain('effective_caller_id_number=1821');
  });

  it('origination_caller_id_name is set for named caller (John Smith)', async () => {
    const cmd = await runOriginateLeg({ number: '1832', name: 'John Smith' });
    expect(cmd).toContain("origination_caller_id_name='John Smith'");
    expect(cmd).toContain('origination_caller_id_number=1832');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ENS REGRESSION — isolation proof
// ═══════════════════════════════════════════════════════════════════════════════

describe('ENS regression — ENS caller identity completely isolated from ERS changes', () => {
  it('eslService.js (ENS) does NOT call lookupCallerIdentity', () => {
    expect(eslServiceSrc).not.toContain('lookupCallerIdentity');
  });

  it('eslService.js (ENS) does NOT call startRingAll', () => {
    expect(eslServiceSrc).not.toContain('startRingAll');
  });

  it('eslService.js (ENS) does NOT call originateLeg from ersRingService', () => {
    expect(eslServiceSrc).not.toContain('originateLeg');
  });

  it('ENS outbound identity is blast_clid — never reads caller_id_name for CLI', () => {
    expect(eslServiceSrc).toContain('ensCli');
    const fnStart = eslServiceSrc.indexOf('export async function originateCampaignCall(');
    const fnEnd   = eslServiceSrc.indexOf('\nexport', fnStart + 10);
    expect(eslServiceSrc.slice(fnStart, fnEnd)).not.toContain('caller_id_name');
  });

  it('ersRingService.js does NOT reference blast_clid', () => {
    expect(ersRingSrc).not.toContain('blast_clid');
  });

  it('ersRingService.js does NOT reference ens_configurations', () => {
    expect(ersRingSrc).not.toContain('ens_configurations');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// XML GENERATOR — empty caller_id_name safety
// ═══════════════════════════════════════════════════════════════════════════════

describe('xmlGenerator: effective_caller_id_name is safe when caller_id_name is empty', () => {
  it('generated dialplan uses ${caller_id_name} variable reference, not a literal', async () => {
    const { generateDialplanXml } = await import('../../utils/xmlGenerator.js');
    const xml = generateDialplanXml(
      [{ number: '7501', flow_uuid: 'test-uuid', flow_name: 'Test Flow', version_number: 1 }],
      { nested: false }
    );
    // The set action must be there and reference the variable — not a hardcoded value
    expect(xml).toContain('application="set" data="effective_caller_id_name=${caller_id_name}"');
  });

  it('generated XML is structurally valid (contains required extension elements)', async () => {
    const { generateDialplanXml } = await import('../../utils/xmlGenerator.js');
    const xml = generateDialplanXml(
      [{ number: '7501', flow_uuid: 'test-uuid', flow_name: 'Test', version_number: 1 }],
      { nested: false }
    );
    expect(xml).toContain('<extension name="enrs_ivr_7501"');
    expect(xml).toContain('application="lua"  data="ivr_executor.lua"');
    // Both identity lines present and in the right order
    const nameIdx   = xml.indexOf('effective_caller_id_name');
    const numberIdx = xml.indexOf('effective_caller_id_number');
    expect(nameIdx).toBeGreaterThan(0);
    expect(nameIdx).toBeLessThan(numberIdx);
  });

  it('empty caller_id_name in the channel produces no "undefined" or "null" literal in XML', async () => {
    // The template is ${caller_id_name} — FreeSWITCH evaluates this at runtime.
    // The XML generator itself never evaluates the variable; verify it does NOT
    // substitute it with any literal value.
    const { generateDialplanXml } = await import('../../utils/xmlGenerator.js');
    const xml = generateDialplanXml(
      [{ number: '7501', flow_uuid: 'uuid', flow_name: 'F', version_number: 1 }],
      { nested: false }
    );
    expect(xml).not.toContain('effective_caller_id_name=undefined');
    expect(xml).not.toContain('effective_caller_id_name=null');
    expect(xml).not.toContain('effective_caller_id_name=""');
  });
});
