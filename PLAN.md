# Xero Timesheet Agent — Full Plan

Owner: Pradhan Pissay Sajjan · letschat@process-x.com.au · ProcessX  
Branch: `feature/teams-bot` → merges into `main`

---

## What We're Building

Team members open Microsoft Teams, describe their work in plain English, and the agent parses it, shows a draft Xero time entry for confirmation, then writes it to Xero Projects on approval. No forms. No Xero login per person. Just chat.

---

## Architecture

```
LAYER 1 — USER FACING
  Microsoft Teams (personal app)
  └── Adaptive Cards (Submit / Cancel buttons)
  └── Teams App Manifest (admin approves once for org)

LAYER 2 — BACKEND  (Azure, process-x.com.au tenant)
  Azure Bot Service  ──→  Azure App Service (Node.js/Express, B1 + Always On, 1 instance)
                              ├── bot.js              M365 Agents SDK adapter + pre-filter
                              ├── agent.js            SINGLE AGENT, TWO MODELS:
                              │     ├── triage        gpt-4.1-mini — classifies: help/review/complex
                              │     └── reasoning     gpt-4.1 — tool-calling loop (get_projects,
                              │                       create_draft, get_week_summary)
                              ├── conversationStore.js  state per conversationId
                              ├── grounding.js         LLM + 6 guards (used by /capture REST only)
                              ├── xero.js              Xero API client
                              ├── draftStore.js        draft lifecycle
                              └── userMap.js           Teams ID → Xero user
                          Azure Table Storage
                              ├── conversation state
                              ├── draft entries
                              └── Xero OAuth tokens

LAYER 3 — LLM + OBSERVABILITY
  Azure AI Foundry (Azure OpenAI):
    gpt-4.1-mini deployment ← triage model (cheap, fast)
    gpt-4.1 deployment      ← reasoning model (tool calling)
  Application Insights      ← every step logged
  Xero Projects API         ← time entry reads + writes
```

See `architecture.html` for visual diagram (two tabs: Sandbox and Production).

---

## Agent Design

### Two Models, One Agent
The agent is the architecture — not one of the models. Two models live inside it:

| Model | Role | When used |
|---|---|---|
| gpt-4.1-mini | Triage | Every message — cheap classification only |
| gpt-4.1 | Reasoning | Complex tasks — full tool-calling loop |

**Triage output** (json_object, max_tokens 20):
```
{ "type": "help" }         → send help text, no LLM cost
{ "type": "off_topic" }    → redirect, no LLM cost
{ "type": "review" }       → call toolGetWeekSummary() directly
{ "type": "complex" }      → wake reasoning model
```

Complexity ≠ intent. "How many hours did I log this week?" could be simple or complex (goal tracking needs reasoning). Triage decides — not keywords.

### Tool-Calling Loop (gpt-4.1)
The reasoning model calls tools in app code. LLM cannot bypass guards — they run inside the tool handlers:

```
get_projects()       → filters xero.getProjects() by user.allowedProjectIds
create_draft(args)   → runs all 4 guards in app code:
                         1. project in user's allowlist
                         2. task valid for that project
                         3. duration present + ≤16h soft warn (>16h allowed)
                         4. date not in the future
                       Guard failure → error string returned to LLM → LLM asks user to clarify
get_week_summary()   → draftStore.getWeek(), formatted text
```

**No `submit_to_xero` tool.** Xero writes only happen when user taps "Submit to Xero" on an Adaptive Card. LLM never writes to Xero.

### Pre-filter (app code, free — no LLM)
Bot.js handles card button taps and NEEDS_CONFIRMATION state entirely in app code before agent.js is called:
- `SUBMIT` tap → iterate entries, call xero.createTimeEntry(), markSubmitted()
- `CANCEL` tap → clear conversation state

### Cost Estimate (10-person team)
- ~70–80% messages → triage only (cheap mini-model classification)
- ~20–30% messages → reasoning model (gpt-4.1)
- Estimated: ~$7/month LLM total

