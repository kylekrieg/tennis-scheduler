'use strict';
const db = require('../db');
const { generateRawToken, hashToken } = require('./tokens');
const tokenStore = require('./tokenStore');
const { logPlayerActivity } = require('./activityLog');
const email = require('./email');
const { zonedTimeToUtc } = require('./tz');
const { getTimezone } = require('./settings');

/**
 * Direct player-to-player swaps: a two-way trade of two specific players' own
 * upcoming slots, distinct from subFlow.js's sub_requests/sub_offers (a
 * one-to-many fan-out where someone drops out and anyone can claim it). Here
 * the initiator picks exactly one other player and exactly one of that
 * player's own weeks to trade for — nobody else is involved, and neither
 * side becomes a "sub" in the season-target sense (is_sub stays 0 for both;
 * they're each still playing their own configured number of games, just on a
 * different date). Kyle's request, 2026-08-11: self-service, requires the
 * other player's confirmation, and a swap that happens to create an actual
 * cross-session double-booking is flagged for the admin rather than blocked
 * (see sessionHelper.js's findActualDoubleBookings()) — the two players
 * already agreed to this trade, so refusing it outright would be a worse
 * outcome than just surfacing the conflict for a human to sort out.
 */

/** Looks up a pending (or since-resolved) swap by either its original token
 * or the second, additionally-valid nudge token (see nudgeOverdueSwaps()
 * below) — mirrors tokenStore.js's "multiple valid tokens for one thing"
 * pattern rather than rotating/invalidating the original link when a nudge
 * goes out. Used by both the GET landing page and respondToSwap() itself, so
 * there's exactly one place that knows about the two-token shape. */
function findSwapRequestByToken(rawToken) {
  const hashed = hashToken(rawToken);
  return db.prepare('SELECT * FROM swap_requests WHERE token = ? OR nudge_token = ?').get(hashed, hashed);
}

