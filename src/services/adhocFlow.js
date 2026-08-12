'use strict';
const db = require('../db');
const { generateRawToken, hashToken } = require('./tokens');

/**
 * Service layer for ad-hoc pickup-game sessions (sessions.session_type =
 * 'adhoc' — see "Ad-hoc sessions" in CLAUDE.md). Deliberately separate from
 * scheduleRun.js/engine.js: there is no fairness math, no blackout dates, no
 * confirm/need-a-sub flow here — courts fill first-come-first-served purely
 * from when a player clicks their "I'm in" link.
 *
 * The whole model in one paragraph: at T-minus-(adhoc_invite_lead_hours)
 * before a week's match, every currently-enrolled roster player gets a
 * single-use sign-up link (ensureInvitesForWeek). Each click stamps
 * signed_up_at = now — that timestamp IS the first-come-first-served order.
 * courtGroupsForWeek() live-computes (never stores) how those timestamps
 * chunk into complete groups of 4 vs. a single trailing incomplete group.
 * At T-minus-(adhoc_reminder_lead_hours), if there's currently an incomplete
 * group, a reminder goes only to whoever hasn't signed up yet. At
 * T-minus-(adhoc_final_lead_hours), finalizeWeek() materializes every
 * complete group into real week_assignments rows (status 'confirmed'
 * directly — signing up already IS their confirmation) and reports the
 * leftover incomplete group so the caller can send the "not enough signed
 * up" email. See cron.js's processAdhocInvites/processAdhocReminders/
 * processAdhocFinalization for the timing side of this.
 */

/**
 * Idempotently creates an adhoc_signups row (with a fresh single-use token)
 * for every active roster player who doesn't already have one for this
 * week. Safe to call more than once — a player who's already been invited
 * (row already exists) is left completely untouched, so this never mints a
 * second token or resets a timestamp. Returns only the newly-created rows
 * (with their raw tokens, for the caller to email), same shape as
 * tokenStore.issueToken's single-token return but batched.
 */
function ensureInvitesForWeek(weekId) {
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId);
  if (!week) throw new Error('Week not found');

  const roster = db
    .prepare(
      `SELECT p.id, p.name, p.email FROM session_players sp JOIN players p ON p.id = sp.player_id
       WHERE sp.session_id = ? AND p.active = 1 ORDER BY p.name`
    )
    .all(week.session_id);
  const already = new Set(
    db.prepare('SELECT player_id FROM adhoc_signups WHERE week_id = ?').all(weekId).map((r) => r.player_id)
  );

  const insert = db.prepare('INSERT INTO adhoc_signups (week_id, player_id, token) VALUES (?, ?, ?)');
  const created = [];
  for (const p of roster) {
    if (already.has(p.id)) continue;
    const raw = generateRawToken();
    insert.run(weekId, p.id, hashToken(raw));
    created.push({ player: p, token: raw });
  }
  return created;
}

/**
 * Live-computed grouping of a week's sign-ups, ordered by signed_up_at (the
 * FCFS order) — never stored, recomputed on every call from
 * adhoc_signups.signed_up_at, same "live query, not a stored flag" pattern
 * as sessionHelper.js's doubleBookingMapForSession(). `courts` is an array
 * of complete 4-player groups in formation order; `waiting` is the single
 * trailing incomplete group (0-3 players, empty array if none); `notSignedUp`
 * is everyone on the roster who's been invited but hasn't clicked yet.
 */
function courtGroupsForWeek(weekId) {
  const signedUp = db
    .prepare(
      `SELECT ads.*, p.name, p.email FROM adhoc_signups ads JOIN players p ON p.id = ads.player_id
       WHERE ads.week_id = ? AND ads.signed_up_at IS NOT NULL ORDER BY ads.signed_up_at ASC, ads.id ASC`
    )
    .all(weekId);

  const courts = [];
  let i = 0;
  for (; i + 4 <= signedUp.length; i += 4) {
    courts.push(signedUp.slice(i, i + 4));
  }
  const waiting = signedUp.slice(i);

  const notSignedUp = db
    .prepare(
      `SELECT ads.*, p.name, p.email FROM adhoc_signups ads JOIN players p ON p.id = ads.player_id
       WHERE ads.week_id = ? AND ads.signed_up_at IS NULL ORDER BY p.name`
    )
    .all(weekId);

  return { courts, waiting, notSignedUp, totalSignedUp: signedUp.length };
}

/**
 * Resolves a raw sign-up token back to its adhoc_signups row (joined with
 * player/week). Checks both `token` (the original invite) and
 * `reminder_token` (minted only if the T-30h stragglers reminder fires) —
 * either one still works, same "multiple valid tokens, nothing invalidates
 * the older one" reasoning as week_assignment_tokens/swap_requests.nudge_token.
 * Refuses (returns null) once the week has locked — same second-line-of-
 * defense reasoning as every other token lookup in this app.
 */
