# Xero Timesheet Agent

Conversational timesheet capture for ProcessX: a team member writes a plain-English message in
Microsoft Teams, the backend maps it to real Xero Projects/projects/tasks, shows an Adaptive Card
for confirmation, and writes Xero Projects time entries only after approval.

Current architecture:

```text
Teams -> Azure Bot Service -> Node/Express backend -> Xero Projects API
                         bot.js   M365 Agents SDK + Adaptive Cards
                         agent.js two-model Azure OpenAI agent
```

The older Copilot Studio/custom connector path is no longer the primary delivery path. The
`xero-connector/openapi.yaml` file remains as reference for REST endpoints.

## What's Here

| File | Role |
|---|---|
| `src/server.js` | Express API: `/api/messages`, `/capture`, `/week`, `/entry/:id`, `/submit`, `/projects`, `/health` |
| `src/bot.js` | M365 Agents SDK Teams handler, confirmation pre-filter, Adaptive Card submit/cancel |
| `src/agent.js` | Main bot AI path: triage deployment + reasoning deployment with tool-calling loop |
| `src/grounding.js` | Legacy/single-turn grounding path used by `/capture` REST only |
| `src/xero.js` | Xero Projects client, token refresh, project/task cache, time-entry write |
| `src/userMap.js` | Teams identity -> Xero user + allowed project IDs |
| `src/draftStore.js` | Draft lifecycle: add, update, remove, markSubmitted, getWeek |
| `src/conversationStore.js` | Teams conversation state: memory locally or Azure Table Storage in production |
| `src/store.js` | Persistence backend: local JSON files or Azure Table Storage |
| `src/auth-cli.js` | One-time Xero OAuth consent flow |
| `src/list-users.js` | Prints Xero project users/projects for `config/userMap.json` |
| `xero-connector/openapi.yaml` | Reference Swagger 2.0 REST connector |

## Current Stage

The core code path is built. The project is now in **Phase 3.7: local bot integration testing**.

Already built:

- Xero client, mock mode, draft store, user map, and storage backends.
- `/api/messages` endpoint, exempt from `x-api-key` and using Bot Service JWT auth when bot creds exist.
- M365 Agents SDK bot handler with Adaptive Card confirmation.
- `src/agent.js` with triage + reasoning models and guarded tool handlers.
- `src/config.js` with `llm.triageDeployment`.

Still pending:

- Confirm Azure AI Foundry has a triage deployment, currently expected as `gpt-4.1-mini`.
- Run local bot testing against `http://localhost:3000/api/messages`.
- Azure infrastructure: App Service B1, Bot Service, Table Storage, Application Insights.
- Teams app manifest and org rollout.

## Environment

Copy `.env.example` to `.env`, then fill in the real values. Secrets stay in `.env` only.

Azure OpenAI uses deployment names:

```env
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_KEY=your-azure-openai-key
AZURE_OPENAI_DEPLOYMENT=gpt-4.1
AZURE_TRIAGE_DEPLOYMENT=gpt-4.1-mini
AZURE_OPENAI_API_VERSION=2024-06-01
```

`AZURE_OPENAI_DEPLOYMENT` is the reasoning model. `AZURE_TRIAGE_DEPLOYMENT` is the cheaper/faster
classification model. The API key belongs to the Azure OpenAI resource, not to each deployment.

## Local Run

```powershell
npm install
npm run auth          # one-time Xero org consent, unless using mock mode only
npm run test:xero     # verify Xero scopes, projects, tasks, users
npm run test:llm      # verify Azure OpenAI config
npm start             # backend on :3000
```

For full local pipeline testing without live Xero writes:

```powershell
# in .env
XERO_MOCK=true

npm start
```

`GET /health` should report the selected storage backend and mock mode.

## REST Smoke Test

The REST `/capture` path still uses `grounding.js` and is useful for quick backend checks:

```powershell
curl -s -X POST http://localhost:3000/capture -H "x-api-key: <API_KEY>" -H "content-type: application/json" -d "{\"identity\":\"letschat@process-x.com.au\",\"text\":\"3 hours on validation for the DM project today\"}"
curl -s "http://localhost:3000/week?identity=letschat@process-x.com.au" -H "x-api-key: <API_KEY>"
curl -s -X POST http://localhost:3000/submit -H "x-api-key: <API_KEY>" -H "content-type: application/json" -d "{\"identity\":\"letschat@process-x.com.au\"}"
```

## Local Bot Test

Run the server locally, then point Teams App Test Tool / Agents Playground / Bot Framework Emulator
at:

```text
http://localhost:3000/api/messages
```

Exercise:

- Log time: `3h on the DM project validation today`
- Review: `show my week`
- Help: `what can you do?`
- Confirmation: tap Submit / Cancel, and also try typed `submit` / `cancel`
- Guards: missing duration, future date, unknown task, project outside allowlist, >16h soft warning

## Xero Setup

See `SETUP-XERO.md` for the Xero developer app, scopes, OAuth consent, and user-map setup.

Key facts:

- One Standard/Adviser Xero user authorises the org connection.
- Per-person attribution uses the `userId` field in the Xero Projects time-entry payload.
- Team members do not need individual Xero OAuth consent.
- Xero project access is enforced by `userMap.js` allowlists, because Xero cannot list projects per staff member.

## Azure Deployment

Blocked until the admin creates `xero-agent-rg` in Australia East and grants Contributor access.

Target resources:

- Azure App Service B1, Always On, single instance.
- Azure Bot Service pointing to `https://<app>.azurewebsites.net/api/messages`.
- Azure Table Storage via `AZURE_STORAGE_CONNECTION_STRING`.
- Application Insights via `APPLICATIONINSIGHTS_CONNECTION_STRING`.

Keep the App Service at one instance until token-refresh concurrency is hardened.
