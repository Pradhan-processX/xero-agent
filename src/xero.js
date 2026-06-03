'use strict';
const { XeroClient } = require('xero-node');
const config = require('./config');
const store = require('./store');

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

async function getProjects() {
  if (_projectsCache.data && Date.now() - _projectsCache.at < CACHE_TTL_MS) {
    return _projectsCache.data;
  }
  const { x, tid } = await ensureToken();
  const res = await x.projectApi.getProjects(tid);
  const items = (res.body.items || []).map((p) => ({
    projectId: p.projectId,
    name: p.name,
    status: p.status,
  }));
  _projectsCache = { at: Date.now(), data: items };
  return items;
}

async function getTasks(projectId) {
  const cached = _tasksCache.get(projectId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
  const { x, tid } = await ensureToken();
  const res = await x.projectApi.getTasks(tid, projectId);
  const items = (res.body.items || []).map((t) => ({
    taskId: t.taskId,
    name: t.name,
    status: t.status,
    chargeType: t.chargeType,
  }));
  _tasksCache.set(projectId, { at: Date.now(), data: items });
  return items;
}

async function getProjectUsers() {
  const { x, tid } = await ensureToken();
  const res = await x.projectApi.getProjectUsers(tid);
  return (res.body.items || []).map((u) => ({ userId: u.userId, name: u.name, email: u.email }));
}

// Create one time entry. duration is in MINUTES. idempotencyKey prevents double-posting.
async function createTimeEntry({ projectId, userId, taskId, dateUtc, durationMin, description }, idempotencyKey) {
  const { x, tid } = await ensureToken();
  const payload = {
    userId,
    taskId,
    dateUtc: dateUtc, // ISO 8601, e.g. 2026-06-03T00:00:00Z
    duration: Math.round(durationMin),
    description: description || undefined,
  };
  const res = await x.projectApi.createTimeEntry(tid, projectId, payload, idempotencyKey);
  return res.body;
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
