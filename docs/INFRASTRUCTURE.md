# Infrastructure Documentation — Xero Timesheet Agent

Last updated: 2026-06-23

---

## 1. Architecture Overview

Team members send natural-language messages in Microsoft Teams. Azure Bot Service receives the message and forwards it over HTTPS to the Express app running on Azure App Service. The app identifies the user via their Teams AAD object ID, resolves their allowed Xero projects from a static user map, and passes the message to a two-model Azure OpenAI agent. The agent classifies the message, optionally calls tools (project lookup, draft creation, week summary), and returns either a text reply or a set of draft time entries. Draft entries are shown to the user on an Adaptive Card in Teams. When the user taps Submit, the app writes the confirmed entries directly to the Xero Projects API using the `xero-node` SDK. All steps are logged to Azure Application Insights.

---

## 2. Component Decisions

### Azure App Service B1 — not Free F1, not Azure Functions, not a VM

**Chosen:** App Service B1 with Always On enabled, single instance, Australia East region (`xero-agent-api`).

- **Not Free F1:** F1 has no Always On. The app idles out after inactivity. The next Teams message hits a cold start that can exceed the Azure Bot Service reply timeout (~15 seconds), causing the bot to appear broken. B1 costs ~AUD$25-30/month and keeps the process always running.
- **Not Azure Functions:** Functions are serverless and restart on every invocation. This app holds two in-memory caches (`_projectsCache` and `_tasksCache` in `xero.js`) that avoid redundant Xero API calls across users. Cold-starting a Function on every message would also risk exceeding the bot reply timeout. Functions also complicate the single shared Xero token row — concurrent invocations can race on token refresh.
- **Not a VM:** A VM requires OS patching, manual Node.js installation, and ongoing ops overhead. App Service is PaaS — Microsoft manages the host.
- **Single instance:** The Xero refresh token is stored as a single row in Azure Table Storage (partition `xero`, row `org`). Multiple App Service instances could race to refresh this token simultaneously, each writing a different new token set back, causing the others to use a stale refresh token and break the Xero connection. One instance avoids this entirely. See REVIEW-FINDINGS.md F7.

### Azure Bot Service F0 — free tier

**Chosen:** Azure Bot Service F0 (free), connected to Microsoft Teams.

Teams is classified as a Standard Channel by Azure Bot Service. Standard Channels have no message limit and no per-message cost. The F0 tier is free for Standard Channels. The S1 paid tier is only relevant for Premium Channels (Alexa, Direct Line Speech, etc.), which this app does not use. For a 10-person team the cost is permanently $0.

### Azure Table Storage — not Cosmos DB, not SQL

**Chosen:** Azure Table Storage (`xeroagentstorage`, Australia East), LRS redundancy, three tables: `xerotokens`, `drafts`, `conversations`.

- **Not Cosmos DB:** Cosmos DB is significantly more expensive and designed for global distribution and complex query patterns. This app stores three simple key-value structures: one token row, draft entries keyed by user, and conversation state keyed by conversation ID. Table Storage handles all of this for ~AUD$1-2/month.
- **Not SQL:** SQL requires schema migrations and a managed server. The data model here is schemaless JSON blobs — Table Storage is a natural fit.
- **LRS redundancy:** The app is internal and non-critical. Geo-redundant storage (GRS) is not worth the cost for draft timesheet entries that can be re-entered if there is a regional failure.

### M365 Agents SDK — not Bot Framework SDK (botbuilder)

**Chosen:** `@microsoft/agents-hosting` (M365 Agents SDK).

Bot Framework SDK (`botbuilder`) is in maintenance mode. Microsoft's actively developed successor is the Microsoft 365 Agents SDK, which uses the same activity/adapter model and Adaptive Cards API but will receive future feature development and security updates. `bot.js` uses `AgentApplication`, `MessageFactory`, `CardFactory`, `CloudAdapter`, `loadAuthConfigFromEnv`, and `authorizeJWT` — all from `@microsoft/agents-hosting`. See REVIEW-FINDINGS.md F2.

### No Copilot Studio

Copilot Studio licensing costs approximately AUD$200/month for a small number of users plus per-message charges. For a 10-person internal tool that only logs time to Xero, this cost is not justified. The same functionality is implemented directly in the Express app with the M365 Agents SDK at no additional per-message cost.

### No MCP for Xero

MCP (Model Context Protocol) is a standardised protocol for exposing tools to LLM hosts. There is no published MCP server for the Xero Projects API. More importantly, even if one were built, the four entry-level guards (project allowlist, task validity, duration check, date check) must run in application code to be trustworthy — they cannot be delegated to an LLM-adjacent process. The tool-calling loop in `agent.js` (10-iteration max, raw fetch to Azure OpenAI) provides the same capability with full control over guard execution, at the cost of ~30 lines of loop code.

