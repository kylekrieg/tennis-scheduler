'use strict';
const db = require('../db');
const { fullName } = require('./playerName');
const subFlow = require('./subFlow');
const { NO_EMAIL_DOMAIN } = require('./email');

/**
 * "Player Behavior" stats (Kyle, 2026-09-15) — shown collapsed at the top of
 * the Admin -> Activity Log page. Distinct from the Stats page's
 * tennis-performance numbers (win %, games won, target/played): these
 * describe how players actually USE the app — do they confirm promptly or
 * need a nudge, how often do they need a sub and who ends up covering it, do
 * they proactively swap or blackout ahead of time versus leaving it to the
 * reminder system.
 *
 * Every function here takes an optional `sessionId` and, when given, scopes
 * to just that session (matching the Activity Log page's own session filter
 * dropdown); omitted, every function reports all-time across every session
 * (including archived ones — same "history shouldn't quietly disappear"
 * reasoning as email_log/admin_activity_log never being pruned on session
 * delete/archive).
 *
 * Every query here reports on REAL players only (players.id), never a
 * one-time no-email sub or a not-yet-claimed broader_sub_list entry — both
 * of those either don't have a players row at all, or only get one the
 * moment they actually claim a slot, which is exactly when they'd start
 * showing up here anyway.
 */

