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
    tokenSet = refreshed;
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
      idempotencyKey, loggedAt: new Date().toISOString(),
    };
    // Append to a local log so you can inspect exactly what WOULD be posted to Xero.
    let log = [];
    try { log = JSON.parse(fs.readFileSync(config.xero.mockTimeLog, 'utf8')); } catch {}
    log.push(entry);
    fs.writeFileSync(config.xero.mockTimeLog, JSON.stringify(log, null, 2));
    telemetry.track('xero.time_entry.mock_created', { ...base, timeEntryId: entry.timeEntryId, success: true });
    return entry;
  }

  try {
    const { x, tid } = await ensureToken();
    const payload = {
      userId,
      taskId,
      dateUtc: dateUtc, // ISO 8601, e.g. 2026-06-03T00:00:00Z
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

module.exports = {
  buildConsentUrl,
  handleCallback,
  getProjects,
  getTasks,
  getProjectUsers,
  createTimeEntry,
  _internal: { loadTokenSet, saveTokenSet },
};
