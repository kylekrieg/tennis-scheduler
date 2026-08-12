'use strict';
const db = require('../db');

/** Sessions with a generated schedule worth showing on public pages.
 * Archived sessions (archived_at set — see "Archiving" in CLAUDE.md) are
 * excluded even if their status would otherwise qualify: archiving is meant
 * to fully hide a session from players, not just from the admin dashboard. */
function getViewableSessions() {
  return db
    .prepare(`SELECT * FROM sessions WHERE status IN ('scheduled', 'active') AND archived_at IS NULL ORDER BY start_date DESC`)
    .all();
}

/** Same, but also includes 'draft' sessions — used only by the blackout-dates
 * page, since players must be able to pick blackout dates *before* the admin
 * clicks "Schedule these players" (which is what moves a session out of
 * draft). Every other public page (schedule, lookahead, calendar, pdf,
 * request-sub) has nothing to show until a real schedule exists, so they
 * stick with getViewableSessions(). */
function getBlackoutViewableSessions() {
  // session_type = 'regular' only — ad-hoc sessions have no blackout-dates
  // concept at all (no draft phase, no target-games math to protect); see
  // "Ad-hoc sessions" in CLAUDE.md.
  return db
    .prepare(`SELECT * FROM sessions WHERE status IN ('draft', 'scheduled', 'active') AND archived_at IS NULL AND session_type = 'regular' ORDER BY start_date DESC`)
    .all();
}

/** Resolves which session a public page should show: an explicit ?session=
 * query param if valid, otherwise the most relevant viewable session.
 * Since overlapping/concurrent sessions are allowed, more than one may be
 * viewable at once — the picker in the view lets the visitor switch.
 * Pass includeDraft: true for the blackout-dates page. Pass regularOnly:
 * true for Request a Sub / Swap a Week — ad-hoc sessions have no sub/swap
 * concept at all (no fixed roster to sub out of — see "Ad-hoc sessions" in
 * CLAUDE.md), so they're excluded from the pool entirely rather than just
 * hidden after the fact, which could otherwise leave `session` resolved to
 * an ad-hoc one with no regular fallback available. */
function resolveSession(req, { includeDraft = false, regularOnly = false } = {}) {
  let sessions = includeDraft ? getBlackoutViewableSessions() : getViewableSessions();
  if (regularOnly) sessions = sessions.filter((s) => s.session_type === 'regular');
  if (sessions.length === 0) return { session: null, sessions };

  const requestedId = Number(req.query.session);
  if (requestedId) {
    const found = sessions.find((s) => s.id === requestedId);
    if (found) return { session: found, sessions };
  }

  const active = sessions.find((s) => s.status === 'active');
  return { session: active || sessions[0], sessions };
}

/**
 * Finds players double-booked across two non-archived sessions that meet on
 * the same day of week with overlapping date ranges — a genuine scheduling
 * risk that nothing previously checked (see Full_Scope_Of_Work.md §14,
 * question 4: concurrent/overlapping sessions are supported by design, but
 * the scheduler operates entirely within one session_id and never looks at
 * a player's assignments in any other session).
 *
 * Deliberately a warning, not a hard block, same as the admin blackout
 * override and understaffed-week handling elsewhere in the app — two
 * sessions sharing a day of week and date range might be totally fine (e.g.
 * different match_time hours apart), so this surfaces the specific
 * player/session pairs for the admin to judge rather than refusing to save.
 * match_time is intentionally *not* part of the trigger condition — there's
 * no match-duration field to compare against, so "same day, overlapping
 * dates" is the trigger, and both sessions' match_time are included in the
 * caller-facing message so the admin can judge for themselves how real the
 * conflict is.
 *
 * Pass a sessionId to scope results to conflicts involving one specific
 * session (used right after saving its roster/dates); omit it to check every
 * non-archived session against every other, for the flattened Status page
 * view.
 *
 * Returns one row per (session pair, shared player): { sessionA, sessionB,
 * player, priorityA, priorityB, resolution }. `priorityA`/`priorityB` are the
 * player's `session_players.priority` value in sessionA/sessionB respectively
 * (see the `priority` column added in db/index.js's ensureColumn — lower
 * number is meant to indicate the session that should probably win if a real
 * conflict comes up). `resolution` is purely descriptive now — priority is
 * advisory only, the scheduler never acts on it (see scheduleRun.js's doc
 * comment for why the auto-exclusion this used to drive was reverted
 * 2026-08-11):
 *   - 'unresolved': either side's priority is NULL — no preference recorded.
 *   - 'tied': both sides have the same non-null priority — ambiguous.
 *   - 'a_wins' / 'b_wins': priority is set and distinct, indicating which
 *     session the admin has flagged as higher priority for this player —
 *     informational only, not enforced.
 */
