'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { XeroClient } = require('xero-node');
const config = require('./config');
const store = require('./store');
const mockData = require('./mockData');
const telemetry = require('./telemetry');

const MOCK = config.xero.mock;

// --- Token persistence (store backend: local file in dev, Azure Table when configured) ---
async function loadTokenSet() {
  return store.tokens.get();
}
async function saveTokenSet(tokenSet, tenantId) {
  const data = { ...tokenSet };
  if (tenantId) data._tenantId = tenantId;
  await store.tokens.set(data);
}

function buildClient() {
  return new XeroClient({
    clientId: config.xero.clientId,
    clientSecret: config.xero.clientSecret,
    redirectUris: [config.xero.redirectUri],
    scopes: config.xero.scopes.split(' '),
  });
}

let _client = null;
function client() {
  if (!_client) _client = buildClient();
  return _client;
}

// Resolve the tenant (org) id to act against.
function tenantId(tokenSet) {
  return config.xero.tenantId || (tokenSet && tokenSet._tenantId) || '';
}

// Ensure we have a valid (non-expired) access token; refresh if needed.
async function ensureToken() {
  const x = client();
  let tokenSet = await loadTokenSet();
  if (!tokenSet) {
    throw new Error('No Xero token found. Run `npm run auth` to authorise the org connection first.');
  }
  x.setTokenSet(tokenSet);

  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = tokenSet.expires_at || 0;
  if (expiresAt - 60 <= nowSec) {
    const existingTenant = tokenSet._tenantId;
    const refreshed = await x.refreshWithRefreshToken(
      config.xero.clientId,
      config.xero.clientSecret,
      tokenSet.refresh_token
    );
    tokenSet = { ...refreshed, _tenantId: existingTenant };
    await saveTokenSet(tokenSet, existingTenant);
    x.setTokenSet(tokenSet);
  }

  const tid = tenantId(tokenSet);
  if (!tid) throw new Error('No tenant id resolved. Set XERO_TENANT_ID or re-run `npm run auth`.');
  return { x, tid };
}

// --- Consent / callback helpers (used by auth-cli.js) ---
async function buildConsentUrl() {
  return client().buildConsentUrl();
}
async function handleCallback(callbackUrl) {
  const x = client();
  const tokenSet = await x.apiCallback(callbackUrl);
  await x.updateTenants(false);
  const tenant = (x.tenants || [])[0];
  await saveTokenSet(tokenSet, tenant && tenant.tenantId);
  return { tokenSet, tenants: x.tenants };
}

// --- Cached reads (60 calls/min, 5000/day per tenant -> cache ~1h) ---
const CACHE_TTL_MS = 60 * 60 * 1000;
let _projectsCache = { at: 0, data: null };
const _tasksCache = new Map(); // projectId -> { at, data }

function readMockTimeLog() {
  try { return JSON.parse(fs.readFileSync(config.xero.mockTimeLog, 'utf8')); } catch { return []; }
}

function writeMockTimeLog(log) {
  fs.writeFileSync(config.xero.mockTimeLog, JSON.stringify(log, null, 2));
}