---

## Conversation Design

### 3 States
```
IDLE                → waiting, no active context
CLARIFYING          → LLM flagged missing info, bot asked a follow-up
NEEDS_CONFIRMATION  → draft shown, waiting for Submit / Cancel
```

### 6 Intents (handled by agent, not regex)
```
LOG_TIME   "3hrs on Acme today" / "worked on website"
REVIEW     "show my week" / "what did I log"
SUBMIT     "yes" / "submit" / tapping Submit on Adaptive Card    ← pre-filter (no LLM)
CANCEL     "no" / "cancel" / tapping Cancel on Adaptive Card     ← pre-filter (no LLM)
EDIT       "change that to 2hrs" / "wrong project"               ← reasoning model
HELP       "hi" / "?" / anything unrecognised                    ← triage handles
```

### 6 Guards (all must pass before draft is saved)
Guards run in app code inside tool handlers — LLM output never bypasses them:
```
1. project in user's allowlist          ← toolCreateDraft() in agent.js
2. task valid for that project          ← toolCreateDraft() in agent.js
3. duration > 0 (missing = hard block)  ← toolCreateDraft() in agent.js
   duration > 16hrs = soft warning only (overnight shifts are valid)
4. date is not in the future            ← toolCreateDraft() in agent.js
5. LLM output is valid JSON shape       ← tool_call response parsing in agent.js
6. confidence >= threshold (default 0.7)← reasoningAgent() in agent.js
```

### Governance (non-negotiable)
```
- LLM NEVER writes to Xero. App code calls createTimeEntry() only.
- User MUST tap Submit on Adaptive Card before any Xero write.
- xeroUserId always comes from userMap, never from LLM output.
- Every LLM call logged to Application Insights.
```

---

## Data Flow (one turn, end to end)

```
1.  Team member sends message in Teams
2.  Teams → Azure Bot Service → POST /api/messages on Express (exempt from x-api-key)
3.  bot.js: if NEEDS_CONFIRMATION + card tap → SUBMIT or CANCEL (app code, no LLM); else continue
4.  bot.js loads conversation state from conversationStore (history + state)
5.  userMap.resolveUser(teamsId) → xeroUserId + allowedProjectIds
6.  agent.run(text, history, user):
      a. triage(text) → gpt-4.1-mini: classify as help / off_topic / review / complex
      b. help/off_topic → return help text immediately
      c. review → toolGetWeekSummary(user) → return formatted summary
      d. complex → reasoningAgent(text, history, user):
           - gpt-4.1 tool-calling loop (max 10 iterations)
           - get_projects() called → app code returns scoped project+task list
           - create_draft(args) called → 4 guards run → draft entry or error string
           - get_week_summary() called → week totals
7.  Result: { type: 'text', content } or { type: 'card', entries }
8.  If card: draftStore.addEntries() → Azure Table, status: 'draft'
9.  bot.js sends Adaptive Card or text reply to Teams
10. User taps Submit → createTimeEntry() fires for each entry
11. Draft marked submitted, conversation state cleared
12. Every step tracked via Application Insights trackEvent()
```

---

## What Is Already Built

