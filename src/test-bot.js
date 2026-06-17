'use strict';
// Must set mock mode before any module loads config.
process.env.XERO_MOCK = 'true';
require('dotenv').config();

const { run } = require('./agent');
const mockData = require('./mockData');

const user = mockData.defaultUser;

// ── Helpers ───────────────────────────────────────────────────────────────────
const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const SKIP = '\x1b[33m~\x1b[0m';

let passed = 0, failed = 0;

function check(label, actual, expectFn) {
  let ok = false;
  let detail = '';
  try {
    ok = expectFn(actual);
  } catch (e) {
    detail = e.message;
  }
  if (ok) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

async function test(name, text, expectFn) {
  console.log(`\n── ${name}`);
  console.log(`   input: "${text}"`);
  try {
    const result = await run(text, [], user);
    console.log(`   type: ${result.type}`);
    if (result.type === 'card') {
      const e = result.entries[0];
      console.log(`   entries[0]: ${e?.projectName} › ${e?.taskName} ${e?.durationMin}min ${e?.dateUtc?.slice(0,10)} warnings=${e?.issues?.length}`);
    } else {
      console.log(`   content: "${(result.content || '').slice(0, 120)}"`);
    }
    expectFn(result);
  } catch (err) {
    console.log(`  ${FAIL} threw: ${err.message}`);
    failed++;
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Bot path tests (XERO_MOCK=true) ===\n');

  // ── Happy paths ──────────────────────────────────────────────────────────────

  await test('1. Help triage', 'hi', (r) => {
    check('type=text',       r, (r) => r.type === 'text');
    check('mentions logging', r, (r) => /log|timesheet|xero/i.test(r.content));
  });

  await test('2. Off-topic triage', "what's the weather like today", (r) => {
    check('type=text',              r, (r) => r.type === 'text');
    check('redirects to timesheets', r, (r) => /log|xero|time/i.test(r.content));
  });

  await test('3. Review (show week)', 'show my week', (r) => {
    check('type=text',    r, (r) => r.type === 'text');
    check('week summary', r, (r) => /week|hours|logged/i.test(r.content));
  });

  await test('4. Log time — happy path (single entry)', '3h on ProcessX TranXform Project (DM) Development today', (r) => {
    check('type=card',        r, (r) => r.type === 'card');
    check('1 entry',          r, (r) => r.entries.length === 1);
    check('correct project',  r, (r) => r.entries[0].projectName.includes('TranXform'));
    check('correct task',     r, (r) => r.entries[0].taskName === 'Development');
    check('duration 180 min', r, (r) => r.entries[0].durationMin === 180);
    check('no issues',        r, (r) => r.entries[0].issues.length === 0);
  });

  await test('5. Log time — multiple entries', '2h meetings and 1.5h development on DM project today', (r) => {
    check('type=card',     r, (r) => r.type === 'card');
    check('2+ entries',    r, (r) => r.entries.length >= 2);
  });

  // ── Guard / hard paths ───────────────────────────────────────────────────────

  await test('6. Guard: missing duration', 'I worked on the DM project Development today', (r) => {
    check('type=text',       r, (r) => r.type === 'text');
    check('asks for duration', r, (r) => /how long|duration|hours|time/i.test(r.content));
  });

  await test('7. Guard: future date', '3h on ProcessX TranXform Project (DM) Development tomorrow', (r) => {
    check('type=text',          r, (r) => r.type === 'text');
    check('mentions future date', r, (r) => /future|tomorrow|date/i.test(r.content));
  });

  await test('8. Guard: unknown project', '3h on FakeProject XYZ today', (r) => {
    check('type=text',             r, (r) => r.type === 'text');
    check('mentions not found', r, (r) => /not found|available|project/i.test(r.content));
  });

  await test('9. Guard: unknown task', '3h on ProcessX TranXform Project (DM) FakeTask today', (r) => {
    check('type=text',          r, (r) => r.type === 'text');
    check('mentions task issue', r, (r) => /task|not found|available/i.test(r.content));
  });

  await test('10. Soft warning: >16h duration', '20h on ProcessX TranXform Project (DM) Development today', (r) => {
    check('type=card',          r, (r) => r.type === 'card');
    check('has warning',        r, (r) => r.entries[0].issues.length > 0);
    check('needsConfirmation',  r, (r) => r.entries[0].needsConfirmation === true);
    check('duration=1200min',   r, (r) => r.entries[0].durationMin === 1200);
  });

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`${PASS} ${passed} passed   ${failed > 0 ? FAIL : ''} ${failed > 0 ? failed + ' failed' : ''}`);
  console.log();
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
