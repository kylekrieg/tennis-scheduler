'use strict';
// Season sign-ups (Kyle, 2026-09-23) — see "Season sign-ups" in CLAUDE.md and
// schema.sql's comments on session_signup_candidates/session_signups for the
// full design. Short version: before an admin hand-types every player's
// target_games on session_form.ejs, players can declare a percentage-of-
// season commitment themselves (full/half/quarter, admin-defined per
// session), the app turns that into a whole number of weeks, and the admin
// reviews whether everyone's numbers actually add up to the available
// slots before applying them to the real roster.
const db = require('../db');
const { ensureWeeksExist } = require('./scheduleRun');
const { fullName } = require('./playerName');

const TIERS = ['full', 'half', 'quarter', 'sub'];
const TIER_LABELS = { full: 'Full time', half: 'Half time', quarter: 'Quarter time', sub: 'Sub only (not on the roster)' };
// Percentage tiers only — 'sub' isn't a fraction of the season, it's a flat
// opt-out of the roster, so it's deliberately excluded from PERCENT_TIERS
// and has no session.signup_pct_* column of its own.
const PERCENT_TIERS = ['full', 'half', 'quarter'];

class SignupError extends Error {}

/** This session's three tier percentages, as {full, half, quarter}. */
function tierPercents(session) {
  return {
    full: session.signup_pct_full,
    half: session.signup_pct_half,
    quarter: session.signup_pct_quarter,
  };
}

function isValidTier(tier) {
  return TIERS.includes(tier);
}

// Rounds to the nearest whole week (Kyle's own call — see the "Rounding
// rule" discussion in CLAUDE.md's dated entry for this feature): 75% of 17
// weeks is 12.75, which rounds up to 13 rather than always flooring or
// always ceiling. Clamped to [0, totalWeeks] defensively — a percentage
// somehow set above 100 or below 0 (validated against on save, but this is
// the one place every caller funnels through) can never produce a week
// count that doesn't make sense against the season length.
function weeksForPercent(totalWeeks, pct) {
  const raw = Math.round((Number(pct) || 0) / 100 * totalWeeks);
  return Math.max(0, Math.min(totalWeeks, raw));
}

/**
 * Ensures this session's `weeks` rows exist (same idempotent call the
 * blackout pages already make — sign-ups need to happen before the first
 * "Schedule these players" run, same as blackout dates, so the match-date
 * list has to be generated on demand rather than assumed to already exist)
 * and returns { session, weeks, totalWeeks }.
 */
function seasonContext(sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) throw new SignupError('Session not found');
  if (session.status === 'draft') ensureWeeksExist(session.id);
  const weeks = db.prepare('SELECT * FROM weeks WHERE session_id = ? ORDER BY match_date').all(session.id);
  return { session, weeks, totalWeeks: weeks.length };
}

/** Every active player currently on this session's sign-up candidate list. */
function candidatesForSession(sessionId) {
  return db
    .prepare(
      `SELECT p.* FROM session_signup_candidates sc JOIN players p ON p.id = sc.player_id
       WHERE sc.session_id = ? AND p.active = 1 ORDER BY p.name`
    )
    .all(sessionId);
}

function isCandidate(sessionId, playerId) {
  return !!db
    .prepare('SELECT 1 FROM session_signup_candidates WHERE session_id = ? AND player_id = ?')
    .get(sessionId, playerId);
}

/**
 * Every sign-up recorded for this session, joined to the player, with a
 * `stale` flag (Kyle, 2026-09-23: "changed since it was last applied") set
 * whenever the row's been saved again since the last time it was copied
 * into the real roster (or was never applied at all).
 */
function signupsForSession(sessionId) {
  const rows = db
    .prepare(
      `SELECT s.*, p.name, p.full_name FROM session_signups s JOIN players p ON p.id = s.player_id
       WHERE s.session_id = ? ORDER BY p.name`
    )
    .all(sessionId);
  return rows.map((r) => ({
    ...r,
    playerName: fullName(r),
    stale: !r.applied_at,
  }));
}

/**
 * Admin picks who's even offered a sign-up link — mirrors saveAdhocRoster()
 * in admin.js (plain add/remove against a checked list, nothing fancier).
 * Deliberately does NOT touch session_signups for anyone removed — a
 * player's already-recorded sign-up is real history; taking them off the
 * candidate list just stops offering them a link going forward.
 */