function getAssignmentContext(assignmentId) {
  const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(assignmentId);
  if (!assignment) return null;
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(assignment.week_id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(assignment.player_id);
  return { assignment, week, session, player };
}

/** An assignment is swappable at all if its week hasn't locked and nobody's
 * already mid-flow on it (a sub request or another swap already pending). */
function isAssignmentSwappable(assignmentId, excludeSwapRequestId = null) {
  const ctx = getAssignmentContext(assignmentId);
  if (!ctx) return false;
  if (ctx.week.locked) return false;
  if (!['scheduled', 'confirmed'].includes(ctx.assignment.status)) return false;
  const activeSub = db
    .prepare(`SELECT id FROM sub_requests WHERE week_assignment_id = ? AND status IN ('open', 'escalated')`)
    .get(assignmentId);
  if (activeSub) return false;
  // excludeSwapRequestId lets a swap's own accept-time re-validation ignore
  // itself here — otherwise the just-created pending row would make both of
  // its own assignments look "already mid-flow" and the swap could never be
  // accepted. Every other caller (a brand new proposal) passes nothing, so
  // any *other* pending swap on either assignment still correctly blocks it.
  const activeSwap = db
    .prepare(
      `SELECT id FROM swap_requests WHERE status = 'pending' AND (initiator_assignment_id = ? OR target_assignment_id = ?) AND id != ?`
    )
    .get(assignmentId, assignmentId, excludeSwapRequestId || 0);
  if (activeSwap) return false;
  return true;
}

/** A player's own upcoming, swappable assignments in a session — step 1 of
 * the self-service picker ("which of your weeks do you want to give up"). */
function eligibleOwnAssignments(sessionId, playerId) {
  const rows = db
    .prepare(
      `SELECT wa.* FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id
       WHERE w.session_id = ? AND wa.player_id = ? AND w.locked = 0
         AND wa.status IN ('scheduled', 'confirmed')
       ORDER BY w.match_date`
    )
    .all(sessionId, playerId);
  return rows.filter((r) => isAssignmentSwappable(r.id)).map((r) => ({ ...r, ...getAssignmentContext(r.id) }));
}

/** Given the initiator's chosen assignment, which of a specific target
 * player's own upcoming assignments could actually be swapped for it —
 * excludes the target's own blacked-out dates for the initiator's week, the
 * initiator's blacked-out dates for the target's week, same-week pairs
 * (nothing to trade — see swapFlow.js's own doc comment), and anything that
 * would collide with an assignment either player already has that week.
 * Pass excludeSwapRequestId when re-validating a specific pending request at
 * accept time, so it doesn't see itself as a blocking conflict (see
 * isAssignmentSwappable above). */
function eligibleTargetAssignments(initiatorAssignmentId, targetPlayerId, excludeSwapRequestId = null) {
  const initiatorCtx = getAssignmentContext(initiatorAssignmentId);
  if (!initiatorCtx) return [];
  const { session, week: initiatorWeek, player: initiatorPlayer } = initiatorCtx;

  const targetRows = db
    .prepare(
      `SELECT wa.* FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id
       WHERE w.session_id = ? AND wa.player_id = ? AND w.locked = 0
         AND wa.status IN ('scheduled', 'confirmed') AND w.id != ?
       ORDER BY w.match_date`
    )
    .all(session.id, targetPlayerId, initiatorWeek.id)
    .filter((r) => isAssignmentSwappable(r.id, excludeSwapRequestId));

  const blackouts = new Set(
    db
      .prepare('SELECT player_id, date FROM blackout_dates WHERE session_id = ?')
      .all(session.id)
      .map((b) => `${b.player_id}|${b.date}`)
  );

  return targetRows
    .filter((r) => {
      const targetWeek = db.prepare('SELECT * FROM weeks WHERE id = ?').get(r.week_id);
      // Neither player can already be blacked out on the date they'd be
      // moving into — self-service has no admin around to override this.
      if (blackouts.has(`${targetPlayerId}|${initiatorWeek.match_date}`)) return false;
      if (blackouts.has(`${initiatorPlayer.id}|${targetWeek.match_date}`)) return false;
      // Neither player can already have a (different) slot in the week
      // they'd be moving into — would collide with the UNIQUE(week_id,
      // player_id) constraint once the swap applies.
      const initiatorAlreadyInTargetWeek = db
        .prepare('SELECT 1 FROM week_assignments WHERE week_id = ? AND player_id = ?')
        .get(targetWeek.id, initiatorPlayer.id);
      if (initiatorAlreadyInTargetWeek) return false;
      const targetAlreadyInInitiatorWeek = db
        .prepare('SELECT 1 FROM week_assignments WHERE week_id = ? AND player_id = ?')
        .get(initiatorWeek.id, targetPlayerId);
      if (targetAlreadyInInitiatorWeek) return false;
      return true;
    })
    .map((r) => ({ ...r, week: db.prepare('SELECT * FROM weeks WHERE id = ?').get(r.week_id) }));
}

/** Creates the proposal, emails the target player an accept/decline link,
 * and confirms to the initiator that it went out (same wrong-name safety net
 * as subFlow.js's sendSubRequestOwnConfirmation). Re-validates eligibility
 * server-side even though the picker UI already filtered — defense against
 * a stale page or a state change between load and submit. */
async function proposeSwap(initiatorAssignmentId, targetAssignmentId) {
  if (!isAssignmentSwappable(initiatorAssignmentId) || !isAssignmentSwappable(targetAssignmentId)) {
    return { ok: false, reason: 'not_available' };
  }
  const initiatorCtx = getAssignmentContext(initiatorAssignmentId);
  const targetCtx = getAssignmentContext(targetAssignmentId);
  if (initiatorCtx.session.id !== targetCtx.session.id) {
    return { ok: false, reason: 'not_available' };
  }
  const stillEligible = eligibleTargetAssignments(initiatorAssignmentId, targetCtx.player.id).some(
    (r) => r.id === targetAssignmentId
  );
  if (!stillEligible) return { ok: false, reason: 'not_available' };

  const raw = generateRawToken();
  const info = db
    .prepare(
      `INSERT INTO swap_requests (initiator_assignment_id, target_assignment_id, initiator_player_id, target_player_id, token, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    )
    .run(initiatorAssignmentId, targetAssignmentId, initiatorCtx.player.id, targetCtx.player.id, hashToken(raw));

  logPlayerActivity({
    playerName: initiatorCtx.player.name,
    action: 'swap.propose',
    description: `${initiatorCtx.player.name} proposed swapping their ${email.fmtDate(initiatorCtx.week.match_date)} slot for ${targetCtx.player.name}'s ${email.fmtDate(targetCtx.week.match_date)} slot`,
    sessionId: initiatorCtx.session.id,
  });

  await email.sendSwapRequestEmail({
    recipient: targetCtx.player,
    initiatorPlayer: initiatorCtx.player,
    initiatorWeek: initiatorCtx.week,
    targetWeek: targetCtx.week,
    session: initiatorCtx.session,
    claimToken: raw,
  });
  await email.sendSwapProposedConfirmation({
    player: initiatorCtx.player,
    targetPlayer: targetCtx.player,
    initiatorWeek: initiatorCtx.week,
    targetWeek: targetCtx.week,
    session: initiatorCtx.session,
  });

  return { ok: true, swapRequestId: info.lastInsertRowid };
}

