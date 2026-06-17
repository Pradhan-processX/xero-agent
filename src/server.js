'use strict';
const express = require('express');
const { CloudAdapter, loadAuthConfigFromEnv, authorizeJWT } = require('@microsoft/agents-hosting');
const config = require('./config');
const xero = require('./xero');
const userMap = require('./userMap');
const draftStore = require('./draftStore');
const store = require('./store');
const { groundNarration } = require('./grounding');
const { agent } = require('./bot');
const telemetry = require('./telemetry');

const app = express();
app.use(express.json());

// Attach operationId + start timer to every request; emit http.request.completed on finish.
app.use((req, res, next) => {
  req.operationId = telemetry.newOperationId();
  req._startMs = Date.now();
  telemetry.track('http.request.received', {
    operationId: req.operationId,
    source: 'server',
    stage: 'http',
    method: req.method,
    path: req.path,
    storageBackend: store.backend,
    mock: config.xero.mock,
  });
  res.on('finish', () => {
    const latencyMs = Date.now() - req._startMs;
    const success = res.statusCode < 400;
    telemetry.track(success ? 'http.request.completed' : 'http.request.failed', {
      operationId: req.operationId,
      source: 'server',
      stage: 'http',
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      latencyMs,
      success,
    });
  });
  next();
});

// Bot adapter — auth config reads clientId/clientSecret/tenantId from env.
// When clientId is unset (local dev without a Bot Service), auth validation is skipped
// so the emulator / Teams App Test Tool can reach /api/messages without JWT.
const authConfig = loadAuthConfigFromEnv();
const adapter = new CloudAdapter(authConfig);
if (config.bot.clientId) {
  // Production: validate Bot Service JWT on all traffic before routing
  app.use('/api/messages', authorizeJWT(authConfig));
}

adapter.onTurnError = async (context, err) => {
  console.error('[bot] unhandled error:', err);
  await context.sendActivity('Something went wrong. Please try again.');
};

// --- API key guard (Power Platform connector / Copilot Studio sends x-api-key) ---
// /health and /api/messages are deliberately exempt:
//   /health  — public liveness probe
//   /api/messages — Bot Service authenticates with its own JWT (handled above)
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/api/messages') return next();
  if (!config.server.apiKey) return next(); // unset = open (local dev only)
  if (req.get('x-api-key') !== config.server.apiKey) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// POST /api/messages — Teams bot intake (M365 Agents SDK / Bot Service)
