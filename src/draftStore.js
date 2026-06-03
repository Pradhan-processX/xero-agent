'use strict';
const crypto = require('crypto');
const store = require('./store');

// Monday (UTC) of the week containing dateUtc -> "YYYY-MM-DD".
function weekStartOf(dateUtc) {
  const d = new Date(dateUtc);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
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

module.exports = { addEntries, getWeek, updateEntry, removeEntry, markSubmitted, weekStartOf };
