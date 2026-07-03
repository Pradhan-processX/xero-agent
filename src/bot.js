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
function isSoftIssue(issue) {
  return issue.includes('unusually long') || issue.includes('Future date in the current week');
}

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
    (e) => e.needsConfirmation && e.issues && e.issues.some((i) => !isSoftIssue(i))
  );
  const hasPlannedTime = entries.some(
    (e) => (e.issues || []).some((i) => i.includes('Future date in the current week'))
  );

  return CardFactory.adaptiveCard({
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.3',
    body: [
      { type: 'TextBlock', text: 'Draft time entries', weight: 'bolder', size: 'medium' },
      ...(hasBlockingIssues
        ? [{ type: 'TextBlock', text: 'Some entries have issues — fix them before submitting.', color: 'attention', wrap: true }]
        : hasPlannedTime
          ? [{ type: 'TextBlock', text: 'Some entries are planned for future dates this week. Review before submitting.', color: 'attention', wrap: true }]
        : [{ type: 'TextBlock', text: 'Review and submit when ready.', isSubtle: true }]),
      { type: 'Container', separator: true, items: entryBlocks },
    ],
    actions: [
      { type: 'Action.Submit', title: hasPlannedTime ? '✓ Submit planned time to Xero' : '✓ Submit to Xero', data: { intent: 'SUBMIT' } },
      { type: 'Action.Submit', title: '✕ Cancel', data: { intent: 'CANCEL' } },
    ],
  });
}

function buildMutationCard(mutation) {
  const isDelete = mutation.action === 'delete';
  const title = isDelete ? 'Confirm time entry delete' : 'Confirm time entry update';
  const changeText = isDelete
    ? `${fmtDuration(mutation.currentDurationMin)} will be deleted`
    : `${fmtDuration(mutation.currentDurationMin)} → ${fmtDuration(mutation.newDurationMin)}`;

  return CardFactory.adaptiveCard({
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.3',
    body: [
      { type: 'TextBlock', text: title, weight: 'bolder', size: 'medium' },
      { type: 'TextBlock', text: 'Review before changing Xero.', color: 'attention', wrap: true },
      {
        type: 'Container',
        style: isDelete ? 'attention' : 'good',
        separator: true,
        items: [
          { type: 'TextBlock', text: `**${mutation.projectName || '?'}** › ${mutation.taskName || '?'}`, wrap: true },
          { type: 'TextBlock', text: `${changeText} · ${(mutation.dateUtc || '').slice(0, 10) || '?'}`, isSubtle: true, spacing: 'none' },
          ...(mutation.reason ? [{ type: 'TextBlock', text: mutation.reason, isSubtle: true, wrap: true, spacing: 'none' }] : []),
        ],
      },
    ],
    actions: [
      { type: 'Action.Submit', title: isDelete ? '✓ Delete time entry' : '✓ Update time entry', data: { intent: 'SUBMIT' } },
      { type: 'Action.Submit', title: '✕ Cancel', data: { intent: 'CANCEL' } },
    ],
  });
}

async function discardPendingDrafts(entries, operationId) {
  let deletedCount = 0;
  for (const e of entries || []) {
    if (!e || !e.id) continue;
    try {
      const deleted = await draftStore.removeEntry(e.id);
      if (deleted) deletedCount++;
    } catch (err) {
      telemetry.track('draft.entry.discard_failed', {
        operationId, source: 'bot', stage: 'discard',
        entryId: e.id, errorName: err.name || 'Error', success: false,
      });
    }
  }
  if (deletedCount > 0) {
    telemetry.track('draft.entries.discarded', {
      operationId, source: 'bot', stage: 'discard',
      deletedCount, success: true,
    });
  }
  return deletedCount;
}