| File | What it does | Status |
|---|---|---|
| `src/xero.js` | Xero Projects API client, token refresh, 1hr project/task cache, createTimeEntry with idempotency | ✅ Done |
| `src/grounding.js` | LLM call (Azure OpenAI), multi-turn history, system prompt, all 6 guards — used by /capture REST | ✅ Done |
| `src/draftStore.js` | Draft lifecycle: add, update, markSubmitted, getWeek, removeEntry | ✅ Done |
| `src/store.js` | Pluggable persistence: file (local) or Azure Table (prod) | ✅ Done |
| `src/userMap.js` | Maps Teams identity → xeroUserId + allowedProjectIds | ✅ Done |
| `src/auth-cli.js` | One-time OAuth2 consent CLI (`npm run auth`) | ✅ Done |
| `src/config.js` | Central env config, including `llm.triageDeployment` | ✅ Done |
| `src/server.js` | Express HTTP API — /api/messages (Bot Service, exempt from x-api-key), /capture, /week, /entry/:id, /submit, /projects, /health | ✅ Done |
| `src/conversationStore.js` | Conversation state per conversationId: memory (dev) or Azure Table (prod), 30-min idle TTL | ✅ Done |
| `src/bot.js` | M365 Agents SDK adapter, NEEDS_CONFIRMATION pre-filter, Adaptive Cards, routes normal messages through `agent.run()` | ✅ Done |
| `architecture.html` | Visual sandbox + production architecture diagrams | ✅ Done |

---

## What Is NOT Built Yet

### Phase 3 — Code / Local Testing

| # | File | What it does | Status |
|---|---|---|---|
| 3.3 | `src/agent.js` | Two-model agent: triage (`gpt-4.1-mini`) + reasoning with tool calling (`gpt-4.1`), raw fetch() | Done |
| 3.4 | `src/config.js` | `llm.triageDeployment` for the mini-model deployment name | Done |
| 3.5 | `src/bot.js` | M365 Agents SDK bot routes through `agent.run()`; confirmation submit/cancel stays in app code | Done |
| 3.6 | `.env` / Azure AI Foundry | Confirm `AZURE_TRIAGE_DEPLOYMENT=gpt-4.1-mini` points to the actual Azure deployment name | Pending |
| 3.7 | Local bot testing | Exercise `/api/messages`, Adaptive Cards, submit/cancel, review/help, and guard paths | Current |

### Phase 1 — Azure Infrastructure (BLOCKED — needs admin to create `xero-agent-rg`)

| Resource | Name | Cost |
|---|---|---|
| App Service | `xero-agent-api` | **B1 (~AU$20/mo) + Always On** — NOT Free F1: F1 has no Always On, app idles out after ~20 min, cold start exceeds Bot Framework's ~15s timeout → first message after idle fails |
| Bot Service | `xero-agent-bot` | Free |
| Table Storage | `xeroagentstorage` | ~$0.05/mo |
| Application Insights | `xero-agent-insights` | Free within Azure sub |

**Ask admin:** Create resource group `xero-agent-rg` in Australia East, grant Pradhan Contributor access. Mention ~AU$20–25/mo cost so approval happens once.  
**Total cost:** ~AU$20–25/month.
**Keep App Service at 1 instance** — the shared Xero token row in Table Storage can race on concurrent refresh if scaled out.

### Phase 2 — Observability (BLOCKED — needs resource group)

- Install `applicationinsights` npm package
- One-line init in `server.js`
- Add `trackEvent()` calls in `agent.js` around triage call, reasoning loop iterations, and tool invocations

### Phase 4 — Teams Delivery (after code + infra)

- Create `teams-app/manifest.json` + icons
- Zip and upload to Teams Developer Portal
- Test personally → send to admin for org approval
- Staged rollout: you → 2–3 people → whole team

---

## Build Order

```
NOW (no Azure needed):
  3.6  Confirm gpt-4.1-mini triage deployment in Azure AI Foundry and .env
  3.7  Local testing (see Testing Plan below) — no Azure needed  ← CURRENT

WHEN ADMIN CREATES RESOURCE GROUP:
  1.1  Deploy Express to App Service (B1, Node 20, Always On, 1 instance)
  1.2  Create Table Storage → set AZURE_STORAGE_CONNECTION_STRING
  1.3  Create Bot Service → endpoint <app-url>/api/messages → get MicrosoftAppId + Password
  2.0  Create Application Insights → npm install applicationinsights → add trackEvent() to agent.js

AFTER INFRA:
  E2E test against deployed bot (Testing Plan stages 4–5)
  4.0  Teams manifest → Developer Portal → admin approval → org rollout
```

---

