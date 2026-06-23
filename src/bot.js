'use strict';
const { AgentApplication, MessageFactory, CardFactory } = require('@microsoft/agents-hosting');
const config = require('./config');
const userMap = require('./userMap');
const xero = require('./xero');
const draftStore = require('./draftStore');
const conversationStore = require('./conversationStore');
const { run } = require('./agent');
const telemetry = require('./telemetry');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Teams sends the AAD Object ID in aadObjectId — that's what userMap.teamsId stores.
// Fall back to from.id for emulator / local testing (emulator has no aadObjectId).
function teamsUserId(context) {
  // Local dev only: no bot credentials means emulator, which generates random IDs each session.
  // LOCAL_USER_IDENTITY pins it to a fixed value so userMap lookup always works.
  if (!config.bot.clientId && process.env.LOCAL_USER_IDENTITY) {
    return process.env.LOCAL_USER_IDENTITY;
  }
  return context.activity.from.aadObjectId || context.activity.from.id;
}

// Strip @mentions so "3h on Acme" isn't prefixed with "@XeroBot 3h on Acme".
function cleanText(context) {
  try {
    return (context.activity.removeMentionText() || context.activity.text || '').trim();
  } catch {
    return (context.activity.text || '').trim();
  }
}

function fmtDuration(minutes) {
  if (!minutes) return '?';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

// ── Adaptive Card builder ─────────────────────────────────────────────────────
function buildDraftCard(entries) {
  const entryBlocks = entries.map((e) => {
    const hasIssues = e.issues && e.issues.length > 0;
    return {
      type: 'Container',
      style: hasIssues ? 'attention' : 'good',
      spacing: 'small',
      items: [
        {
          type: 'TextBlock',
          text: `**${e.projectName || '?'}** › ${e.taskName || '?'}`,
          wrap: true,
        },
        {
          type: 'TextBlock',
          text: `${fmtDuration(e.durationMin)} · ${(e.dateUtc || '').slice(0, 10) || '?'}`,
          isSubtle: true,
          spacing: 'none',
        },
        ...(e.description
          ? [{ type: 'TextBlock', text: e.description, isSubtle: true, wrap: true, spacing: 'none' }]
          : []),
        ...(hasIssues
          ? [{ type: 'TextBlock', text: `⚠ ${e.issues.join('; ')}`, color: 'attention', wrap: true, spacing: 'none' }]
          : []),
      ],
    };
  });

  const hasBlockingIssues = entries.some(
    (e) => e.needsConfirmation && e.issues && e.issues.some((i) => !i.includes('unusually long'))
  );

  return CardFactory.adaptiveCard({
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.3',
    body: [
      { type: 'TextBlock', text: 'Draft time entries', weight: 'bolder', size: 'medium' },
      ...(hasBlockingIssues
        ? [{ type: 'TextBlock', text: 'Some entries have issues — fix them before submitting.', color: 'attention', wrap: true }]
        : [{ type: 'TextBlock', text: 'Review and submit when ready.', isSubtle: true }]),
      { type: 'Container', separator: true, items: entryBlocks },
    ],
    actions: [
      { type: 'Action.Submit', title: '✓ Submit to Xero', data: { intent: 'SUBMIT' } },
      { type: 'Action.Submit', title: '✕ Cancel', data: { intent: 'CANCEL' } },
    ],
  });
}

// Text fallbacks for when the user types instead of tapping the card buttons.
const SUBMIT_RE = /^\s*(yes|submit|confirm|looks good|send it|ok|yep|yeah|do it)\s*$/i;
const CANCEL_RE = /^\s*(no|cancel|nope|discard|never mind|clear)\s*$/i;

// ── AgentApplication ──────────────────────────────────────────────────────────
const agent = new AgentApplication();

agent.onMessage(async (context) => {
  const operationId = telemetry.newOperationId();
  const conversationId = context.activity.conversation.id;
  const identity = teamsUserId(context);
  const cardValue = context.activity.value;
  const text = cleanText(context);

  telemetry.track('bot.turn.received', {
    operationId,
    source: 'bot',
    stage: 'turn',
    conversationHash: telemetry.hash(conversationId),
    userHash: telemetry.hash(identity),
    textLength: text.length,
    textHash: telemetry.hash(text),
    mock: config.xero.mock,
    isCardAction: !!cardValue,
  });

  // ── Resolve user ─────────────────────────────────────────────────────────────
  const user = userMap.resolveUser(identity);
  if (!user) {
    telemetry.track('bot.user.unmapped', {
      operationId, source: 'bot', stage: 'user_resolve',
      userHash: telemetry.hash(identity),
      success: false,
    });
    await context.sendActivity(MessageFactory.text(
      "I don't recognise your Teams account. Ask your admin to add you to the user map."
    ));
    return;
  }
  telemetry.track('bot.user.resolved', {
    operationId, source: 'bot', stage: 'user_resolve', success: true,
  });

  // ── Load conversation state ───────────────────────────────────────────────────
  let state = await conversationStore.get(conversationId) || {
    conversationState: 'IDLE',
    history: [],
    pendingEntries: [],
  };

  telemetry.track('bot.state.loaded', {
    operationId,
    source: 'bot',
    stage: 'state',
    conversationHash: telemetry.hash(conversationId),
    stateBefore: state.conversationState,
    pendingEntryCount: (state.pendingEntries || []).length,
    historyLength: (state.history || []).length,
  });

  // ── Pre-filter: card taps and typed confirmations — no LLM needed ─────────────
  if (state.conversationState === 'NEEDS_CONFIRMATION') {
    const intent = cardValue?.intent
      || (SUBMIT_RE.test(text) ? 'SUBMIT' : CANCEL_RE.test(text) ? 'CANCEL' : null);

    if (intent === 'SUBMIT' || intent === 'CANCEL') {
      telemetry.track('bot.confirmation.intent_detected', {
        operationId,
        source: 'bot',
        stage: 'confirmation',
        intent,
        intentSource: cardValue?.intent ? 'card' : 'typed',
        stateBefore: 'NEEDS_CONFIRMATION',
        pendingEntryCount: (state.pendingEntries || []).length,
      });
    }

    if (intent === 'SUBMIT') {
      const entries = state.pendingEntries || [];
      // Soft-warning entries (only "unusually long") are submittable; hard-blocked ones are not.
      const submittable = entries.filter(
        (e) => !e.needsConfirmation || (e.issues || []).every((i) => i.includes('unusually long'))
      );

      if (submittable.length === 0) {
        await context.sendActivity(MessageFactory.text(
          'No complete entries to submit. Fix the flagged issues first, or type **Cancel** to discard.'
        ));
        telemetry.track('bot.reply.sent', {
          operationId, source: 'bot', stage: 'reply',
          note: 'no_submittable_entries', success: true,
        });
        return;
      }

      const lines = [];
      let submittedCount = 0;
      let failedCount = 0;
      for (const e of submittable) {
        try {
          const created = await xero.createTimeEntry(
            {
              projectId: e.projectId,
              userId: user.xeroUserId,
              taskId: e.taskId,
              dateUtc: e.dateUtc,
              durationMin: e.durationMin,
              description: e.description,
            },
            e.id, // idempotency key — re-submitting the same draft won't double-post
            { operationId }
          );
          await draftStore.markSubmitted(e.id, created?.timeEntryId);
          telemetry.track('draft.entry.submitted', {
            operationId, source: 'bot', stage: 'submit',
            entryId: e.id, projectId: e.projectId, taskId: e.taskId,
            durationMin: e.durationMin, mock: config.xero.mock, success: true,
          });
          submittedCount++;
          lines.push(`✓ ${e.projectName} › ${e.taskName}: ${fmtDuration(e.durationMin)}`);
        } catch (err) {
          failedCount++;
          lines.push(`✗ ${e.projectName} › ${e.taskName}: ${err.message}`);
        }
      }

      telemetry.track('bot.confirmation.submitted', {
        operationId,
        source: 'bot',
        stage: 'confirmation',
        input: {
          stateBefore: 'NEEDS_CONFIRMATION',
          pendingEntryCount: entries.length,
          submittableEntryCount: submittable.length,
        },
        output: { stateAfter: 'IDLE', submittedCount, failedCount, mock: config.xero.mock },
        success: failedCount === 0,
      });

      await conversationStore.clear(conversationId);
      telemetry.track('conversation.cleared', {
        operationId, source: 'bot',
        conversationHash: telemetry.hash(conversationId), success: true,
      });

      await context.sendActivity(MessageFactory.text(
        `Submitted ${lines.filter((l) => l.startsWith('✓')).length} entr${lines.length === 1 ? 'y' : 'ies'} to Xero:\n${lines.join('\n')}`
      ));
      telemetry.track('bot.reply.sent', { operationId, source: 'bot', stage: 'reply', success: true });
      return;
    }

    if (intent === 'CANCEL') {
      telemetry.track('bot.confirmation.cancelled', {
        operationId,
        source: 'bot',
        stage: 'confirmation',
        input: {
          stateBefore: 'NEEDS_CONFIRMATION',
          pendingEntryCount: (state.pendingEntries || []).length,
          intentSource: cardValue?.intent ? 'card' : 'typed',
        },
        output: { stateAfter: 'IDLE', conversationCleared: true, xeroWriteAttempted: false },
        success: true,
      });
      await conversationStore.clear(conversationId);
      telemetry.track('conversation.cleared', {
        operationId, source: 'bot',
        conversationHash: telemetry.hash(conversationId), success: true,
      });
      await context.sendActivity(MessageFactory.text('Cancelled. Nothing was submitted to Xero.'));
      telemetry.track('bot.reply.sent', { operationId, source: 'bot', stage: 'reply', success: true });
      return;
    }

    // Any other message while waiting for confirmation — treat as a new request
    state = { conversationState: 'IDLE', history: state.history, pendingEntries: [] };
  }

  // ── Route everything else through the agent ───────────────────────────────────
  let result;
  try {
    result = await run(text, state.history || [], user, operationId);
  } catch (err) {
    telemetry.track('bot.turn.failed', {
      operationId, source: 'bot', stage: 'agent',
      errorName: err.name || 'Error', success: false,
    });
    await context.sendActivity(MessageFactory.text(`Something went wrong: ${err.message}`));
    return;
  }

  if (result.type === 'card') {
    const saved = await draftStore.addEntries(user.email || user.teamsId, result.entries);
    telemetry.track('draft.entries.added', {
      operationId, source: 'bot', stage: 'draft',
      draftCount: saved.length, success: true,
    });
    await conversationStore.set(conversationId, {
      conversationState: 'NEEDS_CONFIRMATION',
      history: [
        ...(state.history || []),
        { role: 'user', content: text },
        { role: 'assistant', content: 'Showing draft for confirmation.' },
      ],
      pendingEntries: saved,
    });
    await context.sendActivity({ type: 'message', attachments: [buildDraftCard(saved)] });
    telemetry.track('bot.card.sent', {
      operationId, source: 'bot', stage: 'card',
      entryCount: saved.length, success: true,
    });
  } else {
    await conversationStore.set(conversationId, {
      conversationState: 'IDLE',
      history: [
        ...(state.history || []),
        { role: 'user', content: text },
        { role: 'assistant', content: result.content },
      ],
      pendingEntries: [],
    });
    await context.sendActivity(MessageFactory.text(result.content));
    telemetry.track('bot.reply.sent', { operationId, source: 'bot', stage: 'reply', success: true });
  }
});

// Welcome message when the bot is first added to a chat
agent.onConversationUpdate('membersAdded', async (context) => {
  for (const member of context.activity.membersAdded || []) {
    if (member.id !== context.activity.recipient.id) {
      await context.sendActivity(MessageFactory.text(
        "Hi! I'm your Xero timesheet assistant. Tell me what you worked on and I'll log it.\nTry: _\"3h on the DM project meetings today\"_"
      ));
    }
  }
});

module.exports = { agent };