function findOverlappingSessionEnrollments(sessionId = null) {
  const sessions = db.prepare(`SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY start_date`).all();
  const scopedId = sessionId ? Number(sessionId) : null;
  const conflicts = [];

  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i];
      const b = sessions[j];
      if (scopedId && a.id !== scopedId && b.id !== scopedId) continue;
      if (a.match_day_of_week !== b.match_day_of_week) continue;
      // Inclusive date-range overlap test.
      if (!(a.start_date <= b.end_date && b.start_date <= a.end_date)) continue;

      const sharedPlayers = db
        .prepare(
          `SELECT p.id, p.name, spa.priority as priorityA, spb.priority as priorityB
           FROM session_players spa
           JOIN session_players spb ON spb.player_id = spa.player_id AND spb.session_id = ?
           JOIN players p ON p.id = spa.player_id
           WHERE spa.session_id = ? AND p.active = 1
           ORDER BY p.name`
        )
        .all(b.id, a.id);

      for (const row of sharedPlayers) {
        const { id, name, priorityA, priorityB } = row;
        let resolution = 'unresolved';
        if (priorityA != null && priorityB != null) {
          if (priorityA === priorityB) resolution = 'tied';
          else resolution = priorityA < priorityB ? 'a_wins' : 'b_wins';
        }
        conflicts.push({ sessionA: a, sessionB: b, player: { id, name }, priorityA, priorityB, resolution });
      }
    }
  }

  return conflicts;
}

/**
 * A stronger, more concrete cousin of findOverlappingSessionEnrollments()
 * above: that function flags players *enrolled* in two sessions that could
 * collide (a risk); this one finds players *actually assigned* to play in
 * two different non-archived sessions on the very same calendar date (a
 * confirmed, real conflict, regardless of how it happened — an admin
 * reassign, "Add a player" on an understaffed week, or a direct swap between
 * two players — see swapFlow.js). Kyle asked specifically that a swap which
 * creates one of these not be blocked (the two players already agreed to the
 * trade), just flagged here for the admin to fix manually — same
 * warn-don't-block philosophy as every other conflict in this app.
 *
 * Deliberately a live, computed-at-render-time query rather than a stored
 * flag: it always reflects the database's actual current state, so fixing
 * either assignment (e.g. via Reassign) makes the flag disappear on its own
 * next render, with nothing extra to clean up.
 *
 * Returns one row per (player, date, session pair):
 * { player, date, sessionA, sessionB }.
 */
function findActualDoubleBookings(sessionId = null) {
  const scopedId = sessionId ? Number(sessionId) : null;
  const rows = db
    .prepare(
      `SELECT p.id as playerId, p.name as playerName, w1.match_date as date,
              s1.id as session1Id, s1.name as session1Name, s1.club_name as session1Club, s1.court_info as session1Court, s1.match_time as session1Time,
              s2.id as session2Id, s2.name as session2Name, s2.club_name as session2Club, s2.court_info as session2Court, s2.match_time as session2Time
       FROM week_assignments wa1
       JOIN weeks w1 ON w1.id = wa1.week_id
       JOIN sessions s1 ON s1.id = w1.session_id
       JOIN week_assignments wa2 ON wa2.player_id = wa1.player_id AND wa2.id != wa1.id
       JOIN weeks w2 ON w2.id = wa2.week_id AND w2.match_date = w1.match_date
       JOIN sessions s2 ON s2.id = w2.session_id AND s2.id != s1.id
       JOIN players p ON p.id = wa1.player_id
       WHERE wa1.status != 'subbed_out' AND wa2.status != 'subbed_out'
         AND s1.archived_at IS NULL AND s2.archived_at IS NULL
         AND s1.id < s2.id
       ORDER BY w1.match_date, p.name`
    )
    .all()
    .filter((r) => !scopedId || r.session1Id === scopedId || r.session2Id === scopedId);

  return rows.map((r) => ({
    player: { id: r.playerId, name: r.playerName },
    date: r.date,
    sessionA: { id: r.session1Id, name: r.session1Name, club_name: r.session1Club, court_info: r.session1Court, match_time: r.session1Time },
    sessionB: { id: r.session2Id, name: r.session2Name, club_name: r.session2Club, court_info: r.session2Court, match_time: r.session2Time },
  }));
}

/**
 * Player-facing convenience wrapper around findActualDoubleBookings(), scoped
 * to one session's point of view: "for a player+date in *this* session, which
 * other session are they also booked into?" Added 2026-08-11 alongside the
 * priority-to-warn-only revert (see scheduleRun.js's doc comment) — since the
 * scheduler no longer prevents a double-booking, players need to see it
 * themselves, weeks in advance, on the pages they already look at (schedule,
 * lookahead, My Page) rather than only the admin catching it later.
 *
 * Returns a Map keyed by `${playerId}|${matchDate}` -> the *other* session
 * object ({id, name, ...full row}). Every consumer of findActualDoubleBookings
 * that only cares about one session's assignments (not the flat admin list)
 * should use this instead of re-deriving sessionA/sessionB comparisons itself.
 */
function doubleBookingMapForSession(sessionId) {
  const rows = findActualDoubleBookings(sessionId);
  const map = new Map();
  for (const r of rows) {
    const other = r.sessionA.id === Number(sessionId) ? r.sessionB : r.sessionA;
    map.set(`${r.player.id}|${r.date}`, other);
  }
  return map;
}

module.exports = {
  getViewableSessions,
  getBlackoutViewableSessions,
  resolveSession,
  findOverlappingSessionEnrollments,
  findActualDoubleBookings,
  doubleBookingMapForSession,
};
