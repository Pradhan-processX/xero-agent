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
  - Plan: Free F1
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
- [ ] Add Application Insights trackEvent() around callLLM() and guards

### 3.2 Build src/conversationStore.js
- [ ] get(conversationId) — load history + state from Azure Table
- [ ] set(conversationId, data) — save history + state
- [ ] clear(conversationId) — wipe after submit or 30min idle
- [ ] Add Langfuse span

### 3.3 Build src/bot.js
- [ ] Wire Bot Framework adapter
- [ ] On each message: load conversation state
- [ ] Route by state: IDLE / CLARIFYING / NEEDS_CONFIRMATION
- [ ] Handle intents: LOG_TIME, REVIEW, SUBMIT, EDIT, DELETE, HELP
- [ ] Build Adaptive Card for draft confirmation (buttons: Submit / Edit / Delete)
- [ ] Save updated conversation state after each turn
- [ ] Add Langfuse trace per conversation turn

### 3.4 Update src/server.js
- [ ] Add `POST /api/messages` endpoint for Bot Framework adapter
- [ ] Keep all existing endpoints untouched

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

- [ ] Monitor Langfuse dashboard — check for hallucination flags daily (first week)
- [ ] Tune `NLU_CONFIDENCE_THRESHOLD` if too many false positives
- [ ] Add new team members to `config/userMap.json` as needed
- [ ] Document how to add new projects to a user's allowlist

---

## Current Status
**Up next: Phase 1.1 — Create Azure App Service**
