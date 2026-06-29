'use strict';
const crypto = require('crypto');
const store = require('./store');
const dateService = require('./dateService');

// Monday in the configured business timezone for the date containing dateUtc.
function weekStartOf(dateUtc) {
  return dateService.weekStartOf(dateUtc);
}

async function addEntries(userKey, entries) {
  const created = [];
  for (const e of entries) {
    const record = {
      id: crypto.randomUUID(),
      userKey,
      weekStart: weekStartOf(e.dateUtc),
      status: 'draft', // draft | submitted | deleted
      createdAt: new Date().toISOString(),
      ...e,
    };
    await store.drafts.insert(record);
    created.push(record);
  }
  return created;
}

async function getWeek(userKey, weekStart) {
  const all = await store.drafts.byUser(userKey);
  return all.filter((e) => e.weekStart === weekStart && e.status !== 'deleted');
}

async function getEntry(id) {
  return store.drafts.findById(id);
}

async function updateEntry(id, patch) {
  const entry = await store.drafts.findById(id);
  if (!entry) return null;
  Object.assign(entry, patch);
  if (patch.dateUtc) entry.weekStart = weekStartOf(patch.dateUtc);
  await store.drafts.replace(entry);
  return entry;
}

async function removeEntry(id) {
  const entry = await store.drafts.findById(id);
  if (!entry) return false;
  entry.status = 'deleted';
  await store.drafts.replace(entry);
  return true;
}

async function markSubmitted(id, xeroTimeEntryId) {
  return updateEntry(id, { status: 'submitted', xeroTimeEntryId, submittedAt: new Date().toISOString() });
}

module.exports = { addEntries, getWeek, getEntry, updateEntry, removeEntry, markSubmitted, weekStartOf };
