'use strict';
const crypto = require('crypto');
const config = require('./config');
const xero = require('./xero');
const draftStore = require('./draftStore');
const telemetry = require('./telemetry');
const dateService = require('./dateService');
const weekSummary = require('./weekSummary');

// ── Azure OpenAI raw fetch ────────────────────────────────────────────────────
async function callAzure(deployment, messages, opts = {}) {
  const endpoint = config.llm.azureEndpoint.replace(/\/+$/, '');
  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${config.llm.azureApiVersion}`;
  const body = { messages, temperature: 0 };
  if (opts.max_tokens) body.max_tokens = opts.max_tokens;
  if (opts.response_format) body.response_format = opts.response_format;
  if (opts.tools) { body.tools = opts.tools; body.tool_choice = opts.tool_choice || 'auto'; }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': config.llm.azureKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Azure OpenAI ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Triage: cheap classification with gpt-4o-mini ────────────────────────────
// Falls back to the reasoning deployment if triageDeployment is not set.
async function triage(text, history) {
  const deployment = config.llm.triageDeployment || config.llm.azureDeployment;
  // Last 2 history messages give triage context for short follow-up replies
  // (e.g. "AI clinical" after bot asked "which project?")
  const recentHistory = Array.isArray(history) ? history.slice(-2) : [];
  const resp = await callAzure(
    deployment,
    [
      {
        role: 'system',
        content: `Classify the user message into exactly one type and respond ONLY with JSON.

Types:
- "help": greeting, asking what the bot does, general questions about using the assistant
- "off_topic": nothing to do with work hours, timesheets, or time tracking
- "complex": anything else — logging time, reviewing hours (this week, last week, any time range), editing entries, multi-step questions

When in doubt, choose "complex". If the conversation history shows the assistant asked a clarifying question, treat the user reply as "complex".

Respond ONLY with: {"type":"help"} or {"type":"off_topic"} or {"type":"complex"}`,
      },
      ...recentHistory,
      { role: 'user', content: text },
    ],
    { max_tokens: 20, response_format: { type: 'json_object' } }
  );

  try {
    const parsed = JSON.parse(resp.choices[0].message.content);
    return ['help', 'off_topic', 'complex'].includes(parsed.type)
      ? parsed
      : { type: 'complex' };
  } catch {
    return { type: 'complex' };
  }
}

// ── Tool definitions passed to gpt-4.1 ───────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_projects',
      description: "Returns the user's allowed Xero projects and their tasks. Always call this before create_draft so you know the exact project and task names.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_draft',
      description: 'Validates and queues one time entry draft. Call once per distinct activity. Returns ok with confirmation, or an error explaining what is missing.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Exact project name from get_projects result' },
          taskName: { type: 'string', description: 'Exact task name from get_projects result' },
          durationMinutes: { type: 'number', description: 'Duration as an integer number of minutes (e.g. 90 for 1.5 hours)' },
          date: { type: 'string', description: 'Date as YYYY-MM-DD, "today", or "yesterday"' },
          description: { type: 'string', description: 'Optional one-line description of the work done' },
        },
        required: ['projectName', 'taskName', 'durationMinutes', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_week_summary',
      description: "Returns the user's Xero time entries for the current week with totals versus their weekly target.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'prepare_time_entry_mutation',
      description: 'Finds exactly one existing time entry and prepares an update or delete for user confirmation. Use for editing, reducing, removing, or deleting existing timesheet entries. This does not write to Xero.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Exact date as YYYY-MM-DD, "today", or "yesterday". Required for edits/deletes.' },
          projectName: { type: 'string', description: 'Project name mentioned by the user, if any.' },
          taskName: { type: 'string', description: 'Task name mentioned by the user, if any.' },
          removeDurationMinutes: { type: 'number', description: 'Minutes to remove from the existing entry, e.g. 600 for "remove 10 hours".' },
          newDurationMinutes: { type: 'number', description: 'New total duration in minutes, e.g. 600 for "set it to 10 hours".' },
          deleteEntireEntry: { type: 'boolean', description: 'True only when the user wants to remove/delete the entire matching entry.' },
          reason: { type: 'string', description: 'Short user-facing reason for the proposed change.' },
        },
        required: ['date'],
      },
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const norm = (s) => (s || '').trim().toLowerCase();

function fmtDuration(minutes) {
  if (!minutes) return '?';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function futureWithinWeekIssue(dateUtc) {
  return `Future date in the current week (${dateUtc.slice(0, 10)}) - please confirm this planned time`;
}

// ── Tool handlers (guards run here in app code, not inside the LLM) ───────────

async function handleGetProjects(user) {
  const all = await xero.getProjects();
  const allowed = new Set(user.allowedProjectIds || []);
  const mine = all.filter((p) => allowed.has(p.projectId));
  return Promise.all(mine.map(async (p) => ({ ...p, tasks: await xero.getTasks(p.projectId) })));
}

// All 4 entry-level guards live here. Returns { error, guard } or { ok, entry }.
// cachedProjects is passed in so we don't re-fetch during a single reasoning loop.
function handleCreateDraft(args, cachedProjects) {
  // Guard 1: project in user's allowlist
  const project = cachedProjects.find((p) => norm(p.name) === norm(args.projectName));
  if (!project) {
    const names = cachedProjects.map((p) => p.name).join(', ');
    return { error: `Project "${args.projectName}" not found. Available: ${names || '(none)'}`, guard: 'project_not_found' };
  }

  // Guard 2: task valid for this project
  const task = (project.tasks || []).find((t) => norm(t.name) === norm(args.taskName));
  if (!task) {
    const names = (project.tasks || []).map((t) => t.name).join(', ');
    return { error: `Task "${args.taskName}" not found in "${project.name}". Available: ${names || '(none)'}`, guard: 'task_not_found' };
  }

  // Guard 3: duration present and positive; >16h is a soft warning, not a block
  const durationMin = Math.round(Number(args.durationMinutes));
  if (!Number.isFinite(durationMin) || durationMin <= 0) {
    return { error: 'Duration is missing or invalid. Ask the user how long they worked.', guard: 'duration_required' };
  }

  // Guard 4: future dates are allowed only inside the current timesheet week,
  // and only as a soft warning that the user must confirm on the draft card.
  const dateUtc = dateService.resolveDateToken(args.date || 'today');
  if (dateService.isFutureDate(dateUtc)) {
    if (!dateService.isInCurrentWeek(dateUtc)) {
      return { error: `Date ${dateUtc.slice(0, 10)} is outside the current week. Ask the user for the correct date.`, guard: 'future_date_outside_current_week' };
    }
  }

  const issues = [];
  if (durationMin > 960) issues.push(`${Math.round(durationMin / 60)} hours is unusually long — please confirm`);
  if (dateService.isFutureDate(dateUtc)) issues.push(futureWithinWeekIssue(dateUtc));

  return {
    ok: true,
    entry: {
      projectId: project.projectId,
      projectName: project.name,
      taskId: task.taskId,
      taskName: task.name,
      durationMin,
      dateUtc,
      description: args.description || '',
      issues,
      needsConfirmation: issues.length > 0,
    },
  };
}

async function handleGetWeekSummary(user) {
  const weekStart = dateService.currentWeekStart();
  const entries = await draftStore.getWeek(user.email || user.teamsId, weekStart);
  if (entries.length === 0) return 'No time entries logged this week yet. Tell me what you worked on!';
  const totalMin = entries.reduce((s, e) => s + (e.durationMin || 0), 0);
  const lines = entries.map(
    (e) => `• ${(e.dateUtc || '').slice(0, 10)} — ${e.projectName} › ${e.taskName}: ${fmtDuration(e.durationMin)}`
  );
  return [`This week: ${+(totalMin / 60).toFixed(1)}h / ${config.agent.weeklyHours}h`, ...lines].join('\n');
}

async function handleGetXeroWeekSummary(user) {
  const summary = await weekSummary.getWeekSummaryForUser(user);
  return weekSummary.formatWeekSummary(summary);
}

function parsePositiveMinutes(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function matchesName(actual, requested) {
  if (!requested) return true;
  const a = norm(actual);
  const r = norm(requested);
  return a === r || a.includes(r) || r.includes(a);
}

function matchingProjects(projects, projectName) {
  if (!projectName) return projects;
  const exact = projects.filter((p) => norm(p.name) === norm(projectName));
  if (exact.length > 0) return exact;
  return projects.filter((p) => matchesName(p.name, projectName));
}

function matchingTasks(project, taskName) {
  const tasks = project.tasks || [];
  if (!taskName) return tasks;
  const exact = tasks.filter((t) => norm(t.name) === norm(taskName));
  if (exact.length > 0) return exact;
  return tasks.filter((t) => matchesName(t.name, taskName));
}

function taskNameFor(project, taskId) {
  const task = (project.tasks || []).find((t) => t.taskId === taskId);
  return task ? task.name : taskId;
}

function candidateLabel(c) {
  return `${c.projectName} › ${c.taskName}: ${fmtDuration(c.durationMin)} on ${c.dateUtc.slice(0, 10)} (${c.source})`;
}

function mutationSummary(m) {
  if (m.action === 'delete') {
    return `Delete ${m.projectName} › ${m.taskName}: ${fmtDuration(m.currentDurationMin)} on ${m.dateUtc.slice(0, 10)}`;
  }
  return `Update ${m.projectName} › ${m.taskName} on ${m.dateUtc.slice(0, 10)} from ${fmtDuration(m.currentDurationMin)} to ${fmtDuration(m.newDurationMin)}`;
}

async function findEditableCandidates(args, user, cachedProjects) {
  const dateUtc = dateService.resolveDateToken(args.date);
  const dateYmd = dateUtc.slice(0, 10);
  let projects = matchingProjects(cachedProjects, args.projectName);

  if (args.projectName && projects.length === 0) {
    return { error: `Project "${args.projectName}" was not found in your allowed projects.` };
  }
  if (args.projectName && projects.length > 1) {
    return { error: `More than one project matched "${args.projectName}": ${projects.map((p) => p.name).join(', ')}. Ask the user which project.` };
  }

  const taskIdsByProject = new Map();
  const projectsWithMatchingTasks = [];
  for (const project of projects) {
    const tasks = matchingTasks(project, args.taskName);
    if (args.taskName && tasks.length === 0) {
      if (!args.projectName) continue;
      return { error: `Task "${args.taskName}" was not found in "${project.name}".` };
    }
    if (args.taskName && tasks.length > 1) {
      return { error: `More than one task matched "${args.taskName}" in "${project.name}": ${tasks.map((t) => t.name).join(', ')}. Ask the user which task.` };
    }
    taskIdsByProject.set(project.projectId, new Set(tasks.map((t) => t.taskId)));
    projectsWithMatchingTasks.push(project);
  }
  projects = projectsWithMatchingTasks;
  if (args.taskName && projects.length === 0) {
    return { error: `Task "${args.taskName}" was not found in your allowed projects.` };
  }

  const projectIds = new Set(projects.map((p) => p.projectId));
  const userKey = user.email || user.teamsId;
  const weekStart = dateService.weekStartOf(dateUtc);
  const localEntries = await draftStore.getWeek(userKey, weekStart);
  const candidates = [];
  const seenXeroIds = new Set();

  for (const e of localEntries) {
    if ((e.dateUtc || '').slice(0, 10) !== dateYmd) continue;
    if (!projectIds.has(e.projectId)) continue;
    const taskIds = taskIdsByProject.get(e.projectId);
    if (taskIds && taskIds.size > 0 && !taskIds.has(e.taskId)) continue;
    if (!['draft', 'submitted'].includes(e.status)) continue;
    if (e.xeroTimeEntryId) seenXeroIds.add(e.xeroTimeEntryId);
    candidates.push({
      source: e.status === 'submitted' ? 'submitted' : 'draft',
      localEntryId: e.id,
      xeroTimeEntryId: e.xeroTimeEntryId || null,
      projectId: e.projectId,
      projectName: e.projectName,
      taskId: e.taskId,
      taskName: e.taskName,
      userId: user.xeroUserId,
      dateUtc: e.dateUtc,
      durationMin: e.durationMin,
      description: e.description || '',
      status: e.status,
    });
  }

  for (const project of projects) {
    const taskIds = taskIdsByProject.get(project.projectId);
    const taskId = taskIds && taskIds.size === 1 ? [...taskIds][0] : undefined;
    const entries = await xero.getTimeEntries({
      projectId: project.projectId,
      userId: user.xeroUserId,
      taskId,
      states: ['ACTIVE'],
      dateAfterUtc: dateUtc,
      dateBeforeUtc: dateUtc,
    });

    for (const e of entries) {
      if (seenXeroIds.has(e.timeEntryId)) continue;
      if (taskIds && taskIds.size > 0 && !taskIds.has(e.taskId)) continue;
      candidates.push({
        source: 'xero',
        localEntryId: null,
        xeroTimeEntryId: e.timeEntryId,
        projectId: project.projectId,
        projectName: project.name,
        taskId: e.taskId,
        taskName: taskNameFor(project, e.taskId),
        userId: e.userId,
        dateUtc: e.dateUtc,
        durationMin: e.duration,
        description: e.description || '',
        status: e.status || 'ACTIVE',
      });
    }
  }

  return { candidates };
}

async function handlePrepareTimeEntryMutation(args, user, cachedProjects) {
  if (!args.date) {
    return { error: 'Date is required for edits/deletes. Ask the user which date to change.', guard: 'edit_date_required' };
  }

  const removeMin = parsePositiveMinutes(args.removeDurationMinutes);
  const newMin = parsePositiveMinutes(args.newDurationMinutes);
  const wantsDelete = args.deleteEntireEntry === true;

  if (removeMin !== null && newMin !== null) {
    return { error: 'The edit request has both a removal amount and a new total duration. Ask the user which one they mean.', guard: 'edit_duration_ambiguous' };
  }
  if (removeMin === null && newMin === null && !wantsDelete) {
    return { error: 'Ask the user how much time to remove, the new total duration, or whether to delete the whole entry.', guard: 'edit_duration_required' };
  }
  if (removeMin === 0 && !wantsDelete) {
    return { error: 'Ask the user how much time to remove.', guard: 'edit_duration_required' };
  }
  if (newMin !== null && newMin > 59940) {
    return { error: 'The requested duration is above Xero Projects limits. Ask the user for a smaller duration.', guard: 'edit_duration_too_large' };
  }

  const found = await findEditableCandidates(args, user, cachedProjects);
  if (found.error) return { error: found.error, guard: 'edit_match_error' };

  let candidates = found.candidates || [];
  const allMatches = candidates;
  if (removeMin !== null && removeMin > 0) {
    candidates = candidates.filter((c) => c.durationMin >= removeMin);
  }

  if (candidates.length === 0) {
    if (allMatches.length > 0 && removeMin !== null) {
      return {
        error: `I found matching entries, but none has at least ${fmtDuration(removeMin)} to remove: ${allMatches.map(candidateLabel).join('; ')}`,
        guard: 'edit_remove_too_large',
      };
    }
    return { error: 'No matching time entry was found. Ask the user to check the date, project, or task.', guard: 'edit_not_found' };
  }

  if (candidates.length > 1) {
    return {
      error: `Multiple entries match. Ask the user which one to change: ${candidates.map(candidateLabel).join('; ')}`,
      guard: 'edit_ambiguous',
    };
  }

  const target = candidates[0];
  let action = 'update';
  let newDurationMin = null;

  if (removeMin !== null && removeMin > 0) {
    newDurationMin = target.durationMin - removeMin;
    if (newDurationMin === 0) action = 'delete';
  } else if (newMin !== null) {
    newDurationMin = newMin;
    if (newDurationMin === 0) action = 'delete';
  } else if (wantsDelete) {
    action = 'delete';
  }

  if (action === 'update') {
    if (!Number.isFinite(newDurationMin) || newDurationMin <= 0) {
      return { error: 'The requested edit would leave no time on the entry. Ask the user to confirm deleting the entry instead.', guard: 'edit_invalid_result' };
    }
    if (newDurationMin === target.durationMin) {
      return { error: `That entry is already ${fmtDuration(target.durationMin)}. No change is needed.`, guard: 'edit_noop' };
    }
  }

  if (target.source === 'submitted' && !target.xeroTimeEntryId) {
    return { error: 'That submitted entry is missing its Xero time entry id, so I cannot safely edit it. Ask the user to update it in Xero.', guard: 'edit_missing_xero_id' };
  }

  const mutation = {
    id: crypto.randomUUID(),
    action,
    source: target.source,
    localEntryId: target.localEntryId,
    xeroTimeEntryId: target.xeroTimeEntryId,
    projectId: target.projectId,
    projectName: target.projectName,
    taskId: target.taskId,
    taskName: target.taskName,
    userId: user.xeroUserId,
    dateUtc: target.dateUtc,
    currentDurationMin: target.durationMin,
    newDurationMin,
    removeDurationMin: removeMin,
    description: target.description,
    reason: args.reason || '',
  };
  mutation.summary = mutationSummary(mutation);

  return { ok: true, mutation };
}

// ── Reasoning agent: gpt-4.1 with tool-calling loop ──────────────────────────
async function reasoningAgent(text, history, user, operationId) {
  const today = dateService.todayYmd();
  const weekStart = dateService.currentWeekStart();
  const messages = [
    {
      role: 'system',
      content: `You are a timesheet assistant. Today is ${today} in ${config.agent.timeZone}. The current timesheet week starts on ${weekStart} and uses Monday as the week start.

To log time:
1. Call get_projects() to see the user's available projects and tasks.
2. If the user's message could match tasks in more than one project, ask which project before calling create_draft().
3. Call create_draft() for each distinct activity — one call per entry.
   CRITICAL: Only call create_draft() if the user EXPLICITLY stated a duration.
   If no duration is mentioned, ask the user "How long did you work on that?" BEFORE calling create_draft().
   NEVER guess, assume, or infer a duration. No duration stated = ask first.
   If the user asks for "this week", "the whole week", or gives a per-day split without another date range, use the current timesheet week that starts on ${weekStart}.
   Future dates inside the current timesheet week are allowed as planned time, but future dates outside the current week are not allowed.
4. If create_draft() returns an error, tell the user clearly what is missing or wrong.
5. After all entries are drafted, confirm briefly: project, task, duration, and date for each.

To edit or delete existing time:
1. The user must provide or imply a specific date. "Yesterday" is OK. If no date is available, ask which date.
2. Call prepare_time_entry_mutation() with the project/task/date and either removeDurationMinutes, newDurationMinutes, or deleteEntireEntry.
3. If the tool reports multiple matches, ask the user to clarify which entry.
4. If the tool prepares a change, the app will show a confirmation card before any Xero write.

For week summaries, call get_week_summary().
Never ask for or mention xeroUserId — the app sets that automatically.`,
    },
    ...history,
    { role: 'user', content: text },
  ];

  const reasoningStart = Date.now();
  telemetry.track('agent.reasoning.started', { operationId, source: 'agent', stage: 'reasoning' });

  let cachedProjects = null;
  const draftedEntries = [];
  let pendingMutation = null;

  for (let i = 0; i < 10; i++) {
    const iterStart = Date.now();
    const resp = await callAzure(config.llm.azureDeployment, messages, { tools: TOOLS });
    const msg = resp.choices[0].message;
    messages.push(msg);

    telemetry.track('agent.reasoning.iteration', {
      operationId,
      source: 'agent',
      stage: 'reasoning',
      iteration: i + 1,
      hasToolCalls: !!(msg.tool_calls && msg.tool_calls.length > 0),
      latencyMs: Date.now() - iterStart,
    });

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const resultType = draftedEntries.length > 0 ? 'card' : pendingMutation ? 'mutation_card' : 'text';
      telemetry.track('agent.reasoning.completed', {
        operationId,
        source: 'agent',
        stage: 'reasoning',
        iterations: i + 1,
        draftCount: draftedEntries.length,
        resultType,
        latencyMs: Date.now() - reasoningStart,
        success: true,
      });
      if (draftedEntries.length > 0) return { type: 'card', entries: draftedEntries };
      if (pendingMutation) return { type: 'mutation_card', mutation: pendingMutation };
      return { type: 'text', content: msg.content || 'Done.' };
    }

    for (const tc of msg.tool_calls) {
      const toolStart = Date.now();
      telemetry.track('agent.tool.called', {
        operationId,
        source: 'agent',
        stage: 'tool',
        toolName: tc.function.name,
        iteration: i + 1,
      });

      let toolResult;
      try {
        const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};

        if (tc.function.name === 'get_projects') {
          if (!cachedProjects) cachedProjects = await handleGetProjects(user);
          toolResult = JSON.stringify(
            cachedProjects.map((p) => ({ name: p.name, tasks: p.tasks.map((t) => t.name) }))
          );
          telemetry.track('agent.tool.completed', {
            operationId,
            source: 'agent',
            stage: 'tool',
            toolName: 'get_projects',
            projectCount: cachedProjects.length,
            latencyMs: Date.now() - toolStart,
            success: true,
          });
        } else if (tc.function.name === 'create_draft') {
          if (!cachedProjects) cachedProjects = await handleGetProjects(user);
          const outcome = handleCreateDraft(args, cachedProjects);
          if (outcome.error) {
            telemetry.track('agent.guard.failed', {
              operationId,
              source: 'agent',
              stage: 'create_draft',
              guard: outcome.guard,
              input: {
                projectName: args.projectName || null,
                taskName: args.taskName || null,
                durationMin: args.durationMinutes || null,
                date: args.date || null,
              },
              output: { guard: outcome.guard, needsClarification: true },
              success: false,
            });
            toolResult = JSON.stringify({ error: outcome.error });
          } else {
            draftedEntries.push(outcome.entry);
            const e = outcome.entry;
            telemetry.track('agent.draft.created', {
              operationId,
              source: 'agent',
              stage: 'create_draft',
              projectName: e.projectName,
              taskName: e.taskName,
              durationMin: e.durationMin,
              date: e.dateUtc.slice(0, 10),
              hasWarnings: e.issues.length > 0,
              success: true,
            });
            telemetry.track('agent.tool.completed', {
              operationId,
              source: 'agent',
              stage: 'tool',
              toolName: 'create_draft',
              projectName: e.projectName,
              taskName: e.taskName,
              durationMin: e.durationMin,
              date: e.dateUtc.slice(0, 10),
              draftCount: draftedEntries.length,
              needsConfirmation: e.needsConfirmation,
              latencyMs: Date.now() - toolStart,
              success: true,
            });
            toolResult = JSON.stringify({
              ok: true,
              drafted: `${e.projectName} › ${e.taskName}: ${fmtDuration(e.durationMin)} on ${e.dateUtc.slice(0, 10)}`,
              ...(e.issues.length > 0 && { warnings: e.issues }),
            });
          }
        } else if (tc.function.name === 'prepare_time_entry_mutation') {
          if (!cachedProjects) cachedProjects = await handleGetProjects(user);
          const outcome = await handlePrepareTimeEntryMutation(args, user, cachedProjects);
          if (outcome.error) {
            telemetry.track('agent.guard.failed', {
              operationId,
              source: 'agent',
              stage: 'prepare_time_entry_mutation',
              guard: outcome.guard,
              input: {
                projectName: args.projectName || null,
                taskName: args.taskName || null,
                date: args.date || null,
                removeDurationMin: args.removeDurationMinutes || null,
                newDurationMin: args.newDurationMinutes || null,
                deleteEntireEntry: args.deleteEntireEntry === true,
              },
              output: { guard: outcome.guard, needsClarification: true },
              success: false,
            });
            toolResult = JSON.stringify({ error: outcome.error });
          } else {
            pendingMutation = outcome.mutation;
            telemetry.track('agent.mutation.prepared', {
              operationId,
              source: 'agent',
              stage: 'prepare_time_entry_mutation',
              action: pendingMutation.action,
              mutationSource: pendingMutation.source,
              projectName: pendingMutation.projectName,
              taskName: pendingMutation.taskName,
              currentDurationMin: pendingMutation.currentDurationMin,
              newDurationMin: pendingMutation.newDurationMin,
              date: pendingMutation.dateUtc.slice(0, 10),
              success: true,
            });
            telemetry.track('agent.tool.completed', {
              operationId,
              source: 'agent',
              stage: 'tool',
              toolName: 'prepare_time_entry_mutation',
              action: pendingMutation.action,
              latencyMs: Date.now() - toolStart,
              success: true,
            });
            toolResult = JSON.stringify({ ok: true, prepared: pendingMutation.summary });
          }
        } else if (tc.function.name === 'get_week_summary') {
          toolResult = await handleGetXeroWeekSummary(user);
          telemetry.track('agent.tool.completed', {
            operationId,
            source: 'agent',
            stage: 'tool',
            toolName: 'get_week_summary',
            latencyMs: Date.now() - toolStart,
            success: true,
          });
          telemetry.track('agent.reasoning.completed', {
            operationId,
            source: 'agent',
            stage: 'reasoning',
            iterations: i + 1,
            draftCount: draftedEntries.length,
            resultType: 'text',
            directToolResult: 'get_week_summary',
            latencyMs: Date.now() - reasoningStart,
            success: true,
          });
          return { type: 'text', content: toolResult };
        } else {
          toolResult = JSON.stringify({ error: `Unknown tool: ${tc.function.name}` });
          telemetry.track('agent.tool.failed', {
            operationId,
            source: 'agent',
            stage: 'tool',
            toolName: tc.function.name,
            errorName: 'UnknownTool',
            latencyMs: Date.now() - toolStart,
            success: false,
          });
        }
      } catch (err) {
        toolResult = JSON.stringify({ error: err.message });
        telemetry.track('agent.tool.failed', {
          operationId,
          source: 'agent',
          stage: 'tool',
          toolName: tc.function.name,
          errorName: err.name || 'Error',
          latencyMs: Date.now() - toolStart,
          success: false,
        });
      }

      messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
    }
  }

  telemetry.track('agent.reasoning.limit_reached', {
    operationId,
    source: 'agent',
    stage: 'reasoning',
    latencyMs: Date.now() - reasoningStart,
    success: false,
  });

  return { type: 'text', content: 'I reached my reasoning limit. Please try again or simplify your request.' };
}

// ── Entry point ───────────────────────────────────────────────────────────────
// Returns { type: 'text', content: string } or { type: 'card', entries: [...] }
// bot.js calls this after its NEEDS_CONFIRMATION pre-filter.
// operationId is generated by the caller (bot.js) so all events for one turn share the same id.
async function run(text, history, user, operationId) {
  const opId = operationId || telemetry.newOperationId();
  const deployment = config.llm.triageDeployment || config.llm.azureDeployment;

  telemetry.track('agent.triage.started', {
    operationId: opId,
    source: 'agent',
    stage: 'triage',
    input: { textLength: text.length, textHash: telemetry.hash(text) },
    modelDeployment: deployment,
  });

  const triageStart = Date.now();
  let triageType = 'complex';
  try {
    const t = await triage(text, history);
    triageType = t.type;
    telemetry.track('agent.triage.completed', {
      operationId: opId,
      source: 'agent',
      stage: 'triage',
      input: { textLength: text.length, textHash: telemetry.hash(text) },
      output: { triageType, modelDeployment: deployment },
      latencyMs: Date.now() - triageStart,
      success: true,
    });
  } catch (err) {
    telemetry.track('agent.triage.failed', {
      operationId: opId,
      source: 'agent',
      stage: 'triage',
      errorName: err.name || 'Error',
      latencyMs: Date.now() - triageStart,
      success: false,
    });
    // Triage failure is non-fatal — safe to treat as complex
  }

  if (triageType === 'help') {
    return {
      type: 'text',
      content: [
        '**Xero Timesheet Assistant**',
        '• Log time: _"3h on the DM project meetings today"_',
        '• Multiple entries: _"2h development and 1h meetings yesterday"_',
        '• Review: _"show my week"_',
        '• After the draft appears: tap **Submit to Xero** or **Cancel**',
      ].join('\n'),
    };
  }

  if (triageType === 'off_topic') {
    return {
      type: 'text',
      content: "I can only help with logging time to Xero. Try: _\"3h on the DM project today\"_",
    };
  }


  // complex (or any unknown value): wake the reasoning model
  return reasoningAgent(text, history, user, opId);
}

module.exports = {
  run,
  _internal: {
    handleGetProjects,
    handlePrepareTimeEntryMutation,
    findEditableCandidates,
  },
};
