'use strict';

const config = require('./config');
const dateService = require('./dateService');
const xero = require('./xero');

function fmtDuration(minutes) {
  const total = Math.round(Number(minutes) || 0);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function normalizeWeekStart(weekStart) {
  if (!weekStart) return dateService.currentWeekStart();
  return dateService.weekStartOf(weekStart);
}

function taskNameFor(project, taskId) {
  const task = (project.tasks || []).find((t) => t.taskId === taskId);
  return task ? task.name : taskId || 'Unknown task';
}

async function allowedProjectsWithTasks(user) {
  const allowed = new Set(user.allowedProjectIds || []);
  const projects = await xero.getProjects();
  const mine = projects.filter((p) => allowed.has(p.projectId));
  return Promise.all(mine.map(async (p) => ({ ...p, tasks: await xero.getTasks(p.projectId) })));
}

function normalizeEntry(entry, project) {
  const durationMin = Math.round(Number(entry.duration || entry.durationMin || 0));
  return {
    source: 'xero',
    timeEntryId: entry.timeEntryId,
    projectId: project.projectId,
    projectName: project.name,
    taskId: entry.taskId,
    taskName: taskNameFor(project, entry.taskId),
    userId: entry.userId,
    dateUtc: entry.dateUtc,
    durationMin,
    description: entry.description || '',
    status: entry.status || 'ACTIVE',
  };
}

async function getWeekSummaryForUser(user, weekStart) {
  if (!user) throw new Error('user is required');
  if (!user.xeroUserId) throw new Error('mapped xeroUserId is required');

  const normalizedWeekStart = normalizeWeekStart(weekStart);
  const weekEnd = dateService.addDays(normalizedWeekStart, 6);
  const dateAfterUtc = dateService.toXeroDateUtc(normalizedWeekStart);
  const dateBeforeUtc = dateService.toXeroDateUtc(weekEnd);

  const projects = await allowedProjectsWithTasks(user);
  const entries = [];

  for (const project of projects) {
    const projectEntries = await xero.getTimeEntries({
      projectId: project.projectId,
      userId: user.xeroUserId,
      states: ['ACTIVE'],
      dateAfterUtc,
      dateBeforeUtc,
    });
    for (const entry of projectEntries) {
      entries.push(normalizeEntry(entry, project));
    }
  }

  entries.sort((a, b) =>
    String(a.dateUtc || '').localeCompare(String(b.dateUtc || '')) ||
    String(a.projectName || '').localeCompare(String(b.projectName || '')) ||
    String(a.taskName || '').localeCompare(String(b.taskName || '')) ||
    String(a.timeEntryId || '').localeCompare(String(b.timeEntryId || ''))
  );

  const totalMin = entries.reduce((sum, entry) => sum + (entry.durationMin || 0), 0);

  return {
    source: 'xero',
    weekStart: normalizedWeekStart,
    weekEnd,
    entries,
    totalMin,
    totalHours: +(totalMin / 60).toFixed(2),
    targetHours: config.agent.weeklyHours,
    projectCount: projects.length,
  };
}

function formatWeekSummary(summary) {
  if (!summary.entries.length) {
    return `No Xero time entries logged for this week (${summary.weekStart} to ${summary.weekEnd}) yet.`;
  }

  const lines = summary.entries.map(
    (e) => `${(e.dateUtc || '').slice(0, 10)} - ${e.projectName} > ${e.taskName}: ${fmtDuration(e.durationMin)}`
  );

  return [
    `Here's your Xero timesheet summary for this week (${summary.weekStart} to ${summary.weekEnd}):`,
    '',
    ...lines,
    '',
    `Total: ${fmtDuration(summary.totalMin)} logged (weekly target: ${summary.targetHours}h)`,
  ].join('\n');
}

module.exports = {
  allowedProjectsWithTasks,
  formatWeekSummary,
  getWeekSummaryForUser,
  _internal: {
    fmtDuration,
    normalizeEntry,
    normalizeWeekStart,
  },
};
