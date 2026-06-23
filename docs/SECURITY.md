# Security Documentation — Xero Timesheet Agent

Last updated: 2026-06-23

---

## 1. Threat Model

### Actors

| Actor | Trust level | Risk |
|---|---|---|
| Team member (mapped in userMap) | Trusted, authenticated via Teams AAD | Can only log time against their allowed projects |
| Team member (not in userMap) | Untrusted | Bot refuses all requests immediately |
| External attacker (internet) | Untrusted | Cannot reach /api/messages without a valid Bot Service JWT |
| Compromised Teams account | Low-trust | Damage limited to that user's allowed projects only |
| LLM (Azure OpenAI) | Untrusted for writes | Cannot write to Xero; all writes require explicit user confirmation |

### What could go wrong

- **Someone logs time to a project they shouldn't access** — blocked by the per-user allowlist in `userMap.json` (Guard 1 in `agent.js`)
- **LLM hallucinates a Xero write** — impossible by design; LLM only proposes drafts, app code performs all writes after user confirmation
- **External party POSTs to /api/messages** — blocked by Bot Service JWT validation in `server.js` when `MICROSOFT_APP_ID` is configured
- **External party POSTs to /capture or /submit** — blocked by `x-api-key` middleware in `server.js`
- **Refresh token stolen** — attacker gains access to Xero Projects API for the single org; mitigated by storing tokens in Azure Table Storage (not in code or git), TLS in transit, and access key auth on the storage account
- **User submits a draft twice** — prevented by idempotency key in `xero.createTimeEntry()` (draft `id` is passed as the idempotency key; Xero deduplicates on it)
- **LLM injection via message text** — the system prompt does not expose internal IDs or credentials; `xeroUserId` is never passed to the LLM and never read from LLM output

---

## 2. Authentication and Authorisation Layers

### Layer 1 — Bot Service JWT (`/api/messages`)

`server.js` conditionally applies `authorizeJWT(authConfig)` from `@microsoft/agents-hosting`:

```js
if (config.bot.clientId) {
  app.use('/api/messages', authorizeJWT(authConfig));
}
```

When `MICROSOFT_APP_ID` (read as `clientId` via `loadAuthConfigFromEnv()`) is set, every POST to `/api/messages` must carry a valid Azure Bot Service JWT. Without it the request is rejected before the bot handler runs. In local dev where `clientId` is unset, validation is skipped so the Teams App Test Tool and Bot Framework Emulator can connect without credentials.

### Layer 2 — x-api-key middleware (all other routes)

`server.js` applies an API key check to every route except `/health` and `/api/messages`:

```js
if (req.path === '/health' || req.path === '/api/messages') return next();
if (!config.server.apiKey) return next(); // unset = open in local dev
if (req.get('x-api-key') !== config.server.apiKey) return res.status(401).json({ error: 'unauthorized' });
```

Routes protected: `/capture`, `/submit`, `/projects`, `/week`, `/entry/:id`.

The `API_KEY` env var must be set in App Service for production. If unset the middleware passes all requests — intentionally open only for local dev.

### Layer 3 — Per-user allowlist (userMap)

After authentication, `userMap.resolveUser(identity)` is called on every bot turn (`bot.js`) and every REST request (`server.js`). If the Teams AAD object ID is not in `userMap.json` (or `USER_MAP_JSON` env var), the request is rejected with a "not recognised" message. No LLM call is made for unmapped users.

### Route exemptions summary

| Route | Auth method | Reason for exemption |
|---|---|---|
| `/api/messages` | Bot Service JWT | Bot Service does not send x-api-key; it uses its own signed JWT |
| `/health` | None | Public liveness probe for App Service health checks and load balancer |
| All others | x-api-key header | Called by internal tooling or Power Platform connector |

---

## 3. Xero OAuth Scopes

Scopes configured in `config.js` and requested during `npm run auth`:

```
openid profile email projects projects.read offline_access
```

| Scope | Purpose |
|---|---|
| `openid profile email` | Identity — used to identify the authenticated Xero user during the OAuth flow |
| `projects` | Read and write to Xero Projects API — required to create time entries |
| `projects.read` | Read projects and tasks — required for `getProjects()` and `getTasks()` |
| `offline_access` | Enables refresh tokens so the app can operate unattended without re-authentication |

### What is explicitly NOT granted

- `accounting.*` — no access to invoices, bills, bank transactions, payroll, or any financial data
- `assets.*` — no access to fixed assets
- `files.*` — no access to Xero Files
- `payroll.*` — no access to payroll

The app cannot read or modify any financial data even if it wanted to. The scope boundary is enforced by Xero's OAuth server at token issuance time.

### Why offline_access is required

The bot runs unattended on Azure App Service. Users send messages at any time. The app must be able to call the Xero API without prompting anyone to re-authenticate. `offline_access` grants a refresh token that `xero.js` uses to silently obtain new access tokens when the current one expires (60-minute lifetime). Without this scope, the connection would expire and all Xero calls would fail until someone manually re-ran `npm run auth`.

---

## 4. Per-User Allowlist

### How it works

`config/userMap.json` (or the `USER_MAP_JSON` env var in App Service) maps each team member's Teams identity to:
- Their `xeroUserId` — used as the `userId` field in every time entry
- Their `allowedProjectIds` — the list of Xero project IDs they are permitted to log against

`userMap.js` resolves a user by matching their Teams AAD object ID (`aadObjectId`), email, or UPN case-insensitively. The resolved user object is passed to `agent.js`, which passes only the allowed projects to the LLM via `handleGetProjects()`.

The LLM only ever sees projects on the user's allowlist. Even if a user types "log 3h to the Finance project" and Finance is not in their allowlist, the LLM will report back that the project was not found — because it was never presented to the LLM in the first place.

