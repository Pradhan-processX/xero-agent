# AGENTS.md — project context for any AI coding tool

Portable working memory for this repo. Read this first. Works with any agent/IDE (Claude Code,
Cursor, GitHub Copilot, etc.). Keep it updated as decisions change. **Never put secrets here.**

## What this project is
A conversational **timesheet agent**: a team member narrates their work in **Microsoft Teams**
("3 hours on validation for the DM project today") → the agent maps it to the org's **real Xero
projects/tasks** → shows a weekly review → on approval, writes **Xero Projects time entries**.
Goal: replace manual Xero time entry with quick narration + a Friday confirmation.

## Architecture (decided)
```
Teams ─► Copilot Studio agent ─► THIS backend (Node) ─► Xero Projects API
        (chat shell, generative      grounding + per-person map +
         orchestration, cards)       draft store + Xero write
```
- **Chat shell:** Microsoft **Copilot Studio**, published to Teams (Microsoft shop; deploy-in-a-day).
  The platform is just the front end — the real logic is this backend, identical regardless of shell.
- **Backend (this repo):** Express tool API the agent calls.

## Load-bearing facts (don't relearn these)
- **No Xero MCP covers the Projects module.** Official + community Xero MCP servers do accounting +
  *payroll* only. Project time entries MUST use the Xero **Projects REST API** directly.
- **Xero Projects endpoints:** `GET /Projects`, `GET /Projects/{id}/Tasks`, `GET /Projects/Users`,
  `POST /Projects/{id}/Time`. Time payload: `userId`, `taskId`, `dateUtc`, `duration` (**integer
  MINUTES**), optional `description`. Supports an idempotency key.
- **Per-person attribution ≠ per-user OAuth.** ONE org connection (authorised by a **Standard/Adviser**
  Xero user) can log time for anyone by setting `userId`. So: single connection + a static
  `Teams user → { xeroUserId, allowedProjectIds }` map. No per-teammate Xero consent.
- **Xero can't list projects-per-staff** (`GET /Projects` filters only by projectIds/contactID/states).
  So each person's project list is a backend allowlist we maintain.
- **Grounding rule (accuracy):** fetch the person's allowed projects+tasks, pass as context to the
  LLM, then **validate** the LLM's choice against that canonical list. Never invent a project/task,
  never guess a missing duration — flag it for the user instead.
- **Limits:** Xero 60 calls/min, 5,000/day per org → projects/tasks cached ~1h.
- **LLM:** used for inference only (NOT training/fine-tuning on Xero data). Prefer **Azure OpenAI**
  (data stays in tenant) or OpenAI API (no training by default).

## Repo layout
- `src/server.js` — tool API: `/capture`, `/week`, `/entry/:id`, `/submit`, `/projects`, `/health`.
- `src/grounding.js` — LLM map + validation against the allowed list.
- `src/xero.js` — Xero Projects client (`xero-node`): reads, create time entry, token refresh, cache.
- `src/userMap.js` — per-person map (file, or `USER_MAP_JSON` env).
- `src/draftStore.js` — per-person per-week drafts (async, via store).
- `src/store.js` — persistence: local JSON files (dev) OR Azure Table Storage (when
  `AZURE_STORAGE_CONNECTION_STRING` set). Same code, runtime-selected.
- `src/auth-cli.js` (`npm run auth`) — one-time OAuth consent → saves the org token.
- `src/test-connection.js` (`npm run test:xero`) — verify connection + print project/task/user IDs.
- `xero-connector/openapi.yaml` — Swagger 2.0 → import as Power Platform custom connector.
- `SETUP-XERO.md` — Xero developer-app + auth walkthrough.
- `README.md` — full run + Azure deploy guide.

## Conventions
- **Secrets only in `.env`** (git-ignored). `.env.example` holds placeholders only — never real values.
  Also git-ignored: `.tokens.json`, `.drafts.json`, `config/userMap.json`.
- Node (CommonJS), `node --check` for syntax, run from repo root so `dotenv` finds `.env`.
- Commit each logical change separately; conventional, descriptive messages.

## Branches
- `main` — code.
- `xero-app` — Xero developer-app setup work (docs + connection test).

## Run / verify
```
npm install
npm run auth         # sign in as Standard/Adviser Xero user
npm run test:xero    # confirm scopes + get IDs
npm start            # backend on :3000
```

## Status (as of 2026-06-03)
- ✅ Backend built + tested (grounding, draft store, both storage backends, server boot).
- ✅ Git: GitHub `Pradhan-processX/xero-agent`, branches `main` + `xero-app`.
- 🔜 In progress: create Xero app + authorise connection (Task 1).
- 🔜 Next build: Copilot Studio agent instructions + adaptive review card; Phase 2 Friday review;
  Phase 3 calendar auto-capture (Microsoft Graph).
- Tasks needing portal/credentials (human): Xero app, LLM key, Azure (storage + web app),
  Power Platform connector import, Copilot Studio agent, Teams publish, per-teammate map rows.
