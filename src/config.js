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
  },
  llm: {
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
    azureKey: process.env.AZURE_OPENAI_KEY || '',
    azureDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || '',
  },
  agent: {
    confidenceThreshold: parseFloat(process.env.NLU_CONFIDENCE_THRESHOLD || '0.70'),
    weeklyHours: parseFloat(process.env.DEFAULT_WEEKLY_HOURS || '37.5'),
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
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    apiKey: process.env.API_KEY || '',
  },
  required,
};

module.exports = config;