### xeroUserId is never LLM-sourced

This is a non-negotiable governance rule. In `bot.js` and `server.js`, `user.xeroUserId` comes exclusively from the resolved `userMap` entry and is passed directly to `xero.createTimeEntry()`. The LLM output is never inspected for a userId. A prompt injection attack asking the LLM to "use userId X" has no effect.

---

## 5. LLM Governance Rules

These rules are enforced in application code, not by prompting the LLM to behave correctly.

1. **LLM never writes to Xero.** The LLM calls the `create_draft` tool, which returns a draft entry stored locally. `xero.createTimeEntry()` is only called by `bot.js` after the user taps Submit on the Adaptive Card, or by `server.js` on `POST /submit`.

2. **User confirmation is mandatory before any Xero write.** When the agent produces draft entries, `bot.js` sends an Adaptive Card with Submit and Cancel buttons. No write happens until the user explicitly taps Submit (or types "yes"/"submit"/"confirm"). The `NEEDS_CONFIRMATION` conversation state enforces this — the bot will not proceed to write without clearing this gate.

3. **All entry-level guards run in app code.** The four guards in `agent.js:handleCreateDraft()` are pure JavaScript — they do not rely on the LLM to enforce them. The LLM is told about guard failures via tool result messages and must ask the user for corrections.

4. **Conversation history is hashed before telemetry.** `telemetry.js` hashes `userId` and `conversationId` with SHA-256 before sending to Application Insights, so raw PII is never stored in telemetry events.

---

## 6. The Four Guards (Plus Soft Warning)

All guards execute in `agent.js:handleCreateDraft()` before a draft entry is accepted.

| Guard | Check | Failure behaviour |
|---|---|---|
| 1. Project allowlist | Project name must match an entry in the user's `allowedProjectIds` | Hard block — LLM told project not found, asked to clarify |
| 2. Task validity | Task name must exist in the matched project's task list | Hard block — LLM told task not found, lists available tasks |
| 3. Duration present | `durationMinutes` must be a finite positive integer | Hard block — LLM told to ask the user how long they worked |
| 4. Date not future | Resolved date must not be later than today (UTC) | Hard block — LLM told to ask for the correct date |
| Soft warning | Duration > 960 minutes (16 hours) | Entry is created but flagged with `needsConfirmation: true` and a warning shown on the Adaptive Card |

The soft warning allows overnight or travel entries (e.g. 20h international flights) while making them visible to the user before submission.

---

## 7. Token Storage

### Production (Azure Table Storage)

When `AZURE_STORAGE_CONNECTION_STRING` is set, `store.js` uses the `tableBackend`. The Xero refresh token and access token are stored as a JSON blob in the `xerotokens` Azure Table (row key `org`, partition key `xero`). Access to this table requires the storage account connection string, which is stored in App Service environment variables and never committed to git.

### Local dev (file backend)

When no connection string is set, `store.js` uses the `fileBackend`. Tokens are stored in `.tokens.json` in the project root. This file is in `.gitignore` and must never be committed.

### Why tokens are not in env vars

Xero access tokens expire every 60 minutes. `xero.js:ensureToken()` refreshes them automatically and writes the new token set back to the store. If tokens were in env vars, every refresh would require a restart of the app or an App Service configuration update — neither is acceptable for an unattended server. The store backend (file or Azure Table) is the correct place for mutable, short-lived credentials.

---

## 8. Data in Transit

- All communication between App Service and Azure OpenAI is HTTPS (TLS 1.2+).
- All communication between App Service and Azure Table Storage is HTTPS. The storage account was created with "Secure transfer required" enabled and minimum TLS version set to 1.2.
- All communication between Teams and the bot endpoint (`/api/messages`) is HTTPS — Azure Bot Service always uses HTTPS for the messaging endpoint.
- All communication between the app and the Xero API uses the `xero-node` SDK over HTTPS.

---

## 9. What Is NOT in Scope

- **Per-user OAuth** — there is a single Xero org connection shared by all team members. Individual user attribution is handled by the `userId` field in time entry payloads, sourced from `userMap.json`.
- **Multi-tenant Xero** — the app is connected to one Xero organisation. `XERO_TENANT_ID` pins it.
- **Accounting data** — no `accounting.*` scopes are granted. The app cannot read invoices, payroll, or any financial records.
- **Teams message content storage** — message text is not stored. Conversation history (used for LLM context) is held in `conversationStore` with a 30-minute idle TTL and cleared after submit or cancel.

---

## 10. Secrets Management

### What lives in App Service environment variables

| Variable | What it contains |
|---|---|
| `AZURE_OPENAI_KEY` | Azure OpenAI API key |
| `XERO_CLIENT_ID` | Xero OAuth app client ID |
| `XERO_CLIENT_SECRET` | Xero OAuth app client secret |
| `AZURE_STORAGE_CONNECTION_STRING` | Azure Table Storage connection string (includes account key) |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Application Insights instrumentation connection string |
| `API_KEY` | Shared secret for x-api-key protected routes |
| `MICROSOFT_APP_ID` | Bot Service app registration client ID (set after Bot Service is created) |
| `MICROSOFT_APP_PASSWORD` | Bot Service client secret (set after Bot Service is created) |

### What never gets committed to git

- `.env` — local environment file, in `.gitignore`
- `.tokens.json` — Xero OAuth tokens, in `.gitignore`
- `.drafts.json` — local draft store, in `.gitignore`
- `.mock-xero-time.json` — mock mode time log, in `.gitignore`

### What is safe to commit

- `config/userMap.json` — contains team member names, emails, and Xero project IDs. No passwords or secrets. Acceptable to keep in the repo for a small internal team; move to `USER_MAP_JSON` env var if the repo becomes public.
- `.env.example` — template with placeholder values only, no real credentials.