function saveCandidates(sessionId, playerIds) {
  const wanted = new Set(playerIds.map(Number).filter(Boolean));
  const existing = new Set(
    db.prepare('SELECT player_id FROM session_signup_candidates WHERE session_id = ?').all(sessionId).map((r) => r.player_id)
  );
  const insert = db.prepare('INSERT INTO session_signup_candidates (session_id, player_id) VALUES (?, ?)');
  const del = db.prepare('DELETE FROM session_signup_candidates WHERE session_id = ? AND player_id = ?');
  let added = 0;
  let removed = 0;
  for (const pid of wanted) {
    if (!existing.has(pid)) {
      insert.run(sessionId, pid);
      added++;
    }
  }
  for (const pid of existing) {
    if (!wanted.has(pid)) {
      del.run(sessionId, pid);
      removed++;
    }
  }
  return { added, removed };
}

function saveTierPercents(sessionId, { full, half, quarter }) {
  const vals = [full, half, quarter].map(Number);
  if (!vals.every((n) => Number.isInteger(n) && n > 0 && n <= 100)) {
    throw new SignupError('Each tier percentage must be a whole number between 1 and 100.');
  }
  db.prepare('UPDATE sessions SET signup_pct_full = ?, signup_pct_half = ?, signup_pct_quarter = ? WHERE id = ?').run(
    vals[0],
    vals[1],
    vals[2],
    sessionId
  );
}

/**
 * A player (or an admin, on their behalf) declares a tier. Always
 * recomputes `weeks` from the session's *current* tier percentages rather
 * than trusting anything submitted by the client, and always resets
 * `applied_at` to NULL — even a re-save of the same tier counts as "not
 * confirmed applied since this save," which just means a harmless no-op
 * re-apply later, never a stale, silently-wrong roster number.
 */