### No LangGraph / CrewAI

These orchestration frameworks are designed for multi-agent pipelines with complex state machines, branching, and inter-agent communication. This application has one agent with two models and three tools. LangGraph or CrewAI would add a significant dependency and abstraction layer with no benefit. The reasoning loop in `agent.js:reasoningAgent()` is 60 lines and straightforward to read and modify.

### No per-user OAuth

Per-user OAuth would require each team member to individually connect their Xero account, manage their own refresh tokens, and re-authenticate periodically. For an internal tool where all users belong to the same Xero organisation, this complexity is unnecessary. A single org-level OAuth connection is established once via `npm run auth`. Per-person attribution in Xero is handled by passing each user's `xeroUserId` (from `userMap.json`) as the `userId` field in every `POST /projects/{projectId}/time` call.

### Azure OpenAI — not OpenAI (public API)

**Chosen:** Azure OpenAI (deployments in the process-x.com.au Azure AI Foundry subscription).

- Data stays within the Azure tenant — message content does not leave the organisation's cloud environment.
- Azure OpenAI is already provisioned in the subscription. No new vendor relationship or billing account is required.
- Azure AI Foundry provides the deployment management, quota controls, and usage monitoring already in use for other workloads.

### Azure Monitor / Application Insights — not Langfuse

Langfuse is a third-party LLM observability tool requiring a separate account and data egress to an external service. Application Insights is already available in the Azure subscription, charges nothing under 5GB/month ingestion, and is where other Azure infrastructure metrics are monitored. The `telemetry.js` module wraps Application Insights with a `track()` function that silently no-ops when the connection string is absent (local dev), and emits structured custom events in production.

### Raw fetch() — not OpenAI SDK or Anthropic SDK

`agent.js` calls Azure OpenAI using Node.js built-in `fetch()` directly. This means:
- No SDK dependency to update or audit
- Full control over the request body — tools, response_format, temperature, max_tokens
- No abstraction layer between the app and the API response shape
- The Azure OpenAI endpoint URL and API version are explicit in the code, not hidden inside an SDK

The tradeoff is that tool-call loop logic (appending messages, pushing tool results) is written manually (~60 lines). This is acceptable given the loop is simple and stable.

---

## 3. Two-Model Design

Every user message passes through two model calls.

### Model 1 — Triage (`gpt-4.1-mini`, `AZURE_TRIAGE_DEPLOYMENT`)

A single, cheap call that classifies the message into one of four types:

| Type | Action |
|---|---|
| `help` | Return static help text. No further LLM call. |
| `off_topic` | Return rejection message. No further LLM call. |
| `review` | Fetch week summary from draft store. Return it directly. No reasoning model call. |
| `complex` | Pass to reasoning model. |

Cost rationale: most "show my week" and "help" messages never need the expensive model. Triage failure is non-fatal — the app defaults to `complex` and routes to the reasoning model.

### Model 2 — Reasoning (`gpt-4.1`, `AZURE_OPENAI_DEPLOYMENT`)

Called only for complex messages. Runs a tool-calling loop (maximum 10 iterations):

1. LLM receives conversation history + system prompt + user message + tool definitions
2. LLM responds with a tool call (e.g. `get_projects`) or a plain text reply
3. If tool call: app executes the tool, appends the result to messages, repeats from step 2
4. If plain text: loop ends, result returned to `bot.js`

Three tools are available:
- `get_projects` — fetches the user's allowed projects and tasks from the Xero cache
- `create_draft` — runs all four guards, creates a draft entry if they pass
- `get_week_summary` — reads the draft store and returns a formatted week summary

The LLM is instructed never to call `create_draft` without an explicit duration from the user. If no duration is stated, it must ask before calling the tool.

---

## 4. Data Flow

1. Team member sends a message in the Teams bot chat.
2. Teams routes the message to Azure Bot Service.
3. Azure Bot Service forwards it as an Activity to `POST /api/messages` on the App Service.
4. `server.js` validates the Bot Service JWT (when credentials are configured).
5. `bot.js` extracts the Teams AAD object ID from `context.activity.from.aadObjectId`.
6. `userMap.resolveUser(identity)` looks up the user in `userMap.json` — returns their `xeroUserId` and `allowedProjectIds`, or rejects if not found.
7. `conversationStore.get(conversationId)` loads conversation state (history, state machine state, pending entries).
8. If state is `NEEDS_CONFIRMATION` and the message is a Submit/Cancel intent, the bot handles it directly without calling the agent:
   - Submit: calls `xero.createTimeEntry()` for each submittable entry, marks drafts submitted, clears conversation state.
   - Cancel: clears conversation state, sends confirmation.
