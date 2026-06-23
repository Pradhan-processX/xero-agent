# Xero Timesheet Agent — Project Context

## What This Is
Conversational timesheet agent: team members narrate work in **Microsoft Teams** → AI parses it → drafts Xero time entries → user confirms → writes to **Xero Projects API**.

Owner: Pradhan Pissay Sajjan (letschat@process-x.com.au), ProcessX (process-x.com.au)

> **Read `REVIEW-FINDINGS.md`** (architecture review, 2026-06-11): known issues and corrections —
> B1 plan not F1, use M365 Agents SDK for bot.js, exempt /api/messages from the API-key middleware,
> doc drift fixes. Apply when touching related code, or use as context.

---

## What Is Already Built (do not rebuild these)

| File | What it does | Status |
|---|---|---|
| `src/xero.js` | Xero Projects API client (xero-node SDK), token refresh, project/task cache 1hr, createTimeEntry with idempotency | Complete |
| `src/grounding.js` | Calls LLM (Azure OpenAI or OpenAI), multi-turn history, system prompt with scoped projects, all 6 guards | Complete |
| `src/conversationStore.js` | Conversation state per conversationId: memory (dev) or Azure Table (prod), 30-min idle TTL | Complete |
| `src/draftStore.js` | Draft lifecycle: add, update, markSubmitted, getWeek, removeEntry | Complete |
| `src/store.js` | Pluggable persistence: file backend (local dev) or Azure Table Storage (prod), selected at startup | Complete |
| `src/userMap.js` | Maps Teams identity (email/UPN/teamsId) → xeroUserId + allowedProjectIds | Complete |
| `src/auth-cli.js` | One-time OAuth2 consent CLI (npm run auth) | Complete |
| `src/config.js` | Central env config, including `llm.triageDeployment` | Complete |
| `src/server.js` | Express HTTP API with `/api/messages` exempt from x-api-key and Bot Service JWT validation when credentials are configured | Complete |
| `src/agent.js` | Two-model agent: triage deployment (`gpt-4.1-mini`) + reasoning deployment (`gpt-4.1`) with guarded tool-calling loop | Complete |
| `src/bot.js` | M365 Agents SDK handler, conversation state, Adaptive Card confirmation, routes normal messages through `agent.run()` | Complete |
| `xero-connector/openapi.yaml` | OpenAPI spec for Power Platform connector | Complete — kept as reference |

## What Is NOT Built Yet (the work ahead)

1. **Local bot integration testing** — run the server locally, point Teams App Test Tool / Agents Playground / Bot Framework Emulator at `http://localhost:3000/api/messages`, and test log-time, review, help, submit/cancel, and guard paths.
2. **Confirm triage deployment** — `AZURE_TRIAGE_DEPLOYMENT` should point to the actual Azure AI Foundry deployment name for `gpt-4.1-mini`.
3. **Application Insights observability** — `applicationinsights` npm package, init in `server.js`, `trackEvent()` around triage, reasoning loop, tools, guards, draft store, and Xero writes.
4. **Teams app manifest** — package for Teams Developer Portal.
5. **Azure App Service deployment** — **B1 plan with Always On** (NOT Free F1 — idles out, cold start exceeds Bot Framework ~15s timeout).

---

## Architecture Decisions (already agreed, do not re-debate)

- **No Copilot Studio** — too expensive (~$200/month). Teams bot via Azure Bot Service (free tier) + bot handler in this Express app.
- **M365 Agents SDK** (`@microsoft/agents-hosting`) for bot.js — NOT `botbuilder` (Bot Framework SDK is in maintenance mode; Agents SDK is the successor, same activity/adapter model and Adaptive Cards).
- **Azure App Service B1 + Always On** for hosting — PaaS, not serverless (Functions would kill the in-memory Xero cache + cold starts break bot timeout) and not a VM (unneeded ops). Keep at **1 instance** (shared Xero token row can race on refresh).
- **No LangGraph / CrewAI** — overkill. The bot uses one agent module with a cheap triage call and a reasoning/tool-calling loop. App code handles state and all Xero writes.
- **No per-user OAuth** — single Xero org connection, per-person attribution via `userId` field in createTimeEntry payload.
- **No MCP for Xero** — Xero Projects API not covered by any MCP server. Use xero-node SDK directly.
- **Azure Monitor / Application Insights** for observability — already in Azure subscription, no extra tool. Use `applicationinsights` npm package. NOT Langfuse (decided against — extra tool, not needed when already on Azure AI Foundry).
- **Azure Table Storage** for production persistence — file backend unsafe for concurrent users.
- **Raw fetch() for LLM** — no Anthropic/OpenAI SDK. Already in grounding.js. Keep it.

---

## Conversation Design

### 3 States (minimal state machine)
```
IDLE                → waiting for any message
CLARIFYING          → LLM flagged missing info (duration/project/task), asking user
NEEDS_CONFIRMATION  → draft shown to user, waiting for confirm/edit/delete
```

