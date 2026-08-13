'use strict';
const db = require('../db');
const { generateRawToken, hashToken } = require('./tokens');
const tokenStore = require('./tokenStore');
const email = require('./email');
const { zonedTimeToUtc } = require('./tz');
const { getTimezone } = require('./settings');

/**
 * The master broader_sub_list, scoped down to just the people an admin has
 * assigned to this specific session (session_sub_list) — see "Per-session
 * sub list" in CLAUDE.md. Used both by escalateOverdueRequests() to decide
 * who actually gets emailed, and by admin.js's session-subs page to render
 * the current checklist state.
 */
function sessionSubList(sessionId) {
  return db
    .prepare(
      `SELECT bl.* FROM session_sub_list ssl
       JOIN broader_sub_list bl ON bl.id = ssl.broader_list_id
       WHERE ssl.session_id = ? ORDER BY bl.name`
    )
    .all(sessionId);
}

function getWeekWithSession(weekId) {
  return db
    .prepare(
      `SELECT w.*, s.match_time, s.name as session_name, s.id as session_id
       FROM weeks w JOIN sessions s ON s.id = w.session_id WHERE w.id = ?`
    )
    .get(weekId);
}

function upcomingWeeksPreview(sessionId, fromDate, count = 3) {
  const weeks = db
    .prepare(
      `SELECT * FROM weeks WHERE session_id = ? AND match_date >= ? ORDER BY match_date LIMIT ?`
    )
    .all(sessionId, fromDate, count);
  return weeks.map((w) => {
    const players = db
      .prepare(
        `SELECT p.name FROM week_assignments wa JOIN players p ON p.id = wa.player_id
         WHERE wa.week_id = ? AND wa.status != 'subbed_out'`
      )
      .all(w.id);
    const ballDuty = w.ball_duty_player_id
      ? db.prepare('SELECT name FROM players WHERE id = ?').get(w.ball_duty_player_id)
      : null;
    return { ...w, players, ballDutyName: ballDuty ? ballDuty.name : null };
  });
}

/** Is there already an active (open/escalated) sub request for a different
 * player in this same week? Per the resolved open item, v1 does not run two
 * automated parallel sub-request flows for the same week — a second request
 * is surfaced to the admin to handle manually instead. */
function hasActiveConcurrentSubRequest(weekId, excludingAssignmentId) {
  const row = db
    .prepare(
      `SELECT sr.id FROM sub_requests sr
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       WHERE wa.week_id = ? AND wa.id != ? AND sr.status IN ('open', 'escalated')`
    )
    .get(weekId, excludingAssignmentId);
  return !!row;
}

/**
 * Kicks off a sub request for a given week_assignment: marks it needs_sub,
 * opens a sub_requests row, and emails every other enrolled player in the
 * session who isn't already playing that week (the "5 non-playing regulars"
 * in the example 9-player/4-per-week group; generalizes to roster size).
 */
async function createSubRequest(weekAssignmentId) {
  const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(weekAssignmentId);
  if (!assignment) throw new Error('Assignment not found');
  const week = getWeekWithSession(assignment.week_id);
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(assignment.player_id);

  if (hasActiveConcurrentSubRequest(week.id, weekAssignmentId)) {
    return { blocked: true, reason: 'concurrent' };
  }

  const alreadyPlaying = db
    .prepare(`SELECT player_id FROM week_assignments WHERE week_id = ? AND status != 'subbed_out'`)
    .all(week.id)
    .map((r) => r.player_id);

  const candidates = db
    .prepare(
      `SELECT p.id, p.name, p.email FROM session_players sp JOIN players p ON p.id = sp.player_id
       WHERE sp.session_id = ? AND p.active = 1 AND p.id NOT IN (${alreadyPlaying.map(() => '?').join(',') || '0'})`
    )
    .all(week.session_id, ...alreadyPlaying);

  const wasBallDuty = week.ball_duty_player_id === player.id;

  const applyDb = db.transaction(() => {
    db.prepare("UPDATE week_assignments SET status = 'needs_sub' WHERE id = ?").run(weekAssignmentId);
    // The moment a sub is requested, the "I'm playing" confirm link for this
    // exact slot should stop working outright — not just show a polite
    // "already requested" message — since the player themselves just said
    // they can't make it. Kills every outstanding token for this assignment
    // (original reminder, any follow-up nudge, etc. all at once).
    tokenStore.invalidateTokensForAssignment(weekAssignmentId);
    const reqInfo = db
      .prepare('INSERT INTO sub_requests (week_assignment_id, status) VALUES (?, ?)')
      .run(weekAssignmentId, 'open');
    const subRequestId = reqInfo.lastInsertRowid;

    if (wasBallDuty) {
      db.prepare(
        "UPDATE weeks SET ball_duty_player_id = NULL, needs_attention = 1, notes = ? WHERE id = ?"
      ).run(`Ball duty needs reassignment (was ${player.name}, now needs a sub)`, week.id);
    }

    const offers = candidates.map((c) => {
      const raw = generateRawToken();
      db.prepare(
        'INSERT INTO sub_offers (sub_request_id, candidate_player_id, token, status) VALUES (?, ?, ?, ?)'
      ).run(subRequestId, c.id, hashToken(raw), 'pending');
      return { candidate: c, rawToken: raw };
    });

    return { subRequestId, offers };
  });

  const { subRequestId, offers } = applyDb();

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  for (const { candidate, rawToken } of offers) {
    await email.sendSubRequestFanout({
      recipient: candidate,
      week,
      session,
      claimToken: rawToken,
      requestingPlayerName: player.name,
    });
  }

  // Safety net for a wrong-name mix-up (e.g. on the self-service "Request a
  // Sub" page): the affected player gets their own confirmation the moment
  // this fires, so a mistake surfaces immediately instead of after the fact.
  await email.sendSubRequestOwnConfirmation({ player, week, session });

  return { blocked: false, subRequestId, offerCount: offers.length };
}

/** First explicit "Confirm" click on a sub offer wins; closes all others. */
async function claimSub(rawToken) {
  const hashed = hashToken(rawToken);
  const offer = db.prepare('SELECT * FROM sub_offers WHERE token = ?').get(hashed);
  if (!offer) return { ok: false, reason: 'invalid' };
  if (offer.status !== 'pending') return { ok: false, reason: 'already_claimed' };

  const subRequest = db.prepare('SELECT * FROM sub_requests WHERE id = ?').get(offer.sub_request_id);
  // 'resolved_manually' covers an admin having reassigned or manually
  // confirmed this slot directly (see closeActiveSubRequestForAssignment) —
  // treated the same as 'filled' here as defense in depth. In practice that
  // path also closes every pending offer, so the offer.status check above
  // would already catch it; this just means correctness here doesn't depend
  // on that other cleanup having also run.
  if (!subRequest || subRequest.status === 'filled' || subRequest.status === 'resolved_manually') {
    return { ok: false, reason: 'already_filled' };
  }

  const originalAssignment = db
    .prepare('SELECT * FROM week_assignments WHERE id = ?')
    .get(subRequest.week_assignment_id);
  const week = getWeekWithSession(originalAssignment.week_id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);

  let subPlayer;
  if (offer.candidate_player_id) {
    subPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(offer.candidate_player_id);
  } else {
    const bl = db.prepare('SELECT * FROM broader_sub_list WHERE id = ?').get(offer.broader_list_id);
    // Broader-list subs must exist as a player row so they can be scheduled/emailed like anyone else.
    let existing = db.prepare('SELECT * FROM players WHERE email = ?').get(bl.email);
    if (!existing) {
      const info = db.prepare('INSERT INTO players (name, email) VALUES (?, ?)').run(bl.name, bl.email);
      existing = { id: info.lastInsertRowid, name: bl.name, email: bl.email };
    }
    subPlayer = existing;
  }

  db.transaction(() => {
    db.prepare("UPDATE sub_offers SET status = 'claimed', responded_at = datetime('now') WHERE id = ?").run(offer.id);
    db.prepare(
      "UPDATE sub_offers SET status = 'closed' WHERE sub_request_id = ? AND id != ? AND status = 'pending'"
    ).run(subRequest.id, offer.id);
    db.prepare("UPDATE sub_requests SET status = 'filled' WHERE id = ?").run(subRequest.id);
    db.prepare("UPDATE week_assignments SET status = 'subbed_out' WHERE id = ?").run(originalAssignment.id);
    // A sub's own "I'm playing"/"need a sub" tokens don't exist yet — they
    // won't get any until they're next reminded — but the *original*
    // player's tokens for this exact slot need to die now: they just got
    // subbed out, so their old reminder/follow-up links shouldn't still be
    // able to act on this assignment (which now belongs to someone else).
    tokenStore.invalidateTokensForAssignment(originalAssignment.id);
    db.prepare(
      `INSERT INTO week_assignments (week_id, player_id, team, court, is_sub, status, confirmed_at)
       VALUES (?, ?, ?, ?, 1, 'confirmed', datetime('now'))`
    ).run(originalAssignment.week_id, subPlayer.id, originalAssignment.team, originalAssignment.court);
  })();

  // Notify that week's full group of 4 (other 3 originals + the new sub)
  const groupRows = db
    .prepare(
      `SELECT p.id, p.name, p.email FROM week_assignments wa JOIN players p ON p.id = wa.player_id
       WHERE wa.week_id = ? AND wa.status != 'subbed_out'`
    )
    .all(originalAssignment.week_id);

  for (const recipient of groupRows) {
    await email.sendSubFilledNotice({ recipient, week, session, subName: subPlayer.name });
  }

  return { ok: true, week, subPlayer };
}

/**
 * Called when an admin manually resolves a slot that has (or had) an active
 * sub request — either by reassigning that slot to someone else, or by
 * marking the original player confirmed after all (they told the admin
 * directly they can make it). Without this, two things stay wrong: the "sub
 * open" flag on the session detail page and dashboard never clears, and —
 * more importantly — the sub-invite emails already out to other players stay
 * claimable. claimSub() only refuses once sub_requests.status is 'filled'
 * (or the request is gone); left 'open'/'escalated'/'unfilled', a player
 * clicking their still-live link would silently overwrite whatever the admin
 * just did (flip the reassigned/confirmed slot to 'subbed_out' and add a
 * second, unwanted player to that week). Closes the request and every
 * outstanding offer under it so those links now fail with a normal "already
 * filled" message instead. Uses a distinct 'resolved_manually' status rather
 * than reusing 'filled' so the stats page's sub history can still tell
 * self-serve sub fills apart from admin interventions.
 */
function closeActiveSubRequestForAssignment(weekAssignmentId) {
  const active = db
    .prepare(`SELECT id FROM sub_requests WHERE week_assignment_id = ? AND status IN ('open', 'escalated', 'unfilled')`)
    .get(weekAssignmentId);
  if (!active) return false;
  db.prepare(`UPDATE sub_requests SET status = 'resolved_manually' WHERE id = ?`).run(active.id);
  db.prepare(`UPDATE sub_offers SET status = 'closed' WHERE sub_request_id = ? AND status = 'pending'`).run(active.id);
  return true;
}

/** Cron entry point: for any sub_request still open once we're within 24
 * hours *before* its week's match day/time (i.e. the original 5 didn't fill
 * it in time), fan out to the broader escalation list. Uses the same
 * timezone-aware wall-clock conversion as the reminder emails (tz.js) rather
 * than raw SQLite datetime math, since match_time is stored as local wall
 * time, not UTC. */
async function escalateOverdueRequests() {
  const tz = getTimezone();
  const now = new Date();

  // Joins through to sessions so an archived session's stray open request
  // (e.g. archived mid-season, before it was actually resolved) doesn't
  // still escalate and email the broader sub list — archiving is meant to
  // go fully quiet, not just hide from the dashboard.
  const openRequests = db
    .prepare(
      `SELECT sr.*, wa.id as assignment_id, w.id as week_id
       FROM sub_requests sr
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       WHERE sr.status = 'open' AND s.archived_at IS NULL`
    )
    .all();

  let escalatedCount = 0;

  for (const req of openRequests) {
    const week = getWeekWithSession(req.week_id);
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
    const matchAt = zonedTimeToUtc(week.match_date, session.match_time, tz);
    const escalateAt = new Date(matchAt.getTime() - 24 * 60 * 60 * 1000); // 24h before match
    if (now < escalateAt) continue;

    escalatedCount++;

    // Per-session subset of the master broader_sub_list, not the whole
    // list — see "Per-session sub list" in CLAUDE.md. Looked up per
    // request (not hoisted above the loop) since different open requests
    // can belong to different sessions with different sub lists.
    const sessionSubs = sessionSubList(session.id);

    if (sessionSubs.length === 0) {
      db.prepare("UPDATE sub_requests SET status = 'unfilled' WHERE id = ?").run(req.id);
      continue;
    }

    db.prepare("UPDATE sub_requests SET status = 'escalated', escalated_at = datetime('now') WHERE id = ?").run(
      req.id
    );

    for (const bl of sessionSubs) {
      const raw = generateRawToken();
      db.prepare(
        'INSERT INTO sub_offers (sub_request_id, broader_list_id, token, status) VALUES (?, ?, ?, ?)'
      ).run(req.id, bl.id, hashToken(raw), 'pending');
      await email.sendEscalationEmail({ recipient: bl, week, session, claimToken: raw });
    }
  }

  return escalatedCount;
}

/** A second pass: once match time has actually arrived and an escalated
 * request still isn't filled, flag it for the admin dashboard rather than
 * leaving it silently "escalated" forever. Same timezone-aware comparison as
 * escalateOverdueRequests. */
function flagStillUnfilled() {
  const tz = getTimezone();
  const now = new Date();

  const escalated = db
    .prepare(
      `SELECT sr.id, wa.week_id FROM sub_requests sr
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       WHERE sr.status = 'escalated'`
    )
    .all();

  let count = 0;
  for (const row of escalated) {
    const week = getWeekWithSession(row.week_id);
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
    const matchAt = zonedTimeToUtc(week.match_date, session.match_time, tz);
    if (now >= matchAt) {
      db.prepare("UPDATE sub_requests SET status = 'unfilled' WHERE id = ?").run(row.id);
      count++;
    }
  }
  return count;
}

module.exports = {
  createSubRequest,
  claimSub,
  closeActiveSubRequestForAssignment,
  escalateOverdueRequests,
  flagStillUnfilled,
  upcomingWeeksPreview,
  getWeekWithSession,
  hasActiveConcurrentSubRequest,
  sessionSubList,
};
