'use strict';
const express = require('express');
const config = require('./config');
const xero = require('./xero');
const userMap = require('./userMap');
const draftStore = require('./draftStore');
const store = require('./store');
const { groundNarration } = require('./grounding');

const app = express();
app.use(express.json());

// --- API key guard (Copilot Studio / connector sends x-api-key) ---
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!config.server.apiKey) return next(); // unset = open (local dev only)
  if (req.get('x-api-key') !== config.server.apiKey) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, storage: store.backend }));

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
    res.json({ user: { name: user.name, xeroUserId: user.xeroUserId }, projects });
  } catch (err) { next(err); }
});

// POST /capture { identity, text } -> ground narration into drafts, return for confirmation
app.post('/capture', async (req, res, next) => {
  try {
    const { identity, text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const { user, projects } = await scopedProjectsFor(identity);
    if (!user) return res.status(404).json({ error: 'user not mapped', identity });

    const result = await groundNarration(text, projects);
    if (result.error) return res.status(502).json({ error: result.error });
    if (result.isQuery) return res.json({ isQuery: true, message: 'Looks like a question, not a time log.' });

    const stored = await draftStore.addEntries(user.email || user.teamsId, result.entries);
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
    res.json(final);
  } catch (err) { next(err); }
});

app.delete('/entry/:id', async (req, res, next) => {
  try {
    res.json({ deleted: await draftStore.removeEntry(req.params.id) });
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
          e.id // idempotency key: re-submitting won't double-post
        );
        await draftStore.markSubmitted(e.id, created && created.timeEntryId);
        results.push({ id: e.id, ok: true, xeroTimeEntryId: created && created.timeEntryId });
      } catch (err) {
        results.push({ id: e.id, ok: false, reason: err.message });
      }
    }
    res.json({ weekStart: ws, submitted: results.filter((r) => r.ok).length, results });
  } catch (err) { next(err); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(config.server.port, () => {
  console.log(`Xero timesheet agent listening on :${config.server.port}`);
});
