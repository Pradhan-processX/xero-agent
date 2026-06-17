# Xero Timesheet Agent Observability

This document is the source of truth for monitoring the Xero Timesheet Agent.

Goal: for every bot or REST turn, be able to answer:

- what came in
- what state was loaded
- what the agent decided
- what tools ran
- what drafts were created
- whether Submit or Cancel happened
- whether Xero or mock writes succeeded

The observability policy is **Level 1 + Level 2 telemetry only**: safe metadata plus sanitized
structured inputs/outputs. Do not log raw user narration, full prompts, full model responses,
secrets, Xero tokens, Azure OpenAI keys, or Bot credentials.

## Monitoring Split

**Application Insights / Azure Monitor is the workflow source of truth.**

Use it to inspect the actual app timeline:

```text
Teams -> Azure Bot Service -> server.js -> bot.js -> agent.js -> Xero
```

Application Insights should receive custom events, exceptions, request/dependency timing, and safe
dimensions from the Node app.

**Azure AI Foundry Monitoring is model/deployment observability.**

Use it for:

- model request counts
- token usage
- model latency
- Azure OpenAI failures
- throttling

Foundry Monitoring does not replace app workflow tracing. The custom agent remains self-hosted in
`src/agent.js`; no hosted Azure AI Foundry Agent migration is required.

Planned telemetry flow:

```text
server.js / bot.js / agent.js / xero.js
  -> src/telemetry.js
  -> console fallback locally
  -> Application Insights when APPLICATIONINSIGHTS_CONNECTION_STRING is set
```

## Telemetry Levels

### Level 1: Safe Metadata

Always in scope.

Examples:

- `operationId`
- `source`
- `stage`
- `success`
- `mock`
- `storageBackend`
- `conversationHash`
- `userHash`
- `textHash`
- `textLength`
- `stateBefore`
- `stateAfter`
- `latencyMs`
- counts, booleans, and non-sensitive status values

### Level 2: Sanitized Structured Inputs/Outputs

Always in scope.

Examples:

- triage type
- tool name
- project ID/name
- task ID/name
- duration in minutes
- date
- draft count
- submit/cancel result
- warning/guard category

Level 2 input/output values must be sanitized. They should explain what the stage received and
returned without exposing raw narration, prompts, or secrets.

### Level 3: Raw Text / Prompt Capture

Out of scope by default.

Do not emit:

- raw Teams messages
- full user narration
- full prompt text
- full model response text
- full request/response bodies
- secrets or tokens

If raw capture is ever needed for a short debugging session, it must be added behind an explicit
local-only flag and never enabled in production.

## Per-Turn Timeline

Every bot turn should have one `operationId`. All events from that user turn must include the same
`operationId` so Transaction Search and KQL can show the sequence in order.

Target log-time timeline:

```text
bot.turn.received
bot.state.loaded
agent.triage.started
agent.triage.completed
agent.reasoning.started
agent.reasoning.iteration
agent.tool.called
agent.tool.completed
agent.draft.created
agent.reasoning.completed
draft.entries.added
bot.card.sent
```

Target cancel timeline:

```text
bot.turn.received
bot.state.loaded
bot.confirmation.intent_detected
bot.confirmation.cancelled
conversation.cleared
bot.reply.sent
```

Target submit timeline:

```text
bot.turn.received
bot.state.loaded
bot.confirmation.intent_detected
bot.confirmation.submitted
xero.time_entry.mock_created
draft.entry.submitted
conversation.cleared
bot.reply.sent
```

## Event Model

Standard fields should be reused across events.

| Field | Meaning |
|---|---|
| `operationId` | Correlates all telemetry for one bot turn or REST request. |
| `source` | `bot`, `rest`, `agent`, `xero`, `store`, or `server`. |
| `stage` | Stage name, often matching or complementing the event name. |
| `success` | Boolean success/failure for the event. |
| `mock` | Whether `XERO_MOCK=true`. |
| `storageBackend` | `file`, `memory`, or `azure-table`, where relevant. |
| `conversationHash` | Hash of conversation ID, not the raw ID. |
| `userHash` | Hash of Teams/email identity, not the raw identity. |
| `textHash` | Hash of user text, not the raw text. |
| `textLength` | Character count for the user text. |
| `stateBefore` | Conversation state before the operation. |
| `stateAfter` | Conversation state after the operation. |
| `latencyMs` | Duration for model calls, tools, requests, or dependencies. |

Sanitized input/output conventions:

- `input` and `output` may be JSON strings or flattened dimensions.
- Inputs must not contain raw narration or full prompts.
- Outputs should contain decisions and business facts only.
- Keep values small enough for Application Insights custom dimensions.
- Prefer IDs/counts/statuses over large objects.

## Event Names

### Server / REST

- `server.started`
- `http.request.received`
- `http.request.completed`
- `http.request.failed`
- `rest.capture.received`
- `rest.capture.completed`
- `rest.week.completed`
- `rest.submit.started`
- `rest.submit.completed`
- `rest.projects.completed`
- `rest.entry.updated`
- `rest.entry.deleted`

### Bot

- `bot.turn.received`
- `bot.user.resolved`
- `bot.user.unmapped`
- `bot.state.loaded`
- `bot.confirmation.intent_detected`
- `bot.confirmation.cancelled`
- `bot.confirmation.submitted`
- `bot.card.sent`
- `bot.reply.sent`
- `bot.turn.failed`

### Agent

- `agent.triage.started`
- `agent.triage.completed`
- `agent.triage.failed`
- `agent.reasoning.started`
- `agent.reasoning.iteration`
- `agent.reasoning.completed`
- `agent.reasoning.limit_reached`
- `agent.tool.called`
- `agent.tool.completed`
- `agent.tool.failed`
- `agent.guard.failed`
- `agent.draft.created`

### Store / Xero

- `conversation.cleared`
- `draft.entries.added`
- `draft.entry.submitted`
- `xero.time_entry.mock_created`
- `xero.time_entry.created`
- `xero.time_entry.failed`

## Stage Examples

### Help Turn

```json
{
  "name": "agent.triage.completed",
  "operationId": "op_123",
  "source": "agent",
  "stage": "triage",
  "input": {
    "textLength": 16,
    "textHash": "sha256:..."
  },
  "output": {
    "triageType": "help",
    "modelDeployment": "gpt-4.1-mini"
  },
  "latencyMs": 210,
  "success": true
}
```

### Log-Time Turn

```json
{
  "name": "agent.tool.completed",
  "operationId": "op_456",
  "source": "agent",
  "stage": "tool",
  "input": {
    "toolName": "create_draft",
    "projectName": "ProcessX TranXform Project (DM)",
    "taskName": "Validation",
    "durationMin": 180,
    "date": "2026-06-17"
  },
  "output": {
    "success": true,
    "draftCount": 1,
    "needsConfirmation": false
  },
  "latencyMs": 5
}
```

### Cancel Turn

```json
{
  "name": "bot.confirmation.cancelled",
  "operationId": "op_789",
  "source": "bot",
  "stage": "confirmation",
  "input": {
    "stateBefore": "NEEDS_CONFIRMATION",
    "pendingEntryCount": 1,
    "intentSource": "typed"
  },
  "output": {
    "stateAfter": "IDLE",
    "conversationCleared": true,
    "xeroWriteAttempted": false
  },
  "success": true
}
```

### Submit Turn

```json
{
  "name": "bot.confirmation.submitted",
  "operationId": "op_abc",
  "source": "bot",
  "stage": "confirmation",
  "input": {
    "stateBefore": "NEEDS_CONFIRMATION",
    "pendingEntryCount": 1,
    "submittableEntryCount": 1
  },
  "output": {
    "stateAfter": "IDLE",
    "submittedCount": 1,
    "failedCount": 0,
    "mock": true
  },
  "success": true
}
```

### Guard Failure

```json
{
  "name": "agent.guard.failed",
  "operationId": "op_def",
  "source": "agent",
  "stage": "create_draft",
  "input": {
    "projectName": "ProcessX TranXform Project (DM)",
    "taskName": null,
    "durationMin": null,
    "date": "2026-06-17"
  },
  "output": {
    "guard": "duration_required",
    "needsClarification": true
  },
  "success": false
}
```

### Xero Write Failure

```json
{
  "name": "xero.time_entry.failed",
  "operationId": "op_ghi",
  "source": "xero",
  "stage": "create_time_entry",
  "input": {
    "projectId": "mock-proj-tranxform-dm",
    "taskId": "mock-task-dm-validation",
    "durationMin": 180,
    "date": "2026-06-17"
  },
  "output": {
    "success": false,
    "errorName": "XeroApiError",
    "errorMessage": "safe summarized error"
  },
  "success": false
}
```

## Starter KQL Queries

Latest bot turns:

```kusto
customEvents
| where name == "bot.turn.received"
| order by timestamp desc
| project timestamp,
          operationId = tostring(customDimensions.operationId),
          userHash = tostring(customDimensions.userHash),
          conversationHash = tostring(customDimensions.conversationHash),
          textLength = toint(customDimensions.textLength)
```

