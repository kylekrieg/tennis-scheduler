'use strict';
/**
 * Player-entered "other dates" (Kyle, 2026-09-26) — matches a player plays
 * outside any session in this app, added from My Page so the player's .ics
 * download and subscribe feed hold ALL their tennis in one calendar.
 *
 * Deliberately a calendar convenience only: no link to blackout dates, the
 * scheduler, double-booking checks, or anything an admin sees. Kyle: "No
 * need to keep track of Blackout dates. This is just a service ... to help
 * players keep all their tennis in one place."
 *
 * Security: My Page has no login, and unlike the rest of My Page this is a
 * WRITE into a calendar feed on the player's phone, so editing requires an
 * emailed link (issueEditToken / findPlayerByEditToken). The link is reusable
 * for EDIT_TOKEN_DAYS so a player can bookmark it rather than re-requesting
 * one every time; only its hash is stored.
 */
const db = require('../db');
const { generateRawToken, hashToken } = require('./tokens');

const EDIT_TOKEN_DAYS = 30;
const MAX_UPCOMING_PER_PLAYER = 100; // abuse ceiling, far above real use
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TEXT_MAX = 120;

function issueEditToken(playerId) {
  const raw = generateRawToken();
  const expires = new Date(Date.now() + EDIT_TOKEN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO personal_event_tokens (player_id, token_hash, expires_at) VALUES (?, ?, ?)')
    .run(playerId, hashToken(raw), expires);
  return raw;
}

/** Returns the player row the token belongs to, or null if unknown/expired.
 * If expectedPlayerId is given, a token for a different player is rejected. */
function findPlayerByEditToken(raw, expectedPlayerId = null) {
  if (!raw || typeof raw !== 'string' || raw.length > 200) return null;
  const row = db.prepare('SELECT * FROM personal_event_tokens WHERE token_hash = ?').get(hashToken(raw));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  if (expectedPlayerId != null && row.player_id !== expectedPlayerId) return null;
  return db.prepare('SELECT * FROM players WHERE id = ?').get(row.player_id) || null;
}

function cleanText(v) {
  const s = (v == null ? '' : String(v)).trim().slice(0, TEXT_MAX);
  return s || null;
}

// Error CODES (not free text) travel in the redirect's query string, and the
// view maps them to these messages — so nobody can craft a My Page URL that
// displays arbitrary text.
const ERROR_MESSAGES = {
  bad_date: 'Pick a valid date.',
  past_date: 'That date has already passed — only upcoming dates can be added.',
  bad_time: 'Pick a valid start time.',
  bad_duration: 'Length must be between 15 and 600 minutes.',
  too_many: `You already have ${MAX_UPCOMING_PER_PLAYER} upcoming dates — delete some first.`,
  not_found: "That entry wasn't found (it may already be deleted).",
};

/** Validates form input. Returns { value } or { error: <code in ERROR_MESSAGES> }. */
function parseEventInput(body, todayIso) {
  const eventDate = String(body.event_date || '').trim();
  const startTime = String(body.start_time || '').trim();
  if (!DATE_RE.test(eventDate) || Number.isNaN(Date.parse(eventDate + 'T00:00:00Z'))) {
    return { error: 'bad_date' };
  }
  if (todayIso && eventDate < todayIso) return { error: 'past_date' };
  if (!TIME_RE.test(startTime)) return { error: 'bad_time' };
  let duration = body.duration_minutes === undefined || body.duration_minutes === '' ? 90 : Number(body.duration_minutes);
  if (!Number.isInteger(duration) || duration < 15 || duration > 600) {
    return { error: 'bad_duration' };
  }
  return {
    value: {
      eventDate,
      startTime,
      durationMinutes: duration,
      club: cleanText(body.club),
      court: cleanText(body.court),
      notes: cleanText(body.notes),
    },
  };
}

function addEvent(playerId, v, todayIso) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM personal_events WHERE player_id = ? AND event_date >= ?')
    .get(playerId, todayIso).n;
  if (count >= MAX_UPCOMING_PER_PLAYER) return { error: 'too_many' };
  const info = db.prepare(
    `INSERT INTO personal_events (player_id, event_date, start_time, duration_minutes, club, court, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(playerId, v.eventDate, v.startTime, v.durationMinutes, v.club, v.court, v.notes);
  return { id: Number(info.lastInsertRowid) };
}

/** Deletes only if the row belongs to playerId. Returns the deleted row or null. */
function deleteEvent(playerId, eventId) {
  const row = db.prepare('SELECT * FROM personal_events WHERE id = ? AND player_id = ?').get(eventId, playerId);
  if (!row) return null;
  db.prepare('DELETE FROM personal_events WHERE id = ?').run(eventId);
  return row;
}

function upcomingEvents(playerId, todayIso) {
  return db.prepare('SELECT * FROM personal_events WHERE player_id = ? AND event_date >= ? ORDER BY event_date, start_time')
    .all(playerId, todayIso);
}

function eventsInRange(playerId, fromIso, toIso) {
  return db.prepare(
    'SELECT * FROM personal_events WHERE player_id = ? AND event_date >= ? AND event_date <= ? ORDER BY event_date, start_time'
  ).all(playerId, fromIso, toIso);
}

function allEvents(playerId) {
  return db.prepare('SELECT * FROM personal_events WHERE player_id = ? ORDER BY event_date, start_time').all(playerId);
}

/** "Frontenac Tennis Club, Court 3" / "Court 3" / "" */
function placeLabel(ev) {
  return [ev.club, ev.court].filter(Boolean).join(', ');
}

/** Converts one row into an `ics` library event object (or null on bad data).
 * The stable uid is what makes the subscribe feed update in place instead of
 * piling up duplicates — same reasoning as ics.js's assignment uids. */
function toIcsEvent(ev) {
  const [y, mo, d] = ev.event_date.split('-').map(Number);
  const [hh, mm] = ev.start_time.split(':').map(Number);
  if (![y, mo, d, hh, mm].every(Number.isFinite)) return null;
  const place = placeLabel(ev);
  return {
    uid: `personal-${ev.id}@tennis-scheduler.local`,
    title: place ? `Match — ${place}` : 'Match',
    start: [y, mo, d, hh, mm],
    duration: { minutes: ev.duration_minutes || 90 },
    ...(place ? { location: place } : {}),
    description: (ev.notes ? `${ev.notes}\n\n` : '') + 'Added by you on My Page (My Other Dates).',
    status: 'CONFIRMED',
  };
}

module.exports = {
  EDIT_TOKEN_DAYS,
  ERROR_MESSAGES,
  issueEditToken,
  findPlayerByEditToken,
  parseEventInput,
  addEvent,
  deleteEvent,
  upcomingEvents,
  eventsInRange,
  allEvents,
  placeLabel,
  toIcsEvent,
};
