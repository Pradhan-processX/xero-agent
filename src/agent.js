'use strict';
const config = require('./config');
const xero = require('./xero');
const draftStore = require('./draftStore');
const telemetry = require('./telemetry');
const dateService = require('./dateService');

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
      description: "Returns the user's logged time entries for the current week with totals versus their weekly target.",
      parameters: { type: 'object', properties: {}, required: [] },
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
      const resultType = draftedEntries.length > 0 ? 'card' : 'text';
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
        } else if (tc.function.name === 'get_week_summary') {
          toolResult = await handleGetWeekSummary(user);
          telemetry.track('agent.tool.completed', {
            operationId,
            source: 'agent',
            stage: 'tool',
            toolName: 'get_week_summary',
            latencyMs: Date.now() - toolStart,
            success: true,
          });
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

module.exports = { run };
