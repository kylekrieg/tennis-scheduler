'use strict';
const db = require('../db');
const { generateRawToken, hashToken } = require('./tokens');

/**
 * Confirm/need-a-sub link lifecycle for week_assignments.
 *
 * This replaces the original design, where a single `week_assignments.token`
 * column meant issuing a new link (e.g. the morning-of follow-up nudge)
 * silently killed whatever link was already out in an earlier email — a
 * real bug: a player who went back to their first reminder email instead of
 * the newer follow-up got "Link not found" even though they'd never clicked
 * anything. Multiple tokens can now be valid for the same assignment at
 * once. A token stops working when it's explicitly invalidated here, which
 * happens at two points: the assignment leaves scheduled/confirmed (see
 * subFlow.js — requesting a sub kills the "I'm playing" link immediately,
 * not just via a status check), or the week locks because match time has
 * passed (cron.processWeekLocking) — so an old email can't be used to
 * "confirm" a match that already happened.
 */

/** Mints a new valid link for a week_assignment. Does not touch any
 * previously issued tokens for the same assignment — they stay valid until
 * explicitly invalidated below. */
function issueToken(weekAssignmentId) {
  const raw = generateRawToken();
  db.prepare('INSERT INTO week_assignment_tokens (week_assignment_id, token) VALUES (?, ?)').run(
    weekAssignmentId,
    hashToken(raw)
  );
  return raw;
}

/** Resolves a raw token from an emailed link back to its week_assignment
 * (joined with player + week). Returns null if the token doesn't exist OR
 * if its week has already locked — the locked check here is a second line
 * of defense alongside invalidateTokensForWeek, in case cleanup hasn't run
 * for some reason (e.g. the cron tick that would have locked it hasn't
 * fired yet at the exact moment of the request). */
function findAssignmentByToken(rawToken) {
  const hashed = hashToken(rawToken);
  const row = db
    .prepare(
      `SELECT wa.*, p.name, p.email, w.locked AS week_locked
       FROM week_assignment_tokens t
       JOIN week_assignments wa ON wa.id = t.week_assignment_id
       JOIN players p ON p.id = wa.player_id
       JOIN weeks w ON w.id = wa.week_id
       WHERE t.token = ?`
    )
    .get(hashed);
  if (!row || row.week_locked) return null;
  return row;
}

/** Kills every outstanding link for one assignment — used when its status
 * moves away from scheduled/confirmed (needs_sub, subbed_out) or it's
 * reassigned to a different player, so a stale email can't act on behalf of
 * whoever used to be in that slot. */
function invalidateTokensForAssignment(weekAssignmentId) {
  db.prepare('DELETE FROM week_assignment_tokens WHERE week_assignment_id = ?').run(weekAssignmentId);
}

/** Kills every outstanding link for every assignment in a week — used once
 * the week locks (match time has passed), so nobody can use an old
 * reminder/follow-up email to "confirm" or "need a sub" for a match that
 * already happened. */
function invalidateTokensForWeek(weekId) {
  db.prepare(
    'DELETE FROM week_assignment_tokens WHERE week_assignment_id IN (SELECT id FROM week_assignments WHERE week_id = ?)'
  ).run(weekId);
}

module.exports = { issueToken, findAssignmentByToken, invalidateTokensForAssignment, invalidateTokensForWeek };
