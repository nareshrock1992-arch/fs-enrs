/**
 * Unit tests for resolveContact() routing logic in campaignEngine.js.
 *
 * These tests cover only the routing decision (routing_mode_used, gateway_name,
 * target_type, phone_number). Nothing else in the campaign engine is exercised.
 *
 * The platform default gateway is mocked to 'default' for every test so that
 * the "extension always internal even when a gateway exists" fix is verified
 * under the same conditions that triggered the original bug.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock config before importing campaignEngine so the module sees the stub.
// The platform default gateway must be non-null to recreate the original bug scenario.
vi.mock('../../config/index.js', () => ({
  config: {
    freeswitch: { defaultGateway: 'default', ttsEngine: 'flite|kal' },
    esl:        { domain: '127.0.0.1' },
    piper:      { url: 'http://127.0.0.1:5002', defaultVoice: 'en_US-lessac-medium', timeoutMs: 30000, sampleRate: 8000 },
  },
}));

// campaignEngine now imports piperClient; mock it so config.piper isn't
// accessed at module-load time in tests that don't exercise Piper.
vi.mock('../../services/piperClient.js', () => ({
  synthesize:            vi.fn(),
  synthesizeToFile:      vi.fn(),
  PiperError:            class PiperError extends Error { constructor(code, m) { super(m); this.code = code; } },
  PiperUnavailableError: class PiperUnavailableError extends Error {},
  PiperTimeoutError:     class PiperTimeoutError extends Error {},
}));

// Mock the DB pool and ESL service — resolveContact itself makes no DB calls,
// but the module imports them at the top level.
vi.mock('../../db/pool.js',       () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../../services/eslService.js', () => ({ originateCampaignCall: vi.fn() }));
vi.mock('../../services/socketService.js', () => ({ emitInternal: vi.fn() }));
vi.mock('../../infrastructure/index.js',  () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveContact } from '../../services/campaignEngine.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

// A gateway map that contains a 'default' gateway (the platform default).
// Used in all tests to prove that a configured gateway does NOT force
// extension contacts into gateway mode.
function makeGateways(names = ['default']) {
  const rows = names.map((n, i) => ({ id: i + 1, name: n }));
  return {
    byId:   new Map(rows.map(g => [g.id,   g])),
    byName: new Map(rows.map(g => [g.name, g])),
  };
}

// Base ENS configuration — auto mode, no explicit gateway.
const BASE_CFG = {
  routing_mode:    'auto',
  dial_preference: 'extension_mobile',
  allow_extension: true,
  allow_mobile:    true,
  sip_gateway:     null,
  gateway_override: null,
  mobile_normalize_enabled: false,
  ext_normalize_enabled:    false,
};

// ── auto mode ────────────────────────────────────────────────────────────────

describe('resolveContact — routing_mode = auto', () => {

  describe('Case 1: extension only', () => {
    it('routes internally even when a platform default gateway is configured', () => {
      const contact  = { extension_number: '1001', mobile_number: null, gateway_id: null };
      const gateways = makeGateways(['default']); // platform default IS in the map

      const result = resolveContact(contact, BASE_CFG, gateways);

      expect(result.skip).toBe(false);
      expect(result.target_type).toBe('extension');
      expect(result.routing_mode_used).toBe('internal');
      expect(result.gateway_name).toBeNull();
      expect(result.phone_number).toBe('1001');
    });
  });

  describe('Case 2: mobile only', () => {
    it('routes via gateway when one is configured', () => {
      const contact  = { extension_number: null, mobile_number: '0507221769', gateway_id: null };
      const gateways = makeGateways(['default']);

      const result = resolveContact(contact, BASE_CFG, gateways);

      expect(result.skip).toBe(false);
      expect(result.target_type).toBe('mobile');
      expect(result.routing_mode_used).toBe('gateway');
      expect(result.gateway_name).toBe('default');
      expect(result.phone_number).toBe('0507221769');
    });

    it('routes internally when no gateway is configured', () => {
      const contact  = { extension_number: null, mobile_number: '0507221769', gateway_id: null };
      const gateways = makeGateways([]); // no gateways at all

      const result = resolveContact(contact, BASE_CFG, gateways);

      expect(result.skip).toBe(false);
      expect(result.target_type).toBe('mobile');
      expect(result.routing_mode_used).toBe('internal');
      expect(result.gateway_name).toBeNull();
    });
  });

  describe('Case 3: extension + mobile, dial_preference = mobile_extension', () => {
    it('selects mobile and routes via gateway', () => {
      const contact  = { extension_number: '1002', mobile_number: '0507221769', gateway_id: null };
      const cfg      = { ...BASE_CFG, dial_preference: 'mobile_extension' };
      const gateways = makeGateways(['default']);

      const result = resolveContact(contact, cfg, gateways);

      expect(result.skip).toBe(false);
      expect(result.target_type).toBe('mobile');
      expect(result.routing_mode_used).toBe('gateway');
      expect(result.gateway_name).toBe('default');
      expect(result.phone_number).toBe('0507221769');
    });
  });

  describe('Case 4: extension + mobile, dial_preference = extension_mobile', () => {
    it('selects extension and routes internally even when a gateway is configured', () => {
      const contact  = { extension_number: '1002', mobile_number: '0507221769', gateway_id: null };
      const cfg      = { ...BASE_CFG, dial_preference: 'extension_mobile' };
      const gateways = makeGateways(['default']);

      const result = resolveContact(contact, cfg, gateways);

      expect(result.skip).toBe(false);
      expect(result.target_type).toBe('extension');
      expect(result.routing_mode_used).toBe('internal');
      expect(result.gateway_name).toBeNull();
      expect(result.phone_number).toBe('1002');
    });
  });

  describe('mobile falls back to extension when mobile not allowed', () => {
    it('dial_preference=mobile_extension, allow_mobile=false → falls back to extension → internal', () => {
      const contact  = { extension_number: '1003', mobile_number: '0507221769', gateway_id: null };
      const cfg      = { ...BASE_CFG, dial_preference: 'mobile_extension', allow_mobile: false };
      const gateways = makeGateways(['default']);

      const result = resolveContact(contact, cfg, gateways);

      expect(result.skip).toBe(false);
      expect(result.target_type).toBe('extension');
      expect(result.routing_mode_used).toBe('internal');
      expect(result.gateway_name).toBeNull();
    });
  });

});

// ── gateway_only ─────────────────────────────────────────────────────────────

describe('resolveContact — routing_mode = gateway_only', () => {

  it('skips contact when no gateway is configured', () => {
    const contact  = { extension_number: '1001', mobile_number: null, gateway_id: null };
    const cfg      = { ...BASE_CFG, routing_mode: 'gateway_only' };
    const gateways = makeGateways([]); // no gateways

    const result = resolveContact(contact, cfg, gateways);

    expect(result.skip).toBe(true);
    expect(result.reason).toBe('gateway_only_mode_but_no_gateway_configured');
  });

  it('routes via gateway when a gateway is configured, regardless of target type', () => {
    const contact  = { extension_number: '1001', mobile_number: null, gateway_id: null };
    const cfg      = { ...BASE_CFG, routing_mode: 'gateway_only', sip_gateway: 'service-provider' };
    const gateways = makeGateways(['service-provider']);

    const result = resolveContact(contact, cfg, gateways);

    expect(result.skip).toBe(false);
    expect(result.routing_mode_used).toBe('gateway');
    expect(result.gateway_name).toBe('service-provider');
  });

  it('skips when no contact numbers at all', () => {
    const contact  = { extension_number: null, mobile_number: null, gateway_id: null };
    const cfg      = { ...BASE_CFG, routing_mode: 'gateway_only', sip_gateway: 'service-provider' };
    const gateways = makeGateways(['service-provider']);

    const result = resolveContact(contact, cfg, gateways);

    expect(result.skip).toBe(true);
  });

});

// ── internal_only ─────────────────────────────────────────────────────────────

describe('resolveContact — routing_mode = internal_only', () => {

  it('routes extension internally even when a gateway is configured', () => {
    const contact  = { extension_number: '1001', mobile_number: null, gateway_id: null };
    const cfg      = { ...BASE_CFG, routing_mode: 'internal_only', sip_gateway: 'service-provider' };
    const gateways = makeGateways(['default', 'service-provider']);

    const result = resolveContact(contact, cfg, gateways);

    expect(result.skip).toBe(false);
    expect(result.routing_mode_used).toBe('internal');
    expect(result.gateway_name).toBeNull();
    expect(result.phone_number).toBe('1001');
  });

  it('routes mobile internally — gateway is suppressed', () => {
    const contact  = { extension_number: null, mobile_number: '0507221769', gateway_id: null };
    const cfg      = { ...BASE_CFG, routing_mode: 'internal_only', sip_gateway: 'service-provider' };
    const gateways = makeGateways(['default', 'service-provider']);

    const result = resolveContact(contact, cfg, gateways);

    expect(result.skip).toBe(false);
    expect(result.routing_mode_used).toBe('internal');
    expect(result.gateway_name).toBeNull();
    expect(result.phone_number).toBe('0507221769');
  });

  it('skips when no dialable number exists', () => {
    const contact  = { extension_number: null, mobile_number: null, gateway_id: null };
    const cfg      = { ...BASE_CFG, routing_mode: 'internal_only' };
    const gateways = makeGateways(['default']);

    const result = resolveContact(contact, cfg, gateways);

    expect(result.skip).toBe(true);
  });

});
