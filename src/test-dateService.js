'use strict';
const assert = require('assert');
const dateService = require('./dateService');

const tz = 'Australia/Sydney';
const sydneyMorningUtc = new Date('2026-06-24T22:30:00Z');

assert.strictEqual(dateService.todayYmd(tz, sydneyMorningUtc), '2026-06-25');
assert.strictEqual(
  dateService.resolveDateToken('today', tz, sydneyMorningUtc),
  '2026-06-25T00:00:00Z'
);
assert.strictEqual(
  dateService.resolveDateToken('yesterday', tz, sydneyMorningUtc),
  '2026-06-24T00:00:00Z'
);
assert.strictEqual(
  dateService.resolveDateToken('tomorrow', tz, sydneyMorningUtc),
  '2026-06-26T00:00:00Z'
);
assert.strictEqual(
  dateService.weekStartOf('2026-06-25T00:00:00Z', tz),
  '2026-06-22'
);
assert.strictEqual(
  dateService.currentWeekStart(tz, sydneyMorningUtc),
  '2026-06-22'
);
assert.strictEqual(
  dateService.isFutureDate('2026-06-25T00:00:00Z', tz, sydneyMorningUtc),
  false
);
assert.strictEqual(
  dateService.isFutureDate('2026-06-26T00:00:00Z', tz, sydneyMorningUtc),
  true
);

console.log('dateService tests passed');