function playersById(ids) {
  const uniqueIds = [...new Set(ids)].filter((id) => id != null);
  if (uniqueIds.length === 0) return new Map();
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM players WHERE id IN (${placeholders})`).all(...uniqueIds);
  return new Map(rows.map((p) => [p.id, p]));
}

/**
 * Per-player confirmation timing: of every assignment a player actually
 * confirmed (wa.confirmed_at set — regardless of what the assignment's
 * FINAL status ended up being, since a player can confirm and still later
 * need a sub), how many came in before the automatic follow-up nudge
 * (email_log category 'followup_reminder') ever went out for that week vs.
 * after, vs. an admin confirming them directly instead (Kyle, 2026-09-15:
 * "add an 'admin confirmed' column where the admin confirms a player by the
 * admin panel" — the session-detail page's "Mark confirmed" button, which
 * stamps wa.admin_confirmed = 1; see schema.sql's comment on that column).
 * These three buckets are mutually exclusive and exhaustive of every
 * confirmed row: admin-confirmed rows are pulled out FIRST, before the
 * before/after-followup split, since "admin confirmed" isn't the player's
 * own response timing at all — counting it under either reminder bucket
 * would misattribute an admin's action as player responsiveness. "After"
 * here means the follow-up was sent AND the assignment still hadn't been
 * confirmed at the time it went out (fu.sent_at <= wa.confirmed_at) — a
 * player who confirmed between the two emails going out still counts as
 * "on the first reminder," since they responded before ever being nudged.
 */
function confirmTimingStats(sessionId) {
  const params = [];
  let sessionClause = '';
  if (sessionId) {
    sessionClause = 'AND w.session_id = ?';
    params.push(sessionId);
  }
  const rows = db
    .prepare(
      `SELECT wa.player_id,
              COUNT(*) as totalConfirmed,
              SUM(CASE WHEN wa.admin_confirmed = 1 THEN 1 ELSE 0 END) as adminConfirmed,
              SUM(CASE WHEN wa.admin_confirmed = 0 AND fu.id IS NOT NULL THEN 1 ELSE 0 END) as confirmedAfterFollowup
       FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = wa.player_id
       LEFT JOIN email_log fu ON fu.category = 'followup_reminder' AND fu.related_week_id = w.id
              AND fu.to_email = p.email AND fu.sent_at <= wa.confirmed_at
       WHERE wa.confirmed_at IS NOT NULL ${sessionClause}
       GROUP BY wa.player_id`
    )
    .all(...params);

  const players = playersById(rows.map((r) => r.player_id));
  return rows
    .map((r) => ({
      player: players.get(r.player_id),
      totalConfirmed: r.totalConfirmed,
      adminConfirmed: r.adminConfirmed,
      confirmedAfterFollowup: r.confirmedAfterFollowup,
      confirmedOnFirstReminder: r.totalConfirmed - r.adminConfirmed - r.confirmedAfterFollowup,
    }))
    .filter((r) => r.player)
    .sort((a, b) => fullName(a.player).localeCompare(fullName(b.player)));
}

/**
 * Per-player count of assignments that reached their week's lock (match time
 * passed) still sitting at 'scheduled' — never confirmed, never requested a
 * sub, never got a swap or reassign to move them off the slot. `is_sub = 0`
 * excludes a sub's own row, which is never relevant here: claimSub() always
 * inserts a sub's row already 'confirmed' (see subFlow.js), so a sub can
 * never end up in this bucket.
 */
function neverConfirmedStats(sessionId) {
  const params = [];
  let sessionClause = '';
  if (sessionId) {
    sessionClause = 'AND w.session_id = ?';
    params.push(sessionId);
  }
  const rows = db
    .prepare(
      `SELECT wa.player_id, COUNT(*) as neverConfirmed
       FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       WHERE w.locked = 1 AND wa.status = 'scheduled' AND wa.is_sub = 0 ${sessionClause}
       GROUP BY wa.player_id`
    )
    .all(...params);

  const players = playersById(rows.map((r) => r.player_id));
  return rows
    .map((r) => ({ player: players.get(r.player_id), neverConfirmed: r.neverConfirmed }))
    .filter((r) => r.player)
    .sort((a, b) => fullName(a.player).localeCompare(fullName(b.player)));
}

/**
 * The core "who needed a sub, how often, and who ended up covering it" pass.
 * One query, one JS reduce — returns both the per-player breakdown and the
 * league-wide totals, since both are needed (Kyle, 2026-09-15: "both") and
 * computing them separately would mean scanning sub_requests twice.
 *
 * Both `status = 'filled'` (a real self-service claim, with a sub_offers
 * winner to bucket by) AND `status = 'resolved_manually'` (an admin's own
 * direct Reassign/one-time-sub/Correct-player placement) count as a real sub
 * here — Kyle, 2026-09-15: "let's count a sub as a sub, no matter if it got
 * a sub_offers record tied to it or an admin did the coordination." (Before
 * this, `resolved_manually` counted only toward `subsNeeded`, deliberately
 * excluded from the source-bucket totals and "subs claimed for others" —
 * that's the older design; see [[project_tennis_scheduler_player_behavior_stats]]
 * in project memory for the Ed Bourneuf/Jim Newell case that prompted the
 * change.) 'resolved_double_booking' rows are still excluded entirely (from
 * every count here) — per subFlow.js's own doc comment, that's a schedule
 * correction, not a player needing a sub.
 *
 * For a 'filled' row, `filler` is found via `replaces_assignment_id` (the
 * exact link claimSub() stamps onto the new row) and bucketed via the real
 * sub_offers winner (was_new_person / candidate_player_id / broader_list_id)
 * — claimSub() always inserts a fresh row this way, so this direct link is
 * always reliable for a self-service fill.
 *
 * A 'resolved_manually' row has no sub_offers winner to read at all, and its
 * filler can't always be found via the same direct link either: a plain
 * in-place Reassign that closes an already-open request overwrites
 * week_assignments.player_id on the SAME row rather than inserting a new
 * one, and some pre-2026-09-10 admin placements were never linked in the
 * first place (the real case that prompted logging admin placements to Sub
 * History at all — see CLAUDE.md's "Sub History gap" entry). So this uses
 * subFlow.js's `resolveSubRequestFiller()` — the exact same three-tier
 * fallback the Stats page's own Sub History "Filled by" column relies on —
 * rather than a second, possibly-drifting heuristic. Once a filler is found,
 * it's bucketed by identity instead of by offer (there is no offer):
 * the "One-time sub" flow's `@no-email.invalid` placeholder address means a
 * genuinely new/unknown person, an email matching an existing
 * `broader_sub_list` entry means broader list, and anything else (an actual
 * roster player, however the admin found them) means roster.
 */
function subRequestStats(sessionId) {
  const params = [];
  let sessionClause = '';
  if (sessionId) {
    sessionClause = 'AND w.session_id = ?';
    params.push(sessionId);
  }
  const rows = db
    .prepare(
      `SELECT sr.id, sr.status, sr.self_arranged, sr.requesting_player_id,
              wa.id as assignment_id, wa.week_id, wa.team, wa.court, wa.player_id as current_player_id,
              p.id as original_player_id,
              filler.player_id as filled_by_player_id,
              so.candidate_player_id, so.was_new_person
       FROM sub_requests sr
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = COALESCE(sr.requesting_player_id, wa.player_id)
       LEFT JOIN week_assignments filler ON filler.replaces_assignment_id = sr.week_assignment_id AND filler.is_sub = 1
       LEFT JOIN sub_offers so ON so.sub_request_id = sr.id AND so.status = 'claimed'
       WHERE sr.status != 'resolved_double_booking' ${sessionClause}`
    )
    .all(...params);

  // Only needed for resolved_manually rows whose filler isn't already
  // resolved via the direct replaces_assignment_id link above — see
  // resolveSubRequestFiller()'s doc comment in subFlow.js for why a fallback
  // is needed at all. Cached per week since several sub_requests can share
  // one week.
  const weekAssignmentsCache = new Map();
  function weekAssignmentsFor(weekId) {
    if (!weekAssignmentsCache.has(weekId)) {
      weekAssignmentsCache.set(
        weekId,
        db
          .prepare(
            'SELECT id, player_id, team, court, is_sub, replaces_assignment_id FROM week_assignments WHERE week_id = ?'
          )
          .all(weekId)
      );
    }
    return weekAssignmentsCache.get(weekId);
  }
  const claimedFillerIds = new Set();

  // Identity-based bucketing for a resolved_manually filler, since there's no
  // sub_offers row to read a source from.
  const playerEmailById = new Map(db.prepare('SELECT id, email FROM players').all().map((p) => [p.id, p.email]));
  const broaderEmails = new Set(db.prepare('SELECT email FROM broader_sub_list').all().map((r) => r.email));

  const byRequester = new Map(); // player_id -> { subsNeeded, selfArranged, roster, broader, unknown }
  const byFiller = new Map(); // player_id -> subsClaimedForOthers
  const totals = { roster: 0, broader: 0, unknown: 0 };

  function requesterBucket(playerId) {
    if (!byRequester.has(playerId)) {
      byRequester.set(playerId, { subsNeeded: 0, selfArranged: 0, roster: 0, broader: 0, unknown: 0 });
    }
    return byRequester.get(playerId);
  }

  for (const r of rows) {
    if (r.requesting_player_id == null) continue;
    const bucket = requesterBucket(r.requesting_player_id);
    bucket.subsNeeded++;
    if (r.self_arranged) bucket.selfArranged++;

    if (r.status === 'filled') {
      let source = null;
      if (r.was_new_person) source = 'unknown';
      else if (r.candidate_player_id != null) source = 'roster';
      else if (r.filled_by_player_id != null) source = 'broader'; // a claimed broader-list offer whose sub_offers row itself only had broader_list_id set
      if (source) {
        bucket[source]++;
        totals[source]++;
      }
      if (r.filled_by_player_id != null) {
        byFiller.set(r.filled_by_player_id, (byFiller.get(r.filled_by_player_id) || 0) + 1);
      }
    } else if (r.status === 'resolved_manually') {
      const fillerId =
        r.filled_by_player_id != null
          ? r.filled_by_player_id
          : subFlow.resolveSubRequestFiller({
              assignmentId: r.assignment_id,
              team: r.team,
              court: r.court,
              currentPlayerId: r.current_player_id,
              originalPlayerId: r.original_player_id,
              weekAssignments: weekAssignmentsFor(r.week_id),
              claimedFillerIds,
            });
      if (fillerId != null) {
        const fillerEmail = playerEmailById.get(fillerId);
        let source = 'roster';
        if (fillerEmail && fillerEmail.endsWith(`@${NO_EMAIL_DOMAIN}`)) source = 'unknown';
        else if (fillerEmail && broaderEmails.has(fillerEmail)) source = 'broader';
        bucket[source]++;
        totals[source]++;
        byFiller.set(fillerId, (byFiller.get(fillerId) || 0) + 1);
      }
    }
  }

  const allPlayerIds = [...new Set([...byRequester.keys(), ...byFiller.keys()])];
  const players = playersById(allPlayerIds);

  const perPlayer = [...byRequester.entries()]
    .map(([playerId, b]) => ({
      player: players.get(playerId),
      subsNeeded: b.subsNeeded,
      selfArranged: b.selfArranged,
      filledFromRoster: b.roster,
      filledFromBroaderList: b.broader,
      filledByUnknownPlayer: b.unknown,
      subsClaimedForOthers: byFiller.get(playerId) || 0,
    }))
    .filter((r) => r.player);

  // Anyone who's only ever covered for others (never needed a sub
  // themselves) still deserves a row for the "subs claimed" column.
  for (const [playerId, count] of byFiller.entries()) {
    if (!byRequester.has(playerId) && players.get(playerId)) {
      perPlayer.push({
        player: players.get(playerId),
        subsNeeded: 0,
        selfArranged: 0,
        filledFromRoster: 0,
        filledFromBroaderList: 0,
        filledByUnknownPlayer: 0,
        subsClaimedForOthers: count,
      });
    }
  }

  perPlayer.sort((a, b) => fullName(a.player).localeCompare(fullName(b.player)));

  return { perPlayer, totals };
}

/**
 * Direct player-to-player swaps (swapFlow.js) — proposed (by the initiator),
 * plus accepted/declined (by the target, who's the one actually responding).
 * Scoped to whichever side's own assignment is being counted, so a swap
 * spanning two different sessions still attributes each half correctly.
 */
function swapStats(sessionId) {
  const initParams = [];
  let initClause = '';
  if (sessionId) {
    initClause = 'AND w.session_id = ?';
    initParams.push(sessionId);
  }
  const proposed = db
    .prepare(
      `SELECT sr.initiator_player_id as player_id, COUNT(*) as n
       FROM swap_requests sr
       JOIN week_assignments wa ON wa.id = sr.initiator_assignment_id
       JOIN weeks w ON w.id = wa.week_id
       WHERE sr.initiator_player_id IS NOT NULL ${initClause}
       GROUP BY sr.initiator_player_id`
    )
    .all(...initParams);

  const targetParams = [];
  let targetClause = '';
  if (sessionId) {
    targetClause = 'AND w.session_id = ?';
    targetParams.push(sessionId);
  }
  const responded = db
    .prepare(
      `SELECT sr.target_player_id as player_id, sr.status, COUNT(*) as n
       FROM swap_requests sr
       JOIN week_assignments wa ON wa.id = sr.target_assignment_id
       JOIN weeks w ON w.id = wa.week_id
       WHERE sr.status IN ('accepted', 'declined') ${targetClause}
       GROUP BY sr.target_player_id, sr.status`
    )
    .all(...targetParams);

  const byPlayer = new Map(); // player_id -> { proposed, accepted, declined }
  function bucket(playerId) {
    if (!byPlayer.has(playerId)) byPlayer.set(playerId, { proposed: 0, accepted: 0, declined: 0 });
    return byPlayer.get(playerId);
  }
  for (const r of proposed) bucket(r.player_id).proposed = r.n;
  for (const r of responded) bucket(r.player_id)[r.status] = r.n;

  const players = playersById([...byPlayer.keys()]);
  return [...byPlayer.entries()]
    .map(([playerId, b]) => ({ player: players.get(playerId), ...b }))
    .filter((r) => r.player)
    .sort((a, b) => fullName(a.player).localeCompare(fullName(b.player)));
}

/**
 * Self-reported blackout dates (source = 'self' — excludes an admin adding
 * one on a player's behalf), scoped by session directly since blackout_dates
 * already carries its own session_id, no join through weeks needed.
 */
function blackoutStats(sessionId) {
  const params = [];
  let sessionClause = '';
  if (sessionId) {
    sessionClause = 'AND session_id = ?';
    params.push(sessionId);
  }
  const rows = db
    .prepare(
      `SELECT player_id, COUNT(*) as n FROM blackout_dates WHERE source = 'self' ${sessionClause} GROUP BY player_id`
    )
    .all(...params);
  const players = playersById(rows.map((r) => r.player_id));
  return rows
    .map((r) => ({ player: players.get(r.player_id), selfReported: r.n }))
    .filter((r) => r.player)
    .sort((a, b) => fullName(a.player).localeCompare(fullName(b.player)));
}

/**
 * Everything the Activity Log page's collapsible Player Behavior section
 * needs, in one call. `sessionId` is optional (falsy = all-time, every
 * session) — see the module doc comment above.
 */
function playerBehaviorSummary(sessionId) {
  const confirmTiming = confirmTimingStats(sessionId);
  const neverConfirmed = neverConfirmedStats(sessionId);
  const subStats = subRequestStats(sessionId);
  const swaps = swapStats(sessionId);
  const blackouts = blackoutStats(sessionId);

  // Merge confirmTiming + neverConfirmed + subStats.perPlayer into one
  // "Confirmation & subs" table, one row per player who shows up in ANY of
  // the three, rather than three separate tables that all repeat the same
  // player-name column.
  const byPlayer = new Map();
  function row(player) {
    if (!byPlayer.has(player.id)) {
      byPlayer.set(player.id, {
        player,
        confirmedOnFirstReminder: 0,
        confirmedAfterFollowup: 0,
        adminConfirmed: 0,
        neverConfirmed: 0,
        subsNeeded: 0,
        filledFromRoster: 0,
        filledFromBroaderList: 0,
        filledByUnknownPlayer: 0,
      });
    }
    return byPlayer.get(player.id);
  }
  for (const r of confirmTiming) {
    const out = row(r.player);
    out.confirmedOnFirstReminder = r.confirmedOnFirstReminder;
    out.confirmedAfterFollowup = r.confirmedAfterFollowup;
    out.adminConfirmed = r.adminConfirmed;
  }
  for (const r of neverConfirmed) {
    row(r.player).neverConfirmed = r.neverConfirmed;
  }
  for (const r of subStats.perPlayer) {
    const out = row(r.player);
    out.subsNeeded = r.subsNeeded;
    out.filledFromRoster = r.filledFromRoster;
    out.filledFromBroaderList = r.filledFromBroaderList;
    out.filledByUnknownPlayer = r.filledByUnknownPlayer;
  }
  const confirmAndSubRows = [...byPlayer.values()].sort((a, b) => fullName(a.player).localeCompare(fullName(b.player)));

  // Separate "other activity" table: self-arranged subs found, subs claimed
  // for others, swap activity, blackout self-reports — one row per player
  // who shows up in ANY of these, same merge pattern as above.
  const byPlayer2 = new Map();
  function row2(player) {
    if (!byPlayer2.has(player.id)) {
      byPlayer2.set(player.id, {
        player,
        selfArranged: 0,
        subsClaimedForOthers: 0,
        swapProposed: 0,
        swapAccepted: 0,
        swapDeclined: 0,
        blackoutSelfReported: 0,
      });
    }
    return byPlayer2.get(player.id);
  }
  for (const r of subStats.perPlayer) {
    if (r.selfArranged || r.subsClaimedForOthers) {
      const out = row2(r.player);
      out.selfArranged = r.selfArranged;
      out.subsClaimedForOthers = r.subsClaimedForOthers;
    }
  }
  for (const r of swaps) {
    const out = row2(r.player);
    out.swapProposed = r.proposed;
    out.swapAccepted = r.accepted;
    out.swapDeclined = r.declined;
  }
  for (const r of blackouts) {
    row2(r.player).blackoutSelfReported = r.selfReported;
  }
  const otherActivityRows = [...byPlayer2.values()].sort((a, b) => fullName(a.player).localeCompare(fullName(b.player)));

  return {
    confirmAndSubRows,
    otherActivityRows,
    subSourceTotals: subStats.totals,
  };
}

module.exports = {
  confirmTimingStats,
  neverConfirmedStats,
  subRequestStats,
  swapStats,
  blackoutStats,
  playerBehaviorSummary,
};
