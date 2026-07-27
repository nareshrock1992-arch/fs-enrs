/**
 * Prometheus-compatible metric recorder — Sprint 0 infrastructure foundation.
 *
 * Wraps prom-client with the MetricRecorder interface defined in the Shared Kernel.
 * All metrics are prefixed with 'enrs_' and carry a 'service' label.
 *
 * Usage:
 *   import { metrics } from './infrastructure/metrics.js';
 *   metrics.increment('campaign_started_total', { tenant_id: tid });
 *   metrics.gauge('active_campaigns', 5, { tenant_id: tid });
 *   metrics.timing('originate_duration_ms', 342, { channel: 'freeswitch' });
 *
 * Exposition:
 *   import { metricsText } from './infrastructure/metrics.js';
 *   const body = await metricsText(); // Prometheus text format
 */

import client from 'prom-client';

// Default labels on every metric
const DEFAULT_LABELS = { service: process.env.SERVICE_NAME ?? 'enrs-backend' };

client.register.setDefaultLabels(DEFAULT_LABELS);

// Collect default Node.js process metrics (memory, CPU, event loop lag)
client.collectDefaultMetrics({ prefix: 'enrs_' });

// ── Metric definitions ─────────────────────────────────────────────────────
// We use a registry-backed pattern: define each metric once, lazily on first
// use. Unknown metric names throw — no silent counter creation.

const _counters   = new Map();
const _gauges     = new Map();
const _histograms = new Map();

const COUNTER_NAMES = new Set([
  // Campaign
  'enrs_campaign_created_total',
  'enrs_campaign_started_total',
  'enrs_campaign_completed_total',
  'enrs_campaign_expired_total',
  'enrs_campaign_cancelled_total',
  // Delivery
  'enrs_originate_total',
  'enrs_originate_answered_total',
  'enrs_originate_failed_total',
  'enrs_retry_total',
  // Playback
  'enrs_playback_session_total',
  'enrs_playback_unauthorized_total',
  // API
  'enrs_http_requests_total',
  'enrs_http_errors_total',
  // Internal
  'enrs_internal_requests_total',
  // Gateway
  'enrs_gateway_degraded_total',
  // Auth
  'enrs_login_success_total',
  'enrs_login_failed_total',
]);

const GAUGE_NAMES = new Set([
  'enrs_active_campaigns',
  'enrs_active_calls',
  'enrs_queued_destinations',
  'enrs_redis_connected',
  'enrs_db_pool_size',
  'enrs_db_pool_idle',
  'enrs_esl_connected',
]);

const HISTOGRAM_NAMES = new Set([
  'enrs_originate_duration_ms',
  'enrs_http_request_duration_ms',
  'enrs_db_query_duration_ms',
  'enrs_playback_duration_sec',
]);

function getCounter(name) {
  if (!COUNTER_NAMES.has(name)) throw new Error(`Unknown counter: ${name}`);
  if (!_counters.has(name)) {
    _counters.set(name, new client.Counter({ name, help: name, labelNames: ['tenant_id', 'channel', 'cause', 'status', 'method', 'path'] }));
  }
  return _counters.get(name);
}

function getGauge(name) {
  if (!GAUGE_NAMES.has(name)) throw new Error(`Unknown gauge: ${name}`);
  if (!_gauges.has(name)) {
    _gauges.set(name, new client.Gauge({ name, help: name, labelNames: ['tenant_id', 'gateway'] }));
  }
  return _gauges.get(name);
}

function getHistogram(name) {
  if (!HISTOGRAM_NAMES.has(name)) throw new Error(`Unknown histogram: ${name}`);
  if (!_histograms.has(name)) {
    _histograms.set(name, new client.Histogram({
      name,
      help: name,
      labelNames: ['tenant_id', 'channel', 'method', 'path', 'status'],
      buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
    }));
  }
  return _histograms.get(name);
}

// ── Public interface ────────────────────────────────────────────────────────

export const metrics = {
  increment(name, labels = {}) {
    try { getCounter(name).inc(labels); } catch (e) { /* unknown metric — silent in prod */ }
  },

  gauge(name, value, labels = {}) {
    try { getGauge(name).set(labels, value); } catch (e) { /* unknown metric — silent in prod */ }
  },

  timing(name, ms, labels = {}) {
    try { getHistogram(name).observe(labels, ms); } catch (e) { /* unknown metric — silent in prod */ }
  },

  // Returns a timer function — call it to record the elapsed duration.
  // Usage: const done = metrics.startTimer('enrs_db_query_duration_ms', labels);
  //        await runQuery(); done();
  startTimer(name, labels = {}) {
    const end = getHistogram(name).startTimer(labels);
    return end;
  },
};

// Returns the full Prometheus text exposition string.
export async function metricsText() {
  return client.register.metrics();
}

export { client as promClient };
