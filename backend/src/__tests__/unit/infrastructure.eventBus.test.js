/**
 * Unit tests — InProcessEventBus
 * Sprint 0 acceptance criterion: event bus dispatches, isolates failures,
 * enforces tenant_id + correlation_id, supports wildcard subscriptions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InProcessEventBus } from '../../infrastructure/eventBus/InProcessEventBus.js';

// Helper: flush all setImmediate callbacks so async dispatch completes.
function flushImmediate() {
  return new Promise(resolve => setImmediate(resolve));
}

function makeEvent(overrides = {}) {
  return {
    event_type:     'campaign.started',
    event_id:       'ev-001',
    schema_version: '1.0',
    tenant_id:      'tenant-abc',
    correlation_id: 'corr-xyz',
    causation_id:   null,
    occurred_at:    new Date().toISOString(),
    payload:        { campaign_id: 'camp-1' },
    ...overrides,
  };
}

describe('InProcessEventBus', () => {
  let bus;

  beforeEach(() => {
    bus = new InProcessEventBus();
  });

  // ── publish / subscribe ────────────────────────────────────────────────────

  it('delivers event to a matching subscriber', async () => {
    const received = [];
    bus.subscribe('campaign.started', (e) => received.push(e));

    bus.publish(makeEvent());
    await flushImmediate();

    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe('campaign.started');
  });

  it('does not deliver event to non-matching subscriber', async () => {
    const received = [];
    bus.subscribe('campaign.completed', (e) => received.push(e));

    bus.publish(makeEvent({ event_type: 'campaign.started' }));
    await flushImmediate();

    expect(received).toHaveLength(0);
  });

  it('delivers to wildcard (*) subscriber', async () => {
    const received = [];
    bus.subscribe('*', (e) => received.push(e));

    bus.publish(makeEvent({ event_type: 'some.other.event' }));
    await flushImmediate();

    expect(received).toHaveLength(1);
  });

  it('delivers to both specific and wildcard subscribers', async () => {
    const specific = [];
    const wildcard = [];
    bus.subscribe('campaign.started', (e) => specific.push(e));
    bus.subscribe('*', (e) => wildcard.push(e));

    bus.publish(makeEvent());
    await flushImmediate();

    expect(specific).toHaveLength(1);
    expect(wildcard).toHaveLength(1);
  });

  it('unsubscribe stops delivery', async () => {
    const received = [];
    const unsub = bus.subscribe('campaign.started', (e) => received.push(e));
    unsub();

    bus.publish(makeEvent());
    await flushImmediate();

    expect(received).toHaveLength(0);
  });

  it('subscribeOnce delivers exactly once', async () => {
    const received = [];
    bus.subscribeOnce('campaign.started', (e) => received.push(e));

    bus.publish(makeEvent());
    bus.publish(makeEvent());
    await flushImmediate();

    expect(received).toHaveLength(1);
  });

  // ── Required field enforcement ─────────────────────────────────────────────

  it('throws synchronously when tenant_id is missing', () => {
    expect(() => bus.publish(makeEvent({ tenant_id: undefined }))).toThrow(/tenant_id/);
  });

  it('throws synchronously when correlation_id is missing', () => {
    expect(() => bus.publish(makeEvent({ correlation_id: undefined }))).toThrow(/correlation_id/);
  });

  it('throws synchronously when event_type is missing', () => {
    expect(() => bus.publish(makeEvent({ event_type: undefined }))).toThrow(/event_type/);
  });

  // ── Consumer failure isolation ──────────────────────────────────────────────

  it('a failing handler does not prevent other handlers from receiving the event', async () => {
    const received = [];
    bus.subscribe('campaign.started', async () => { throw new Error('handler explosion'); });
    bus.subscribe('campaign.started', (e) => received.push(e));

    bus.publish(makeEvent());
    await flushImmediate();

    // The second handler must still receive the event.
    expect(received).toHaveLength(1);
  });

  it('increments failed stat when a handler throws', async () => {
    bus.subscribe('campaign.started', async () => { throw new Error('boom'); });

    bus.publish(makeEvent());
    await flushImmediate();

    expect(bus.stats.failed).toBe(1);
  });

  // ── Stats ──────────────────────────────────────────────────────────────────

  it('increments published stat', () => {
    bus.subscribe('campaign.started', () => {});
    bus.publish(makeEvent());
    expect(bus.stats.published).toBe(1);
  });

  it('subscriberCount returns correct count', () => {
    bus.subscribe('campaign.started', () => {});
    bus.subscribe('campaign.started', () => {});
    expect(bus.subscriberCount('campaign.started')).toBe(2);
  });

  it('clear() removes all handlers and resets stats', async () => {
    const received = [];
    bus.subscribe('campaign.started', (e) => received.push(e));
    bus.publish(makeEvent());
    bus.clear();
    bus.publish(makeEvent());
    await flushImmediate();

    // After clear, second publish has no handlers → dead letter, received stays at 0
    expect(received).toHaveLength(0);
    expect(bus.stats.published).toBe(0);
  });

  // ── publishMany ────────────────────────────────────────────────────────────

  it('publishMany dispatches all events', async () => {
    const received = [];
    bus.subscribe('*', (e) => received.push(e));

    bus.publishMany([
      makeEvent({ event_id: 'ev-1' }),
      makeEvent({ event_id: 'ev-2' }),
      makeEvent({ event_id: 'ev-3' }),
    ]);
    await flushImmediate();

    expect(received).toHaveLength(3);
  });
});