app.post('/api/messages', async (req, res) => {
  try {
    await adapter.process(req, res, (context) => agent.run(context));
  } catch (err) {
    // Swallow reply-delivery failures (e.g. emulator disconnected, serviceUrl unreachable).
    // The turn error handler in the adapter already logs these; crashing the server is not useful.
    console.error('[adapter] process error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, storage: store.backend, mock: config.xero.mock }));

// Resolve the person + their scoped projects (allowlist) with tasks attached.
async function scopedProjectsFor(identity) {
  const user = userMap.resolveUser(identity);
  if (!user) return { user: null, projects: [] };
  const all = await xero.getProjects();
  const allowed = new Set(user.allowedProjectIds || []);
  const mine = all.filter((p) => allowed.has(p.projectId));
  const projects = await Promise.all(
    mine.map(async (p) => ({ ...p, tasks: await xero.getTasks(p.projectId) }))
  );
  return { user, projects };
}

// GET /projects?identity=  -> this person's projects + tasks (debug / grounding peek)
app.get('/projects', async (req, res, next) => {
  try {
    const { user, projects } = await scopedProjectsFor(req.query.identity);
    if (!user) return res.status(404).json({ error: 'user not mapped', identity: req.query.identity });
    telemetry.track('rest.projects.completed', {
      operationId: req.operationId, source: 'server', stage: 'projects',
      projectCount: projects.length, success: true,
    });
    res.json({ user: { name: user.name, xeroUserId: user.xeroUserId }, projects });
  } catch (err) { next(err); }
});

// POST /capture { identity, text } -> ground narration into drafts, return for confirmation
app.post('/capture', async (req, res, next) => {
  try {
    const { identity, text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    telemetry.track('rest.capture.received', {
      operationId: req.operationId, source: 'server', stage: 'capture',
      textLength: (text || '').length, textHash: telemetry.hash(text),
    });

    const { user, projects } = await scopedProjectsFor(identity);
    if (!user) return res.status(404).json({ error: 'user not mapped', identity });

    const result = await groundNarration(text, projects); // single-turn: text string is fine here
    if (result.error) return res.status(502).json({ error: result.error });
    if (result.isQuery) return res.json({ isQuery: true, message: 'Looks like a question, not a time log.' });

    const stored = await draftStore.addEntries(user.email || user.teamsId, result.entries);
    telemetry.track('rest.capture.completed', {
      operationId: req.operationId, source: 'server', stage: 'capture',
      draftCount: stored.length, success: true,
    });
    res.json({
      isQuery: false,
      entries: stored,
      summary: `Captured ${stored.length} draft entr${stored.length === 1 ? 'y' : 'ies'}.`,
    });
  } catch (err) { next(err); }
});

// GET /week?identity=&weekStart=YYYY-MM-DD -> drafts + totals vs weekly target
app.get('/week', async (req, res, next) => {
  try {
    const user = userMap.resolveUser(req.query.identity);
    if (!user) return res.status(404).json({ error: 'user not mapped' });
    const weekStart = req.query.weekStart || draftStore.weekStartOf(new Date().toISOString());
    const entries = await draftStore.getWeek(user.email || user.teamsId, weekStart);
    const totalMin = entries.reduce((s, e) => s + (e.durationMin || 0), 0);
    telemetry.track('rest.week.completed', {
      operationId: req.operationId, source: 'server', stage: 'week',
      entryCount: entries.length, totalMin, success: true,
    });
    res.json({
      weekStart,
      entries,
      totalHours: +(totalMin / 60).toFixed(2),
      targetHours: config.agent.weeklyHours,
      needsAttention: entries.filter((e) => e.needsConfirmation).length,
    });
  } catch (err) { next(err); }
});

// PATCH /entry/:id { projectId?, taskId?, durationMin?, dateUtc?, description? }
app.patch('/entry/:id', async (req, res, next) => {
  try {
    const allowed = ['projectId', 'projectName', 'taskId', 'taskName', 'durationMin', 'dateUtc', 'description'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    const updated = await draftStore.updateEntry(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'entry not found' });
    // Re-derive the confirmation flag after an edit.
    const needsConfirmation = !updated.projectId || !updated.taskId || !updated.durationMin;
    const final = await draftStore.updateEntry(req.params.id, { needsConfirmation, issues: [] });
    telemetry.track('rest.entry.updated', {
      operationId: req.operationId, source: 'server', stage: 'entry',
      entryId: req.params.id, success: true,
    });
    res.json(final);
  } catch (err) { next(err); }
});

app.delete('/entry/:id', async (req, res, next) => {
  try {
    const deleted = await draftStore.removeEntry(req.params.id);
    telemetry.track('rest.entry.deleted', {
      operationId: req.operationId, source: 'server', stage: 'entry',
      entryId: req.params.id, deleted, success: true,
    });
    res.json({ deleted });
  } catch (err) { next(err); }
});

// POST /submit { identity, weekStart } -> write clean drafts to Xero
app.post('/submit', async (req, res, next) => {
  try {
    const { identity, weekStart } = req.body;
    const user = userMap.resolveUser(identity);
    if (!user) return res.status(404).json({ error: 'user not mapped' });
    const ws = weekStart || draftStore.weekStartOf(new Date().toISOString());
    const entries = (await draftStore.getWeek(user.email || user.teamsId, ws)).filter((e) => e.status === 'draft');

    telemetry.track('rest.submit.started', {
      operationId: req.operationId, source: 'server', stage: 'submit',
      entryCount: entries.length, weekStart: ws,
    });

    const results = [];
    for (const e of entries) {
      if (!e.projectId || !e.taskId || !e.durationMin) {
        results.push({ id: e.id, ok: false, reason: 'incomplete (project/task/duration)' });
        continue;
      }
      try {
        const created = await xero.createTimeEntry(
          {
            projectId: e.projectId,
            userId: user.xeroUserId,
            taskId: e.taskId,
            dateUtc: e.dateUtc,
            durationMin: e.durationMin,
            description: e.description,
          },
          e.id, // idempotency key: re-submitting won't double-post
          { operationId: req.operationId }
        );
        await draftStore.markSubmitted(e.id, created && created.timeEntryId);
        results.push({ id: e.id, ok: true, xeroTimeEntryId: created && created.timeEntryId });
      } catch (err) {
        results.push({ id: e.id, ok: false, reason: err.message });
      }
    }

    const submittedCount = results.filter((r) => r.ok).length;
    telemetry.track('rest.submit.completed', {
      operationId: req.operationId, source: 'server', stage: 'submit',
      submittedCount, failedCount: results.length - submittedCount,
      mock: config.xero.mock, success: true,
    });
    res.json({ weekStart: ws, submitted: submittedCount, results });
  } catch (err) { next(err); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(config.server.port, () => {
  console.log(`Xero timesheet agent listening on :${config.server.port}`);
  telemetry.track('server.started', {
    source: 'server',
    port: config.server.port,
    storageBackend: store.backend,
    mock: config.xero.mock,
  });
});
