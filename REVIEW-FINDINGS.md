# Architecture Review Findings - 2026-06-11

Source: full project review (code + plan docs). Audience: any coding agent or human working in
this repo. Each finding is independently actionable. Keep this file as historical context and
update it when findings are resolved.

Verdict from the review: architecture is sound, direction is right. Azure App Service B1 is the
correct hosting model, not serverless and not a VM.

> Status update 2026-06-17: F2/F3 are now implemented. `src/bot.js` uses the M365 Agents SDK and
> `src/server.js` has `/api/messages` exempt from `x-api-key`, with Bot Service JWT validation when
> credentials are configured. Current project stage is local bot integration testing. F1 still
> applies in Azure Portal: choose B1 + Always On. F7-F9 remain contextual/optional.

## F1 - HIGH - App Service Plan Must Be B1, Not Free F1

- **Where:** Azure Portal deployment step.
- **Problem:** Free F1 has no Always On. The app can unload after idle time; the next Teams message
  can hit a cold start that exceeds the Bot Framework reply window.
- **Fix:** Use App Service **B1** with **Always On enabled**. Keep instance count at 1 for now.

## F2 - HIGH - Use M365 Agents SDK, Not botbuilder - Resolved

- **Where:** `src/bot.js`.
- **Problem:** Bot Framework SDK (`botbuilder`) is in maintenance mode; Microsoft's successor is
  the Microsoft 365 Agents SDK.
- **Fix:** Done. `src/bot.js` uses `@microsoft/agents-hosting`.

## F3 - HIGH - API-Key Middleware Would 401 Bot Service - Resolved

- **Where:** `src/server.js`.
- **Problem:** Azure Bot Service does not send `x-api-key`; it authenticates `/api/messages` with
  its own JWT, validated by the adapter.
- **Fix:** Done. `/api/messages` is exempt from `x-api-key`; Bot Service JWT auth is enabled when
  bot credentials are configured.

## F4 - MEDIUM - AGENTS.md Copilot Studio Drift - Resolved

- **Where:** `AGENTS.md`.
- **Problem:** It used to describe the rejected Copilot Studio path.
- **Fix:** Done. `AGENTS.md` now describes Teams -> Azure Bot Service -> M365 Agents SDK backend.

## F5 - MEDIUM - CLAUDE.md Langfuse Drift - Resolved

- **Where:** `CLAUDE.md`.
- **Problem:** It referenced Langfuse after the decision had moved to Application Insights.
- **Fix:** Done. Observability is Application Insights.

## F6 - MEDIUM - PLAN.md Build-Order Drift - Resolved

- **Where:** `PLAN.md`, `TODO.md`, `CLAUDE.md`, `AGENTS.md`.
- **Problem:** The docs used to say `conversationStore.js`, then `bot.js`, then `/api/messages`
  were still upcoming.
- **Fix:** Done. The current docs now put the project at Phase 3.7: local bot integration testing.

## F7 - LOW - Keep App Service At 1 Instance

- **Where:** `src/store.js` token row, `src/xero.js` token refresh, in-memory project/task caches.
- **Problem:** With 2+ instances, concurrent Xero token refreshes can race on the single shared
  token row.
- **Fix:** Pin instance count to 1. If scaling out ever matters, add optimistic concurrency on the
  token row first.

## F8 - LOW - `store.js` `findById` Is A Full-Table Scan

- **Where:** `src/store.js`.
- **Problem:** Azure Table Storage cannot seek on RowKey alone across partitions. This is fine at
  current scale but would matter at much larger draft counts.
- **Fix:** Optional. Pass `userKey` through to `findById` callers, or embed the user key in IDs.

## F9 - LOW - Graphify Knowledge Graph Is Stale

- **Where:** `graphify-out/`.
- **Fix:** Run `/graphify . --update` if the graph is needed; otherwise ignore it.
