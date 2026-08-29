'use strict';
const db = require('../db');
const { findActualDoubleBookings, carriedOverBlackoutsForSession } = require('./sessionHelper');
const tokenStore = require('./tokenStore');
const subFlow = require('./subFlow');
const swapFlow = require('./swapFlow');

/**
 * Advisory-only cross-session conflict resolver (Kyle, 2026-08-28: "Can we
 * build the joint solver but use it as a guide and not change anything? ...
 * the algorithm tries to resolve any conflicts and they are suggested to the
 * admin to change.").
 *
 * This is deliberately NOT a full joint re-schedule of both sessions (a
 * min-cost-max-flow reflow of every open week, which was the first design
 * discussed). A full reflow can silently reshuffle weeks that were never
 * actually in conflict, producing a large, hard-to-review diff, and — worse
 * — it would mean re-scheduling session A could change session B's schedule
 * even when the admin only touched session A. That's exactly the kind of
 * cross-session coupling that got the earlier `session_players.priority`
 * auto-exclusion reverted the same day it was built (see scheduleRun.js's
 * doc comment) — small blast radius has been the consistent philosophy for
 * every tricky cross-session feature in this app.
 *
 * Instead: for each *actual, confirmed* double-booking (from
 * findActualDoubleBookings — real week_assignments colliding on a real
 * date, not just enrollment risk), decide which session keeps the player on
 * that date (using session_players.priority as the tiebreaker, falling back
 * to a deterministic "lower session id wins" default when priority is unset
 * or tied), then search *only within the session that has to give it up* for
 * a same-session week-for-week swap with another player that clears the
 * conflict without changing anyone's target game count, without violating
 * anyone's blackout dates, and without creating a *new* cross-session
 * conflict. This mirrors the exact swap mechanic engine.js's
 * optimizePartnerVariety() already uses for partner variety (trade which
 * week two players attend, never touch the totals) — just aimed at
 * cross-session dates instead of partner spread.
 *
 * Nothing here writes to the database. It's a pure read + in-memory
 * simulation; the admin reviews the suggested before/after and makes the
 * actual change themselves via the existing Reassign tool if they agree.
 */

/** Loads everything needed to reason about one session's open (unlocked)
 * weeks: roster w/ priority, blackout set (own + carried-over from other
 * sessions, same construction as scheduleRun.js), and a mutable working copy
 * of each open week's current roster (excluding subbed_out rows — a slot
 * that's already been given away isn't "this player's" for conflict
 * purposes). Locked weeks are excluded entirely: already played, untouchable,
 * and irrelevant to a forward-looking suggestion. */
function loadSessionContext(sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return null;

  const roster = db
    .prepare(
      `SELECT sp.player_id as id, sp.target_games as target, sp.priority as priority, p.name as name
       FROM session_players sp JOIN players p ON p.id = sp.player_id
       WHERE sp.session_id = ? AND p.active = 1`
    )
    .all(sessionId);

  const weeks = db.prepare('SELECT * FROM weeks WHERE session_id = ? AND locked = 0 ORDER BY match_date').all(sessionId);

  const blackoutRows = db.prepare('SELECT player_id, date FROM blackout_dates WHERE session_id = ?').all(sessionId);
  const blackoutSet = new Set(blackoutRows.map((b) => `${b.player_id}|${b.date}`));
  for (const key of carriedOverBlackoutsForSession(sessionId).keys()) blackoutSet.add(key);

  const assignmentsByWeek = new Map();
  const originalByWeek = new Map();
  for (const w of weeks) {
    const rows = db
      .prepare(
        `SELECT wa.id, wa.player_id as playerId, wa.team, wa.court, p.name as playerName
         FROM week_assignments wa JOIN players p ON p.id = wa.player_id
         WHERE wa.week_id = ? AND wa.status != 'subbed_out'
         ORDER BY wa.court, wa.team`
      )
      .all(w.id);
    assignmentsByWeek.set(w.id, rows.map((r) => ({ ...r })));
    originalByWeek.set(w.id, rows.map((r) => ({ ...r })));
  }

  return { session, roster, weeks, blackoutSet, assignmentsByWeek, originalByWeek };
}

function isBlackedOut(ctx, playerId, date) {
  return ctx.blackoutSet.has(`${playerId}|${date}`);
}

function weekByDate(ctx, date) {
  return ctx.weeks.find((w) => w.match_date === date) || null;
}

function findAssignment(ctx, weekId, playerId) {
  const rows = ctx.assignmentsByWeek.get(weekId) || [];
  return rows.find((a) => a.playerId === playerId) || null;
}

/** Swaps which week two players attend within one session — player1 moves
 * from week1 to week2 (taking player2's slot there), player2 moves from
 * week2 to week1. Team/court stay attached to the slot, not the player,
 * same convention as the real scheduler. Mutates the working copy only.
 * Returns the two real week_assignments.id values involved (id doesn't
 * change, only who occupies the row) so a caller can later apply the same
 * swap for real with two plain UPDATEs — or null if either row is missing. */
function swapAcrossWeeks(ctx, week1Id, week2Id, player1Id, player2Id) {
  const a = findAssignment(ctx, week1Id, player1Id);
  const b = findAssignment(ctx, week2Id, player2Id);
  if (!a || !b) return null;
  const aName = a.playerName;
  const aId = a.id;
  const bId = b.id;
  a.playerId = player2Id;
  a.playerName = b.playerName;
  b.playerId = player1Id;
  b.playerName = aName;
  return { assignmentIdLeave: aId, assignmentIdPartner: bId };
}

/** Searches `moveCtx`'s other open weeks for a valid swap that moves
 * `playerId` off `leaveDate` without creating a new conflict against
 * `otherCtx` (the session staying put). Returns { week2, partner } or null. */
function findSwapCandidate(moveCtx, otherCtx, playerId, leaveDate) {
  const weekToLeave = weekByDate(moveCtx, leaveDate);
  if (!weekToLeave || !findAssignment(moveCtx, weekToLeave.id, playerId)) return null;

  for (const w2 of moveCtx.weeks) {
    if (w2.id === weekToLeave.id) continue;
    // The moving player has to actually be allowed on the new date, and not
    // already playing that week too (a small roster where someone plays
    // literally every week would otherwise produce a duplicate).
    if (isBlackedOut(moveCtx, playerId, w2.match_date)) continue;
    if (findAssignment(moveCtx, w2.id, playerId)) continue;
    // Moving the player to w2's date must not create a NEW collision with
    // the other session (i.e. they're not also playing there that day).
    const otherWeekSameDate = weekByDate(otherCtx, w2.match_date);
    if (otherWeekSameDate && findAssignment(otherCtx, otherWeekSameDate.id, playerId)) continue;

    for (const q of moveCtx.assignmentsByWeek.get(w2.id) || []) {
      if (q.playerId === playerId) continue;
      // The swap partner has to be allowed on the date they'd be moving to,
      // and not already playing that week too (same duplicate-avoidance
      // reasoning as above, the other direction).
      if (isBlackedOut(moveCtx, q.playerId, leaveDate)) continue;
      if (findAssignment(moveCtx, weekToLeave.id, q.playerId)) continue;
      // And moving THEM must not create a new collision either.
      const otherWeekLeaveDate = weekByDate(otherCtx, leaveDate);
      if (otherWeekLeaveDate && findAssignment(otherCtx, otherWeekLeaveDate.id, q.playerId)) continue;

      return { week2: w2, partner: { id: q.playerId, name: q.playerName } };
    }
  }
  return null;
}

/** Diffs a session's working copy against its original snapshot, returning
 * one entry per week that actually changed (before/after roster names). */
function diffSession(ctx, changedWeekIds) {
  const changes = [];
  for (const weekId of changedWeekIds) {
    const week = ctx.weeks.find((w) => w.id === weekId);
    const before = (ctx.originalByWeek.get(weekId) || []).map((r) => r.playerName).sort();
    const after = (ctx.assignmentsByWeek.get(weekId) || []).map((r) => r.playerName).sort();
    changes.push({ weekId, date: week ? week.match_date : null, before, after });
  }
  changes.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return changes;
}