function toIsoDateString(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toYmd(value) {
  return toIsoDateString(value).slice(0, 10);
}

function mapTimeEntry(entry) {
  return {
    timeEntryId: entry.timeEntryId,
    projectId: entry.projectId,
    userId: entry.userId,
    taskId: entry.taskId,
    dateUtc: toIsoDateString(entry.dateUtc),
    duration: entry.duration,
    description: entry.description || '',
    status: entry.status || 'ACTIVE',
  };
}

// Fetch all pages of a paginated Xero API call. Uses pageSize=500 (max) to minimise calls.
async function fetchAllPages(fetchPage) {
  const items = [];
  let page = 1;
  while (true) {
    const res = await fetchPage(page);
    const batch = res.body.items || [];
    items.push(...batch);
    const pg = res.body.pagination;
    if (!pg || page >= (pg.pageCount || 1)) break;
    page++;
  }
  return items;
}

async function getProjects() {
  if (MOCK) return mockData.projects.map(({ tasks, ...p }) => p);
  if (_projectsCache.data && Date.now() - _projectsCache.at < CACHE_TTL_MS) {
    return _projectsCache.data;
  }
  const { x, tid } = await ensureToken();
  // states='INPROGRESS' excludes CLOSED and DRAFT projects so users never see dead projects.
  const raw = await fetchAllPages((page) =>
    x.projectApi.getProjects(tid, undefined, undefined, 'INPROGRESS', page, 500)
  );
  const items = raw.map((p) => ({ projectId: p.projectId, name: p.name, status: p.status }));
  _projectsCache = { at: Date.now(), data: items };
  return items;
}

async function getTasks(projectId) {
  if (MOCK) {
    const p = mockData.projects.find((x) => x.projectId === projectId);
    return p ? p.tasks : [];
  }
  const cached = _tasksCache.get(projectId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
  const { x, tid } = await ensureToken();
  const raw = await fetchAllPages((page) =>
    x.projectApi.getTasks(tid, projectId, page, 500)
  );
  // getTasks has no server-side status filter — exclude LOCKED tasks in code.
  const items = raw
    .filter((t) => t.status !== 'LOCKED')
    .map((t) => ({ taskId: t.taskId, name: t.name, status: t.status, chargeType: t.chargeType }));
  _tasksCache.set(projectId, { at: Date.now(), data: items });
  return items;
}

async function getProjectUsers() {
  if (MOCK) return mockData.users;
  const { x, tid } = await ensureToken();
  const res = await x.projectApi.getProjectUsers(tid);
  return (res.body.items || []).map((u) => ({ userId: u.userId, name: u.name, email: u.email }));
}

// Connected Xero organisation (tenant). The org name effectively never changes for
// a given connection, so cache it for the process lifetime. getConnectedOrgCached()
// is a synchronous accessor for hot-path callers (e.g. conversation logging);
// getConnectedOrg() performs the one-time resolution.
let _orgCache = null;

function getConnectedOrgCached() {
  return _orgCache;
}

async function getConnectedOrg() {
  if (_orgCache) return _orgCache;
  if (MOCK) {
    _orgCache = { tenantId: config.xero.tenantId || 'mock', tenantName: 'Demo Company (Mock)' };
    return _orgCache;
  }
  try {
    const { x, tid } = await ensureToken();
    // updateTenants(false) only hits /connections (needs a valid token, no accounting
    // scope) and returns tenants carrying tenantName directly.
    await x.updateTenants(false);
    const match = (x.tenants || []).find((t) => t.tenantId === tid) || (x.tenants || [])[0];
    _orgCache = { tenantId: tid, tenantName: (match && match.tenantName) || '' };
    return _orgCache;
  } catch (err) {
    telemetry.track('xero.org.resolve.failed', {
      source: 'xero', stage: 'org_resolve', errorName: err.name || 'Error', success: false,
    });
    // Do not cache failures — always hand back the configured tenant id so callers
    // still have the org GUID, and retry resolution on the next call.
    return { tenantId: config.xero.tenantId || '', tenantName: '' };
  }
}

async function getTimeEntries({
  projectId,
  userId,
  taskId,
  states = ['ACTIVE'],
  dateAfterUtc,
  dateBeforeUtc,
} = {}) {
  if (!projectId) throw new Error('projectId is required to list time entries');

  if (MOCK) {
    const allowedStates = new Set((states || ['ACTIVE']).map((s) => String(s).toUpperCase()));
    const from = dateAfterUtc ? toYmd(dateAfterUtc) : '';
    const to = dateBeforeUtc ? toYmd(dateBeforeUtc) : '';
    return readMockTimeLog()
      .map(mapTimeEntry)
      .filter((e) => e.projectId === projectId)
      .filter((e) => !userId || e.userId === userId)
      .filter((e) => !taskId || e.taskId === taskId)
      .filter((e) => allowedStates.has(String(e.status || 'ACTIVE').toUpperCase()))
      .filter((e) => !from || toYmd(e.dateUtc) >= from)
      .filter((e) => !to || toYmd(e.dateUtc) <= to);
  }

  const { x, tid } = await ensureToken();
  const raw = await fetchAllPages((page) =>
    x.projectApi.getTimeEntries(
      tid,
      projectId,
      userId,
      taskId,
      undefined,
      undefined,
      page,
      500,
      states,
      undefined,
      dateAfterUtc ? new Date(dateAfterUtc) : undefined,
      dateBeforeUtc ? new Date(dateBeforeUtc) : undefined
    )
  );
  return raw.map(mapTimeEntry);
}

// Create one time entry. duration is in MINUTES. idempotencyKey prevents double-posting.
// opts.operationId threads the caller's turn id into Xero telemetry events.
async function createTimeEntry({ projectId, userId, taskId, dateUtc, durationMin, description }, idempotencyKey, opts = {}) {
  const operationId = opts.operationId;
  const base = {
    operationId, source: 'xero', stage: 'create_time_entry',
    projectId, taskId, durationMin, date: (dateUtc || '').slice(0, 10), mock: MOCK,
  };

  if (MOCK) {
    const entry = {
      timeEntryId: 'mock-time-' + crypto.randomUUID(),
      projectId, userId, taskId, dateUtc, duration: Math.round(durationMin), description,
      status: 'ACTIVE', idempotencyKey, loggedAt: new Date().toISOString(),
    };
    // Append to a local log so you can inspect exactly what WOULD be posted to Xero.
    const log = readMockTimeLog();
    log.push(entry);
    writeMockTimeLog(log);
    telemetry.track('xero.time_entry.mock_created', { ...base, timeEntryId: entry.timeEntryId, success: true });
    return entry;
  }

  try {
    const { x, tid } = await ensureToken();
    const payload = {
      userId,
      taskId,
      dateUtc: new Date(dateUtc),
      duration: Math.round(durationMin),
      description: description || undefined,
    };
    const res = await x.projectApi.createTimeEntry(tid, projectId, payload, idempotencyKey);
    telemetry.track('xero.time_entry.created', { ...base, timeEntryId: res.body?.timeEntryId, success: true });
    return res.body;
  } catch (err) {
    telemetry.track('xero.time_entry.failed', {
      ...base,
      errorName: err.name || 'Error',
      errorMessage: String(err.message || '').slice(0, 200),
      success: false,
    });
    throw err;
  }
}

async function updateTimeEntry({ projectId, timeEntryId, userId, taskId, dateUtc, durationMin, description }, idempotencyKey, opts = {}) {
  const operationId = opts.operationId;
  const base = {
    operationId, source: 'xero', stage: 'update_time_entry',
    projectId, taskId, timeEntryId, durationMin, date: (dateUtc || '').slice(0, 10), mock: MOCK,
  };

  if (!projectId || !timeEntryId) throw new Error('projectId and timeEntryId are required to update a time entry');

  if (MOCK) {
    const log = readMockTimeLog();
    const i = log.findIndex((e) => e.projectId === projectId && e.timeEntryId === timeEntryId && e.status !== 'DELETED');
    if (i < 0) throw new Error(`Mock time entry ${timeEntryId} not found`);
    log[i] = {
      ...log[i],
      userId,
      taskId,
      dateUtc,
      duration: Math.round(durationMin),
      description,
      status: 'ACTIVE',
      idempotencyKey,
      updatedAt: new Date().toISOString(),
    };
    writeMockTimeLog(log);
    telemetry.track('xero.time_entry.mock_updated', { ...base, success: true });
    return mapTimeEntry(log[i]);
  }

  try {
    const { x, tid } = await ensureToken();
    const payload = {
      userId,
      taskId,
      dateUtc: new Date(dateUtc),
      duration: Math.round(durationMin),
      description: description || undefined,
    };
    const res = await x.projectApi.updateTimeEntry(tid, projectId, timeEntryId, payload, idempotencyKey);
    telemetry.track('xero.time_entry.updated', { ...base, success: true });
    return res.body || { timeEntryId, projectId, userId, taskId, dateUtc, duration: Math.round(durationMin), description };
  } catch (err) {
    telemetry.track('xero.time_entry.update_failed', {
      ...base,
      errorName: err.name || 'Error',
      errorMessage: String(err.message || '').slice(0, 200),
      success: false,
    });
    throw err;
  }
}

async function deleteTimeEntry(projectId, timeEntryId, opts = {}) {
  const operationId = opts.operationId;
  const base = {
    operationId, source: 'xero', stage: 'delete_time_entry',
    projectId, timeEntryId, mock: MOCK,
  };

  if (!projectId || !timeEntryId) throw new Error('projectId and timeEntryId are required to delete a time entry');

  if (MOCK) {
    const log = readMockTimeLog();
    const i = log.findIndex((e) => e.projectId === projectId && e.timeEntryId === timeEntryId && e.status !== 'DELETED');
    if (i < 0) throw new Error(`Mock time entry ${timeEntryId} not found`);
    log[i] = { ...log[i], status: 'DELETED', deletedAt: new Date().toISOString() };
    writeMockTimeLog(log);
    telemetry.track('xero.time_entry.mock_deleted', { ...base, success: true });
    return { deleted: true, timeEntryId };
  }

  try {
    const { x, tid } = await ensureToken();
    await x.projectApi.deleteTimeEntry(tid, projectId, timeEntryId);
    telemetry.track('xero.time_entry.deleted', { ...base, success: true });
    return { deleted: true, timeEntryId };
  } catch (err) {
    telemetry.track('xero.time_entry.delete_failed', {
      ...base,
      errorName: err.name || 'Error',
      errorMessage: String(err.message || '').slice(0, 200),
      success: false,
    });
    throw err;
  }
}

module.exports = {
  buildConsentUrl,
  handleCallback,
  getProjects,
  getTasks,
  getProjectUsers,
  getConnectedOrg,
  getConnectedOrgCached,
  getTimeEntries,
  createTimeEntry,
  updateTimeEntry,
  deleteTimeEntry,
  _internal: { loadTokenSet, saveTokenSet },
};
