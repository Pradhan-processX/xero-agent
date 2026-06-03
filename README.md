# Xero Timesheet Agent

Narrate your work in Microsoft Teams → the agent grounds it against your **real Xero projects and
tasks** → you confirm a weekly review → it writes time entries into **Xero Projects**.

This repo is the **codeable core** (the "thin backend" + the Xero custom-connector spec). The chat
front end is a **Copilot Studio** agent published to Teams; the portal steps are below.

```
Teams ─► Copilot Studio agent ─► THIS backend ─► Xero Projects API
                                   (grounding + per-person map + draft store + write)
```

See the full design in `../.claude/plans/just-thinking-can-we-warm-petal.md`.

---

## What's here

| File | Role |
|------|------|
| `src/server.js` | HTTP tools the agent/connector call: `/capture`, `/week`, `/entry/:id`, `/submit`, `/projects` |
| `src/grounding.js` | LLM maps narration → project/task/duration **validated against the person's allowed list** |
| `src/xero.js` | Xero Projects client (`xero-node`): list projects/tasks/users, create time entry, token refresh, caching |
| `src/userMap.js` | `Teams user → { xeroUserId, allowedProjectIds }` (the per-person project allowlist) |
| `src/draftStore.js` | Per-person per-week drafts (Phase 1: JSON file) |
| `src/auth-cli.js` | One-time OAuth consent to create the single org connection |
| `src/list-users.js` | Prints Xero project users + projects so you can fill `userMap.json` |
| `xero-connector/openapi.yaml` | Swagger 2.0 → import as a Power Platform custom connector |

---

## Phase 1 — get a sentence into Xero (run locally)

### 1. Xero app (portal)
- developer.xero.com → **New app** → Web app.
- Redirect URI: `http://localhost:3000/auth/callback`.
- Note the **Client ID** and **Client Secret**.
- The app requests scopes: `openid profile email projects projects.read offline_access`.

### 2. Configure + install
```powershell
copy .env.example .env      # fill in XERO_CLIENT_ID/SECRET, OPENAI_API_KEY, API_KEY
npm install
```

### 3. Authorise the org connection (portal + terminal)
```powershell
npm run auth
```
Open the printed URL and **sign in as a Standard or Adviser user** — this lets the one connection
log time for *everyone* via the `userId` field. Tokens are saved to `.tokens.json`.

### 4. Build your per-person map
```powershell
node src/list-users.js                 # prints xeroUserIds + projectIds
copy config\userMap.example.json config\userMap.json
```
Edit `config/userMap.json`: set your `email`, `xeroUserId`, and `allowedProjectIds` (the projects
you log to). Add a row per person later.

### 5. Run + smoke-test the backend
```powershell
npm start
```
```powershell
# capture (use your real email + a project/task you actually have):
curl -s -X POST http://localhost:3000/capture -H "x-api-key: <API_KEY>" -H "content-type: application/json" ^
  -d "{\"identity\":\"you@process-x.com.au\",\"text\":\"3 hours on validation for the DM project today\"}"
# review the week:
curl -s "http://localhost:3000/week?identity=you@process-x.com.au" -H "x-api-key: <API_KEY>"
# write to Xero:
curl -s -X POST http://localhost:3000/submit -H "x-api-key: <API_KEY>" -H "content-type: application/json" ^
  -d "{\"identity\":\"you@process-x.com.au\"}"
```
Then confirm the entry appears in Xero → Projects under the right project/task/person.

### 6. Copilot Studio agent (portal)
- Expose this backend publicly (deploy to Azure App Service, or `ngrok http 3000` for dev) and set
  `host`/`schemes` in `xero-connector/openapi.yaml` accordingly.
- Power Platform → **Custom connectors → Import an OpenAPI file** → `openapi.yaml`; set the API key.
- Copilot Studio → new agent → **turn on generative orchestration** → **Add tool** → your custom
  connector (CaptureNarration / GetWeek / UpdateEntry / SubmitWeek).
- Agent instructions: on a work description call `CaptureNarration`; show the returned entries and
  ask the user to confirm or fix anything flagged `needsConfirmation`; on "looks good" call
  `SubmitWeek`.

### 7. Publish to Teams (portal)
- Copilot Studio → **Channels → Teams + Microsoft 365** → publish. Narrate from a Teams chat.

---

## Deploy for the team (Azure) — required for teammates

localhost only works for *your* testing. For teammates, the backend must run at a public HTTPS URL
that Copilot Studio (Microsoft cloud) can reach, and the local JSON stores must move to shared
storage. **Teammates do NOT each connect to Xero** — the single org connection + their row in the
user map is all that's needed.

### A. Shared storage (so drafts/tokens aren't stuck on one machine)
```powershell
az group create -n rg-timesheet -l australiaeast
az storage account create -n sttimesheet<unique> -g rg-timesheet -l australiaeast --sku Standard_LRS
az storage account show-connection-string -n sttimesheet<unique> -g rg-timesheet --query connectionString -o tsv
```
Put that connection string in `AZURE_STORAGE_CONNECTION_STRING`. The backend then uses **Azure
Table Storage** for tokens + drafts automatically (the `tokens`/`drafts` tables are auto-created).
`GET /health` reports `"storage":"azure-table"` when it's active.

### B. Host the backend
```powershell
# from the project folder:
az webapp up -n timesheet-agent-<unique> -g rg-timesheet --runtime "NODE:20-lts" --sku B1
```
Then set the app settings (env vars) on the Web App:
```powershell
az webapp config appsettings set -g rg-timesheet -n timesheet-agent-<unique> --settings ^
  XERO_CLIENT_ID=... XERO_CLIENT_SECRET=... ^
  XERO_REDIRECT_URI=https://timesheet-agent-<unique>.azurewebsites.net/auth/callback ^
  OPENAI_API_KEY=... API_KEY=<long-random> ^
  AZURE_STORAGE_CONNECTION_STRING="<from step A>" ^
  USER_MAP_JSON="{\"users\":[...]}"
```
Add the same `https://.../auth/callback` URL as a redirect URI on the Xero app.

### C. Authorise once (writes the shared token)
Run `npm run auth` **with `AZURE_STORAGE_CONNECTION_STRING` set** (locally is fine) so the org token
lands in Table Storage where the deployed app reads it. One-time, by a Standard/Adviser user.

### D. Point the connector at the deployed URL
In `xero-connector/openapi.yaml` set `host: timesheet-agent-<unique>.azurewebsites.net`, re-import
the custom connector, and Copilot Studio now calls the cloud backend for everyone.

> Quick demo alternative (not production): `ngrok http 3000` gives a temporary public URL for the
> local backend — fine to show the round trip, but the URL changes and your laptop must stay on.

---

## Phase 2 / 3 (next)
- **Friday review card** + scheduled proactive send; batch `SubmitWeek`. Validate Copilot Studio can
  render an *editable* card; if not, use a Bot Framework card (mine `adaptiveCards.js` from the
  reference zip).
- **Calendar auto-capture** via Microsoft Graph `Calendars.Read` to pre-fill meeting durations.

## Notes
- No connection string set → tokens/drafts use local JSON (dev). Set `AZURE_STORAGE_CONNECTION_STRING`
  → shared Azure Table Storage (team/production). Same code, picked at runtime.
- Xero limits: 60 calls/min, 5,000/day per org; projects/tasks are cached ~1h.
- `/submit` uses each draft's id as the **idempotency key**, so re-submitting won't double-post.
