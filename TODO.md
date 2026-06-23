# Xero Agent — Build Checklist

Check off each item as you complete it. Share screenshots with Claude after each infra step.

---

## PHASE 1 — Azure Infrastructure

### 1.1 Azure App Service (host the Express app)
- [ ] Create App Service in Azure Portal
  - Resource Group: `xero-agent-rg`
  - Name: `xero-agent-api`
  - Runtime: Node 20 LTS
  - Region: Australia East
  - Plan: **B1 (~AU$20/mo)** — NOT Free F1 (no Always On → app idles out → cold start exceeds Bot Framework ~15s timeout → first message after idle fails)
- [ ] Enable **Always On** (Configuration → General settings)
- [ ] Keep instance count at 1 (shared Xero token row can race on refresh if scaled out)
- [ ] Deploy code from local machine to App Service
- [ ] Confirm app is live at `https://xero-agent-api.azurewebsites.net`
- [ ] Set all environment variables in App Service → Configuration

### 1.2 Azure Table Storage (persistent store for drafts + tokens + conversation)
- [ ] Create Storage Account in Azure Portal
  - Resource Group: `xero-agent-rg`
  - Name: `xeroagentstorage`
  - Region: Australia East
  - Redundancy: LRS (cheapest, fine for this)
- [ ] Copy connection string → add to .env as `AZURE_STORAGE_CONNECTION_STRING`
- [ ] Add connection string to App Service Configuration too
- [ ] Verify store.js switches to table backend (check logs on startup)

### 1.3 Azure Bot Service (connect Teams to your Express app)
- [ ] Create Azure Bot in Azure Portal
  - Resource Group: `xero-agent-rg`
  - Bot handle: `xero-agent-bot`
  - Messaging endpoint: `https://xero-agent-api.azurewebsites.net/api/messages`
- [ ] Copy `MicrosoftAppId` → add to .env
- [ ] Create client secret → copy `MicrosoftAppPassword` → add to .env
- [ ] Enable Microsoft Teams channel inside the bot resource
- [ ] Add both values to App Service Configuration

---

## PHASE 2 — Observability (Azure Monitor / Application Insights)

> Already part of your Azure subscription. No new account needed.

- [ ] Create Application Insights resource in Azure Portal
  - Resource Group: `xero-agent-rg`
  - Name: `xero-agent-insights`
  - Region: Australia East
- [ ] Copy `APPLICATIONINSIGHTS_CONNECTION_STRING` → add to .env
- [ ] Add connection string to App Service Configuration
- [ ] Run `npm install applicationinsights`
- [ ] Add one-line init to top of `src/server.js`
- [ ] Add `trackEvent()` calls in `src/agent.js` around triage call, reasoning loop, and tool invocations
- [ ] Verify traces appear in Azure Portal → Application Insights → Transaction search

---

## PHASE 3 — Code Changes

### 3.1 Enhance grounding.js
- [x] Accept full message history array (not single narration string)
- [x] Add guard: task must be valid for the selected project
- [x] Add guard: duration — missing=hard block, >16hrs=soft warning (no hard cap, overnight tasks valid)
- [x] Add guard: date cannot be in the future
- [x] Add guard: LLM output must match expected JSON shape
- [x] Today's date injected into system prompt
- [ ] Add Application Insights trackEvent() (once App Insights is created)

### 3.2 Build src/conversationStore.js
- [x] get(conversationId) — load history + state (in-memory now, Azure Table when infra ready)
- [x] set(conversationId, data) — save history + state
- [x] clear(conversationId) — wipe after submit or 30min idle (TTL auto-clears too)
- [ ] Add Application Insights trackEvent() (once App Insights is created)

### 3.3 Build src/agent.js

> New file. Replaces grounding.js as the primary AI path for bot conversations.
> grounding.js stays untouched — it is still used by the /capture REST endpoint.
> Uses raw fetch() throughout — no openai SDK (confirmed: identical quality, same HTTP request).

- [x] `triage(text)` — calls the triage deployment (`gpt-4.1-mini` currently) via raw fetch(), json_object mode, max_tokens 20
  - Returns `{ type: 'help' | 'off_topic' | 'review' | 'complex' }`
  - Handles ~70–80% of messages cheaply without waking the reasoning model
- [x] `toolGetProjects(user)` — calls xero.getProjects() + xero.getTasks(), filters by allowedProjectIds
- [x] `toolCreateDraft(args, user)` — runs all 4 guards in app code (project allowlist, task validity, duration, future date); returns draft entry or error string to LLM
- [x] `toolGetWeekSummary(user)` — calls draftStore.getWeek(), returns formatted summary
- [x] `reasoningAgent(text, history, user)` — calls gpt-4.1 via raw fetch(), tool-calling loop (max 10 iterations)
  - Tools array passed in request body: `get_projects`, `create_draft`, `get_week_summary`
  - LLM decides which tools to call and when; guards run in app code, never bypassable
  - Returns `{ type: 'text', content }` or `{ type: 'card', entries }`
- [x] `run(text, history, user)` — entry point
  - Triage first; route: help/off_topic → text reply, review → `toolGetWeekSummary`, complex → `reasoningAgent`
  - Returns same `{ type, content | entries }` shape in all cases