## Testing Plan

```
STAGE 1 — unit-ish, already available (no Azure, no bot):
  npm run test:llm                LLM config + grounding round-trip
  npm run test:xero               Xero connection, scopes, IDs (live org)
  Set XERO_MOCK=true, npm start   full pipeline against mock data, exercise
                                  /capture, /week, /entry/:id, /submit via curl

STAGE 2 — bot logic locally (after agent.js + bot.js rewrite):
  Run server locally + Teams App Test Tool / Agents Playground (or Bot
  Framework Emulator) pointed at http://localhost:3000/api/messages.
  No MicrosoftAppId needed locally (adapter auth disabled when unset).
  Script: LOG_TIME happy path → NEEDS_CONFIRMATION card → SUBMIT / CANCEL → REVIEW → HELP.
  Guard checks: future date, >16h soft warning, project not in allowlist,
  unknown task, unmapped user.

STAGE 3 — persistence swap:
  Set AZURE_STORAGE_CONNECTION_STRING (once Table exists) → rerun Stage 2,
  confirm conversation state + drafts survive a server restart.

STAGE 4 — deployed smoke test:
  Bot Service wired to App Service URL → test in Azure Portal "Test in
  Web Chat" → then personal install via Teams Developer Portal.

STAGE 5 — real Xero write:
  One real time entry end-to-end as yourself; verify in Xero; re-submit
  same draft to confirm idempotency key prevents a duplicate.
```

---

## Key Technical Decisions (already made, not up for debate)

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Teams bot platform | M365 Agents SDK (`@microsoft/agents-hosting`) + Azure Bot Service | Copilot Studio (~$200/mo); `botbuilder` (maintenance mode) | Cost; Agents SDK is the supported successor, same adapter model |
| Hosting | App Service B1 + Always On, 1 instance | Free F1 (cold start breaks bot timeout); Functions (kills in-memory cache); VM (ops burden) | Long-lived process with in-memory Xero cache needs PaaS |
| Agent architecture | Single agent, two models: gpt-4.1-mini triage + gpt-4.1 reasoning with tool calling | Single LLM call returning JSON; LangGraph/CrewAI | Tool calling lets LLM ground itself on real project data; triage model keeps cost low |
| LLM HTTP | raw fetch() — no openai SDK | openai npm SDK | Already in grounding.js; quality identical (SDK wraps same HTTP request); no extra dep |
| LLM provider | Azure AI Foundry (Azure OpenAI) | Direct OpenAI | Data stays in tenant |
| Observability | Azure Monitor / Application Insights | Langfuse | Already in Azure sub, no extra tool |
| Xero connection | xero-node SDK, single org OAuth | MCP server | Projects API not in any MCP server |
| Per-person attribution | userId field in createTimeEntry | Per-user OAuth | No consent dance needed |
| Persistence | Azure Table Storage (prod) / file (local dev) | SQL / MongoDB | Cost + already supported |

---

## Xero API Facts (non-obvious)

- Xero Projects API ≠ Accounting API — different base URL and scopes
- `POST /projects/{projectId}/time` needs: `userId`, `taskId`, `dateUtc`, `duration` (integer minutes), `idempotencyKey`
- Cannot filter projects by staff — maintain per-person allowlist in `userMap.js`
- Rate limits: 60 calls/min, 5,000/day → projects + tasks cached 1hr
- Single org connection + `userId` field = per-person attribution without per-user OAuth

---

## Infrastructure Status

```
Azure account         EXISTS  (process-x.com.au tenant)
Azure AI Foundry      EXISTS  (gpt-4.1 deployed; confirm/add gpt-4.1-mini triage deployment)
App Service           NOT CREATED  ← needs admin
Azure Bot             NOT CREATED  ← needs admin
Azure Table Storage   NOT CREATED  ← needs admin
Application Insights  NOT CREATED  ← needs admin
Teams manifest        NOT CREATED  ← Phase 4
```
