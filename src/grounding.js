'use strict';
const config = require('./config');

// ── LLM call (OpenAI or Azure OpenAI), JSON mode, provider-flexible ──────────
async function callLLM(systemPrompt, userMessage) {
  const useAzure = !!config.llm.azureEndpoint;
  const url = useAzure
    ? `${config.llm.azureEndpoint}/openai/deployments/${config.llm.azureDeployment}/chat/completions?api-version=2024-02-01`
    : 'https://api.openai.com/v1/chat/completions';
  const headers = useAzure
    ? { 'api-key': config.llm.azureKey, 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${config.llm.openaiApiKey}`, 'Content-Type': 'application/json' };
  const body = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
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
  return `You convert a person's plain-language description of their work into structured timesheet entries.

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
- confidence reflects how sure you are the project+task mapping is correct.`;
}

function resolveDate(token) {
  const today = new Date();
  let d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (token === 'yesterday') d.setUTCDate(d.getUTCDate() - 1);
  else if (token && /^\d{4}-\d{2}-\d{2}$/.test(token)) {
    const [y, m, day] = token.split('-').map(Number);
    d = new Date(Date.UTC(y, m - 1, day));
  }
  return d.toISOString().replace('.000Z', 'Z');
}

const norm = (s) => (s || '').trim().toLowerCase();

// ── Main: narration -> validated draft entries ──────────────────────────────
// scopedProjects: [{ projectId, name, tasks: [{ taskId, name }] }]
async function groundNarration(narration, scopedProjects, opts = {}) {
  const threshold = opts.confidenceThreshold ?? config.agent.confidenceThreshold;
  let llm;
  try {
    llm = await callLLM(buildSystemPrompt(scopedProjects), narration);
  } catch (err) {
    return { isQuery: false, entries: [], error: err.message };
  }
  if (llm.isQuery) return { isQuery: true, entries: [] };

  const entries = (llm.entries || []).map((e) => {
    const issues = [];
    const project = scopedProjects.find((p) => norm(p.name) === norm(e.project));
    if (!project) issues.push(e.project ? `unknown project "${e.project}"` : 'no project identified');

    let task = null;
    if (project) {
      task = (project.tasks || []).find((t) => norm(t.name) === norm(e.task));
      if (!task) issues.push(e.task ? `unknown task "${e.task}"` : 'no task identified');
    }

    const durationMin = Number.isFinite(e.durationMinutes) && e.durationMinutes > 0 ? Math.round(e.durationMinutes) : null;
    if (!durationMin) issues.push('no duration stated');

    const confidence = typeof e.confidence === 'number' ? e.confidence : 0;
    const needsConfirmation = issues.length > 0 || confidence < threshold;

    return {
      projectId: project ? project.projectId : null,
      projectName: project ? project.name : e.project || null,
      taskId: task ? task.taskId : null,
      taskName: task ? task.name : e.task || null,
      durationMin,
      dateUtc: resolveDate(e.date),
      description: e.description || narration.slice(0, 200),
      confidence,
      issues,
      needsConfirmation,
    };
  });

  return { isQuery: false, entries };
}

module.exports = { groundNarration, buildSystemPrompt };
