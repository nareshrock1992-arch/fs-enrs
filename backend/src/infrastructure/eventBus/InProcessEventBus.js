/**
 * In-process event bus — Sprint 0 infrastructure foundation.
 *
 * Implements the IEventBus interface for the modular monolith phase.
 * All events are dispatched within the same Node.js process.
 *
 * Design decisions:
 *   - publish() is non-blocking: handlers run via setImmediate to decouple
 *     the publisher from its consumers. The publisher never waits.
 *   - Consumer failures are isolated: Promise.allSettled() ensures one
 *     failing handler cannot block or suppress other handlers.
 *   - Every event must carry tenant_id and correlation_id. publish() throws
 *     synchronously if either is absent — fail-fast at the call site.
 *   - Wildcard subscriptions: subscribe('*', handler) receives every event.
 *   - Dead letter: events with no subscribers are emitted to a 'dead_letter'
 *     internal channel and logged at debug level.
 *
 * Usage:
 *   import { eventBus } from '../infrastructure/eventBus/InProcessEventBus.js';
 *
 *   // Subscribe
 *   const unsub = eventBus.subscribe('campaign.started', async (event) => {
 *     await monitoringService.onCampaignStarted(event);
 *   });
 *
 *   // Publish
 *   await eventBus.publish({
 *     event_type:      'campaign.started',
 *     event_id:        crypto.randomUUID(),
 *     schema_version:  '1.0',
 *     tenant_id:       tenantId,
 *     correlation_id:  correlationId,
 *     causation_id:    parentEventId,
 *     occurred_at:     new Date().toISOString(),
 *     payload:         { campaign_id, started_at },
 *   });
 *
 *   // Unsubscribe
 *   unsub();
 */

import { logger } from '../logger.js';

const log = logger.child({ module: 'event-bus' });

class InProcessEventBus {
  constructor() {
    // Map<event_type | '*', Set<handler>>
    this._handlers = new Map();

    // Total published / delivered / failed counters (accessible for tests)
    this._stats = { published: 0, delivered: 0, failed: 0 };
  }

  /**
   * Subscribe to an event type.
   * @param {string}   eventType  — exact event_type or '*' for all events
   * @param {function} handler    — async (event) => void
   * @returns {function}          — call to unsubscribe
   */
  subscribe(eventType, handler) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');

    if (!this._handlers.has(eventType)) {
      this._handlers.set(eventType, new Set());
    }
    this._handlers.get(eventType).add(handler);

    log.debug('Event handler registered', { event_type: eventType });

    return () => this.unsubscribe(eventType, handler);
  }

  /**
   * Subscribe for a single delivery only.
   */
  subscribeOnce(eventType, handler) {
    const wrapper = async (event) => {
      this.unsubscribe(eventType, wrapper);
      return handler(event);
    };
    return this.subscribe(eventType, wrapper);
  }

  /**
   * Remove a specific handler for an event type.
   */
  unsubscribe(eventType, handler) {
    this._handlers.get(eventType)?.delete(handler);
  }

  /**
   * Publish an event. Returns immediately — handlers run asynchronously.
   *
   * @throws {Error} if event is missing tenant_id or correlation_id
   */
  publish(event) {
    if (!event?.tenant_id)      throw new Error(`Event missing tenant_id: ${event?.event_type}`);
    if (!event?.correlation_id) throw new Error(`Event missing correlation_id: ${event?.event_type}`);
    if (!event?.event_type)     throw new Error('Event missing event_type');

    this._stats.published++;

    const handlers = [
      ...(this._handlers.get(event.event_type) ?? []),
      ...(this._handlers.get('*') ?? []),
    ];

    if (handlers.length === 0) {
      log.debug('Event has no subscribers (dead letter)', {
        event_type:     event.event_type,
        tenant_id:      event.tenant_id,
        correlation_id: event.correlation_id,
      });
      return;
    }

    // Dispatch asynchronously — publisher does not wait.
    setImmediate(() => {
      Promise.allSettled(handlers.map(h => this._invoke(h, event)));
    });
  }

  /**
   * Publish multiple events in order. Each is dispatched independently.
   */
  publishMany(events) {
    for (const event of events) this.publish(event);
  }

  async _invoke(handler, event) {
    try {
      await handler(event);
      this._stats.delivered++;
    } catch (err) {
      this._stats.failed++;
      log.error('Event handler threw', {
        event_type:     event.event_type,
        tenant_id:      event.tenant_id,
        correlation_id: event.correlation_id,
        error:          err.message,
        stack:          err.stack,
      });
    }
  }

  /**
   * Returns subscriber count for a given event type (used in tests).
   */
  subscriberCount(eventType) {
    return (this._handlers.get(eventType)?.size ?? 0) +
           (this._handlers.get('*')?.size ?? 0);
  }

  /**
   * Removes all handlers. Primarily for test isolation.
   */
  clear() {
    this._handlers.clear();
    this._stats = { published: 0, delivered: 0, failed: 0 };
  }

  get stats() {
    return { ...this._stats };
  }
}

// Platform-wide singleton. All modules import this instance.
export const eventBus = new InProcessEventBus();

// Export the class for testing / subclassing.
export { InProcessEventBus };