function submitSignup(sessionId, playerId, tier) {
  if (!isValidTier(tier)) throw new SignupError('Not a valid sign-up tier.');
  const { session, totalWeeks } = seasonContext(sessionId);
  // 'sub' (Kyle, 2026-09-23: "a player might be on the roster but does not
  // want to play that session so they might be downgraded to a sub") always
  // computes to 0 weeks — it isn't a percentage of the season at all, it's a
  // declaration that this player doesn't want a roster spot this time. See
  // applySignupsToRoster() below for what actually happens to them on apply.
  const weeks = tier === 'sub' ? 0 : weeksForPercent(totalWeeks, tierPercents(session)[tier]);
  const existing = db.prepare('SELECT id FROM session_signups WHERE session_id = ? AND player_id = ?').get(sessionId, playerId);
  if (existing) {
    db.prepare(
      `UPDATE session_signups SET tier = ?, weeks = ?, applied_at = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(tier, weeks, existing.id);
  } else {
    db.prepare(
      `INSERT INTO session_signups (session_id, player_id, tier, weeks) VALUES (?, ?, ?, ?)`
    ).run(sessionId, playerId, tier, weeks);
  }
  return weeks;
}

/**
 * How this session's sign-ups stack up against the actual number of slots
 * available (Kyle, 2026-09-23: "if there are 10 players and 17 weeks, not
 * everybody can sign up for a full time slot... that needs to be flagged on
 * the admin side"). `totalSlots` mirrors session_form.ejs's own
 * open-weeks x players-per-week math exactly (see that page's `recalc()`) —
 * this is the same capacity question, just asked of sign-ups instead of
 * hand-typed targets.
 */
function capacitySummary(sessionId) {
  const { session, totalWeeks } = seasonContext(sessionId);
  const totalSlots = totalWeeks * session.players_per_week;
  const signups = signupsForSession(sessionId);
  const signedUpWeeks = signups.reduce((sum, s) => sum + s.weeks, 0);
  const candidates = candidatesForSession(sessionId);
  const signedUpPlayerIds = new Set(signups.map((s) => s.player_id));
  const notYetSignedUp = candidates.filter((p) => !signedUpPlayerIds.has(p.id));
  // Sign-ups that opted for "sub only" contribute 0 weeks (already excluded
  // from signedUpWeeks above by construction), but they're worth calling out
  // separately from "hasn't answered yet" — this is a real answer, just not
  // one that fills a roster slot.
  const optedForSub = signups.filter((s) => s.tier === 'sub');
  return {
    totalWeeks,
    playersPerWeek: session.players_per_week,
    totalSlots,
    signedUpWeeks,
    delta: signedUpWeeks - totalSlots, // positive = oversubscribed, negative = still room
    signups,
    candidates,
    notYetSignedUp,
    optedForSub,
  };
}

/**
 * Copies every sign-up's computed `weeks` into session_players.target_games
 * — the admin's deliberate "yes, use these numbers" action (Kyle's own
 * answer to "should sign-ups write the roster directly or stay separate
 * until applied": stay separate). Mirrors admin.js's saveRoster() INSERT-vs-
 * UPDATE shape exactly, including the same original_target-snapshotted-
 * once-at-first-enrollment rule, so a player who signs up for the first
 * time behaves identically to an admin typing their first target by hand.
 * Marks every applied row's applied_at so the review page can tell what's
 * current; a sign-up saved again after this will flip back to "stale" (see
 * submitSignup() above) until applied a second time.
 */
function applySignupsToRoster(sessionId) {
  const rows = db
    .prepare(
      `SELECT s.*, p.name, p.full_name FROM session_signups s JOIN players p ON p.id = s.player_id
       WHERE s.session_id = ?`
    )
    .all(sessionId);
  const existingByPid = new Map(
    db.prepare('SELECT player_id, target_games FROM session_players WHERE session_id = ?').all(sessionId).map((r) => [r.player_id, r])
  );
  const added = [];
  const updated = [];
  // "A player might be on the roster but does not want to play that
  // session so they might be downgraded to a sub" (Kyle, 2026-09-23) — a
  // 'sub' sign-up is the opposite of every other tier: applying it REMOVES
  // any existing session_players row (rather than setting a target) and
  // adds them to session_sub_players instead, the same table "Manage subs"
  // already uses for a session's own sub candidates (see subFlow.js's
  // sessionSubList(), which merges this with broader_sub_list). Someone who
  // signs up for a real tier after previously being a sub gets the reverse
  // cleanup — removed from session_sub_players so they're not listed as
  // both a roster player and a sub candidate at once (the session-detail
  // sub dropdown already filters that case out defensively, but there's no
  // reason to leave the stale row behind).
  const movedToSubs = [];
  const markApplied = db.prepare(`UPDATE session_signups SET applied_at = datetime('now') WHERE id = ?`);
  const addAsSub = db.prepare('INSERT OR IGNORE INTO session_sub_players (session_id, player_id) VALUES (?, ?)');
  const removeAsSub = db.prepare('DELETE FROM session_sub_players WHERE session_id = ? AND player_id = ?');
  db.transaction(() => {
    for (const row of rows) {
      if (row.tier === 'sub') {
        if (existingByPid.has(row.player_id)) {
          db.prepare('DELETE FROM session_players WHERE session_id = ? AND player_id = ?').run(sessionId, row.player_id);
          movedToSubs.push(fullName(row));
        }
        addAsSub.run(sessionId, row.player_id);
      } else if (existingByPid.has(row.player_id)) {
        const before = existingByPid.get(row.player_id);
        if (before.target_games !== row.weeks) {
          db.prepare('UPDATE session_players SET target_games = ? WHERE session_id = ? AND player_id = ?').run(
            row.weeks,
            sessionId,
            row.player_id
          );
          updated.push(fullName(row));
        }
        removeAsSub.run(sessionId, row.player_id);
      } else {
        // original_target is set here, at first enrollment, and only here —
        // see admin.js's saveRoster() for the identical rule this mirrors.
        db.prepare(
          'INSERT INTO session_players (session_id, player_id, target_games, original_target) VALUES (?, ?, ?, ?)'
        ).run(sessionId, row.player_id, row.weeks, row.weeks);
        added.push(fullName(row));
        removeAsSub.run(sessionId, row.player_id);
      }
      markApplied.run(row.id);
    }
  })();
  return { added, updated, movedToSubs, count: rows.length };
}

module.exports = {
  TIERS,
  PERCENT_TIERS,
  TIER_LABELS,
  SignupError,
  tierPercents,
  isValidTier,
  weeksForPercent,
  seasonContext,
  candidatesForSession,
  isCandidate,
  signupsForSession,
  saveCandidates,
  saveTierPercents,
  submitSignup,
  capacitySummary,
  applySignupsToRoster,
};