9. Otherwise, `agent.run(text, history, user, operationId)` is called.
10. Triage model classifies the message.
11. If `complex`, reasoning model runs the tool-calling loop (get_projects, create_draft, get_week_summary as needed).
12. If the result is draft entries (`type: 'card'`): `draftStore.addEntries()` persists them, `conversationStore.set()` saves state as `NEEDS_CONFIRMATION`, Adaptive Card is sent to Teams.
13. If the result is a text reply: conversation state saved as `IDLE`, message sent to Teams.
14. Every step is logged to Application Insights via `telemetry.track()`.

---

## 5. Infrastructure Status

| Resource | Status | Notes |
|---|---|---|
| App Service plan (`ASP-ProcessXAUAEXARG01-a991`, B1) | Created | Australia East, Always On enabled |
| App Service (`xero-agent-api`) | Created | Australia East, Node 20 |
| Storage account (`xeroagentstorage`) | Created | Australia East, LRS, Tables: conversations, drafts |
| Application Insights (`xero-agent-insights`) | Created | Australia East, workspace-based |
| Azure Bot Service | Pending | Blocked on `Microsoft.BotService` resource provider registration on the Microsoft Partner Network subscription — requires admin action |
| App Service env vars | Partially set | `APPLICATIONINSIGHTS_CONNECTION_STRING`, `AZURE_STORAGE_CONNECTION_STRING` set; Xero, Azure OpenAI, and Bot Service vars still need to be added |
| Code deployment | Not done | ZIP deploy via Kudu pending |
| Teams app manifest | Not created | After Bot Service is available |

---

## 6. Cost Estimate (10-person team)

| Resource | Cost | Notes |
|---|---|---|
| App Service B1 | ~AUD $25-30/month | Fixed, Always On |
| Azure Bot Service F0 | $0 | Teams = Standard Channel, free |
| Azure Table Storage | ~AUD $1-2/month | ~10-person team, minimal data |
| Application Insights | $0 | Under 5GB/month ingestion (free tier) |
| Azure OpenAI (gpt-4.1-mini triage) | ~AUD $2-5/month | ~50 triage calls/day, cheap model |
| Azure OpenAI (gpt-4.1 reasoning) | ~AUD $5-15/month | Fewer calls, more tokens per call |
| **Total** | **~AUD $33-52/month** | Usage-based LLM cost varies |

---

## 7. Scaling Constraints

**Keep App Service at 1 instance.**

The Xero OAuth token is stored as a single row in Azure Table Storage. If two App Service instances run concurrently and both detect an expired access token, both will attempt to refresh using the same refresh token. Xero refresh tokens are single-use — whichever instance refreshes second will attempt to use an already-consumed refresh token and receive a 401, breaking the Xero connection for all users until someone re-runs `npm run auth`.

If horizontal scaling becomes necessary in the future, add optimistic concurrency control to the token row (check `_ts` or an ETag before writing) before increasing instance count. See REVIEW-FINDINGS.md F7.

**Bot reply timeout is ~15 seconds.**

Azure Bot Service drops the connection if the app does not reply within approximately 15 seconds. Always On on the B1 plan prevents cold starts. Keep the triage model fast (`gpt-4.1-mini`) and avoid blocking operations on the hot path.

---

## 8. Build Order (Remaining Steps)

### Now (unblocked)

1. Add remaining env vars to App Service: Xero credentials, Azure OpenAI credentials, `API_KEY`, `AZURE_OPENAI_API_VERSION`, `SCM_DO_BUILD_DURING_DEPLOYMENT=true`
2. ZIP deploy code to App Service via Kudu (`Advanced Tools > Zip Push Deploy`)
3. Verify `/health` endpoint returns `{"ok":true}` at `https://xero-agent-api.azurewebsites.net/health`
4. Test with Teams App Test Tool or Bot Framework Emulator pointed at `https://xero-agent-api.azurewebsites.net/api/messages`

### When admin registers Microsoft.BotService provider

5. Create Azure Bot Service resource in `ProcessX-AUAE-XA-RG-01` (F0, Single Tenant, new App ID)
6. Set messaging endpoint to `https://xero-agent-api.azurewebsites.net/api/messages`
7. Copy `MicrosoftAppId` and generated client secret into App Service env vars (`clientId`, `clientSecret`, `tenantId`)
8. Update Xero OAuth redirect URI in Xero Developer Portal to `https://xero-agent-api.azurewebsites.net/auth/callback`
9. Re-run `npm run auth` against the deployed URL (or set `XERO_TOKEN_FILE` to point to Azure Table)

### After Bot Service

10. End-to-end test in real Teams via Developer Portal personal install
11. Exercise all guard paths: missing duration, future date, project outside allowlist, unknown task, >16h soft warning, unmapped user
12. Create Teams app manifest, submit for admin approval
13. Staged rollout: owner -> 2-3 team members -> full team