/** Accept or decline a pending swap proposal. Re-validates both assignments
 * are still swappable at the moment of response (state may have moved since
 * the request was created — an admin reassign, the week locking, etc.). */
async function respondToSwap(rawToken, accept) {
  const swapRequest = findSwapRequestByToken(rawToken);
  if (!swapRequest) return { ok: false, reason: 'invalid' };
  // Distinct from 'already_resolved' below: nobody actually responded here —
  // the window just closed (see expireStaleSwaps()). Worth a different
  // message so a player who finally clicks an old nudge link isn't told
  // someone else already answered it.
  if (swapRequest.status === 'expired') return { ok: false, reason: 'expired' };
  if (swapRequest.status !== 'pending') return { ok: false, reason: 'already_resolved' };

  const initiatorCtx = getAssignmentContext(swapRequest.initiator_assignment_id);
  const targetCtx = getAssignmentContext(swapRequest.target_assignment_id);
  if (!initiatorCtx || !targetCtx) return { ok: false, reason: 'invalid' };

  // Identity-drift guard: getAssignmentContext() always reflects who
  // CURRENTLY holds each assignment row, not who held it when this request
  // was proposed. If an admin reassigns either slot to a different player
  // while the request is still pending (e.g. an unrelated Reassign click
  // that has no idea a swap is in flight), the assignment ids are still
  // valid and still "swappable" by every other check here — but they no
  // longer belong to the two players who actually agreed to this trade.
  // Without this check, whoever clicks the still-live accept link ends up
  // silently trading places with whoever now happens to occupy the other
  // seat, who never consented to anything. NULL initiator_player_id (a
  // pre-migration row) can never match a real id, so it fails closed.
  if (
    initiatorCtx.player.id !== swapRequest.initiator_player_id ||
    targetCtx.player.id !== swapRequest.target_player_id
  ) {
    return { ok: false, reason: 'no_longer_available' };
  }

  if (!accept) {
    db.prepare(`UPDATE swap_requests SET status = 'declined', responded_at = datetime('now') WHERE id = ?`).run(
      swapRequest.id
    );
    logPlayerActivity({
      playerName: targetCtx.player.name,
      action: 'swap.decline',
      description: `${targetCtx.player.name} declined a swap proposed by ${initiatorCtx.player.name} (${email.fmtDate(initiatorCtx.week.match_date)} for ${email.fmtDate(targetCtx.week.match_date)})`,
      sessionId: initiatorCtx.session.id,
    });
    await email.sendSwapDeclinedNotice({
      player: initiatorCtx.player,
      targetPlayer: targetCtx.player,
      initiatorWeek: initiatorCtx.week,
      session: initiatorCtx.session,
    });
    return { ok: true, accepted: false, respondingPlayerId: targetCtx.player.slug || targetCtx.player.id };
  }

  // Exclude this swap's own (still-pending, about to be accepted) row from
  // the "already mid-flow" check — otherwise it would block itself from
  // ever being accepted. Any *other* pending request touching either
  // assignment still correctly blocks this one.
  if (
    !isAssignmentSwappable(swapRequest.initiator_assignment_id, swapRequest.id) ||
    !isAssignmentSwappable(swapRequest.target_assignment_id, swapRequest.id)
  ) {
    return { ok: false, reason: 'no_longer_available' };
  }
  const stillEligible = eligibleTargetAssignments(swapRequest.initiator_assignment_id, targetCtx.player.id, swapRequest.id).some(
    (r) => r.id === swapRequest.target_assignment_id
  );
  if (!stillEligible) return { ok: false, reason: 'no_longer_available' };

  db.transaction(() => {
    // Swap which player each existing assignment row belongs to — the week,
    // court, and team stay put (ball duty stays attached to the week too,
    // untouched here, same as every other roster-changing action in this
    // app — see "Add a player" in CLAUDE.md). Neither becomes is_sub: both
    // are still playing their own configured number of games, just on a
    // different date, not covering for someone else's target.
    db.prepare(
      `UPDATE week_assignments SET player_id = ?, status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?`
    ).run(targetCtx.player.id, initiatorCtx.assignment.id);
    db.prepare(
      `UPDATE week_assignments SET player_id = ?, status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?`
    ).run(initiatorCtx.player.id, targetCtx.assignment.id);
    // Old tokens pointed at "whoever used to be in this slot" — kill them so
    // a stale reminder link can't act on behalf of the player who just
    // traded out of it, same reasoning as claimSub()/createSubRequest().
    tokenStore.invalidateTokensForAssignment(initiatorCtx.assignment.id);
    tokenStore.invalidateTokensForAssignment(targetCtx.assignment.id);
    db.prepare(`UPDATE swap_requests SET status = 'accepted', responded_at = datetime('now') WHERE id = ?`).run(
      swapRequest.id
    );
  })();

  logPlayerActivity({
    playerName: targetCtx.player.name,
    action: 'swap.accept',
    description: `${targetCtx.player.name} accepted a swap with ${initiatorCtx.player.name}: ${initiatorCtx.player.name} now plays ${email.fmtDate(targetCtx.week.match_date)}, ${targetCtx.player.name} now plays ${email.fmtDate(initiatorCtx.week.match_date)}`,
    sessionId: initiatorCtx.session.id,
  });

  await email.sendSwapAcceptedNotice({
    initiatorPlayer: initiatorCtx.player,
    targetPlayer: targetCtx.player,
    initiatorWeek: initiatorCtx.week,
    targetWeek: targetCtx.week,
    session: initiatorCtx.session,
  });

  // Let the rest of both affected weeks know their roster shifted — same
  // pattern as subFlow.js's claimSub() notifying the full remaining group,
  // excluding the two who just swapped (they already got the notice above).
  for (const { weekId, excludePlayerId } of [
    { weekId: initiatorCtx.week.id, excludePlayerId: initiatorCtx.player.id },
    { weekId: targetCtx.week.id, excludePlayerId: targetCtx.player.id },
  ]) {
    const groupRows = db
      .prepare(
        `SELECT p.id, p.name, p.email FROM week_assignments wa JOIN players p ON p.id = wa.player_id
         WHERE wa.week_id = ? AND wa.status != 'subbed_out' AND p.id NOT IN (?, ?)`
      )
      .all(weekId, initiatorCtx.player.id, targetCtx.player.id);
    const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId);
    for (const recipient of groupRows) {
      await email.sendSwapGroupNotice({ recipient, week, session: initiatorCtx.session });
    }
  }

  return { ok: true, accepted: true, respondingPlayerId: targetCtx.player.slug || targetCtx.player.id };
}

/** Admin escape hatch for a stuck/unwanted pending proposal — mirrors
 * subFlow.js's closeActiveSubRequestForAssignment / the "Clear sub request"
 * button. Only acts on a still-pending request. */
function adminCancelSwap(weekAssignmentId) {
  const active = db
    .prepare(
      `SELECT id FROM swap_requests WHERE status = 'pending' AND (initiator_assignment_id = ? OR target_assignment_id = ?)`
    )
    .get(weekAssignmentId, weekAssignmentId);
  if (!active) return false;
  db.prepare(`UPDATE swap_requests SET status = 'cancelled', responded_at = datetime('now') WHERE id = ?`).run(
    active.id
  );
  return true;
}

const SWAP_NUDGE_HOURS_BEFORE = 48;

/** Given a pending swap's two assignment contexts, the timestamp of whichever
 * of the two involved weeks' matches comes first — the natural urgency
 * signal for a swap (mirrors sub_requests' "24h before match" escalation
 * trigger, doubled here since it's a one-to-one negotiation rather than a
 * fan-out, so a bit more lead time is reasonable). Once that time arrives,
 * neither side of the trade can happen anyway (the earlier week locks), so
 * it's also the natural expiry point — see expireStaleSwaps(). Returns null
 * if either week's match_time is malformed (a pre-invalidTimeFields legacy
 * row), so callers can skip rather than crash the whole pass. */
function earliestMatchAt(tz, initiatorCtx, targetCtx) {
  try {
    const a = zonedTimeToUtc(initiatorCtx.week.match_date, initiatorCtx.session.match_time, tz);
    const b = zonedTimeToUtc(targetCtx.week.match_date, targetCtx.session.match_time, tz);
    return a < b ? a : b;
  } catch (err) {
    return null;
  }
}

/**
 * Cron entry point: a pending swap has no timeout otherwise — if the target
 * player never opens the original email, nothing ever follows up, and
 * nothing tells the admin. Sends exactly one nudge per swap, once within 48
 * hours of whichever of the two involved weeks' matches comes first, to the
 * target player only (the initiator already knows they're waiting — see
 * sendSwapProposedConfirmation). Mints a second, additionally-valid token
 * rather than rotating the original (same "don't invalidate a link that's
 * already out" reasoning as tokenStore.js's reminder/follow-up tokens), so
 * the first email's link keeps working even after the nudge goes out.
 */
async function nudgeOverdueSwaps() {
  const tz = getTimezone();
  const now = new Date();

  // archived_at IS NULL: an archived session should go fully quiet, same
  // reasoning as processReminders()/escalateOverdueRequests() — see
  // "Archiving" in CLAUDE.md. Not gated by reminders_enabled: like sub
  // request escalation, this is closer to "is this negotiation stuck" than
  // a routine reminder, so the pause toggle shouldn't silence it.
  const pending = db
    .prepare(
      `SELECT sw.* FROM swap_requests sw
       JOIN week_assignments ia ON ia.id = sw.initiator_assignment_id
       JOIN weeks iw ON iw.id = ia.week_id
       JOIN sessions s ON s.id = iw.session_id
       WHERE sw.status = 'pending' AND sw.nudged_at IS NULL AND s.archived_at IS NULL`
    )
    .all();

  let nudgedCount = 0;
  for (const sw of pending) {
    const initiatorCtx = getAssignmentContext(sw.initiator_assignment_id);
    const targetCtx = getAssignmentContext(sw.target_assignment_id);
    if (!initiatorCtx || !targetCtx) continue;

    const matchAt = earliestMatchAt(tz, initiatorCtx, targetCtx);
    if (!matchAt) continue;
    const nudgeAt = new Date(matchAt.getTime() - SWAP_NUDGE_HOURS_BEFORE * 60 * 60 * 1000);
    if (now < nudgeAt) continue;

    const raw = generateRawToken();
    db.prepare(`UPDATE swap_requests SET nudge_token = ?, nudged_at = datetime('now') WHERE id = ?`).run(
      hashToken(raw),
      sw.id
    );

    await email.sendSwapNudge({
      recipient: targetCtx.player,
      initiatorPlayer: initiatorCtx.player,
      initiatorWeek: initiatorCtx.week,
      targetWeek: targetCtx.week,
      session: initiatorCtx.session,
      claimToken: raw,
    });
    nudgedCount++;
  }
  return nudgedCount;
}

/**
 * Cron entry point, paired with nudgeOverdueSwaps(): once the earlier of a
 * pending swap's two involved weeks' match times actually arrives, the trade
 * can no longer happen (that week locks — isAssignmentSwappable() already
 * refuses it), so mark the request 'expired' instead of leaving it
 * perpetually 'pending'. This isn't just cosmetic: isAssignmentSwappable()
 * treats *any* pending swap as blocking BOTH of its assignments, including
 * the side whose own week hasn't locked yet — without this, a swap that goes
 * stale on one side would permanently prevent the other player's other slot
 * from ever being swapped again with anyone, found via live scenario testing
 * (2026-08-11). No email is sent here (silent bookkeeping, same as
 * processWeekLocking()/flagStillUnfilled()) — the dashboard/status flag for a
 * nudged-but-unanswered swap already covers visibility while it's still
 * actionable; once expired there's nothing left to decide.
 */
function expireStaleSwaps() {
  const tz = getTimezone();
  const now = new Date();

  const pending = db.prepare(`SELECT * FROM swap_requests WHERE status = 'pending'`).all();
  let expiredCount = 0;
  for (const sw of pending) {
    const initiatorCtx = getAssignmentContext(sw.initiator_assignment_id);
    const targetCtx = getAssignmentContext(sw.target_assignment_id);
    if (!initiatorCtx || !targetCtx) continue;

    const matchAt = earliestMatchAt(tz, initiatorCtx, targetCtx);
    if (!matchAt || now < matchAt) continue;

    db.prepare(`UPDATE swap_requests SET status = 'expired', responded_at = datetime('now') WHERE id = ?`).run(sw.id);
    expiredCount++;
  }
  return expiredCount;
}

module.exports = {
  getAssignmentContext,
  isAssignmentSwappable,
  eligibleOwnAssignments,
  eligibleTargetAssignments,
  proposeSwap,
  respondToSwap,
  adminCancelSwap,
  findSwapRequestByToken,
  nudgeOverdueSwaps,
  expireStaleSwaps,
};
