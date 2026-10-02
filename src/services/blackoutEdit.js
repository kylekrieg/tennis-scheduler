'use strict';
/**
 * Player self-service blackout removal (Kyle, 2026-10-02): "We need to have
 * the ability for a player to remove a blackout date themselves ... the
 * system will only allow you to remove future dates. A player would not be
 * able to add dates to their blackout date list."
 *
 * Once a season is scheduled, /blackout is read-only. A player whose plans
 * changed can still take a date OFF their list, which makes them available
 * again: they become a candidate for sub requests and swaps that week, and a
 * future "Schedule these players" run may use them. Removing a date never
 * changes the schedule by itself. Adding a date after scheduling stays
 * impossible on purpose (it would silently disagree with the schedule —
 * Request a Sub is the path for missing a week).
 *
 * Same trust model as My Other Dates (personalEvents.js): no login, so the
 * edit page needs a link emailed to the player's own address. Reusable for
 * EDIT_TOKEN_DAYS so a player can come back to it; only the hash is stored.
 *
 * A blackout date is one fact per player + date (see "Blackout date
 * carryover across sessions" in docs/HISTORY.md), so removing a date deletes
 * every blackout_dates row for that player on that date, whichever session
 * page it was entered on and whether the player or an admin entered it.
 */
const db = require('../db');
const { generateRawToken, hashToken } = require('./tokens');

const EDIT_TOKEN_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function issueEditToken(playerId) {
  const raw = generateRawToken();
  const expires = new Date(Date.now() + EDIT_TOKEN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO blackout_edit_tokens (player_id, token_hash, expires_at) VALUES (?, ?, ?)')
    .run(playerId, hashToken(raw), expires);
  return raw;
}

/** The player row the token belongs to, or null if unknown/expired. */
function findPlayerByEditToken(raw) {
  if (!raw || typeof raw !== 'string' || raw.length > 200) return null;
  const row = db.prepare('SELECT * FROM blackout_edit_tokens WHERE token_hash = ?').get(hashToken(raw));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return db.prepare('SELECT * FROM players WHERE id = ?').get(row.player_id) || null;
}

/**
 * The player's blackout dates from `todayIso` on, each with the sessions it
 * actually lands on (non-archived sessions the player is on the roster of,
 * that have a match that date) so the page can say what it affects.
 * `adminSet` is true when an admin entered it rather than the player.
 */
function upcomingBlackouts(playerId, todayIso) {
  const rows = db
    .prepare(
      `SELECT date, MAX(CASE WHEN source = 'admin' THEN 1 ELSE 0 END) AS admin_set
       FROM blackout_dates WHERE player_id = ? AND date >= ? AND source != 'injury' GROUP BY date ORDER BY date`
    )
    .all(playerId, todayIso);
  const sessionsOn = db.prepare(
    `SELECT DISTINCT s.* FROM sessions s
     JOIN weeks w ON w.session_id = s.id
     JOIN session_players sp ON sp.session_id = s.id AND sp.player_id = ?
     WHERE w.match_date = ? AND s.archived_at IS NULL
     ORDER BY s.name`
  );
  return rows.map((r) => ({ date: r.date, adminSet: !!r.admin_set, sessions: sessionsOn.all(playerId, r.date) }));
}

/** Removes a future blackout date. Returns { removed: n } or { error: code }. */
function removeDate(playerId, date, todayIso) {
  if (!DATE_RE.test(String(date || ''))) return { error: 'bad_date' };
  if (date < todayIso) return { error: 'past_date' };
  // 'injury' rows belong to the admin's Injured setting (injury.js), not the player.
  const info = db.prepare("DELETE FROM blackout_dates WHERE player_id = ? AND date = ? AND source != 'injury'").run(playerId, date);
  if (!info.changes) return { error: 'not_found' };
  return { removed: info.changes };
}

const ERROR_MESSAGES = {
  bad_date: "That date wasn't recognized.",
  past_date: 'That date has already passed — only upcoming dates can be removed.',
  not_found: "That date isn't on your list anymore (it may already be removed).",
};

module.exports = { EDIT_TOKEN_DAYS, ERROR_MESSAGES, issueEditToken, findPlayerByEditToken, upcomingBlackouts, removeDate };
