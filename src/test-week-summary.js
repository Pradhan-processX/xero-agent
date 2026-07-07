'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const draftFile = path.join(os.tmpdir(), `xero-agent-week-summary-drafts-${process.pid}.json`);
const mockTimeLog = path.join(os.tmpdir(), `xero-agent-week-summary-xero-${process.pid}.json`);

process.env.XERO_MOCK = 'true';
process.env.AZURE_STORAGE_CONNECTION_STRING = '';
process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = '';
process.env.DRAFT_STORE_FILE = draftFile;
process.env.XERO_MOCK_TIME_LOG = mockTimeLog;
process.env.DEFAULT_TIMEZONE = 'Australia/Sydney';

const draftStore = require('./draftStore');
const mockData = require('./mockData');
const weekSummary = require('./weekSummary');
const xero = require('./xero');

function cleanup() {
  for (const file of [draftFile, mockTimeLog]) {
    try { fs.unlinkSync(file); } catch {}
  }
}

async function createEntry({ project, task, userId, durationMin, dateUtc, description }) {
  return xero.createTimeEntry(
    {
      projectId: project.projectId,
      userId,
      taskId: task.taskId,
      dateUtc,
      durationMin,
      description,
    },
    `week-summary-${description}-${Math.random()}`
  );
}

async function main() {
  cleanup();

  const dm = mockData.projects.find((p) => p.name === 'ProcessX TranXform Project (DM)');
  const general = mockData.projects.find((p) => p.name === 'ProcessX ProcessX General');
  const development = dm.tasks.find((t) => t.name === 'Development');
  const meetings = dm.tasks.find((t) => t.name === 'Project Meetings');
  const admin = general.tasks.find((t) => t.name === 'Admin');

  const user = {
    ...mockData.defaultUser,
    allowedProjectIds: [dm.projectId],
  };

  await createEntry({
    project: dm,
    task: development,
    userId: user.xeroUserId,
    durationMin: 75,
    dateUtc: '2026-07-07T00:00:00Z',
    description: 'included development',
  });
  await createEntry({
    project: dm,
    task: meetings,
    userId: user.xeroUserId,
    durationMin: 30,
    dateUtc: '2026-07-08T00:00:00Z',
    description: 'included meetings',
  });
  await createEntry({
    project: general,
    task: admin,
    userId: user.xeroUserId,
    durationMin: 45,
    dateUtc: '2026-07-07T00:00:00Z',
    description: 'non allowed project',
  });
  await createEntry({
    project: dm,
    task: development,
    userId: 'mock-user-teammate',
    durationMin: 60,
    dateUtc: '2026-07-07T00:00:00Z',
    description: 'other user',
  });
  const deleted = await createEntry({
    project: dm,
    task: development,
    userId: user.xeroUserId,
    durationMin: 15,
    dateUtc: '2026-07-07T00:00:00Z',
    description: 'deleted entry',
  });
  await xero.deleteTimeEntry(dm.projectId, deleted.timeEntryId);

  await draftStore.addEntries(user.email, [{
    projectId: dm.projectId,
    projectName: dm.name,
    taskId: development.taskId,
    taskName: development.name,
    durationMin: 99,
    dateUtc: '2026-07-07T00:00:00Z',
    description: 'local draft only',
    issues: [],
    needsConfirmation: false,
  }]);

  const summary = await weekSummary.getWeekSummaryForUser(user, '2026-07-06');
  assert.equal(summary.source, 'xero');
  assert.equal(summary.weekStart, '2026-07-06');
  assert.equal(summary.weekEnd, '2026-07-12');
  assert.equal(summary.entries.length, 2);
  assert.equal(summary.totalMin, 105);
  assert.deepEqual(summary.entries.map((e) => e.durationMin), [75, 30]);
  assert(summary.entries.every((e) => e.userId === user.xeroUserId));
  assert(summary.entries.every((e) => e.projectId === dm.projectId));

  const text = weekSummary.formatWeekSummary(summary);
  assert.match(text, /Xero timesheet summary/);
  assert.match(text, /1h 15m/);
  assert.match(text, /30m/);
  assert.match(text, /Total: 1h 45m logged/);
  assert.doesNotMatch(text, /99m/);
  assert.equal(summary.entries.some((e) => e.description === 'non allowed project'), false);
  assert.equal(summary.entries.some((e) => e.description === 'other user'), false);
  assert.equal(summary.entries.some((e) => e.description === 'deleted entry'), false);

  const empty = await weekSummary.getWeekSummaryForUser(user, '2026-07-13');
  assert.equal(empty.entries.length, 0);
  assert.match(weekSummary.formatWeekSummary(empty), /No Xero time entries logged/);

  console.log('week summary tests passed');
}

main()
  .then(() => { cleanup(); })
  .catch((err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });
