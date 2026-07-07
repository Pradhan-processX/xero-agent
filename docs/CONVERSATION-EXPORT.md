# Conversation Export

Use this when the business needs a CEO-readable transcript export from Azure Application Insights.
Full message logging is off by default. Enable it only in environments approved for storing user
and bot message text.

## Enable Full Conversation Logging

Set these App Service application settings after deploying code that includes the conversation log
event.

```bash
az webapp config appsettings set \
  --resource-group ProcessX-AUAE-XA-RG-01 \
  --name xero-agent-api \
  --settings CONVERSATION_LOG_TEXT=true CONVERSATION_BOT_NAME="Xero Timesheet" CONVERSATION_LOG_MAX_CHARS=8000

az webapp restart \
  --resource-group ProcessX-AUAE-XA-RG-01 \
  --name xero-agent-api
```

Optional friendly tenant label:

```bash
az webapp config appsettings set \
  --resource-group ProcessX-AUAE-XA-RG-01 \
  --name xero-agent-api \
  --settings CONVERSATION_TENANT_NAME="ProcessX"
```

## Export Query

Open the Application Insights Logs blade, set the time range, then run:

```kusto
customEvents
| where name == "conversation.message"
| extend d = customDimensions
| extend ActivityDate = todatetime(tostring(d.date))
| project
    ['User Name'] = tostring(d.userName),
    ['Bot Name'] = tostring(d.botName),
    ['Channel Id'] = tostring(d.channelId),
    ['Conversation Id'] = tostring(d.conversationId),
    ['Date'] = coalesce(ActivityDate, timestamp),
    ['Message'] = tostring(d.message),
    ['Sender'] = tostring(d.sender),
    ['Tenant Name'] = tostring(d.tenantName),
    ['User First Name'] = tostring(d.userFirstName),
    ['User Last Name'] = tostring(d.userLastName),
    ['Status'] = tostring(d.status),
    ['Message Truncated'] = tostring(d.messageTruncated),
    ['Operation Id'] = tostring(d.operationId)
| order by ['Date'] asc
```

Click **Export** then **Export to CSV**. Open the CSV in Excel and save it as `.xlsx` if needed.

## Single Conversation Query

Use this to inspect one conversation thread.

```kusto
customEvents
| where name == "conversation.message"
| extend d = customDimensions
| where tostring(d.conversationId) == "PASTE_CONVERSATION_ID_HERE"
| extend ActivityDate = todatetime(tostring(d.date))
| project
    ['Date'] = coalesce(ActivityDate, timestamp),
    ['Sender'] = tostring(d.sender),
    ['Message'] = tostring(d.message),
    ['Status'] = tostring(d.status)
| order by ['Date'] asc
```

## Notes

- User messages, bot text replies, submitted/cancelled card actions, draft cards, and edit/delete
  confirmation cards are logged.
- Adaptive Cards are exported as readable transcript text instead of raw card JSON.
- Message text is truncated at `CONVERSATION_LOG_MAX_CHARS` characters. Increase carefully if needed.
- Existing hashed operational telemetry still remains; this export uses the separate
  `conversation.message` event.
