'use strict';
require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const config = {
  xero: {
    clientId: process.env.XERO_CLIENT_ID || '',
    clientSecret: process.env.XERO_CLIENT_SECRET || '',
    redirectUri: process.env.XERO_REDIRECT_URI || 'http://localhost:3000/auth/callback',
    tenantId: process.env.XERO_TENANT_ID || '',
    tokenFile: process.env.XERO_TOKEN_FILE || './.tokens.json',
    // Scopes the org connection needs. offline_access -> refresh tokens for unattended writes.
    scopes: 'openid profile email projects projects.read offline_access',
    // Mock mode: no real Xero connection. Seeded projects/tasks/users; writes are logged
    // locally instead of posted. Flip to false once the org connection is authorised.
    mock: process.env.XERO_MOCK === 'true',
    mockTimeLog: process.env.XERO_MOCK_TIME_LOG || './.mock-xero-time.json',
  },
  llm: {
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    // Azure endpoint: strip any trailing slash so we don't build "...azure.com//openai/...".
    azureEndpoint: (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, ''),
    azureKey: process.env.AZURE_OPENAI_KEY || '',
    azureDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || '',
    // Triage model deployment (gpt-4o-mini). Falls back to azureDeployment if not set.
    triageDeployment: process.env.AZURE_TRIAGE_DEPLOYMENT || process.env.AZURE_OPENAI_DEPLOYMENT || '',
    // GA version that supports JSON-mode (response_format). Override if your resource needs another.
    azureApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-06-01',
  },
  agent: {
    confidenceThreshold: parseFloat(process.env.NLU_CONFIDENCE_THRESHOLD || '0.70'),
    weeklyHours: parseFloat(process.env.DEFAULT_WEEKLY_HOURS || '37.5'),
    timeZone: process.env.DEFAULT_TIMEZONE || 'Australia/Sydney',
    userMapFile: process.env.USER_MAP_FILE || './config/userMap.json',
    // Optional: full userMap JSON as a single env var (App Service application setting),
    // so you can edit the team list without redeploying / shipping a file.
    userMapJson: process.env.USER_MAP_JSON || '',
    draftStoreFile: process.env.DRAFT_STORE_FILE || './.drafts.json',
  },
  // Persistence backend. If a connection string is set -> Azure Table Storage (multi-user,
  // multi-instance). Otherwise -> local JSON files (single-machine dev only).
  storage: {
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
    tokenTable: process.env.AZURE_TOKEN_TABLE || 'xerotokens',
    draftTable: process.env.AZURE_DRAFT_TABLE || 'drafts',
    conversationTable: process.env.AZURE_CONVERSATION_TABLE || 'conversations',
  },
  // Azure Bot Service / M365 Agents SDK credentials.
  // Names match what loadAuthConfigFromEnv() reads from env (clientId, clientSecret, tenantId).
  // Leave unset for local dev — adapter runs without JWT validation when clientId is absent.
  bot: {
    clientId: process.env.clientId || '',
    clientSecret: process.env.clientSecret || '',
    tenantId: process.env.tenantId || '',
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    apiKey: process.env.API_KEY || '',
  },
  required,
};

module.exports = config;
