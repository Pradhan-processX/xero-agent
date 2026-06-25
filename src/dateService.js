'use strict';
const config = require('./config');

const DEFAULT_TIME_ZONE = config.agent.timeZone || 'Australia/Sydney';
const formatterCache = new Map();

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatterFor(timeZone) {
  const tz = timeZone || DEFAULT_TIME_ZONE;
  if (!formatterCache.has(tz)) {
    formatterCache.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }));
  }
  return formatterCache.get(tz);
}

function parseYmd(ymd) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!match) throw new Error(`Invalid date ${ymd}; expected YYYY-MM-DD`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function todayYmd(timeZone = DEFAULT_TIME_ZONE, now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const parts = formatterFor(timeZone).formatToParts(date);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function addDays(ymd, days) {
  const { year, month, day } = parseYmd(ymd);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function toXeroDateUtc(localYmd) {
  const { year, month, day } = parseYmd(localYmd);
  return `${year}-${pad(month)}-${pad(day)}T00:00:00Z`;
}

function isDateOnlyUtc(value) {
  return /^\d{4}-\d{2}-\d{2}(?:$|T00:00(?::00)?(?:\.000)?Z$)/.test(String(value || ''));
}

function ymdFromInput(value, timeZone = DEFAULT_TIME_ZONE, now = new Date()) {
  if (!value) return todayYmd(timeZone, now);
  if (typeof value === 'string' && isDateOnlyUtc(value)) return value.slice(0, 10);

  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date ${value}`);
  return todayYmd(timeZone, d);
}

function resolveDateToken(token, timeZone = DEFAULT_TIME_ZONE, now = new Date()) {
  const raw = String(token || '').trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return toXeroDateUtc(raw);

  const today = todayYmd(timeZone, now);
  if (raw === 'yesterday') return toXeroDateUtc(addDays(today, -1));
  if (raw === 'tomorrow') return toXeroDateUtc(addDays(today, 1));
  return toXeroDateUtc(today);
}

function weekStartOf(value, timeZone = DEFAULT_TIME_ZONE, now = new Date()) {
  const ymd = ymdFromInput(value, timeZone, now);
  const { year, month, day } = parseYmd(ymd);
  const d = new Date(Date.UTC(year, month - 1, day));
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  return addDays(ymd, -daysSinceMonday);
}

function currentWeekStart(timeZone = DEFAULT_TIME_ZONE, now = new Date()) {
  return weekStartOf(todayYmd(timeZone, now), timeZone, now);
}

function isFutureDate(value, timeZone = DEFAULT_TIME_ZONE, now = new Date()) {
  return ymdFromInput(value, timeZone, now) > todayYmd(timeZone, now);
}

module.exports = {
  DEFAULT_TIME_ZONE,
  addDays,
  currentWeekStart,
  isFutureDate,
  resolveDateToken,
  todayYmd,
  toXeroDateUtc,
  weekStartOf,
  ymdFromInput,
};