### 3.4 Update src/config.js

- [x] Add `llm.triageDeployment: process.env.AZURE_TRIAGE_DEPLOYMENT || process.env.AZURE_OPENAI_DEPLOYMENT || ''`
  - Falls back to reasoning model deployment if the triage deployment is not set
- [x] Add `AZURE_TRIAGE_DEPLOYMENT=gpt-4.1-mini` to `.env.example`

### 3.5 Rewrite src/bot.js

> Keep: M365 Agents SDK setup, pre-filter for NEEDS_CONFIRMATION card taps (SUBMIT/CANCEL — app code, no LLM),
> userMap resolution, conversationStore load/save, buildDraftCard(), fmtDuration(), buildWeekSummary().
> Remove: REVIEW_RE / SUBMIT_RE / CANCEL_RE / TIME_RE regex, direct calls to groundNarration, manual intent routing.

- [x] Replace `const { groundNarration } = require('./grounding')` with `const { run } = require('./agent')`
- [x] After NEEDS_CONFIRMATION pre-filter, call `agent.run(text, history, user)` for all other messages
- [x] If result.type === 'text': send text reply, save IDLE state
- [x] If result.type === 'card': draftStore.addEntries() → buildDraftCard() → send card, save NEEDS_CONFIRMATION state
- [x] Keep typed SUBMIT/CANCEL fallback regex only for confirmation state, so users can reply in text instead of tapping the Adaptive Card

### 3.6 Configure triage deployment in Azure AI Foundry

- [ ] Go to Azure AI Foundry → same workspace as gpt-4.1
- [ ] Confirm/create deployment: model = `gpt-4.1-mini`, deployment name = `gpt-4.1-mini` or your chosen Azure deployment name
- [ ] Add `AZURE_TRIAGE_DEPLOYMENT=gpt-4.1-mini` to `.env` using the actual Azure deployment name

### 3.7 Local testing (no Azure needed)

- [x] `npm run test:llm` — LLM config + grounding round-trip
- [ ] Set `XERO_MOCK=true`, then run `npm start` — exercise /capture, /week, /entry/:id, /submit against mock data
- [ ] Teams App Test Tool / Agents Playground (or Bot Framework Emulator) → `http://localhost:3000/api/messages`
- [ ] Script the conversation: LOG_TIME → draft card → SUBMIT / CANCEL → REVIEW → HELP
- [ ] Guard checks: future date, >16h soft warning, project outside allowlist, unknown task, unmapped user
- [ ] After Table Storage exists: set `AZURE_STORAGE_CONNECTION_STRING`, restart mid-conversation, confirm state + drafts survive

---

## PHASE 4 — Teams Delivery

### 4.1 Package the Teams App
- [ ] Create `teams-app/` folder
- [ ] Write `manifest.json` (name, botId, scopes: personal)
- [ ] Add icons: `color.png` (192x192) and `outline.png` (32x32)
- [ ] Zip the folder → `xero-agent.zip`

### 4.2 Test in Developer Portal
- [ ] Upload zip to dev.teams.microsoft.com
- [ ] Install in your own Teams (personal scope)
- [ ] Test full flow: narrate → draft shown → confirm → check Xero

### 4.3 Org Deployment
- [ ] Send `xero-agent.zip` to Teams admin
- [ ] Admin uploads to Teams Admin Center → Manage apps
- [ ] Admin sets availability to org
- [ ] Confirm team members can find and install it from "Built for [Org]"
- [ ] Staged rollout: you → 2-3 people → whole team

---

## PHASE 5 — Post-Launch

- [ ] Monitor Application Insights — check for guard-failure events daily (first week)
- [ ] Tune `NLU_CONFIDENCE_THRESHOLD` if too many false positives
- [ ] Add new team members to `config/userMap.json` as needed
- [ ] Document how to add new projects to a user's allowlist

---

## Code Improvements (Parked)

- [ ] Add `try/catch` around `draftStore.addEntries()` in `bot.js:285` — if this throws, the user gets a generic adapter error instead of a useful message. Wrap it and send a clear error reply.

---

## Current Status

**Active branch: `feature/teams-bot`**

**Phase 1 (Azure infra):** BLOCKED — waiting for admin to create `xero-agent-rg` resource group
**Phase 2 (Observability):** BLOCKED — needs resource group first
**Phase 3.1 (grounding.js):** DONE ✓
**Phase 3.2 (conversationStore.js):** DONE ✓
**Phase 3.3 (agent.js — two-model agent):** DONE ✓
**Phase 3.4 (config.js triageDeployment):** DONE ✓
**Phase 3.5 (bot.js rewrite — call agent.run()):** DONE ✓
**Phase 3.6 (configure gpt-4.1-mini triage deployment):** Confirm Azure deployment + `.env`
**Phase 3.7 (local testing):** CURRENT STAGE

> Current code stage: local bot integration testing. `bot.js` routes messages through `agent.run()`;
> only typed SUBMIT/CANCEL regex remains as a confirmation fallback. `server.js` has `/api/messages`
> exempt from x-api-key and protected by Bot Service JWT auth when bot credentials are configured.
