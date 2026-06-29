# Xero Timesheet Agent — Project Context

## What This Is
Conversational timesheet agent: team members narrate work in **Microsoft Teams** → AI parses it → drafts Xero time entries → user confirms → writes to **Xero Projects API**.

Owner: Pradhan Pissay Sajjan (letschat@process-x.com.au), ProcessX (process-x.com.au)

> **Read `REVIEW-FINDINGS.md`** (architecture review, 2026-06-11): known issues and corrections —
> B1 plan not F1, use M365 Agents SDK for bot.js, exempt /api/messages from the API-key middleware,
> doc drift fixes. Apply when touching related code, or use as context.

---

## Current Truth - 2026-06-29

- Azure App Service is deployed and running: `xero-agent-api`.
- Resource group: `ProcessX-AUAE-XA-RG-01`.
- Public host: `https://xero-agent-api-ftf5csc8fghyaagc.australiaeast-01.azurewebsites.net`.
- Bot endpoint: `/api/messages`.
- Health endpoint: `/health`.
- Azure Bot Web Chat is working.
- Azure Table Storage is active in Azure when `AZURE_STORAGE_CONNECTION_STRING` is set.
- Deployed mode is still `XERO_MOCK=true` until live Xero OAuth access is available.
- Planned-time policy is implemented and deployed: future dates inside the current Monday-start
  timesheet week are allowed with a warning and explicit confirmation; future dates outside the
  current week are blocked.
- Local tests passed after this change: `npm run test:dates` and `npm run test:bot`.
- Next major step: run live Xero auth, discover real Xero users/projects/tasks, set `USER_MAP_JSON`,
  then switch Azure `XERO_MOCK=false`.

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

## What Is NOT Built Yet / Work Ahead

1. **Live Xero auth** — run `npm run auth` once the Xero authorising user is available.
2. **Real Xero discovery** — run `npm run test:xero` to print real Xero users/projects/tasks.
3. **Real user scoping** — set `USER_MAP_JSON` with Teams user IDs, `xeroUserId`, and allowed real
   Xero project IDs.
4. **Switch live mode** — set Azure `XERO_MOCK=false`, restart App Service, then test with real
   projects before submitting real entries.
5. **Teams app manifest / org rollout** — package for Teams Developer Portal and staged rollout.
6. **Automated deployment** — PR tests, merge to `main`, GitHub Actions OIDC deploy to Azure.

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

### Guard Policy
```
1. project in user's allowlist             ✓ app code
2. task valid for that project             ✓ app code
3. duration: missing = hard block,         ✓ app code
   >16hrs = soft warning (overnight valid)
4. date policy:
   - past/today allowed
   - future dates inside current Monday-start week allowed as planned time with warning
   - future dates outside current week blocked
5. LLM output/tool args validated before draft creation
6. confidence threshold still exists for legacy /capture path
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
App Service:          EXISTS — xero-agent-api, B1/Node on Azure App Service
Azure Bot:            EXISTS — Web Chat tested against deployed /api/messages
Azure Table:          EXISTS/ACTIVE when AZURE_STORAGE_CONNECTION_STRING is configured
Application Insights: CONFIGURED if APPLICATIONINSIGHTS_CONNECTION_STRING is set
Teams manifest:       NOT CREATED YET
Live Xero auth:       PENDING — deployed app remains XERO_MOCK=true
```

---

## Build Order (follow this sequence)
```
NOW:
1. Keep local checks green: `npm run test:dates`, `npm run test:bot`, `npm run test:llm`.
2. Use Azure Web Chat for deployed smoke tests while XERO_MOCK=true.
3. When Xero auth is available, run `npm run auth`, then `npm run test:xero`.
4. Build `USER_MAP_JSON` from real Teams IDs, Xero user IDs, and allowed project IDs.
5. Set Azure `XERO_MOCK=false`, restart, then test "what are my projects" before submitting.
6. Create Teams app manifest → test in Developer Portal → staged org rollout.
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
- Express app is deployed to Azure and can also run locally
- Familiar with Teams Developer Portal and app manifest approval flow
- Go step by step, one instruction at a time, with screenshots expected between steps