/**
 * Top-level entry point. Returns null if either session doesn't exist.
 * Otherwise: { sessionA, sessionB, resolutions, changesA, changesB }.
 * `resolutions` is one entry per real conflict, in the order processed
 * (by date, then player name, for determinism) — see the doc comment above
 * for what each field means.
 */
function resolveConflicts(sessionAId, sessionBId) {
  sessionAId = Number(sessionAId);
  sessionBId = Number(sessionBId);
  const ctxA = loadSessionContext(sessionAId);
  const ctxB = loadSessionContext(sessionBId);
  if (!ctxA || !ctxB) return null;
  const ctxBySession = { [sessionAId]: ctxA, [sessionBId]: ctxB };

  const rawViolations = findActualDoubleBookings(sessionAId).filter(
    (v) =>
      (v.sessionA.id === sessionAId && v.sessionB.id === sessionBId) ||
      (v.sessionA.id === sessionBId && v.sessionB.id === sessionAId)
  );
  rawViolations.sort((a, b) => a.date.localeCompare(b.date) || a.player.name.localeCompare(b.player.name));

  const changedWeekIds = { [sessionAId]: new Set(), [sessionBId]: new Set() };
  const resolutions = [];

  for (const v of rawViolations) {
    const playerId = v.player.id;
    const date = v.date;

    const rosterA = ctxA.roster.find((p) => p.id === playerId);
    const rosterB = ctxB.roster.find((p) => p.id === playerId);
    const priorityA = rosterA ? rosterA.priority : null;
    const priorityB = rosterB ? rosterB.priority : null;

    let keepSessionId;
    let reason;
    if (priorityA != null && priorityB != null && priorityA !== priorityB) {
      keepSessionId = priorityA < priorityB ? sessionAId : sessionBId;
      reason = 'priority';
    } else {
      // Tied or one/both unset: deterministic default (lower session id
      // keeps the date) so the suggestion is at least stable and reviewable
      // — flagged clearly in the UI as an arbitrary pick, not a real signal.
      keepSessionId = Math.min(sessionAId, sessionBId);
      reason = priorityA == null || priorityB == null ? 'no-priority' : 'tied';
    }
    let moveSessionId = keepSessionId === sessionAId ? sessionBId : sessionAId;

    const resolution = {
      playerId,
      playerName: v.player.name,
      date,
      priorityA,
      priorityB,
      keepSessionId,
      moveSessionId,
      reason,
      resolved: false,
      swap: null,
    };

    // Try moving the "losing" session's occupant first; if no valid swap
    // exists there, fall back to trying to move the "keeping" session's
    // occupant instead (better to resolve it somewhere than not at all —
    // the priority is a preference, not a hard requirement for HOW it's
    // resolved when only one direction is actually possible).
    let found = findSwapCandidate(ctxBySession[moveSessionId], ctxBySession[keepSessionId], playerId, date);
    let actualMoveSessionId = moveSessionId;
    if (!found) {
      found = findSwapCandidate(ctxBySession[keepSessionId], ctxBySession[moveSessionId], playerId, date);
      actualMoveSessionId = keepSessionId;
    }

    if (found) {
      const moveCtx = ctxBySession[actualMoveSessionId];
      const weekToLeave = weekByDate(moveCtx, date);
      const applied = swapAcrossWeeks(moveCtx, weekToLeave.id, found.week2.id, playerId, found.partner.id);
      if (applied) {
        changedWeekIds[actualMoveSessionId].add(weekToLeave.id);
        changedWeekIds[actualMoveSessionId].add(found.week2.id);
        resolution.resolved = true;
        resolution.actualMoveSessionId = actualMoveSessionId;
        resolution.swap = {
          session: actualMoveSessionId,
          movedFromDate: date,
          movedToDate: found.week2.match_date,
          swappedWithPlayerId: found.partner.id,
          swappedWithPlayerName: found.partner.name,
          // Real week_assignments row ids for the two halves of this swap —
          // assignmentIdLeave currently holds `playerId` and should end up
          // holding `swappedWithPlayerId`; assignmentIdPartner is the
          // reverse. See applyResolutions() below, the only consumer of
          // these that actually writes to the database.
          assignmentIdLeave: applied.assignmentIdLeave,
          assignmentIdPartner: applied.assignmentIdPartner,
        };
      }
    }

    resolutions.push(resolution);
  }

  return {
    sessionA: ctxA.session,
    sessionB: ctxB.session,
    resolutions,
    changesA: diffSession(ctxA, changedWeekIds[sessionAId]),
    changesB: diffSession(ctxB, changedWeekIds[sessionBId]),
  };
}