async function applyPendingMutation(mutation, user, operationId) {
  if (!mutation) throw new Error('No pending edit to apply.');
  if (mutation.userId && mutation.userId !== user.xeroUserId) {
    throw new Error('This edit does not belong to the signed-in Xero user.');
  }

  const isDraftOnly = mutation.source === 'draft';
  if (mutation.action === 'delete') {
    if (!isDraftOnly) {
      if (!mutation.xeroTimeEntryId) throw new Error('Missing Xero time entry id for submitted entry.');
      await xero.deleteTimeEntry(mutation.projectId, mutation.xeroTimeEntryId, { operationId });
    }
    if (mutation.localEntryId) await draftStore.removeEntry(mutation.localEntryId);
    return `Deleted ${mutation.projectName} › ${mutation.taskName}: ${fmtDuration(mutation.currentDurationMin)} on ${mutation.dateUtc.slice(0, 10)}.`;
  }

  if (mutation.action === 'update') {
    if (!Number.isFinite(mutation.newDurationMin) || mutation.newDurationMin <= 0) {
      throw new Error('Invalid target duration for update.');
    }
    if (!isDraftOnly) {
      if (!mutation.xeroTimeEntryId) throw new Error('Missing Xero time entry id for submitted entry.');
      await xero.updateTimeEntry(
        {
          projectId: mutation.projectId,
          timeEntryId: mutation.xeroTimeEntryId,
          userId: user.xeroUserId,
          taskId: mutation.taskId,
          dateUtc: mutation.dateUtc,
          durationMin: mutation.newDurationMin,
          description: mutation.description,
        },
        mutation.id,
        { operationId }
      );
    }
    if (mutation.localEntryId) {
      await draftStore.updateEntry(mutation.localEntryId, {
        durationMin: mutation.newDurationMin,
        needsConfirmation: false,
        issues: [],
      });
    }
    return `Updated ${mutation.projectName} › ${mutation.taskName} on ${mutation.dateUtc.slice(0, 10)} from ${fmtDuration(mutation.currentDurationMin)} to ${fmtDuration(mutation.newDurationMin)}.`;
  }

  throw new Error(`Unknown edit action: ${mutation.action}`);
}

// Text fallbacks for when the user types instead of tapping the card buttons.
const SUBMIT_RE = /^\s*(yes|submit|confirm|looks good|send it|ok|yep|yeah|do it)\s*$/i;
const CANCEL_RE = /^\s*(no|cancel|nope|discard|never mind|clear)\s*$/i;

// Bot Service/Web Chat may retry a turn when the app is warming or a response is slow.
// Track recent activity ids immediately so repeated delivery does not send duplicate replies.
const RECENT_ACTIVITY_TTL_MS = 10 * 60 * 1000;
const recentActivities = new Map();

function pruneRecentActivities(now = Date.now()) {
  for (const [key, at] of recentActivities) {
    if (now - at > RECENT_ACTIVITY_TTL_MS) recentActivities.delete(key);
  }
}

function activityDedupeKey(context) {
  const a = context.activity || {};
  const conversationId = a.conversation && a.conversation.id;
  if (a.id) return `${a.channelId || 'unknown'}:${conversationId || 'none'}:${a.id}`;
  const fallback = [a.type, a.timestamp, a.from && a.from.id, a.text || JSON.stringify(a.value || {})].join(':');
  return `${a.channelId || 'unknown'}:${conversationId || 'none'}:${telemetry.hash(fallback)}`;
}

function isDuplicateActivity(context) {
  const now = Date.now();
  pruneRecentActivities(now);
  const key = activityDedupeKey(context);
  if (recentActivities.has(key)) return true;
  recentActivities.set(key, now);
  return false;
}

// ── AgentApplication ──────────────────────────────────────────────────────────
const agent = new AgentApplication();

