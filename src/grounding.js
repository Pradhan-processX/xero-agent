'use strict';
const config = require('./config');
const dateService = require('./dateService');

// ── LLM call (OpenAI or Azure OpenAI), JSON mode, provider-flexible ──────────
// messages: array of { role, content } for multi-turn, OR a plain string for single-turn
async function callLLM(systemPrompt, messages) {
  const turns = typeof messages === 'string'
    ? [{ role: 'user', content: messages }]
    : messages;

  const useAzure = !!config.llm.azureEndpoint;
  const url = useAzure
    ? `${config.llm.azureEndpoint}/openai/deployments/${config.llm.azureDeployment}/chat/completions?api-version=${config.llm.azureApiVersion}`
    : 'https://api.openai.com/v1/chat/completions';
  const headers = useAzure
    ? { 'api-key': config.llm.azureKey, 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${config.llm.openaiApiKey}`, 'Content-Type': 'application/json' };
  const body = {
    messages: [{ role: 'system', content: systemPrompt }, ...turns],
    temperature: 0,
    max_tokens: 700,
    response_format: { type: 'json_object' },
  };
  if (!useAzure) body.model = config.llm.openaiModel;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`LLM call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// ── Grounding context: the narrator's allowed projects + their tasks ─────────
function buildContextText(scopedProjects) {
  return scopedProjects
    .map((p) => {
      const tasks = (p.tasks || []).map((t) => `    - ${t.name}`).join('\n');
      return `- Project: ${p.name}\n  Tasks:\n${tasks || '    (none)'}`;
    })
    .join('\n');
}

function buildSystemPrompt(scopedProjects) {
  const today = dateService.todayYmd();
  return `You convert a person's plain-language description of their work into structured timesheet entries.
Today's date is ${today} in ${config.agent.timeZone}. Use this to resolve "today", "yesterday", "this morning" etc.

You MUST only use projects and tasks from this list (these are the ONLY ones this person works on):
${buildContextText(scopedProjects)}

Return ONLY a JSON object:
{
  "isQuery": false,                       // true if the message is a question, not a time log
  "entries": [
    {
      "project": "<EXACT project name from the list, or null if unclear>",
      "task": "<EXACT task name from that project's task list, or null if unclear>",
      "durationMinutes": <integer minutes, or null if not stated>,
      "date": "today" | "yesterday" | "YYYY-MM-DD" | null,
      "description": "<concise one-line summary of the work>",
      "confidence": <0.0-1.0>
    }
  ]
}

Rules:
- One entry per distinct activity. "2 meetings and 1h research" on one project = two entries if they map to different tasks.
- Convert durations to minutes: "3 hours"=180, "30 mins"=30, "half day"=225, "full day"=450.
- "project" and "task" MUST be copied verbatim from the list above. If you cannot confidently pick one, use null.
- Never invent a duration. If hours are not stated, set durationMinutes to null.
- confidence reflects how sure you are the project+task mapping is correct.
- Multi-day tasks: if the person says a task spanned multiple days (e.g. "yesterday and today", "Monday to Wednesday"), split into one entry per day. Divide total hours equally across those days unless they give a specific split. Each entry gets its own date.
- Never create a single entry spanning more than one calendar day.`;
}

const norm = (s) => (s || '').trim().toLowerCase();

// ── Guards ────────────────────────────────────────────────────────────────────
// >16hrs flags for confirmation but does NOT block — overnight/multi-day tasks are valid
const LONG_DURATION_FLAG_MIN = 960;

function guardDuration(durationMinutes) {
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return { error: 'no duration stated' };
  if (durationMinutes > LONG_DURATION_FLAG_MIN) return { warning: `${Math.round(durationMinutes / 60)}hrs is unusually long — please confirm` };
  return {};
}

function guardDateNotFuture(dateUtc) {
  if (dateUtc && dateService.isFutureDate(dateUtc)) return `date ${dateUtc.slice(0, 10)} is in the future`;
  return null;
}

function guardOutputShape(llm) {
  if (!llm || typeof llm !== 'object') return 'LLM returned non-object';
  if (!Array.isArray(llm.entries)) return 'LLM response missing entries array';
  return null;
}

// ── Main: narration -> validated draft entries ──────────────────────────────
// scopedProjects: [{ projectId, name, tasks: [{ taskId, name }] }]
// messages: string (single-turn) or [{ role, content }] array (multi-turn)
async function groundNarration(messages, scopedProjects, opts = {}) {
  const threshold = opts.confidenceThreshold ?? config.agent.confidenceThreshold;
  let llm;
  try {
    llm = await callLLM(buildSystemPrompt(scopedProjects), messages);
  } catch (err) {
    return { isQuery: false, entries: [], error: err.message };
  }

  const shapeError = guardOutputShape(llm);
  if (shapeError) return { isQuery: false, entries: [], error: shapeError };
  if (llm.isQuery) return { isQuery: true, entries: [] };

  const narrationText = typeof messages === 'string' ? messages : (messages.at(-1)?.content || '');

  const entries = (llm.entries || []).map((e) => {
    const issues = [];

    // Guard 1: project in allowlist
    const project = scopedProjects.find((p) => norm(p.name) === norm(e.project));
    if (!project) issues.push(e.project ? `unknown project "${e.project}"` : 'no project identified');

    // Guard 2: task valid for this project
    let task = null;
    if (project) {
      task = (project.tasks || []).find((t) => norm(t.name) === norm(e.task));
      if (!task) issues.push(e.task ? `unknown task "${e.task}"` : 'no task identified');
    }

    // Guard 3: duration — missing is a hard block, >16hrs is a soft warning (needsConfirmation only)
    const rawDuration = Number.isFinite(e.durationMinutes) ? Math.round(e.durationMinutes) : null;
    const durationGuard = guardDuration(rawDuration);
    if (durationGuard.error) issues.push(durationGuard.error);
    if (durationGuard.warning) issues.push(durationGuard.warning);
    const durationMin = durationGuard.error ? null : rawDuration;

    // Guard 4: date not in future
    const resolvedDate = dateService.resolveDateToken(e.date);
    const dateIssue = guardDateNotFuture(resolvedDate);
    if (dateIssue) issues.push(dateIssue);

    // Guard 5: confidence threshold
    const confidence = typeof e.confidence === 'number' ? e.confidence : 0;
    const needsConfirmation = issues.length > 0 || confidence < threshold;

    return {
      projectId: project ? project.projectId : null,
      projectName: project ? project.name : e.project || null,
      taskId: task ? task.taskId : null,
      taskName: task ? task.name : e.task || null,
      durationMin,
      dateUtc: resolvedDate,
      description: e.description || narrationText.slice(0, 200),
      confidence,
      issues,
      needsConfirmation,
    };
  });

  return { isQuery: false, entries };
}

module.exports = { groundNarration, buildSystemPrompt };
