'use strict';
const crypto = require('crypto');

// SHA-256 prefix — correlate without exposing raw PII (userId, conversationId, text)
function hash(value) {
  if (value == null) return null;
  return 'sha256:' + crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function newOperationId() {
  return 'op_' + crypto.randomBytes(6).toString('hex');
}

// Init Application Insights once at module load. Silently skipped if connection string absent.
let _client = null;
(function init() {
  const cs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!cs) return;
  try {
    const ai = require('applicationinsights');
    ai.setup(cs)
      .setAutoCollectRequests(false)
      .setAutoCollectDependencies(false)
      .setAutoCollectExceptions(false)
      .setAutoCollectPerformance(false)
      .start();
    _client = ai.defaultClient;
    if (!_client || typeof _client.trackEvent !== 'function') {
      _client = null;
      console.warn('[telemetry] Application Insights client unavailable, telemetry disabled');
      return;
    }
    console.log('[telemetry] Application Insights initialized');
  } catch (err) {
    console.error('[telemetry] init failed (continuing without it):', err.message);
  }
})();

// Track a custom event. Never throws — telemetry failures must not break bot turns.
function track(name, dimensions) {
  const dims = dimensions || {};
  const status = dims.success === false ? 'FAIL' : 'ok';
  console.log(`[tel] ${name} [${status}]`, dims);
  if (!_client) return;
  try {
    const props = {};
    for (const [k, v] of Object.entries(dims)) {
      if (v !== null && v !== undefined) {
        props[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
      }
    }
    _client.trackEvent({ name, properties: props });
    _client.flush();
  } catch (err) {
    console.error('[telemetry] trackEvent error:', err.message);
  }
}

module.exports = { track, hash, newOperationId };
