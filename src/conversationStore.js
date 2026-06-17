'use strict';
const config = require('./config');

// Conversation state persisted between Teams messages, keyed by conversationId.
//
// Schema (one record per active conversation):
//   conversationId  string   Teams conversation ID — unique per 1:1 chat
//   state           string   IDLE | CLARIFYING | NEEDS_CONFIRMATION
//   history         array    [{ role: 'user'|'assistant', content: string }]
//                            Full message history passed to LLM on every turn.
//   pendingEntries  array    Draft entries shown on Adaptive Card, waiting for
//                            Submit / Edit / Delete from the user.
//   updatedAt       string   ISO timestamp — used for 30-min idle TTL.
//
// Connections:
//   bot.js          Only caller. get() on every message, set() after every turn,
//                   clear() after submit or 30-min idle.
//   grounding.js    Does NOT call this. bot.js extracts history[] and passes it.
//   draftStore.js   Separate store — drafts outlive a conversation.
//
// Backends (same interface, selected at startup):
//   In-memory Map   Works locally right now. Resets on server restart.
//   Azure Table     Swap in by setting AZURE_STORAGE_CONNECTION_STRING.
//                   Survives restarts, safe for concurrent users.

const TTL_MS = 30 * 60 * 1000; // 30 minutes idle → auto-clear

const useTable = !!config.storage.connectionString;

// ─── In-memory backend ────────────────────────────────────────────────────────
function memoryBackend() {
  const _map = new Map();

  return {
    async get(conversationId) {
      const entry = _map.get(conversationId);
      if (!entry) return null;
      if (Date.now() - new Date(entry.updatedAt).getTime() > TTL_MS) {
        _map.delete(conversationId);
        return null;
      }
      return entry;
    },

    async set(conversationId, data) {
      _map.set(conversationId, {
        ...data,
        conversationId,
        updatedAt: new Date().toISOString(),
      });
    },

    async clear(conversationId) {
      _map.delete(conversationId);
    },
  };
}

// ─── Azure Table backend ──────────────────────────────────────────────────────
// history[] and pendingEntries[] are JSON-stringified into a single `data` column
// because Azure Table Storage only stores flat key-value rows.
function tableBackend() {
  const { TableClient } = require('@azure/data-tables');
  const client = TableClient.fromConnectionString(
    config.storage.connectionString,
    config.storage.conversationTable || 'conversations'
  );
  const ready = client.createTable().catch(() => {});

  return {
    async get(conversationId) {
      await ready;
      try {
        const e = await client.getEntity('conv', conversationId);
        const entry = JSON.parse(e.data);
        if (Date.now() - new Date(entry.updatedAt).getTime() > TTL_MS) {
          await client.deleteEntity('conv', conversationId).catch(() => {});
          return null;
        }
        return entry;
      } catch {
        return null;
      }
    },

    async set(conversationId, data) {
      await ready;
      const entry = { ...data, conversationId, updatedAt: new Date().toISOString() };
      await client.upsertEntity(
        { partitionKey: 'conv', rowKey: conversationId, data: JSON.stringify(entry) },
        'Replace'
      );
    },

    async clear(conversationId) {
      await ready;
      await client.deleteEntity('conv', conversationId).catch(() => {});
    },
  };
}

const impl = useTable ? tableBackend() : memoryBackend();
impl.backend = useTable ? 'azure-table' : 'memory';

module.exports = impl;
