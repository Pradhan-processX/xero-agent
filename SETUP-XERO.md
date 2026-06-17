# Xero Developer App — setup & connection

Everything needed to create the Xero app, authorise the **single org connection**, and verify it
can read projects/tasks and write time entries for the Teams timesheet agent.

## 1. Create the app (developer.xero.com)
1. Sign in at https://developer.xero.com/ → **My Apps → New app**.
2. **App name:** `ProcessX Timesheet Agent` (anything).
3. **Integration type:** **Web app**.
4. **Company / application URL:** your site (e.g. `https://process-x.com.au`).
5. **Redirect URI** — add **both**:
   - `http://localhost:3000/auth/callback`  (local testing)
   - `https://<your-app>.azurewebsites.net/auth/callback`  (after Azure deploy)
6. Create → open the app → **Configuration**:
   - Copy **Client id** → `.env` `XERO_CLIENT_ID`
   - **Generate a secret** → copy → `.env` `XERO_CLIENT_SECRET`

## 2. Scopes
This app requests (already set in `src/config.js`):
```
openid profile email projects projects.read offline_access
```
- `projects` = read + write project time entries (the create call needs this).
- `offline_access` = refresh tokens so the backend can write unattended (e.g. Friday batch).

## 3. Who authorises matters (per-person attribution)
The Projects API acts on behalf of the **authorising** user. To log time for *everyone* from one
connection, the person who runs the consent in step 4 must be a **Standard or Adviser** user in the
Xero org (a "Limited" user can only log their own time). This is what lets us set `userId` per
person without each teammate connecting.

## 4. Authorise the connection (one-time)
```powershell
copy .env.example .env      # fill XERO_CLIENT_ID / XERO_CLIENT_SECRET (+ OPENAI_API_KEY, API_KEY)
npm install
npm run auth
```
- Open the printed URL, sign in **as a Standard/Adviser user**, pick the org, approve.
- Token is saved to `.tokens.json` locally — or to **Azure Table Storage** if
  `AZURE_STORAGE_CONNECTION_STRING` is set (do this so the deployed app shares the same token).

## 5. Verify the connection
```powershell
npm run test:xero
```
Expected: it prints your **projects** (the 3 real ones) with their `projectId`, each project's
**tasks**, and the org's **project users** with their `xeroUserId`. If you see those, scopes +
connection are good, and you have the IDs needed for `config/userMap.json`.

## 6. Fill the user map
Copy `config/userMap.example.json` → `config/userMap.json`, then for each person set `email`,
`xeroUserId` (from step 5), and `allowedProjectIds` (the projects they log to).

## Troubleshooting
| Symptom | Fix |
|---|---|
| `unauthorized_client` / redirect mismatch | Redirect URI in the Xero app must EXACTLY match `XERO_REDIRECT_URI`. |
| `npm run auth` opens but callback 404s | Make sure nothing else is on port 3000; the callback path is `/auth/callback`. |
| Connection works but no projects returned | The authorising user may not have Projects access, or the org has no in-progress projects. |
| Can read but can't create time later | The authoriser is a "Limited" user — re-auth as Standard/Adviser. |
| `invalid_grant` after a while | Refresh token expired/unused 60+ days — re-run `npm run auth`. |