Full timeline for one operation:

```kusto
let op = "PUT_OPERATION_ID_HERE";
customEvents
| where tostring(customDimensions.operationId) == op
| order by timestamp asc
| project timestamp,
          name,
          source = tostring(customDimensions.source),
          stage = tostring(customDimensions.stage),
          success = tostring(customDimensions.success),
          input = tostring(customDimensions.input),
          output = tostring(customDimensions.output),
          latencyMs = todouble(customDimensions.latencyMs)
```

Guard failures by type:

```kusto
customEvents
| where name == "agent.guard.failed"
| summarize count() by guard = tostring(customDimensions.guard), bin(timestamp, 1d)
| order by timestamp desc
```

Submit vs cancel count:

```kusto
customEvents
| where name in ("bot.confirmation.submitted", "bot.confirmation.cancelled")
| summarize count() by name, bin(timestamp, 1d)
| order by timestamp desc
```

Xero write failures:

```kusto
customEvents
| where name == "xero.time_entry.failed"
| order by timestamp desc
| project timestamp,
          operationId = tostring(customDimensions.operationId),
          projectId = tostring(customDimensions.projectId),
          taskId = tostring(customDimensions.taskId),
          errorName = tostring(customDimensions.errorName),
          errorMessage = tostring(customDimensions.errorMessage)
```

Average triage and reasoning latency:

```kusto
customEvents
| where name in ("agent.triage.completed", "agent.reasoning.completed")
| summarize avgLatencyMs = avg(todouble(customDimensions.latencyMs)),
            p95LatencyMs = percentile(todouble(customDimensions.latencyMs), 95)
            by name, bin(timestamp, 1h)
| order by timestamp desc
```

Tool-call counts by tool:

```kusto
customEvents
| where name == "agent.tool.called"
| summarize count() by toolName = tostring(customDimensions.toolName), bin(timestamp, 1d)
| order by timestamp desc
```

## Future Workbook Layout

Create an Application Insights Workbook with these tiles:

- Today's bot turns
- Drafts created
- Submits
- Cancels
- Guard failures
- Xero failures
- Average `/api/messages` latency
- Average reasoning latency
- Model/tool-call volume

Helpful breakdowns:

- guard failures by type
- submits vs cancels by day
- tool calls by tool name
- Xero writes by mock/real mode
- p95 bot-turn latency
- p95 reasoning latency

## Implementation Notes

Planned dependency:

```text
applicationinsights
```

Alternative later:

```text
Azure Monitor OpenTelemetry distro
```

Recommended default for this project: Azure Monitor / Application Insights integration with a small
wrapper module so the app code does not depend directly on telemetry vendor APIs.

Planned environment variable:

```env
APPLICATIONINSIGHTS_CONNECTION_STRING=
```

Planned module:

```text
src/telemetry.js
```

Required behavior:

- console fallback always works locally
- Application Insights is enabled only when the connection string exists
- telemetry failures must never break the bot turn
- no secrets or raw text are emitted
- event names are stable and documented in this file
- every bot turn and REST request gets an `operationId`

Files to instrument:

- `src/server.js` for HTTP/REST request lifecycle
- `src/bot.js` for Teams state, cards, submit/cancel
- `src/agent.js` for triage, reasoning, tools, guards
- `src/xero.js` for mock/real time-entry writes

## What This Lets You Answer

Where do I see what happened for a user turn?

- Application Insights Transaction Search or Logs.
- Search by `operationId`, `conversationHash`, `userHash`, or recent `bot.turn.received`.

How do I see what happened when the user typed `cancel`?

- Query `bot.confirmation.cancelled`.
- Open the same `operationId` timeline.
- Confirm `conversation.cleared` happened and no `xero.time_entry.created` event exists.

How do I see agent input/output without raw text?

- Inspect the sanitized `input` and `output` dimensions on each event.
- Use `textHash` and `textLength` for correlation without exposing narration.

What is App Insights responsible for versus Azure AI Foundry Monitoring?

- Application Insights: app workflow, bot state, tools, drafts, submit/cancel, Xero writes, errors.
- Foundry Monitoring: model/deployment health, model latency, token usage, throttling.

Which events should implementation emit?

- Use the event names listed in this document.
- Add new names only when a new product behavior or subsystem appears.

Which KQL queries should I start with?

- Use the starter queries in this document, especially the full timeline query by `operationId`.