/**
 * Applies every currently-resolvable suggestion for real (Kyle, 2026-08-28,
 * a follow-up to the advisory-only page above: "Let's put a button on the
 * resolve conflict to accept all the suggested changes."). This is the one
 * place in this module that writes to the database — everything above stays
 * a pure read-and-simulate.
 *
 * Deliberately re-runs resolveConflicts() itself rather than trusting a
 * `result` object handed in from an earlier render: the page could have been
 * open for a while, and applying stale suggestions against a schedule that's
 * since changed (a manual Reassign, another apply, a re-schedule) would be
 * actively wrong rather than just unhelpful. Recomputing fresh means this is
 * always applying exactly what the admin would see if they reloaded the page
 * right before clicking the button.
 *
 * Each accepted swap is applied the same way a real accepted direct swap is
 * (swapFlow.js's respondToSwap(): update player_id on both rows, invalidate
 * old tokens on both) except status resets to 'scheduled' rather than jumping
 * straight to 'confirmed' — this is an admin override on the players' behalf,
 * not something either player actually clicked "accept" on, so they should
 * still go through the normal reminder/confirm cycle for their new date
 * rather than the page silently claiming they've confirmed something they
 * haven't. Also runs the same closeActiveSubRequestForAssignment/
 * adminCancelSwap cleanup a manual Reassign already runs, in case either half
 * of the swap had something else in flight. Every unresolved conflict is left
 * exactly as-is — this never touches anything it couldn't find a clean
 * same-session swap for.
 *
 * Returns { appliedCount, remaining } — remaining is the freshly-recomputed
 * result *after* applying, so the caller can show what (if anything) is still
 * outstanding without a second round trip.
 */
function applyResolutions(sessionAId, sessionBId) {
  const result = resolveConflicts(sessionAId, sessionBId);
  if (!result) return { appliedCount: 0, remaining: null };

  const toApply = result.resolutions.filter((r) => r.resolved && r.swap && r.swap.assignmentIdLeave && r.swap.assignmentIdPartner);
  let appliedCount = 0;

  db.transaction(() => {
    for (const r of toApply) {
      const { assignmentIdLeave, assignmentIdPartner, swappedWithPlayerId } = r.swap;
      const rowLeave = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(assignmentIdLeave);
      const rowPartner = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(assignmentIdPartner);
      if (!rowLeave || !rowPartner) continue; // defensive: row vanished since computed
      const weekLeave = db.prepare('SELECT locked FROM weeks WHERE id = ?').get(rowLeave.week_id);
      const weekPartner = db.prepare('SELECT locked FROM weeks WHERE id = ?').get(rowPartner.week_id);
      if ((weekLeave && weekLeave.locked) || (weekPartner && weekPartner.locked)) continue; // defensive: locked since computed

      db.prepare(`UPDATE week_assignments SET player_id = ?, status = 'scheduled' WHERE id = ?`).run(
        swappedWithPlayerId,
        assignmentIdLeave
      );
      db.prepare(`UPDATE week_assignments SET player_id = ?, status = 'scheduled' WHERE id = ?`).run(
        r.playerId,
        assignmentIdPartner
      );
      tokenStore.invalidateTokensForAssignment(assignmentIdLeave);
      tokenStore.invalidateTokensForAssignment(assignmentIdPartner);
      subFlow.closeActiveSubRequestForAssignment(assignmentIdLeave);
      subFlow.closeActiveSubRequestForAssignment(assignmentIdPartner);
      swapFlow.adminCancelSwap(assignmentIdLeave);
      swapFlow.adminCancelSwap(assignmentIdPartner);
      appliedCount++;
    }
  })();

  return { appliedCount, remaining: resolveConflicts(sessionAId, sessionBId) };
}

module.exports = { resolveConflicts, applyResolutions };
