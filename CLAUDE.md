# Xero Timesheet Agent — Project Context

## What This Is
Conversational timesheet agent: team members narrate work in **Microsoft Teams** → AI parses it → drafts Xero time entries → user confirms → writes to **Xero Projects API**.

Owner: Pradhan Pissay Sajjan (letschat@process-x.com.au), ProcessX (process-x.com.au)

---

## What Is Already Built (do not rebuild these)

| File | What it does | Status |
|---|---|---|
| `src/xero.js` | Xero Projects API client (xero-node SDK), token refresh, project/task cache 1hr, createTimeEntry with idempotency | Complete |
| `src/grounding.js` | Calls LLM (Azure OpenAI or OpenAI), builds system prompt with scoped projects, validates output against allowlist | Complete — needs multi-turn + 4 extra guards |
| `src/draftStore.js` | Draft lifecycle: add, update, markSubmitted, getWeek, removeEntry | Complete |
| `src/store.js` | Pluggable persistence: file backend (local dev) or Azure Table Storage (prod), selected at startup | Complete |
| `src/userMap.js` | Maps Teams identity (email/UPN/teamsId) → xeroUserId + allowedProjectIds | Complete |
| `src/auth-cli.js` | One-time OAuth2 consent CLI (npm run auth) | Complete |
| `src/config.js` | Central env config | Complete |
| `src/server.js` | Express HTTP API with API key middleware | Complete — needs /api/messages endpoint added |
| `xero-connector/openapi.yaml` | OpenAPI spec for Power Platform connector | Complete — kept as reference |

## What Is NOT Built Yet (the work ahead)

1. **Teams bot handler** (`src/bot.js`) — Bot Framework SDK, receives Teams messages, routes by conversation state
2. **Conversation state store** (`src/conversationStore.js`) — persists history + state per user in Azure Table
3. **Multi-turn grounding** — pass full message history to LLM instead of single narration
4. **4 missing guards** in grounding.js — task valid, duration range, date not future, structured output shape
5. **Langfuse observability** — trace every step (resolveUser, getProjects, callLLM, guards, draftStore)
6. **Teams app manifest** — package for Teams Developer Portal
7. **Azure App Service deployment** — Express app needs a public HTTPS URL

---

## Architecture Decisions (already agreed, do not re-debate)

- **No Copilot Studio** — too expensive (~$200/month). Use Bot Framework SDK directly instead.
- **No LangGraph / CrewAI** — overkill. LLM is called once per turn, returns structured JSON. App code handles state.
- **No per-user OAuth** — single Xero org connection, per-person attribution via `userId` field in createTimeEntry payload.
- **No MCP for Xero** — Xero Projects API not covered by any MCP server. Use xero-node SDK directly.
- **No Copilot Studio** — Teams bot via Azure Bot Service (free tier) + Bot Framework SDK.
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
1. project in user's allowlist          (already in grounding.js)
2. task valid for that project          (needs adding)
3. duration between 1min and 480min     (needs adding)
4. date is not in the future            (needs adding)
5. LLM output is valid JSON shape       (needs adding)
6. confidence >= NLU_CONFIDENCE_THRESHOLD (already in grounding.js, default 0.70)
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
1. Teams sends message + userId to `/api/messages` on Express
2. Bot loads conversation state (history + state) from Azure Table by conversationId
3. userMap.resolveUser(userId) → xeroUserId + allowedProjectIds
4. xero.getProjects() → returns from 1hr cache (not a live API call every turn)
5. grounding.js builds system prompt with scoped projects + full message history, calls LLM once
6. Guards validate all 6 rules against LLM output
7. Passed entries → draftStore.addEntries() → Azure Table, status: 'draft'
8. Bot sends Adaptive Card showing draft to user for confirmation
9. User taps Submit → xero.createTimeEntry() fires, draft marked submitted
10. Every step logged to Application Insights via trackEvent()

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
Azure account:    EXISTS — process-x.com.au tenant
App Service:      NOT CREATED YET — Express still running locally
Azure Bot:        NOT CREATED YET
Azure Table:      NOT CREATED YET (store.js already supports it, just needs connection string)
Langfuse:         NOT SET UP YET
Teams manifest:   NOT CREATED YET
```

---

## Build Order (follow this sequence)
```
1. Create Azure App Service → deploy Express app → get public HTTPS URL
2. Create Azure Bot Service → wire to that URL → get MicrosoftAppId + Password
3. Create Azure Table Storage → set AZURE_STORAGE_CONNECTION_STRING
4. Set up Langfuse (cloud free tier) → get keys
5. Add guards + multi-turn to grounding.js
6. Build src/bot.js (Bot Framework handler)
7. Build src/conversationStore.js (Azure Table backed)
8. Add /api/messages endpoint to server.js
9. Test locally with Bot Framework Emulator
10. Create Teams app manifest → test in Developer Portal
11. Admin approves for org → staged rollout (you → 2-3 people → whole team)
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
- First time working with Azure App Service, Azure Bot Service, Langfuse, Bot Framework
- Has Azure account (portal.azure.com, process-x.com.au tenant)
- Has Teams access, can ask Teams admin to approve org apps
- Express app runs locally, not yet deployed
- Familiar with Teams Developer Portal and app manifest approval flow
- Go step by step, one instruction at a time, with screenshots expected between steps
