'use strict';
// Persistence with two interchangeable backends:
//   - Azure Table Storage  (when AZURE_STORAGE_CONNECTION_STRING is set) -> shared, multi-instance
//   - Local JSON files      (otherwise)                                  -> single-machine dev
//
// Exposes:
//   tokens.get() / tokens.set(obj)                         -> the single shared Xero org token
//   drafts.insert(record) / drafts.byUser(userKey)
//   drafts.findById(id)   / drafts.replace(record)
const fs = require('fs');
const config = require('./config');

const useTable = !!config.storage.connectionString;

// PartitionKey/RowKey can't contain backslash, slash, # or ?. Replace those + whitespace.
const DISALLOWED = /[\\/#?\s]/g;
const safeKey = (s) => String(s).replace(DISALLOWED, '_');

// ───────────────────────── File backend ─────────────────────────
function fileBackend() {
  const readJson = (path, fallback) => {
    try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return fallback; }
  };
  const writeJson = (path, data) => fs.writeFileSync(path, JSON.stringify(data, null, 2));

  return {
    tokens: {
      async get() { return readJson(config.xero.tokenFile, null); },
      async set(obj) { writeJson(config.xero.tokenFile, obj); },
    },
    drafts: {
      async insert(record) {
        const d = readJson(config.agent.draftStoreFile, { entries: [] });
        d.entries.push(record);
        writeJson(config.agent.draftStoreFile, d);
        return record;
      },
      async byUser(userKey) {
        const d = readJson(config.agent.draftStoreFile, { entries: [] });
        return d.entries.filter((e) => e.userKey === userKey);
      },
      async findById(id) {
        const d = readJson(config.agent.draftStoreFile, { entries: [] });
        return d.entries.find((e) => e.id === id) || null;
      },
      async replace(record) {
        const d = readJson(config.agent.draftStoreFile, { entries: [] });
        const i = d.entries.findIndex((e) => e.id === record.id);
        if (i >= 0) d.entries[i] = record; else d.entries.push(record);
        writeJson(config.agent.draftStoreFile, d);
        return record;
      },
    },
  };
}

// ───────────────────────── Azure Table backend ─────────────────────────
function tableBackend() {
  const { TableClient, odata } = require('@azure/data-tables');
  const conn = config.storage.connectionString;
  const tokenClient = TableClient.fromConnectionString(conn, config.storage.tokenTable);
  const draftClient = TableClient.fromConnectionString(conn, config.storage.draftTable);
  const ready = Promise.all([
    tokenClient.createTable().catch(() => {}),
    draftClient.createTable().catch(() => {}),
  ]);

  return {
    tokens: {
      async get() {
        await ready;
        try {
          const e = await tokenClient.getEntity('xero', 'org');
          return JSON.parse(e.data);
        } catch { return null; }
      },
      async set(obj) {
        await ready;
        await tokenClient.upsertEntity(
          { partitionKey: 'xero', rowKey: 'org', data: JSON.stringify(obj) },
          'Replace'
        );
      },
    },
    drafts: {
      async insert(record) {
        await ready;
        await draftClient.upsertEntity(
          { partitionKey: safeKey(record.userKey), rowKey: record.id, data: JSON.stringify(record) },
          'Replace'
        );
        return record;
      },
      async byUser(userKey) {
        await ready;
        const out = [];
        const iter = draftClient.listEntities({
          queryOptions: { filter: odata`PartitionKey eq ${safeKey(userKey)}` },
        });
        for await (const e of iter) out.push(JSON.parse(e.data));
        return out;
      },
      async findById(id) {
        await ready;
        const iter = draftClient.listEntities({ queryOptions: { filter: odata`RowKey eq ${id}` } });
        for await (const e of iter) return JSON.parse(e.data);
        return null;
      },
      async replace(record) {
        return this.insert(record); // upsert/Replace
      },
    },
  };
}

const impl = useTable ? tableBackend() : fileBackend();
impl.backend = useTable ? 'azure-table' : 'file';
module.exports = impl;
