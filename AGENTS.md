# AGENTS.md — project context for any AI coding tool

Portable working memory for this repo. Read this first. Works with any agent/IDE (Claude Code,
Cursor, GitHub Copilot, etc.). Keep it updated as decisions change. **Never put secrets here.**

> See `REVIEW-FINDINGS.md` (architecture review 2026-06-11) for known issues and their status.
> Plan + build checklist: `PLAN.md` and `TODO.md`.

## Current truth (2026-06-29)

- Azure App Service is deployed and running: `xero-agent-api` in resource group
  `ProcessX-AUAE-XA-RG-01`, Australia East.
- Public host:
  `https://xero-agent-api-ftf5csc8fghyaagc.australiaeast-01.azurewebsites.net`
- Bot endpoint:
  `https://xero-agent-api-ftf5csc8fghyaagc.australiaeast-01.azurewebsites.net/api/messages`
- Health endpoint: `/health`.
- Azure Table Storage is active in Azure when `AZURE_STORAGE_CONNECTION_STRING` is set.
- Azure Bot Web Chat is working against the deployed app.
- `XERO_MOCK=true` is still the deployed mode until live Xero OAuth access is available.
- Latest deployed policy: future dates inside the current Monday-start timesheet week are allowed
  as planned time with an explicit warning and confirmation; future dates outside the current week
  are blocked.
- `npm run test:dates` and `npm run test:bot` passed locally after the planned-time change.
- Next major step: run live Xero auth, discover real Xero users/projects/tasks, create
  `USER_MAP_JSON`, then switch Azure `XERO_MOCK=false`.

## What this project is
A conversational **timesheet agent**: a team member narrates their work in **Microsoft Teams**
("3 hours on validation for the DM project today") → the agent maps it to the org's **real Xero
projects/tasks** → shows a confirmation card → on approval, writes **Xero Projects time entries**.
Goal: replace manual Xero time entry with quick narration + a Friday confirmation.

## Architecture (decided)
```
Teams ─► Azure Bot Service ─► THIS backend (Node/Express on Azure App Service B1) ─► Xero Projects API
         (channel + auth)        bot.js (M365 Agents SDK)
                                   └── pre-filter: NEEDS_CONFIRMATION card taps (app code, no LLM)
                                 agent.js — SINGLE AGENT, TWO MODELS:
                                  ├── triage:    gpt-4.1-mini — classify: help/off_topic/complex
                                   └── reasoning: gpt-4.1 — tool-calling loop
                                                    tools: get_projects, create_draft, get_week_summary
                                                    guards: run in app code inside tool handlers
                                 grounding.js — LLM + 6 guards (used by /capture REST only)
                                 + conversation/draft stores (Azure Table) + Xero client
```

Key decisions:
- **Chat shell:** Teams personal app via **Azure Bot Service** (free) + a bot handler in this app.
  Copilot Studio was REJECTED (~$200/mo). Bot SDK choice: **M365 Agents SDK**
  (`@microsoft/agents-hosting`) — NOT `botbuilder`, which is in maintenance mode.
- **Hosting:** Azure App Service **B1 plan + Always On**, single instance. NOT Free F1 (idles out;
  cold start exceeds Bot Framework's ~15s reply window). NOT serverless (would kill the in-memory
  Xero cache); NOT a VM (unneeded ops). Keep 1 instance — the shared Xero token row in Table
  Storage can race on concurrent refresh.
- **`POST /api/messages`** is EXEMPT from the `x-api-key` middleware — Bot Service authenticates
  with its own JWT, validated by the adapter. This is already done in server.js.
- **Agent architecture:** Single agent (`src/agent.js`), two models inside:
  - `gpt-4.1-mini`: triage every message cheaply (json_object, max_tokens 20). Returns
    `{ type: 'help' | 'off_topic' | 'complex' }`. Simple help/off-topic messages stop here.
  - `gpt-4.1`: reasoning with full tool-calling loop for complex tasks.
  - **No openai SDK** — raw `fetch()` throughout (same quality: SDK wraps the same HTTP request).
  - **Complexity ≠ intent**: even a REVIEW can be complex ("am I on track?" needs reasoning).
    Triage decides complexity, not keywords.
- **Guards in tool handlers (not in LLM prompt):** Entry-level guards run in app code inside the
  `create_draft` tool handler. LLM cannot bypass them. Guard failures returned as error strings
  → LLM asks user to clarify. Never expose a `submit_to_xero` tool — Xero writes only via
  Adaptive Card button.
- **Date policy:** dates resolve in `DEFAULT_TIMEZONE` (`Australia/Sydney`). Week starts Monday.
  Past/today entries are allowed. Future dates inside the current week are allowed as planned time
  with a soft warning and explicit confirmation. Future dates outside the current week are blocked.
- **Observability:** Application Insights (`applicationinsights` npm package) — NOT Langfuse.

## Load-bearing facts (don't relearn these)
- **No Xero MCP covers the Projects module.** Official + community Xero MCP servers do accounting +
  payroll only. Project time entries MUST use the Xero **Projects REST API** directly.