agent.onMessage(async (context) => {
  const operationId = telemetry.newOperationId();
  const conversationId = context.activity.conversation.id;
  const identity = teamsUserId(context);
  const cardValue = context.activity.value;
  const text = cleanText(context);

  if (!text && !cardValue) {
    telemetry.track('bot.turn.empty_ignored', {
      operationId,
      source: 'bot',
      stage: 'turn',
      conversationHash: telemetry.hash(conversationId),
      activityHash: telemetry.hash(context.activity.id || ''),
      success: true,
    });
    return;
  }

  if (isDuplicateActivity(context)) {
    telemetry.track('bot.turn.duplicate_ignored', {
      operationId,
      source: 'bot',
      stage: 'turn',
      conversationHash: telemetry.hash(conversationId),
      activityHash: telemetry.hash(context.activity.id || ''),
      textHash: telemetry.hash(text),
      success: true,
    });
    return;
  }

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
    pendingMutation: null,
  };

  telemetry.track('bot.state.loaded', {
    operationId,
    source: 'bot',
    stage: 'state',
    conversationHash: telemetry.hash(conversationId),
    stateBefore: state.conversationState,
    pendingEntryCount: (state.pendingEntries || []).length,
    hasPendingMutation: !!state.pendingMutation,
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
        hasPendingMutation: !!state.pendingMutation,
      });
    }

    if (intent === 'SUBMIT') {
      if (state.pendingMutation) {
        try {
          const message = await applyPendingMutation(state.pendingMutation, user, operationId);
          telemetry.track('bot.confirmation.mutation_applied', {
            operationId,
            source: 'bot',
            stage: 'confirmation',
            action: state.pendingMutation.action,
            mutationSource: state.pendingMutation.source,
            output: { stateAfter: 'IDLE', mock: config.xero.mock },
            success: true,
          });
          await conversationStore.clear(conversationId);
          telemetry.track('conversation.cleared', {
            operationId, source: 'bot',
            conversationHash: telemetry.hash(conversationId), success: true,
          });
          await context.sendActivity(MessageFactory.text(message));
          telemetry.track('bot.reply.sent', { operationId, source: 'bot', stage: 'reply', success: true });
        } catch (err) {
          telemetry.track('bot.confirmation.mutation_failed', {
            operationId,
            source: 'bot',
            stage: 'confirmation',
            action: state.pendingMutation.action,
            errorName: err.name || 'Error',
            success: false,
          });
          await context.sendActivity(MessageFactory.text(`I could not apply that change: ${err.message}`));
          telemetry.track('bot.reply.sent', { operationId, source: 'bot', stage: 'reply', success: false });
        }
        return;
      }

      const entries = state.pendingEntries || [];
      // Soft-warning entries are submittable after the user confirms the card;
      // hard-blocked entries are not.
      const submittable = entries.filter(
        (e) => !e.needsConfirmation || (e.issues || []).every(isSoftIssue)
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
      const discardedDraftCount = await discardPendingDrafts(state.pendingEntries || [], operationId);
      telemetry.track('bot.confirmation.cancelled', {
        operationId,
        source: 'bot',
        stage: 'confirmation',
        input: {
          stateBefore: 'NEEDS_CONFIRMATION',
          pendingEntryCount: (state.pendingEntries || []).length,
          hasPendingMutation: !!state.pendingMutation,
          intentSource: cardValue?.intent ? 'card' : 'typed',
        },
        output: { stateAfter: 'IDLE', conversationCleared: true, xeroWriteAttempted: false, discardedDraftCount },
        success: true,
      });
      await conversationStore.clear(conversationId);
      telemetry.track('conversation.cleared', {
        operationId, source: 'bot',
        conversationHash: telemetry.hash(conversationId), success: true,
      });
      await context.sendActivity(MessageFactory.text(
        state.pendingMutation
          ? 'Cancelled. No changes were made to Xero.'
          : 'Cancelled. Nothing was submitted to Xero.'
      ));
      telemetry.track('bot.reply.sent', { operationId, source: 'bot', stage: 'reply', success: true });
      return;
    }

    // Any other message while waiting for confirmation — treat as a new request
    await discardPendingDrafts(state.pendingEntries || [], operationId);
    state = { conversationState: 'IDLE', history: state.history, pendingEntries: [], pendingMutation: null };
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
      pendingMutation: null,
    });
    await context.sendActivity({ type: 'message', attachments: [buildDraftCard(saved)] });
    telemetry.track('bot.card.sent', {
      operationId, source: 'bot', stage: 'card',
      entryCount: saved.length, success: true,
    });
  } else if (result.type === 'mutation_card') {
    await conversationStore.set(conversationId, {
      conversationState: 'NEEDS_CONFIRMATION',
      history: [
        ...(state.history || []),
        { role: 'user', content: text },
        { role: 'assistant', content: `Showing edit confirmation: ${result.mutation.summary}` },
      ],
      pendingEntries: [],
      pendingMutation: result.mutation,
    });
    await context.sendActivity({ type: 'message', attachments: [buildMutationCard(result.mutation)] });
    telemetry.track('bot.mutation_card.sent', {
      operationId,
      source: 'bot',
      stage: 'card',
      action: result.mutation.action,
      mutationSource: result.mutation.source,
      success: true,
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
      pendingMutation: null,
    });
    await context.sendActivity(MessageFactory.text(result.content));
    telemetry.track('bot.reply.sent', { operationId, source: 'bot', stage: 'reply', success: true });
  }
});

// Welcome message when the bot is first added to a chat
agent.onConversationUpdate('membersAdded', async (context) => {
  if (isDuplicateActivity(context)) {
    telemetry.track('bot.conversation_update.duplicate_ignored', {
      source: 'bot',
      stage: 'conversation_update',
      conversationHash: telemetry.hash(context.activity.conversation && context.activity.conversation.id),
      activityHash: telemetry.hash(context.activity.id || ''),
      success: true,
    });
    return;
  }

  for (const member of context.activity.membersAdded || []) {
    if (member.id !== context.activity.recipient.id) {
      await context.sendActivity(MessageFactory.text(
        "Hi! I'm your Xero timesheet assistant. Tell me what you worked on and I'll log it.\nTry: _\"3h on the DM project meetings today\"_"
      ));
    }
  }
});

module.exports = {
  agent,
  _internal: {
    applyPendingMutation,
    discardPendingDrafts,
    buildMutationCard,
  },
};