### 6 Intents the Bot Handles
```
LOG_TIME   → "3hrs on Acme" / "worked on website" / "acme 3h"
REVIEW     → "show my week" / "what did I log"
SUBMIT     → "yes" / "submit" / "looks good" / button tap on Adaptive Card
EDIT       → "change that to 2hrs" / "wrong project"
DELETE     → "remove that" / "delete wednesday"
HELP       → "hi" / "?" / anything unrecognised → show help message
```

### 6 Guards (all must pass before draft is created)
```
1. project in user's allowlist             ✓ in grounding.js
2. task valid for that project             ✓ in grounding.js
3. duration: missing = hard block,         ✓ in grounding.js
   >16hrs = soft warning (overnight valid)
4. date is not in the future               ✓ in grounding.js
5. LLM output is valid JSON shape          ✓ in grounding.js
6. confidence >= NLU_CONFIDENCE_THRESHOLD  ✓ in grounding.js (default 0.70)
```

### Governance Rules (non-negotiable)
```
- LLM never writes to Xero. App code calls createTimeEntry().
- User must confirm (Adaptive Card buttons) before any Xero write.
- xeroUserId always comes from userMap, never from LLM output.
- Every LLM call logged to Application Insights (trackEvent).
```

---

## Data Flow (one sentence per step)
1. Teams sends message + userId to `/api/messages` on Express.
2. Bot loads conversation state (history + state) by conversationId.
3. `userMap.resolveUser(userId)` → `xeroUserId` + `allowedProjectIds`.
4. `agent.run(text, history, user)` triages with the mini-model.
5. Help/off-topic/review can return directly; complex messages enter the reasoning tool loop.
6. `get_projects()` returns allowed projects/tasks from Xero cache.
7. `create_draft()` runs app-code guards and returns draft entries or clarification errors.
8. Passed entries → `draftStore.addEntries()` → status: `draft`.
9. Bot sends Adaptive Card showing draft to user for confirmation.
10. User taps Submit → `xero.createTimeEntry()` fires, draft marked submitted.
11. Every step should be logged to Application Insights via `trackEvent()` once observability is wired.

---

## API Caching (do not add extra Xero calls)
```
getProjects()  → 1hr in-memory cache, shared across all users (module-level in xero.js)
getTasks()     → 1hr in-memory cache per projectId (Map in xero.js)
Estimated daily Xero API calls for 10-person team: ~80 (well within 5000/day limit)
```

---

## Infrastructure Status
```
Azure account:        EXISTS — process-x.com.au tenant (Azure AI Foundry models already deployed)
App Service:          NOT CREATED YET — B1 + Always On; Express still running locally
Azure Bot:            NOT CREATED YET
Azure Table:          NOT CREATED YET (store.js already supports it, just needs connection string)
Application Insights: NOT CREATED YET (decided observability tool — NOT Langfuse)
Teams manifest:       NOT CREATED YET
All Azure infra:      BLOCKED — waiting for admin to create `xero-agent-rg` resource group
```

---

## Build Order (follow this sequence)
```
NOW (no Azure needed):
1. Confirm `.env` has `AZURE_OPENAI_DEPLOYMENT=gpt-4.1` and
   `AZURE_TRIAGE_DEPLOYMENT=gpt-4.1-mini` using the actual Azure deployment names.
2. Test locally: `npm run test:llm`, mock mode (`XERO_MOCK=true`), then
   Teams App Test Tool / Agents Playground against `http://localhost:3000/api/messages`.
3. Exercise guard paths: missing duration, future date, project outside allowlist,
   unknown task, >16h soft warning, unmapped user.

WHEN ADMIN CREATES xero-agent-rg RESOURCE GROUP:
4. Create Azure App Service (B1, Node 20, Always On) → deploy → public HTTPS URL
5. Create Azure Table Storage → set AZURE_STORAGE_CONNECTION_STRING
6. Create Azure Bot Service → point to <app-url>/api/messages → get MicrosoftAppId + Password
7. Create Application Insights → npm install applicationinsights → init + trackEvent() calls

AFTER INFRA:
8. End-to-end test against deployed bot (real Teams via Developer Portal personal install)
9. Create Teams app manifest → test in Developer Portal
10. Admin approves for org → staged rollout (you → 2-3 people → whole team)
```

---

## Key Xero Facts (non-obvious, verified June 2026)
- Xero Projects API ≠ Accounting API. Uses different base URL and scopes.
- `POST /projects/{projectId}/time` needs: userId, taskId, dateUtc, duration (INTEGER MINUTES), idempotencyKey
- Cannot filter projects by staff member — must maintain per-person allowlist manually
- Single org OAuth connection + userId field for per-person attribution (no per-user OAuth)
- Rate limits: 60 calls/min, 5000/day

---

## User Context
- First time working with Azure App Service, Azure Bot Service, Application Insights, M365 Agents SDK
- Has Azure account (portal.azure.com, process-x.com.au tenant)
- Has Teams access, can ask Teams admin to approve org apps
- Express app runs locally, not yet deployed
- Familiar with Teams Developer Portal and app manifest approval flow
- Go step by step, one instruction at a time, with screenshots expected between steps
