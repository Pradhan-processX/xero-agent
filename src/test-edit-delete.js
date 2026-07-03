'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = os.tmpdir();
const draftFile = path.join(tmpRoot, `xero-agent-edit-delete-drafts-${process.pid}.json`);
const mockTimeLog = path.join(tmpRoot, `xero-agent-edit-delete-xero-${process.pid}.json`);

process.env.XERO_MOCK = 'true';
process.env.AZURE_STORAGE_CONNECTION_STRING = '';
process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = '';
process.env.DRAFT_STORE_FILE = draftFile;
process.env.XERO_MOCK_TIME_LOG = mockTimeLog;
process.env.DEFAULT_TIMEZONE = 'Australia/Sydney';

const agent = require('./agent');
const bot = require('./bot');
const draftStore = require('./draftStore');
const mockData = require('./mockData');
const xero = require('./xero');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function cleanup() {
  for (const file of [draftFile, mockTimeLog]) {
    try { fs.unlinkSync(file); } catch {}
  }
}

async function projectsWithTasks() {
  const projects = await xero.getProjects();
  return Promise.all(projects.map(async (p) => ({ ...p, tasks: await xero.getTasks(p.projectId) })));
}

async function addSubmittedEntry(user, project, task, durationMin, dateUtc) {
  const created = await xero.createTimeEntry(
    {
      projectId: project.projectId,
      userId: user.xeroUserId,
      taskId: task.taskId,
      dateUtc,
      durationMin,
      description: 'seeded test entry',
    },
    `seed-${durationMin}-${Math.random()}`
  );
  const [draft] = await draftStore.addEntries(user.email || user.teamsId, [{
    projectId: project.projectId,
    projectName: project.name,
    taskId: task.taskId,
    taskName: task.name,
    durationMin,
    dateUtc,
    description: 'seeded test entry',
    issues: [],
    needsConfirmation: false,
  }]);
  await draftStore.markSubmitted(draft.id, created.timeEntryId);
  return { draftId: draft.id, timeEntryId: created.timeEntryId };
}

async function main() {
  cleanup();

  const user = mockData.defaultUser;
  const project = mockData.projects.find((p) => p.name === 'ProcessX TranXform Project (DM)');
  const task = project.tasks.find((t) => t.name === 'Development');
  const dateUtc = '2026-07-02T00:00:00Z';
  const weekStart = draftStore.weekStartOf(dateUtc);

  const large = await addSubmittedEntry(user, project, task, 1200, dateUtc);
  await addSubmittedEntry(user, project, task, 60, dateUtc);

  const cachedProjects = await projectsWithTasks();

  const partial = await agent._internal.handlePrepareTimeEntryMutation(
    {
      date: '2026-07-02',
      projectName: project.name,
      removeDurationMinutes: 600,
      reason: 'remove 10 hours from the matching entry',
    },
    user,
    cachedProjects
  );

  assert.equal(partial.ok, true, partial.error);
  assert.equal(partial.mutation.action, 'update');
  assert.equal(partial.mutation.localEntryId, large.draftId);
  assert.equal(partial.mutation.currentDurationMin, 1200);
  assert.equal(partial.mutation.newDurationMin, 600);

  const updateMessage = await bot._internal.applyPendingMutation(partial.mutation, user, 'test-edit-update');
  assert.match(updateMessage, /Updated/);

  let weekEntries = await draftStore.getWeek(user.email, weekStart);
  const updatedLarge = weekEntries.find((e) => e.id === large.draftId);
  assert.equal(updatedLarge.durationMin, 600);

  let mockLog = readJson(mockTimeLog, []);
  assert.equal(mockLog.find((e) => e.timeEntryId === large.timeEntryId).duration, 600);

  const fullDelete = await agent._internal.handlePrepareTimeEntryMutation(
    {
      date: '2026-07-02',
      projectName: project.name,
      removeDurationMinutes: 600,
      reason: 'remove the remaining 10 hours',
    },
    user,
    cachedProjects
  );

  assert.equal(fullDelete.ok, true, fullDelete.error);
  assert.equal(fullDelete.mutation.action, 'delete');
  assert.equal(fullDelete.mutation.localEntryId, large.draftId);

  const deleteMessage = await bot._internal.applyPendingMutation(fullDelete.mutation, user, 'test-edit-delete');
  assert.match(deleteMessage, /Deleted/);

  weekEntries = await draftStore.getWeek(user.email, weekStart);
  assert.equal(weekEntries.some((e) => e.id === large.draftId), false);

  mockLog = readJson(mockTimeLog, []);
  assert.equal(mockLog.find((e) => e.timeEntryId === large.timeEntryId).status, 'DELETED');

  const [pendingDraft] = await draftStore.addEntries(user.email, [{
    projectId: project.projectId,
    projectName: project.name,
    taskId: task.taskId,
    taskName: task.name,
    durationMin: 30,
    dateUtc,
    description: 'cancel test',
    issues: [],
    needsConfirmation: false,
  }]);
  const discarded = await bot._internal.discardPendingDrafts([pendingDraft], 'test-cancel');
  assert.equal(discarded, 1);
  weekEntries = await draftStore.getWeek(user.email, weekStart);
  assert.equal(weekEntries.some((e) => e.id === pendingDraft.id), false);

  console.log('edit/delete tests passed');
}

main()
  .then(() => { cleanup(); })
  .catch((err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });
