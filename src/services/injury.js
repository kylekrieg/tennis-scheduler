'use strict';
/**
 * Injured players (Kyle, 2026-10-02): "On the player roster, we need a
 * checkbox for 'Injured', meaning the player can't play. We should have a
 * date on when that checkbox will be lifted."
 *
 * Set on the admin Players page: `players.injured` + `players.injured_until`
 * (the last day they're out, inclusive). It's per player, so it covers every
 * session they're in. syncPlayer() makes the rest of the app match it and is
 * safe to run any number of times — the Players page runs it on save and
 * cron.js runs it every tick for every injured player, which is what picks
 * up a week that couldn't be flagged earlier (another sub request was open)
 * and clears the flag the day after injured_until.
 *
 * What it does, per Kyle's decisions:
 *  - Every one of their unlocked weeks from today through injured_until goes
 *    to "needs sub" via subFlow.adminFlagNeedsSub() — the same thing as an
 *    admin picking "— Needs a sub —", so NO email goes out now; the roster
 *    fan-out waits for that week's normal confirmation-reminder time
 *    (cron.js processReminders → fanOutPendingAdminFlagsForWeek). The
 *    request is tagged sub_requests.injury = 1. A ball-duty week is cleared
 *    and flagged for the admin, same as any admin "Needs a sub".
 *  - Weeks in sessions whose schedule isn't locked yet can't take a sub
 *    request (see adminFlagNeedsSub); they're listed on the Status page
 *    instead. Every date in the range also gets a blackout_dates row with
 *    source 'injury', so a draft session's scheduler skips them, a re-run of
 *    "Schedule these players" leaves them off, and they aren't emailed sub
 *    requests or offered swaps for those dates.
 *  - Pushing the date out flags the new weeks the same way.
 *  - Coming back early (date moved in, or the box unchecked): a week whose
 *    injury request hasn't gone out to anyone yet goes back to "scheduled"
 *    and the request is closed as 'resolved_injury_return' (left out of Sub
 *    History). If the request already went out, it plays out. If a sub
 *    already took the spot, it stays that way.
 *  - An injury request an admin cleared by hand is never re-flagged.
 *  - Only one sub request per week is allowed today, so a week that already
 *    has another player's open request waits (listed on the Status page) and
 *    is flagged on a later tick once that one closes.
 */
const db = require('../db');
const { getTimezone } = require('./settings');
const { utcToZonedParts } = require('./tz');
const { fullName } = require('./playerName');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Full session title for messages/logs (CLAUDE.md convention). */
function sessionTitle(sessionId) {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  return s ? require('./email').sessionFullTitle(s) : `session #${sessionId}`;
}

function localToday() {
  return utcToZonedParts(new Date(), getTimezone()).date;
}

function isActive(player, today = localToday()) {
  return !!(player && player.injured && player.injured_until && player.injured_until >= today);
}

/** Non-archived regular sessions the player is on the roster or session sub list of. */
function playerSessionIds(playerId) {
  return db
    .prepare(
      `SELECT s.id FROM sessions s
       WHERE s.archived_at IS NULL AND s.session_type = 'regular'
         AND (EXISTS (SELECT 1 FROM session_players sp WHERE sp.session_id = s.id AND sp.player_id = ?)
           OR EXISTS (SELECT 1 FROM session_sub_players ssp WHERE ssp.session_id = s.id AND ssp.player_id = ?))`
    )
    .all(playerId, playerId)
    .map((r) => r.id);
}

/** The player's own still-playing rows in the injury range, with session info. */
function assignmentsInRange(playerId, from, to) {
  return db
    .prepare(
      `SELECT wa.id AS assignment_id, wa.status, w.id AS week_id, w.match_date, w.ball_duty_player_id,
              s.id AS session_id, s.name AS session_name, s.schedule_locked_at
       FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       WHERE wa.player_id = ? AND wa.status IN ('scheduled', 'confirmed')
         AND w.locked = 0 AND w.match_date >= ? AND w.match_date <= ?
         AND s.archived_at IS NULL AND s.session_type = 'regular' AND s.status != 'draft'
       ORDER BY w.match_date`
    )
    .all(playerId, from, to);
}

function alreadyHandled(assignmentId) {
  return !!db
    .prepare(`SELECT 1 FROM sub_requests WHERE week_assignment_id = ? AND injury = 1 AND status != 'resolved_injury_return'`)
    .get(assignmentId);
}

/**
 * Brings blackouts and sub requests in line with the player's injury
 * fields. Returns { flagged: [], waiting: [], reverted: [] }, each row
 * { match_date, session_id, session_name, reason? } for messages/logging.
 */
function syncPlayer(playerId) {
  const subFlow = require('./subFlow');
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  const out = { flagged: [], waiting: [], reverted: [] };
  if (!player) return out;
  const today = localToday();
  const active = isActive(player, today);
  const until = active ? player.injured_until : null;

  // 1. Blackouts: add for the range, drop upcoming ones outside it.
  if (active) {
    const ids = playerSessionIds(playerId);
    const ins = db.prepare("INSERT OR IGNORE INTO blackout_dates (session_id, player_id, date, source) VALUES (?, ?, ?, 'injury')");
    for (const sid of ids) {
      const weeks = db
        .prepare('SELECT match_date FROM weeks WHERE session_id = ? AND locked = 0 AND match_date >= ? AND match_date <= ?')
        .all(sid, today, until);
      for (const w of weeks) ins.run(sid, playerId, w.match_date);
    }
    db.prepare("DELETE FROM blackout_dates WHERE player_id = ? AND source = 'injury' AND date >= ? AND date > ?").run(playerId, today, until);
  } else {
    db.prepare("DELETE FROM blackout_dates WHERE player_id = ? AND source = 'injury' AND date >= ?").run(playerId, today);
  }

  // 2. Flag weeks in range.
  if (active) {
    for (const a of assignmentsInRange(playerId, today, until)) {
      if (alreadyHandled(a.assignment_id)) continue;
      const row = { match_date: a.match_date, session_id: a.session_id, session_name: sessionTitle(a.session_id) };
      if (!a.schedule_locked_at) {
        out.waiting.push({ ...row, reason: 'not_locked' });
        continue;
      }
      const r = subFlow.adminFlagNeedsSub(a.assignment_id);
      if (r.blocked) {
        out.waiting.push({ ...row, reason: r.reason });
        continue;
      }
      db.prepare('UPDATE sub_requests SET injury = 1 WHERE id = ?').run(r.subRequestId);
      out.flagged.push({ ...row, ballDuty: a.ball_duty_player_id === playerId });
    }
  }

  // 3. Back early: undo injury requests that haven't gone out to anyone.
  const toRevert = db
    .prepare(
      `SELECT sr.id, sr.week_assignment_id, w.match_date, s.id AS session_id, s.name AS session_name
       FROM sub_requests sr
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       WHERE sr.injury = 1 AND wa.player_id = ? AND sr.status = 'open' AND sr.fanout_sent_at IS NULL
         AND w.locked = 0 AND (? IS NULL OR w.match_date > ?)`
    )
    .all(playerId, until, until);
  for (const r of toRevert) {
    db.transaction(() => {
      db.prepare("UPDATE sub_requests SET status = 'resolved_injury_return' WHERE id = ?").run(r.id);
      db.prepare("UPDATE sub_offers SET status = 'closed' WHERE sub_request_id = ? AND status = 'pending'").run(r.id);
      db.prepare("UPDATE week_assignments SET status = 'scheduled', confirmed_at = NULL WHERE id = ? AND status = 'needs_sub'").run(r.week_assignment_id);
    })();
    out.reverted.push({ match_date: r.match_date, session_id: r.session_id, session_name: sessionTitle(r.session_id) });
  }

  return out;
}

/**
 * Cron pass: clears injuries whose date has passed, then syncs every
 * injured player (retries waiting weeks). Logs only when something changed.
 */
function processInjuries() {
  const { logSystemActivity } = require('./activityLog');
  const today = localToday();
  const expired = db.prepare('SELECT * FROM players WHERE injured = 1 AND (injured_until IS NULL OR injured_until < ?)').all(today);
  for (const p of expired) {
    db.prepare('UPDATE players SET injured = 0 WHERE id = ?').run(p.id);
    logSystemActivity({
      action: 'player.injury_ended',
      description: `${fullName(p)} is no longer marked injured (out through ${p.injured_until || 'no date'} has passed)`,
    });
    syncPlayer(p.id);
  }
  const injured = db.prepare('SELECT * FROM players WHERE injured = 1 AND injured_until >= ?').all(today);
  for (const p of injured) {
    const r = syncPlayer(p.id);
    if (r.flagged.length) {
      logSystemActivity({
        action: 'player.injury_flag',
        description: `Injured player ${fullName(p)}: marked needs sub for ${r.flagged.map((x) => `${x.match_date} (${x.session_name})`).join(', ')}${r.flagged.some((x) => x.ballDuty) ? ' — ball duty needs reassigning' : ''}`,
      });
    }
  }
}

/** For the Status page: injured players' weeks that couldn't be flagged yet. */
function waitingWeeks() {
  const today = localToday();
  const rows = [];
  for (const p of db.prepare('SELECT * FROM players WHERE injured = 1 AND injured_until >= ?').all(today)) {
    for (const a of assignmentsInRange(p.id, today, p.injured_until)) {
      if (alreadyHandled(a.assignment_id)) continue;
      // 'concurrent' (another request open that week) no longer blocks a
      // flag — it joins that request instead (Kyle, 2026-10-02).
      rows.push({
        playerName: fullName(p),
        match_date: a.match_date,
        session_id: a.session_id,
        reason: !a.schedule_locked_at ? 'not_locked' : 'pending',
      });
    }
  }
  return rows;
}

/** The player's upcoming weeks inside the injury range, for the notice email. */
function weeksForNotice(playerId, until) {
  const today = localToday();
  return db
    .prepare(
      `SELECT w.match_date, s.* FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       WHERE wa.player_id = ? AND wa.status IN ('scheduled', 'confirmed', 'needs_sub')
         AND w.locked = 0 AND w.match_date >= ? AND w.match_date <= ?
         AND s.archived_at IS NULL AND s.session_type = 'regular'
       ORDER BY w.match_date`
    )
    .all(playerId, today, until)
    .map((r) => ({ match_date: r.match_date, session: r }));
}

/** Validates the Players page form. Returns { injured, until } or { error }. */
function parseForm(body) {
  const injured = !!body.injured;
  const until = String(body.injured_until || '').trim();
  if (!injured) return { injured: false, until: null };
  if (!DATE_RE.test(until) || Number.isNaN(Date.parse(until + 'T00:00:00Z'))) {
    return { error: 'Pick the last day the player is out ("Out through").' };
  }
  if (until < localToday()) return { error: '"Out through" has to be today or later.' };
  return { injured: true, until };
}

module.exports = { syncPlayer, processInjuries, waitingWeeks, weeksForNotice, parseForm, isActive, localToday };