function findSignupByToken(rawToken) {
  const hashed = hashToken(rawToken);
  const row = db
    .prepare(
      `SELECT ads.*, p.name, p.email, w.match_date, w.locked AS week_locked, w.session_id
       FROM adhoc_signups ads
       JOIN players p ON p.id = ads.player_id
       JOIN weeks w ON w.id = ads.week_id
       WHERE ads.token = ? OR ads.reminder_token = ?`
    )
    .get(hashed, hashed);
  if (!row || row.week_locked) return null;
  return row;
}

/**
 * Mints and stores a second, additionally-valid token for the T-30h
 * stragglers-only reminder — the original invite's raw token can't be
 * reused for a new email since only its SHA-256 hash was ever stored (see
 * tokens.js). Does not touch or invalidate the original `token` column, so
 * a player's first invite email keeps working too.
 */
function mintReminderToken(signupId) {
  const raw = generateRawToken();
  db.prepare('UPDATE adhoc_signups SET reminder_token = ? WHERE id = ?').run(hashToken(raw), signupId);
  return raw;
}

/**
 * Records the click. The timestamp set here (not when the invite email was
 * sent) is the FCFS order, so this always stamps "now" regardless of how
 * long ago the invite went out. A second click on an already-signed-up link
 * is a harmless no-op — idempotent, same as every other single-action token
 * flow in this app (confirm, claim-sub, etc.).
 */
function recordSignup(rawToken) {
  const row = findSignupByToken(rawToken);
  if (!row) return null;
  if (!row.signed_up_at) {
    db.prepare("UPDATE adhoc_signups SET signed_up_at = datetime('now') WHERE id = ?").run(row.id);
  }
  return db.prepare('SELECT * FROM adhoc_signups WHERE id = ?').get(row.id);
}

/**
 * Simple in-signup-order 2v2 split for one court of 4 — deliberately no
 * partner-variety history to optimize against, unlike the regular session
 * engine's bestSplitFor4(): pickup-game partners are just whoever happened
 * to sign up around the same time, not a season-long fairness concern.
 */
function splitCourtOfFour(group) {
  return { teamA: [group[0], group[1]], teamB: [group[2], group[3]] };
}

/**
 * Finalizes a week: materializes every currently-complete court into real
 * week_assignments rows (status 'confirmed' directly — signing up already
 * IS the player's confirmation, there's no separate confirm step for
 * ad-hoc weeks), so the match then shows up on /schedule, /me, /calendar,
 * and the PDF exactly like a regular-session match, just with no sub/swap
 * actions on it (see public.js). Idempotent: a week that already has
 * week_assignments rows (already finalized) is left completely alone rather
 * than re-materializing or duplicating, so this is safe to call more than
 * once from cron. Returns the courts that were just materialized and the
 * leftover incomplete group (if any), so the caller knows who to email.
 */
function finalizeWeek(weekId) {
  const existing = db.prepare('SELECT COUNT(*) as n FROM week_assignments WHERE week_id = ?').get(weekId).n;
  if (existing > 0) return { courts: [], waiting: [], alreadyFinalized: true };

  const { courts, waiting } = courtGroupsForWeek(weekId);
  if (courts.length === 0) return { courts: [], waiting, alreadyFinalized: false };

  const insertAssignment = db.prepare(
    "INSERT INTO week_assignments (week_id, player_id, team, court, is_sub, status) VALUES (?, ?, ?, ?, 0, 'confirmed')"
  );
  const run = db.transaction(() => {
    courts.forEach((group, idx) => {
      const { teamA, teamB } = splitCourtOfFour(group);
      const courtNum = idx + 1;
      teamA.forEach((row) => insertAssignment.run(weekId, row.player_id, 'A', courtNum));
      teamB.forEach((row) => insertAssignment.run(weekId, row.player_id, 'B', courtNum));
    });
  });
  run();

  return { courts, waiting, alreadyFinalized: false };
}

/** Marks the T-30h stragglers-only reminder as sent for a batch of
 * adhoc_signups rows, so cron never sends it twice for the same player/week. */
function markReminded(signupIds) {
  if (!signupIds.length) return;
  const stmt = db.prepare("UPDATE adhoc_signups SET reminded_at = datetime('now') WHERE id = ?");
  signupIds.forEach((id) => stmt.run(id));
}

/** Marks the T-24h final email (their court, or "not enough signed up") as
 * sent for a batch of adhoc_signups rows, so cron never sends it twice. */
function markResultNotified(signupIds) {
  if (!signupIds.length) return;
  const stmt = db.prepare("UPDATE adhoc_signups SET result_notified_at = datetime('now') WHERE id = ?");
  signupIds.forEach((id) => stmt.run(id));
}

module.exports = {
  ensureInvitesForWeek,
  courtGroupsForWeek,
  findSignupByToken,
  mintReminderToken,
  recordSignup,
  finalizeWeek,
  markReminded,
  markResultNotified,
};