- **Xero Projects endpoints:** `GET /Projects`, `GET /Projects/{id}/Tasks`, `GET /Projects/Users`,
  `POST /Projects/{id}/Time`. Time payload: `userId`, `taskId`, `dateUtc`, `duration` (**integer
  MINUTES**), optional `description`. Supports an idempotency key.
- **Per-person attribution ≠ per-user OAuth.** ONE org connection (authorised by a **Standard/Adviser**
  Xero user) can log time for anyone by setting `userId`. So: single connection + a static
  `Teams user → { xeroUserId, allowedProjectIds }` map. No per-teammate Xero consent.
- **Xero can't list projects-per-staff** (`GET /Projects` filters only by projectIds/contactID/states).
  So each person's project list is a backend allowlist we maintain.
- **Grounding rule (accuracy):** `get_projects()` tool fetches the person's allowed projects+tasks
  at runtime. LLM grounds itself on this real data, then guards validate the LLM's choice against
  the canonical list. Never invent a project/task; never guess a missing duration — flag for user.
- **Limits:** Xero 60 calls/min, 5,000/day per org → projects/tasks cached ~1h.
- **LLM:** Azure OpenAI (data stays in tenant). Two deployments are used in Azure AI Foundry:
  `gpt-4.1` for reasoning and `gpt-4.1-mini` for triage. Env vars take Azure deployment names,
  not necessarily model display names.

## Repo layout
- `src/server.js` — Express HTTP API: `/api/messages` (Bot Service, JWT-authenticated),
  `/capture`, `/week`, `/entry/:id`, `/submit`, `/projects`, `/health`.
  `/api/messages` already exempt from x-api-key middleware.
- `src/bot.js` — M365 Agents SDK handler. Pre-filter handles NEEDS_CONFIRMATION card taps
  (SUBMIT/CANCEL) in app code. All other messages → agent.js.
  Typed submit/cancel fallbacks remain intentionally for users who reply in text instead of tapping.
- `src/agent.js` — Built two-model agent: triage (`gpt-4.1-mini`) + reasoning with tool calling
  (`gpt-4.1`). Raw fetch(). Entry point: `run(text, history, user)`.
- `src/dateService.js` — business-timezone date helpers, Monday week start, and current-week checks.
- `src/grounding.js` — Single-turn LLM call + 6 guards. Used by `/capture` REST endpoint only.
  NOT the primary AI path for bot conversations (that's agent.js).
- `src/conversationStore.js` — conversation state per conversationId: memory (dev) or Azure Table
  (prod), 30-min idle TTL.
- `src/xero.js` — Xero Projects client (`xero-node`): reads, create time entry, token refresh, cache.
- `src/userMap.js` — per-person map (file, or `USER_MAP_JSON` env).
- `src/draftStore.js` — per-person per-week drafts (async, via store).
- `src/store.js` — persistence: local JSON files (dev) OR Azure Table Storage (when
  `AZURE_STORAGE_CONNECTION_STRING` set). Same code, runtime-selected.
- `src/config.js` — central env config, including `llm.triageDeployment`.
- `src/auth-cli.js` (`npm run auth`) — one-time OAuth consent → saves the org token.
- `src/test-connection.js` (`npm run test:xero`) — verify connection + print project/task/user IDs.
- `xero-connector/openapi.yaml` — Swagger 2.0 → import as Power Platform custom connector (ref only).
- `SETUP-XERO.md` — Xero developer-app + auth walkthrough.
- `README.md` — full run + Azure deploy guide.

## Conventions
- **Secrets only in `.env`** (git-ignored). `.env.example` holds placeholders only — never real values.
  Also git-ignored: `.tokens.json`, `.drafts.json`, `config/userMap.json`.
- Node (CommonJS), `node --check` for syntax, run from repo root so `dotenv` finds `.env`.
- **No openai SDK** — use raw `fetch()` for all LLM calls (consistent with grounding.js; quality is
  identical since the SDK just wraps the same HTTP request).
- Commit each logical change separately; conventional, descriptive messages.

## Branches
- `main` — primary branch.
- Preferred workflow now: feature branch → PR to `main` → tests → merge → deploy.

## Run / verify / test
```
npm install
npm run test:dates   # deterministic date/week policy tests
npm run test:bot     # mock Xero data + real Azure OpenAI bot-path smoke tests
npm run auth         # sign in as Standard/Adviser Xero user (one-time)
npm run test:xero    # confirm scopes + get IDs
npm run test:llm     # verify LLM config (Azure OpenAI) end to end
npm start            # backend on :3000   (set XERO_MOCK=true for full pipeline without live Xero)
```
Local bot testing: run the server locally, connect the
**Teams App Test Tool / Agents Playground** (or Bot Framework Emulator) to
`http://localhost:3000/api/messages` — no Azure resources needed. Full plan: TODO.md Phase 3.7.

## Status (as of 2026-06-29)
- Backend code path is built and deployed to Azure App Service.
- Azure Bot Web Chat works against `/api/messages`.
- Blank Web Chat message loops are guarded in `src/bot.js`.
- Business timezone date handling is implemented in `src/dateService.js`.
- Planned future time inside the current week is implemented and deployed.
- Azure remains in mock Xero mode until live Xero auth/access is available.
- Next: live Xero auth, `npm run test:xero`, real `USER_MAP_JSON`, switch `XERO_MOCK=false`.
