'use strict';
const db = require('../db');
const { generateRawToken, hashToken } = require('./tokens');
const tokenStore = require('./tokenStore');
const email = require('./email');
const { zonedTimeToUtc, addDays } = require('./tz');
const { getTimezone } = require('./settings');
const { carriedOverBlackoutsForSession } = require('./sessionHelper');
const { generateUniqueSlug, generateUniqueBroaderSubSlug } = require('./playerSlug');
const { logPlayerActivity } = require('./activityLog');
const { deriveShortName, fullName } = require('./playerName');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * This session's sub candidate pool — used both by escalateOverdueRequests()
 * to decide who actually gets emailed, and by admin.js's session-subs page
 * to render the current checklist state. See "Per-session sub list" in
 * docs/HISTORY.md.
 *
 * Two sources, merged into one list (Kyle, 2026-09-02): the master
 * broader_sub_list, scoped down via session_sub_list same as always, PLUS
 * real players assigned directly via session_sub_players — added so one
 * session's roster can double as another session's sub pool (the
 * 16-players/two-sessions-of-8 scenario) without manually duplicating each
 * person into broader_sub_list by hand. Each row is tagged `candidateType`
 * ('broader' | 'player') so callers that need to distinguish them (right
 * now, only escalateOverdueRequests()'s sub_offers insert, which has to
 * point at the correct FK column) can — everything else (email templates,
 * the self-notice's "here's your sub list" summary) only ever reads
 * `.name`/`.email`, which both row shapes have, so they work unmodified.
 *
 * Every row also gets a `.fullName` (Kyle, 2026-09-07 — see playerName.js):
 * for a broader_sub_list row that's already the real full name (that table
 * only ever stores full names); for a real players row it's full_name if
 * an admin has filled it in, otherwise the same public name as `.name`.
 * Only consumer of this function today is admin.js (the Reassign dropdown's
 * "Sub list" optgroup, the Manage Subs picker's duplicate-exclusion check)
 * and escalateOverdueRequests() below — no public page reads this list, so
 * every current admin-facing display should read `.fullName`, not `.name`.
 */
function sessionSubList(sessionId) {
  const fromBroaderList = db
    .prepare(
      `SELECT bl.*, 'broader' as candidateType FROM session_sub_list ssl
       JOIN broader_sub_list bl ON bl.id = ssl.broader_list_id
       WHERE ssl.session_id = ?`
    )
    .all(sessionId);
  const fromPlayers = db
    .prepare(
      `SELECT p.*, 'player' as candidateType FROM session_sub_players ssp
       JOIN players p ON p.id = ssp.player_id
       WHERE ssp.session_id = ? AND p.active = 1`
    )
    .all(sessionId);
  const merged = [...fromBroaderList, ...fromPlayers].map((c) => ({ ...c, fullName: fullName(c) }));
  return merged.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function getWeekWithSession(weekId) {
  return db
    .prepare(
      // schedule_locked_at (Kyle, 2026-09-10) added so every caller that
      // already has a week-with-session row on hand can check the season-lock
      // gate below without a second query — see createSubRequest()/
      // adminFlagNeedsSub()/arrangeSelfSub()'s "not_locked" checks.
      `SELECT w.*, s.match_time, s.name as session_name, s.id as session_id, s.escalation_lead_hours, s.self_arranged_reminder_hours, s.self_arranged_deadline_hours, s.still_open_alert_hours, s.schedule_locked_at
       FROM weeks w JOIN sessions s ON s.id = w.session_id WHERE w.id = ?`
    )
    .get(weekId);
}

// Feeds the "Next few weeks:" list in the confirmation reminder email
// (email.js's nextWeeksPreviewHtml()) — an email, so every name here should
// be a full name (Kyle, 2026-09-07). Selecting full_name alongside name and
// computing fullName() here (rather than in email.js) keeps this the one
// place that knows how to build a "week -> who's playing" summary.
function upcomingWeeksPreview(sessionId, fromDate, count = 3) {
  const weeks = db
    .prepare(
      `SELECT * FROM weeks WHERE session_id = ? AND match_date >= ? ORDER BY match_date LIMIT ?`
    )
    .all(sessionId, fromDate, count);
  return weeks.map((w) => {
    const players = db
      .prepare(
        `SELECT p.name, p.full_name FROM week_assignments wa JOIN players p ON p.id = wa.player_id
         WHERE wa.week_id = ? AND wa.status != 'subbed_out'`
      )
      .all(w.id)
      .map((p) => ({ ...p, name: fullName(p) }));
    const ballDuty = w.ball_duty_player_id
      ? db.prepare('SELECT name, full_name FROM players WHERE id = ?').get(w.ball_duty_player_id)
      : null;
    return { ...w, players, ballDutyName: ballDuty ? fullName(ballDuty) : null };
  });
}

/**
 * "I found a sub" (Kyle, 2026-09-07): the candidate list shown to a player
 * on the /found-sub/:token page when they've already coordinated a sub
 * outside the app and just need to tell the system who it is. Per Kyle's
 * point 2 ("a list of all the players — both on the roster for that session
 * and the sub list"), this unions two pools rather than reusing
 * sessionSubList() alone: this session's own roster (session_players — a
 * teammate who isn't playing *this* week could still be the one who agreed
 * to fill in) plus the session's actual sub pool (sessionSubList(), which
 * itself already merges the broader list + any players explicitly assigned
 * as subs — see that function's own doc comment).
 *
 * Each candidate gets a namespaced `key` (`player:<id>` or `broader:<id>`)
 * rather than a bare id, since a real player's id and a broader_sub_list
 * id are drawn from different tables and can collide numerically — the key
 * is what arrangeSelfSub() below actually receives from the submitted form.
 * Deduped by key so someone on both the roster and the sub list (or added
 * to the sub list twice via both session_sub_list and session_sub_players,
 * see sessionSubList()) only appears once.
 *
 * Blackout status is annotated, not filtered — unlike fanOutSubRequest()'s
 * candidate pool (an unsolicited "will you sub?" email, where a blackout is
 * a reason not to bother someone), this is a specific, already-agreed-upon
 * choice the requesting player is making themselves. A blacked-out real
 * player can still be picked (same "blackout is a strong signal, not a hard
 * rule" pattern used everywhere else in this app — see the admin Reassign
 * dropdown's own blackout override) — the picker just needs to show it so
 * the requester isn't surprised later. Broader-list-only entries have no
 * blackout concept (they're not a `players` row until they actually sub in).
 */
function eligibleSelfArrangedCandidates(weekId) {
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId);
  if (!week) return [];

  const alreadyPlaying = new Set(
    db
      // Any row this week, including 'subbed_out' (Kyle, 2026-09-30): a
      // player who gave up their own spot can't take another spot the same
      // week — week_assignments is UNIQUE(week_id, player_id).
      .prepare(`SELECT player_id FROM week_assignments WHERE week_id = ?`)
      .all(weekId)
      .map((r) => r.player_id)
  );

  const blackoutSet = new Set(
    db
      .prepare('SELECT player_id, date FROM blackout_dates WHERE session_id = ?')
      .all(week.session_id)
      .map((b) => `${b.player_id}|${b.date}`)
  );
  for (const key of carriedOverBlackoutsForSession(week.session_id).keys()) blackoutSet.add(key);

  const byKey = new Map();

  const roster = db
    .prepare(
      `SELECT p.id, p.name, p.full_name, p.email FROM session_players sp JOIN players p ON p.id = sp.player_id
       WHERE sp.session_id = ? AND p.active = 1`
    )
    .all(week.session_id);
  for (const p of roster) {
    if (alreadyPlaying.has(p.id)) continue;
    byKey.set(`player:${p.id}`, {
      key: `player:${p.id}`,
      candidateType: 'player',
      id: p.id,
      name: p.name,
      fullName: fullName(p),
      email: p.email,
      blackedOut: blackoutSet.has(`${p.id}|${week.match_date}`),
    });
  }

  for (const c of sessionSubList(week.session_id)) {
    if (c.candidateType === 'player') {
      if (alreadyPlaying.has(c.id)) continue;
      const key = `player:${c.id}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        key,
        candidateType: 'player',
        id: c.id,
        name: c.name,
        fullName: c.fullName,
        email: c.email,
        blackedOut: blackoutSet.has(`${c.id}|${week.match_date}`),
      });
    } else {
      const key = `broader:${c.id}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        key,
        candidateType: 'broader',
        id: c.id,
        // This is the one public consumer of a broader_sub_list name
        // (/found-sub/:token — Kyle, 2026-09-07: "short public names" here
        // too, same rule as every other public page). Reads the real,
        // admin-reviewed public_name stored on the row (see playerName.js's
        // doc comment) rather than re-deriving one on the fly, so an admin
        // fix on the Sub List page is reflected here immediately — the
        // derive-on-the-fly fallback only covers a pre-migration NULL.
        name: c.public_name || deriveShortName(c.name),
        fullName: c.fullName,
        email: c.email,
        blackedOut: false,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Is there already an active (open/escalated) sub request anywhere in this
 * week — including on the exact assignment being flagged/requested? Per the
 * resolved open item, v1 does not run two parallel sub-request flows for the
 * same week — a second request is surfaced to the admin to handle manually
 * instead.
 *
 * Bug fixed here (found by Kyle, 2026-08-28, tracing a Stats page question):
 * this used to take an `excludingAssignmentId` and explicitly filter out that
 * assignment's own rows (`wa.id != ?`) before checking for an active request.
 * That made sense for "is some *other* assignment in this week already
 * blocking a new one," but createSubRequest()/adminFlagNeedsSub() both call
 * this on the very assignment they're about to flag — so if that assignment
 * itself already had an open request (e.g. an admin double-clicking "Needs a
 * sub," or re-flagging before the first request was resolved), the exclusion
 * meant its own still-open request was invisible to the check, and a second,
 * duplicate `sub_requests` row got created for the same slot instead of being
 * blocked. `closeActiveSubRequestForAssignment()` only ever closes one active
 * row per call (a plain `.get()`, no ordering), so a duplicate like this
 * silently required two separate "Clear sub request" clicks to fully clear —
 * which is exactly what happened in production on 2026-08-18 on one slot,
 * leaving three now-oddly-attributed rows behind (see the Stats page fix in
 * docs/HISTORY.md). Simplified to check the whole week with no exclusion at all —
 * "only one open/escalated request per week" now genuinely means one, full
 * stop, whichever assignment it's tied to.
 */
function hasActiveConcurrentSubRequest(weekId) {
  const row = db
    .prepare(
      `SELECT sr.id FROM sub_requests sr
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       WHERE wa.week_id = ? AND sr.status IN ('open', 'escalated')`
    )
    .get(weekId);
  return !!row;
}

/** Duplicate guard for one slot (Kyle, 2026-10-02). The old one-per-week
 * block above used to double as this; now that a second player in the same
 * week is allowed (see "Shared sub requests" below), this is what still
 * refuses a second active request on the SAME assignment (double-click,
 * re-flagging) — the real bug the 2026-08-28 fix above was about. */
function hasActiveSubRequestForAssignment(weekAssignmentId) {
  return !!db
    .prepare(`SELECT 1 FROM sub_requests WHERE week_assignment_id = ? AND status IN ('open', 'escalated', 'unfilled')`)
    .get(weekAssignmentId);
}

// --- Shared sub requests (Kyle, 2026-10-02) ---------------------------------
// Two (or more) players needing a sub for the same week. Each player keeps
// their own sub_requests row (their own emails, still-open alert, Sub History
// row), but the outreach is shared:
//
//   - The first request emails the roster as usual. A request that comes in
//     while that one is still open JOINS it (sub_requests.pool_id = the
//     first request's id): no new roster email, no new sub-list email.
//   - Every link from that outreach stays live until EVERY request in the
//     group is filled. Each "I'll play" click fills the oldest still-open
//     request in the group (order requested), whichever email it came from.
//   - The sub-list escalation goes out once for the group. A request that
//     joins after it went out is marked escalated straight away.
//   - If the earlier request(s) are all filled (or cleared) before the next
//     one comes in, the group is over: the new request starts its own, with
//     a fresh roster email (everyone already saw "Sub found").
//   - An "I found a sub" request stays on its own while its named sub has
//     time to answer (shared_at IS NULL). When it opens up at its deadline
//     it joins the open group if there is one (no new emails), otherwise it
//     goes out on its own like before. The named sub's own link always fills
//     that player's spot first.
//   - An admin-flagged request waiting for the reminder time joins an open
//     group right away (joining sends nothing), otherwise waits as before.
//
// shared_at marks a request as part of a group's outreach (set when its own
// roster email starts, or when it joins one). pool_id = the group's id (the
// request that started it); NULL on old rows means "its own group".
const CLAIMABLE_STATUSES = ['open', 'escalated', 'unfilled'];
function poolIdOf(sr) {
  return sr.pool_id || sr.id;
}
function isClaimableRequest(sr) {
  return !!sr && CLAIMABLE_STATUSES.includes(sr.status);
}
/** Still open AND part of a group's outreach — i.e. an "I'll play" click from
 * that group can fill it. */
function isSharedRequest(sr) {
  return isClaimableRequest(sr) && !!sr.shared_at;
}
/** An "I found a sub" request still waiting on its named sub. */
function inNamedSubWindow(sr) {
  return !!sr && !!sr.self_arranged && sr.status === 'open' && !sr.shared_at;
}
function poolMembers(poolId) {
  return db.prepare('SELECT * FROM sub_requests WHERE id = ? OR pool_id = ? ORDER BY id').all(poolId, poolId);
}
/** The group's still-open requests, oldest first — the fill order. */
function openPoolMembers(poolId) {
  return poolMembers(poolId).filter(isSharedRequest);
}
function poolStillOpenFor(subRequestId) {
  const sr = db.prepare('SELECT * FROM sub_requests WHERE id = ?').get(subRequestId);
  return !!sr && openPoolMembers(poolIdOf(sr)).length > 0;
}
function weekIdOfRequest(sr) {
  return db.prepare('SELECT week_id FROM week_assignments WHERE id = ?').get(sr.week_assignment_id).week_id;
}
/** The open group in this week another request can join, or null. */
function joinablePoolForWeek(weekId, excludeSubRequestId = 0) {
  const rows = db
    .prepare(
      `SELECT sr.* FROM sub_requests sr JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       WHERE wa.week_id = ? AND sr.id != ? AND sr.status IN ('open', 'escalated', 'unfilled') ORDER BY sr.id`
    )
    .all(weekId, excludeSubRequestId);
  const lead = rows.find(isSharedRequest);
  return lead ? poolIdOf(lead) : null;
}
/** Has this group's sub-list email already gone out? */
function poolEscalated(poolId, excludeSubRequestId = 0) {
  return poolMembers(poolId).some((m) => m.id !== excludeSubRequestId && m.escalated_at);
}
/** Add a request to an open group. Sends nothing. If the group already went
 * to the sub list, this request counts as escalated too. */
function joinPool(subRequestId, poolId) {
  const escalated = poolEscalated(poolId, subRequestId);
  db.prepare('UPDATE sub_requests SET pool_id = id WHERE id = ? AND pool_id IS NULL').run(poolId);
  db.prepare(
    `UPDATE sub_requests SET pool_id = ?, shared_at = COALESCE(shared_at, datetime('now')),
            fanout_sent_at = COALESCE(fanout_sent_at, datetime('now'))
     WHERE id = ?`
  ).run(poolId, subRequestId);
  if (escalated) {
    db.prepare(
      "UPDATE sub_requests SET status = 'escalated', escalated_at = COALESCE(escalated_at, datetime('now')) WHERE id = ? AND status = 'open'"
    ).run(subRequestId);
  }
  return { escalated };
}
/** Everyone currently holding a live link from this group (for "already
 * asked" lists in the joiner's emails). Full names. */
function pendingAskedNames(poolId) {
  const ids = poolMembers(poolId).map((m) => m.id);
  if (!ids.length) return [];
  const rows = db
    .prepare(
      `SELECT p.name AS p_name, p.full_name AS p_full, bl.name AS bl_name FROM sub_offers o
       LEFT JOIN players p ON p.id = o.candidate_player_id
       LEFT JOIN broader_sub_list bl ON bl.id = o.broader_list_id
       WHERE o.status = 'pending' AND o.sub_request_id IN (${ids.map(() => '?').join(',')}) ORDER BY o.id`
    )
    .all(...ids);
  const names = rows.map((r) => (r.p_name ? fullName({ name: r.p_name, full_name: r.p_full }) : r.bl_name)).filter(Boolean);
  return [...new Set(names)];
}
/** Offer counts across the whole group (asked = ever, pending = still live). */
function poolOfferCounts(poolId) {
  const ids = poolMembers(poolId).map((m) => m.id);
  return db
    .prepare(
      `SELECT COUNT(*) AS asked, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM sub_offers WHERE sub_request_id IN (${ids.map(() => '?').join(',')})`
    )
    .get(...ids);
}
/**
 * Start the outreach for a request: join the week's open group if there is
 * one (no emails), otherwise email the roster (fanOutSubRequest). Returns
 * { joined, poolId, count, candidates, alreadyAsked, poolEscalated }.
 */
async function startOutreach(subRequestId, requestingPlayerName) {
  const sr = db.prepare('SELECT * FROM sub_requests WHERE id = ?').get(subRequestId);
  const poolId = joinablePoolForWeek(weekIdOfRequest(sr), subRequestId);
  if (poolId) {
    const { escalated } = joinPool(subRequestId, poolId);
    return { joined: true, poolId, count: 0, candidates: [], alreadyAsked: pendingAskedNames(poolId), poolEscalated: escalated };
  }
  const r = await fanOutSubRequest(subRequestId, requestingPlayerName);
  return { joined: false, poolId: subRequestId, ...r, alreadyAsked: [], poolEscalated: false };
}

/**
 * The actual candidate computation + sub_offers creation + fan-out emails for
 * an already-open sub_requests row — shared by the immediate self-service
 * path (createSubRequest, below) and the deferred admin-flagged path (cron.js's
 * processReminders(), via fanOutPendingAdminFlagsForWeek() below). Recomputes
 * "who's already playing this week" fresh, right now, rather than trusting a
 * snapshot taken whenever the request was first opened — matters for the
 * deferred case, where the roster could genuinely have changed in the time
 * between an admin flagging a slot and that week's reminder time arriving.
 * Sets `fanout_sent_at`, which is what makes this safe to only ever run once
 * per request (see fanOutPendingAdminFlagsForWeek()'s WHERE clause).
 */
// --- Per-request email ordering (Kyle, 2026-09-29) --------------------------
// Everything that emails about one sub request runs through this chain, so a
// request's emails always go out in order: the roster fan-out, then (if the
// match is already inside the escalation window) the sub-list escalation,
// then the requester's own confirmation — and a "sub found" notice never
// lands in the middle of request emails still being sent. Without it, the
// 60s cron escalation pass or a fast claim click could run while a fan-out
// was mid-loop (each send is an await), interleaving the emails. In-memory
// is enough: the app runs as one Node process (PM2 fork mode).
const subRequestLocks = new Map();
function withSubRequestLock(subRequestId, fn) {
  const key = Number(subRequestId);
  const prev = subRequestLocks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  subRequestLocks.set(key, tail);
  tail.then(() => { if (subRequestLocks.get(key) === tail) subRequestLocks.delete(key); });
  return run;
}

// True while a request is still worth emailing candidates about. The send
// loops check this before each email and stop once the spot is filled or an
// admin resolved it, so nobody gets asked about a slot that's already taken.
function subRequestStillOpen(subRequestId) {
  const r = db.prepare('SELECT status FROM sub_requests WHERE id = ?').get(subRequestId);
  return !!r && (r.status === 'open' || r.status === 'escalated');
}

async function fanOutSubRequest(subRequestId, requestingPlayerName) {
  const subRequest = db.prepare('SELECT * FROM sub_requests WHERE id = ?').get(subRequestId);
  const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(subRequest.week_assignment_id);
  const week = getWeekWithSession(assignment.week_id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);

  // Any row this week, subbed_out included — see eligibleSelfArrangedCandidates().
  const alreadyPlaying = db
    .prepare(`SELECT player_id FROM week_assignments WHERE week_id = ?`)
    .all(week.id)
    .map((r) => r.player_id);

  const allCandidates = db
    .prepare(
      `SELECT p.id, p.name, p.full_name, p.email FROM session_players sp JOIN players p ON p.id = sp.player_id
       WHERE sp.session_id = ? AND p.active = 1 AND p.id NOT IN (${alreadyPlaying.map(() => '?').join(',') || '0'})`
    )
    .all(week.session_id, ...alreadyPlaying);

  // Don't offer the slot to someone who's already told the app they can't
  // play this date — same blackoutSet pattern scheduleRun.js's isBlackedOut
  // uses for the scheduler itself: this session's own blackout_dates rows,
  // plus any carried over from another session's real blackout on the same
  // calendar date (see sessionHelper.js's carriedOverBlackoutsForSession()).
  // Kyle, 2026-08-18: "The system should check blackout dates and if someone
  // is blacked out for that date, don't send them an email." A candidate who
  // wants to play anyway despite a blackout entry can still be added
  // manually by the admin (same override every other blackout check in this
  // app allows) — this only controls who gets an unsolicited "sub needed"
  // email, not a hard rule.
  const blackoutSet = new Set(
    db
      .prepare('SELECT player_id, date FROM blackout_dates WHERE session_id = ?')
      .all(week.session_id)
      .map((b) => `${b.player_id}|${b.date}`)
  );
  for (const key of carriedOverBlackoutsForSession(week.session_id).keys()) blackoutSet.add(key);

  // Skip anyone who already has an offer on this request — e.g. the named
  // sub on an "I found a sub" request that later opens up to the roster
  // (Kyle, 2026-09-30): their original invite link is still live.
  const alreadyOffered = new Set(
    db.prepare('SELECT candidate_player_id FROM sub_offers WHERE sub_request_id = ? AND candidate_player_id IS NOT NULL').all(subRequestId).map((r) => r.candidate_player_id)
  );
  // ...or a live link from another request this week (Kyle, 2026-10-02 —
  // e.g. the named sub of a separate "I found a sub" request).
  for (const r of db
    .prepare(
      `SELECT o.candidate_player_id FROM sub_offers o JOIN sub_requests sr ON sr.id = o.sub_request_id
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       WHERE wa.week_id = ? AND o.status = 'pending' AND o.candidate_player_id IS NOT NULL`
    )
    .all(week.id)) alreadyOffered.add(r.candidate_player_id);
  const candidates = allCandidates.filter((c) => !blackoutSet.has(`${c.id}|${week.match_date}`) && !alreadyOffered.has(c.id));

  const offers = db.transaction(() => {
    // shared_at/pool_id (Kyle, 2026-10-02): this request now starts its own
    // group, which a later request in the same week can join.
    db.prepare(
      `UPDATE sub_requests SET fanout_sent_at = datetime('now'), shared_at = COALESCE(shared_at, datetime('now')),
              pool_id = COALESCE(pool_id, id) WHERE id = ?`
    ).run(subRequestId);
    return candidates.map((c) => {
      const raw = generateRawToken();
      db.prepare(
        "INSERT INTO sub_offers (sub_request_id, candidate_player_id, token, status, source) VALUES (?, ?, ?, ?, 'roster')"
      ).run(subRequestId, c.id, hashToken(raw), 'pending');
      return { candidate: c, rawToken: raw };
    });
  })();

  const emailed = [];
  for (const { candidate, rawToken } of offers) {
    // Keep going while ANY request in the group is open (Kyle, 2026-10-02).
    if (!poolStillOpenFor(subRequestId)) break;
    emailed.push(candidate);
    await email.sendSubRequestFanout({
      recipient: candidate,
      week,
      session,
      claimToken: rawToken,
      requestingPlayerName,
      threadKey: subThreadKey(subRequestId),
    });
  }

  // Kyle, 2026-08-27: returning the actual candidate list (not just a count)
  // so createSubRequest() below can tell the requesting player exactly who
  // was just emailed, instead of the old generic "the other players have
  // been emailed" with no names.
  // Only the candidates actually emailed (the loop stops early if the spot
  // gets filled mid-send) — Kyle, 2026-09-29.
  return { count: emailed.length, candidates: emailed };
}

/**
 * Kicks off a sub request for a given week_assignment: marks it needs_sub,
 * opens a sub_requests row, and emails every other enrolled player in the
 * session who isn't already playing that week (the "5 non-playing regulars"
 * in the example 9-player/4-per-week group; generalizes to roster size).
 * Player-initiated (self-service "Need a sub", or the emailed reminder link)
 * — fans out immediately. Compare adminFlagNeedsSub() below, which does the
 * same status transition but deliberately sends nothing right away.
 *
 * Gated on `sessions.schedule_locked_at` (Kyle, 2026-09-10): while a season's
 * schedule is still being built, an admin will typically rework weeks
 * directly (Reassign, the joint cross-session conflict resolver) to fix
 * things like a double-booking — that's schedule construction, not a real
 * substitution, and it shouldn't be able to produce a sub_requests row that
 * shows up in the Stats page's Sub History table looking like one. See
 * docs/HISTORY.md's "Lock this schedule" note, which flagged this exact gate as a
 * planned use of the lock before it existed. Once the admin locks the
 * schedule, this and the other two sub-creating entry points below
 * (adminFlagNeedsSub, arrangeSelfSub) work exactly as before.
 */
async function createSubRequest(weekAssignmentId) {
  const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(weekAssignmentId);
  if (!assignment) throw new Error('Assignment not found');
  const week = getWeekWithSession(assignment.week_id);
  if (!week.schedule_locked_at) return { blocked: true, reason: 'not_locked' };
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(assignment.player_id);

  // Another player already needing a sub this week is fine now (Kyle,
  // 2026-10-02) — this request joins theirs. Only a second request on this
  // same slot is refused.
  if (hasActiveSubRequestForAssignment(weekAssignmentId)) {
    return { blocked: true, reason: 'already_requested' };
  }

  const wasBallDuty = week.ball_duty_player_id === player.id;

  const subRequestId = db.transaction(() => {
    db.prepare("UPDATE week_assignments SET status = 'needs_sub' WHERE id = ?").run(weekAssignmentId);
    // The moment a sub is requested, the "I'm playing" confirm link for this
    // exact slot should stop working outright — not just show a polite
    // "already requested" message — since the player themselves just said
    // they can't make it. Kills every outstanding token for this assignment
    // (original reminder, any follow-up nudge, etc. all at once).
    tokenStore.invalidateTokensForAssignment(weekAssignmentId);
    // requesting_player_id snapshots who was actually on this assignment
    // right now, at request-creation time — same "capture identity before it
    // can drift" reasoning as swap_requests.initiator_player_id. Without it,
    // a later reassignment/swap of this same slot (Reassign, the joint
    // conflict resolver, etc.) would silently relabel this historical row
    // under the *new* occupant's name wherever it's displayed (see the Stats
    // page's Sub History table) — see docs/HISTORY.md for the real case this fixed.
    const reqInfo = db
      .prepare(
        "INSERT INTO sub_requests (week_assignment_id, status, initiated_by, requesting_player_id) VALUES (?, 'open', 'player', ?)"
      )
      .run(weekAssignmentId, player.id);
    const subRequestId = reqInfo.lastInsertRowid;

    if (wasBallDuty) {
      db.prepare(
        "UPDATE weeks SET ball_duty_player_id = NULL, needs_attention = 1, notes = ? WHERE id = ?"
      ).run(`Ball duty needs reassignment (was ${fullName(player)}, now needs a sub)`, week.id);
    }

    return subRequestId;
  })();

  adoptPendingSubThread(weekAssignmentId, subRequestId);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);

  // All of this request's emails in one ordered run (Kyle, 2026-09-29):
  // roster fan-out, then escalation to the sub list if the match is already
  // inside the escalation window, then the requester's confirmation last.
  // If another player's request is still open this week, this one joins it
  // instead of emailing the roster again (Kyle, 2026-10-02) — see
  // startOutreach().
  const { offerCount, joined } = await withSubRequestLock(subRequestId, async () => {
    const out = await startOutreach(subRequestId, fullName(player));
    const esc = await escalateOneRequest(subRequestId, { onlyIfDue: true });
    // Safety net for a wrong-name mix-up (e.g. on the self-service "Request a
    // Sub" page): the affected player gets their own confirmation, so a
    // mistake surfaces immediately. Also tells them exactly who was emailed
    // and what happens next — see sendSubRequestOwnConfirmation().
    const sessionSubs = sessionSubList(session.id);
    await email.sendSubRequestOwnConfirmation({
      player, week, session, candidates: out.candidates, sessionSubs,
      escalatedTo: esc.result === 'escalated' ? esc.emailed : null,
      joined: out.joined ? { alreadyAsked: out.alreadyAsked, escalated: out.poolEscalated || esc.result === 'escalated' } : null,
      threadKey: subThreadKey(subRequestId),
    });
    return { offerCount: out.count, joined: out.joined };
  });

  // Activity log — player self-service "Need a sub" (Kyle, 2026-09-09: wants
  // a searchable breadcrumb of player actions — confirms, sub requests, and
  // sub claims — in the same Activity Log as admin actions). Admin-facing,
  // full name.
  logPlayerActivity({
    playerName: fullName(player),
    action: 'sub.request',
    description: joined
      ? `${fullName(player)} requested a sub for ${week.match_date} — joined the sub request already open that week (no new emails)`
      : `${fullName(player)} requested a sub for ${week.match_date} (${offerCount} candidate${offerCount === 1 ? '' : 's'} notified)`,
    sessionId: session.id,
  });

  return { blocked: false, subRequestId, offerCount, joined };
}

/**
 * Admin-initiated equivalent of createSubRequest(), for a hard conflict the
 * admin needs to flag on a player's behalf — Kyle, 2026-08-13: "admins should
 * really not be touching the player schedule except for edge cases," so this
 * is meant to stay rare, not the normal path (players have Request a Sub /
 * Swap a Week for that). Does the identical status transition and token
 * invalidation as the self-service flow, but sends NO email at all right
 * now — not even a "you've been marked as needing a sub" notice to the
 * affected player ("admin has final say"). The candidate fan-out is deferred
 * entirely to cron.js's processReminders(), which calls
 * fanOutPendingAdminFlagsForWeek() once that week's own reminder threshold
 * arrives — same email, same recipients, just later. Every action here is
 * still logged via activityLog.js at the call site (admin.js), same as every
 * other admin mutation.
 *
 * Also gated on `sessions.schedule_locked_at`, same reasoning as
 * createSubRequest() above (Kyle, 2026-09-10) — this is actually the more
 * important of the two to gate: this admin-flag path is exactly what got
 * used, pre-lock, to mark a slot needing attention while working out a
 * cross-session double-booking, leaving behind sub_requests rows that later
 * read as real sub history once the underlying conflict was fixed by
 * reworking the schedule instead of finding an actual substitute.
 */
function adminFlagNeedsSub(weekAssignmentId) {
  const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(weekAssignmentId);
  if (!assignment) throw new Error('Assignment not found');
  const week = getWeekWithSession(assignment.week_id);
  if (week.locked) return { blocked: true, reason: 'locked' };
  if (!week.schedule_locked_at) return { blocked: true, reason: 'not_locked' };
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(assignment.player_id);

  if (hasActiveSubRequestForAssignment(weekAssignmentId)) {
    return { blocked: true, reason: 'already_requested' };
  }

  const wasBallDuty = week.ball_duty_player_id === player.id;

  const subRequestId = db.transaction(() => {
    db.prepare("UPDATE week_assignments SET status = 'needs_sub' WHERE id = ?").run(weekAssignmentId);
    tokenStore.invalidateTokensForAssignment(weekAssignmentId);
    // See createSubRequest()'s matching comment — requesting_player_id snapshots
    // who this flag was actually about, so a later reassignment of this same
    // slot can't silently relabel this history under someone else's name.
    const reqInfo = db
      .prepare(
        "INSERT INTO sub_requests (week_assignment_id, status, initiated_by, requesting_player_id) VALUES (?, 'open', 'admin', ?)"
      )
      .run(weekAssignmentId, player.id);
    const subRequestId = reqInfo.lastInsertRowid;

    if (wasBallDuty) {
      db.prepare(
        "UPDATE weeks SET ball_duty_player_id = NULL, needs_attention = 1, notes = ? WHERE id = ?"
      ).run(`Ball duty needs reassignment (was ${fullName(player)}, now needs a sub)`, week.id);
    }

    return subRequestId;
  })();

  // Another request already out this week (Kyle, 2026-10-02): join it now.
  // Joining sends nothing, so there's no reason to wait for the reminder
  // time — the next "I'll play" click after the earlier request(s) fills
  // this one.
  const poolId = joinablePoolForWeek(week.id, subRequestId);
  if (poolId) joinPool(subRequestId, poolId);

  // Admin-facing (flash message + activity log at the admin.js call site) —
  // full name (Kyle, 2026-09-07).
  return { blocked: false, subRequestId, playerName: fullName(player), joined: !!poolId };
}

/**
 * Cron entry point (processReminders(), once a given week's own reminder
 * threshold has been reached): finds any admin-flagged sub request for that
 * week whose fan-out hasn't gone out yet, and sends it — same email, same
 * candidate computation as a player's own request, just triggered here
 * instead of inline. The `fanout_sent_at IS NULL` check is what makes this
 * safe to call on every tick once a week's reminder time has passed: the
 * first call sends it and stamps the column, every later call sees nothing
 * to do.
 */
async function fanOutPendingAdminFlagsForWeek(weekId) {
  const pending = db
    .prepare(
      `SELECT sr.id as subRequestId, p.name, p.full_name
       FROM sub_requests sr
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       JOIN players p ON p.id = wa.player_id
       WHERE wa.week_id = ? AND sr.status = 'open' AND sr.initiated_by = 'admin' AND sr.fanout_sent_at IS NULL`
    )
    .all(weekId);

  for (const row of pending) {
    // Same ordered run as createSubRequest(): roster first, then the sub
    // list if already due (Kyle, 2026-09-29).
    // Joins the week's open group instead if one started meanwhile (Kyle,
    // 2026-10-02) — see startOutreach().
    await withSubRequestLock(row.subRequestId, async () => {
      const cur = db.prepare('SELECT status FROM sub_requests WHERE id = ?').get(row.subRequestId);
      if (!cur || cur.status !== 'open') return;
      await startOutreach(row.subRequestId, fullName(row));
      await escalateOneRequest(row.subRequestId, { onlyIfDue: true });
    });
  }

  return pending.length;
}

/** First explicit "Confirm" click on a sub offer wins; closes all others. */
/**
 * Which route a sub_offers row came through: 'roster' | 'self_arranged' |
 * 'escalation'. Uses sub_offers.source when set (every offer since
 * 2026-09-28). For older offers: on a self-arranged request, the first offer
 * is the named sub's invite and any later ones are escalation; on a normal
 * request, a broader-list offer or any offer after escalation started is
 * treated as escalation.
 */
function offerSource(offer, subRequest) {
  if (offer.source) return offer.source;
  const firstId = db.prepare('SELECT MIN(id) AS id FROM sub_offers WHERE sub_request_id = ?').get(offer.sub_request_id).id;
  if (subRequest && subRequest.self_arranged) return offer.id === firstId ? 'self_arranged' : 'escalation';
  if (offer.broader_list_id) return 'escalation';
  return 'roster';
}

/**
 * Status for a sub's new row at claim time (Kyle, 2026-09-30): Shawn A took
 * Pete D's 10/19 spot almost three weeks out and was marked 'confirmed' on
 * the spot, so he'd get no follow-up nudge and the admin pages showed him as
 * settled. Now a claim made BEFORE that week's regular reminder time starts
 * as 'scheduled', and the sub confirms through the normal reminder/follow-up
 * like everyone else. A claim at or after the reminder time stays
 * 'confirmed' (the claim is the confirmation; otherwise the catch-up
 * reminder pass would email "please confirm" seconds after they said yes).
 * Also 'confirmed' when the session's automatic reminders are paused or it's
 * not a regular session, since no reminder would ever come.
 */
function subClaimStatus(week, session, now = new Date()) {
  if (!session || session.session_type !== 'regular' || !session.reminders_enabled) return 'confirmed';
  const reminderAt = zonedTimeToUtc(addDays(week.match_date, -session.reminder_days_before), session.reminder_time, getTimezone());
  return now < reminderAt ? 'scheduled' : 'confirmed';
}

async function claimSub(rawToken) {
  const hashed = hashToken(rawToken);
  // Either the offer's original link or its nudge link (the "I found a sub"
  // reminder/warning emails mint a second one — Kyle, 2026-09-30).
  const offer = db.prepare('SELECT * FROM sub_offers WHERE token = ? OR nudge_token = ?').get(hashed, hashed);
  if (!offer) return { ok: false, reason: 'invalid' };
  return claimOffer(offer);
}

/**
 * The actual claim, shared by claimSub() (the sub clicking their link) and
 * adminConfirmSelfArrangedSub() (an admin confirming on the named sub's
 * behalf — Kyle, 2026-09-30). `byAdmin` skips the player-self-service
 * activity-log entry; the admin route logs its own.
 */
async function claimOffer(offer, { byAdmin = false } = {}) {
  if (offer.status !== 'pending') return { ok: false, reason: 'already_claimed' };

  const ownRequest = db.prepare('SELECT * FROM sub_requests WHERE id = ?').get(offer.sub_request_id);
  // Which request this click fills (Kyle, 2026-10-02) — see claimTarget().
  const subRequest = ownRequest ? claimTarget(offer, ownRequest) : null;
  // 'resolved_manually' covers an admin having reassigned or manually
  // confirmed this slot directly, and 'resolved_double_booking' covers the
  // joint conflict resolver having moved this player to a different week
  // entirely (both via closeActiveSubRequestForAssignment) — both treated
  // the same as 'filled' here as defense in depth. In practice that path
  // also closes every pending offer, so the offer.status check above would
  // already catch it; this just means correctness here doesn't depend on
  // that other cleanup having also run.
  if (!subRequest || !isClaimableRequest(subRequest)) {
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
      // Reuse the slug already reserved on the broader_sub_list row itself
      // (Kyle, 2026-09-01 — see admin/sub_list.ejs and playerSlug.js's
      // generateUniqueBroaderSubSlug()) rather than generating a fresh one
      // here: every sub-list entry gets a slug the moment it's added (or,
      // for a pre-existing entry, at the next boot's backfill), specifically
      // so an admin can see and control it — and resolve a real collision
      // between two pending entries — before either one ever claims a spot.
      // Ignoring bl.slug and generating a brand-new one at claim time would
      // silently throw that admin control away. The generateUniqueSlug()
      // fallback only matters for the narrow edge case of a bl.slug that's
      // somehow still blank (shouldn't happen post-backfill, but avoids a
      // literal "/me/" link if it ever does).
      const slug = bl.slug || generateUniqueSlug(db, bl.name, null);
      // bl.name is a real full name (broader_sub_list only ever stores full
      // names — see playerName.js's doc comment). The new players row needs
      // both: full_name = the real value, name = the admin-reviewed short
      // public form already stored on the sub-list row itself
      // (bl.public_name — Kyle, 2026-09-07), falling back to a fresh
      // "First LastInitial" derivation only for the narrow edge case of a
      // pre-migration row that's somehow still NULL.
      const shortName = bl.public_name || deriveShortName(bl.name);
      const info = db
        .prepare('INSERT INTO players (name, email, slug, full_name) VALUES (?, ?, ?, ?)')
        .run(shortName, bl.email, slug, bl.name);
      existing = { id: info.lastInsertRowid, name: shortName, email: bl.email, slug, full_name: bl.name };
    }
    subPlayer = existing;
  }

  // Already has a row this week — playing another spot, or gave their own
  // spot up (Kyle, 2026-09-30). week_assignments is UNIQUE(week_id,
  // player_id), so this used to crash with a 500. Refuse cleanly instead.
  const existingRow = db
    .prepare('SELECT status FROM week_assignments WHERE week_id = ? AND player_id = ?')
    .get(originalAssignment.week_id, subPlayer.id);
  if (existingRow) {
    return { ok: false, reason: existingRow.status === 'subbed_out' ? 'gave_up_spot' : 'already_playing' };
  }

  // 'scheduled' if claimed before this week's reminder time, else 'confirmed'
  // — see subClaimStatus().
  const subStatus = subClaimStatus(week, session);
  const poolId = poolIdOf(subRequest);
  db.transaction(() => {
    db.prepare("UPDATE sub_offers SET status = 'claimed', responded_at = datetime('now') WHERE id = ?").run(offer.id);
    db.prepare("UPDATE sub_requests SET status = 'filled' WHERE id = ?").run(subRequest.id);
    // Everyone else's links stay live while another request in the group is
    // still open (Kyle, 2026-10-02); only once the last one is filled do
    // they all close.
    if (openPoolMembers(poolId).length === 0) {
      const ids = poolMembers(poolId).map((m) => m.id);
      db.prepare(
        `UPDATE sub_offers SET status = 'closed' WHERE status = 'pending' AND id != ? AND sub_request_id IN (${ids.map(() => '?').join(',')})`
      ).run(offer.id, ...ids);
    }
    db.prepare("UPDATE week_assignments SET status = 'subbed_out' WHERE id = ?").run(originalAssignment.id);
    // A sub's own "I'm playing"/"need a sub" tokens don't exist yet — they
    // won't get any until they're next reminded — but the *original*
    // player's tokens for this exact slot need to die now: they just got
    // subbed out, so their old reminder/follow-up links shouldn't still be
    // able to act on this assignment (which now belongs to someone else).
    tokenStore.invalidateTokensForAssignment(originalAssignment.id);
    db.prepare(
      `INSERT INTO week_assignments (week_id, player_id, team, court, is_sub, status, confirmed_at, replaces_assignment_id)
       VALUES (?, ?, ?, ?, 1, ?, ${subStatus === 'confirmed' ? "datetime('now')" : 'NULL'}, ?)`
    ).run(originalAssignment.week_id, subPlayer.id, originalAssignment.team, originalAssignment.court, subStatus, originalAssignment.id);
  })();

  // Activity log — the sub's own confirm click, whichever pool it came from
  // (the regular fan-out, the broader escalation list, or a self-arranged
  // invite via arrangeSelfSub) — this is the one place all three converge
  // (Kyle, 2026-09-09: wants "when a player confirms they are subbing for
  // another player" in the searchable breadcrumb). Admin-facing, full names.
  const originalPlayerForLog = db.prepare('SELECT * FROM players WHERE id = ?').get(originalAssignment.player_id);
  // Kyle, 2026-09-28: one action per route the claim came through, so a
  // self-arranged sub accepting isn't logged the same as someone grabbing a
  // fan-out spot. See offerSource() for how older offers are classified.
  const source = offerSource(offer, ownRequest);
  const subName = fullName(subPlayer);
  const origName = fullName(originalPlayerForLog);
  const claimLog = {
    self_arranged: { action: 'sub.self_arranged_confirm', description: `${subName} confirmed the sub ${origName} arranged for ${week.match_date}` },
    escalation: { action: 'sub.claim_escalated', description: `${subName} (from the sub list) confirmed they're subbing for ${origName} on ${week.match_date}` },
    roster: { action: 'sub.claim', description: `${subName} confirmed they're subbing for ${origName} on ${week.match_date}` },
  }[source];
  if (!byAdmin) logPlayerActivity({ playerName: subName, action: claimLog.action, description: claimLog.description, sessionId: session.id });

  // Notify that week's full group of 4 (other 3 originals + the new sub)
  const groupRows = db
    .prepare(
      `SELECT p.id, p.name, p.full_name, p.email FROM week_assignments wa JOIN players p ON p.id = wa.player_id
       WHERE wa.week_id = ? AND wa.status != 'subbed_out'`
    )
    .all(originalAssignment.week_id);

  // Other sub requests still open this week (Kyle, 2026-10-02) — the
  // "Sub found" email says the match still needs N more.
  const stillOpenCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sub_requests sr JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       WHERE wa.week_id = ? AND sr.status IN ('open', 'escalated', 'unfilled')`
    )
    .get(originalAssignment.week_id).n;

  // "Sub found" emails wait for any of this request's emails still being
  // sent (a fan-out or escalation loop stops early now that the request is
  // filled), so they always come after the request emails (Kyle, 2026-09-29).
  await withSubRequestLock(subRequest.id, async () => {
  for (const recipient of groupRows) {
    await email.sendSubFilledNotice({
      recipient,
      week,
      session,
      subName: fullName(subPlayer),
      originalName: originalPlayerForLog ? fullName(originalPlayerForLog) : null,
      threadKey: subThreadKey(subRequest.id),
      // Only the sub's own copy, and only when they still have to confirm
      // through the regular reminder (Kyle, 2026-09-30).
      reminderNote: subStatus === 'scheduled' && recipient.id === subPlayer.id,
      stillOpenCount,
    });
  }

  // Kyle, 2026-08-27: the original requester's own row just flipped to
  // 'subbed_out' above, which is exactly why the groupRows query (status !=
  // 'subbed_out') never includes them — they previously got no notice at
  // all that their spot was covered, and had to check the site themselves
  // to find out. One dedicated notice, separate from the group email above
  // since the wording ("you're all set") doesn't fit a still-playing
  // teammate.
  const originalPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(originalAssignment.player_id);
  if (originalPlayer) {
    await email.sendSubFilledOriginalNotice({ recipient: originalPlayer, week, session, subName: fullName(subPlayer), threadKey: subThreadKey(subRequest.id) });
  }
  });

  return { ok: true, week, subPlayer, subStatus, originalName: origName };
}

/**
 * Which request an "I'll play" click fills (Kyle, 2026-10-02):
 *   - the named sub's own link on an "I found a sub" request fills that
 *     player's spot while it's still open;
 *   - otherwise the oldest still-open request in the click's group
 *     (order requested), whichever request's email the link came from.
 * Returns null when nothing in the group is open any more. Read-only, so the
 * claim page can show who they'd be covering before they click.
 */
function claimTarget(offer, ownRequest) {
  if (isClaimableRequest(ownRequest) && offerSource(offer, ownRequest) === 'self_arranged') return ownRequest;
  if (inNamedSubWindow(ownRequest)) return null;
  return openPoolMembers(poolIdOf(ownRequest))[0] || null;
}
/** For the claim page: who this link would currently cover, or null. */
function claimTargetPlayerName(offer) {
  const own = db.prepare('SELECT * FROM sub_requests WHERE id = ?').get(offer.sub_request_id);
  const target = own && offer.status === 'pending' ? claimTarget(offer, own) : null;
  if (!target) return null;
  const p = db
    .prepare('SELECT p.* FROM week_assignments wa JOIN players p ON p.id = wa.player_id WHERE wa.id = ?')
    .get(target.week_assignment_id);
  return p ? fullName(p) : null;
}

/**
 * "I found a sub" (Kyle, 2026-09-07): a player who's already coordinated a
 * sub outside the app tells the system who it is, instead of the system
 * fanning out to a whole candidate pool and waiting for someone to claim it.
 * Deliberately built as a single-candidate variant of the exact same
 * sub_requests/sub_offers shape createSubRequest()/fanOutSubRequest() already
 * use — one sub_requests row, one sub_offers row for the named person — so
 * claimSub() (the actual confirm-and-take-the-slot mutation), the
 * needs_sub/subbed_out badge logic, the Stats page's Sub History table, and
 * escalateOverdueRequests()'s configurable-hours-before-match fallback all work
 * completely unmodified. If the named person never confirms, that fallback
 * fires exactly as it would for any other still-`open` request — no special
 * casing needed here for "what if they don't respond" (Kyle's own pick,
 * "falls back to normal escalation").
 *
 * `selection` is one of:
 *   { candidateKey: 'player:<id>' | 'broader:<id>' } — a pick from
 *     eligibleSelfArrangedCandidates(), i.e. someone already known to this
 *     session (its own roster, or its existing sub pool).
 *   { newPerson: { name, email } } — someone the system has never heard of.
 *     Deduped by email against BOTH `players` and `broader_sub_list` first
 *     (a player typing in a name/email that happens to already be on file
 *     shouldn't create a duplicate identity) — only a genuine miss on both
 *     counts is treated as "new" for the purposes of Kyle's points 3-5
 *     (add to the sub list, alert the admin). A match against either table
 *     is treated exactly like picking that person from the list.
 *
 * Also gated on `sessions.schedule_locked_at`, same reasoning as
 * createSubRequest()/adminFlagNeedsSub() above (Kyle, 2026-09-10).
 */
async function arrangeSelfSub(weekAssignmentId, selection = {}) {
  const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(weekAssignmentId);
  if (!assignment) return { ok: false, reason: 'not_found' };
  const week = getWeekWithSession(assignment.week_id);
  if (week.locked) return { ok: false, reason: 'locked' };
  if (!week.schedule_locked_at) return { ok: false, reason: 'not_locked' };
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(assignment.player_id);

  // Another sub request this week is fine (Kyle, 2026-10-02): this one stays
  // on its own while the named sub has time to answer, and joins the open
  // group (if any) when it opens up.
  if (hasActiveSubRequestForAssignment(weekAssignmentId)) {
    return { ok: false, reason: 'already_requested' };
  }

  // { candidateType: 'player'|'broader', id, name (public/short), email,
  // fullName (real full name — Kyle, 2026-09-07) }
  let candidate;
  let isNewPerson = false;

  if (selection.newPerson) {
    const name = String(selection.newPerson.name || '').trim();
    const rawEmail = String(selection.newPerson.email || '').trim();
    if (!name || /[<>]/.test(name) || !EMAIL_RE.test(rawEmail)) {
      return { ok: false, reason: 'invalid_new_person' };
    }
    const emailLower = rawEmail;

    const existingPlayer = db.prepare('SELECT * FROM players WHERE email = ?').get(emailLower);
    const existingBroader = db.prepare('SELECT * FROM broader_sub_list WHERE email = ?').get(emailLower);

    if (existingPlayer) {
      candidate = {
        candidateType: 'player',
        id: existingPlayer.id,
        name: existingPlayer.name,
        email: existingPlayer.email,
        fullName: fullName(existingPlayer),
      };
    } else if (existingBroader) {
      db.prepare('INSERT OR IGNORE INTO session_sub_list (session_id, broader_list_id) VALUES (?, ?)').run(
        session.id,
        existingBroader.id
      );
      candidate = {
        candidateType: 'broader',
        id: existingBroader.id,
        name: existingBroader.public_name || deriveShortName(existingBroader.name),
        email: existingBroader.email,
        fullName: existingBroader.name,
      };
    } else {
      // Genuinely new — nobody on file has this email. Reserve a slug and a
      // public_name now (same reasoning as every other broader_sub_list
      // entry, see playerSlug.js and playerName.js) and record who added
      // them, so the admin Sub List page can flag this row as worth a
      // name/slug/public-name cleanup pass (Kyle's point 9) and the Activity
      // Log/Status page can say who it was.
      const slug = generateUniqueBroaderSubSlug(db, name, null);
      // `name` here is whatever the requesting player typed into the "First
      // and last name" field on /found-sub — treated as the real full name
      // (broader_sub_list only ever stores full names), with a short public
      // form derived and stored now so it's reviewable on the Sub List page
      // rather than only ever re-derived on the fly.
      const publicName = deriveShortName(name);
      const info = db
        .prepare('INSERT INTO broader_sub_list (name, email, slug, public_name, added_by_player_id) VALUES (?, ?, ?, ?, ?)')
        .run(name, emailLower, slug, publicName, player.id);
      const newId = info.lastInsertRowid;
      db.prepare('INSERT INTO session_sub_list (session_id, broader_list_id) VALUES (?, ?)').run(session.id, newId);
      candidate = { candidateType: 'broader', id: newId, name: publicName, email: emailLower, fullName: name };
      isNewPerson = true;
    }
  } else if (selection.candidateKey) {
    const match = eligibleSelfArrangedCandidates(week.id).find((c) => c.key === selection.candidateKey);
    if (!match) return { ok: false, reason: 'invalid_candidate' };
    candidate = { candidateType: match.candidateType, id: match.id, name: match.name, email: match.email, fullName: match.fullName };
  } else {
    return { ok: false, reason: 'no_selection' };
  }

  if (candidate.candidateType === 'player' && candidate.id === player.id) {
    return { ok: false, reason: 'self' };
  }

  const wasBallDuty = week.ball_duty_player_id === player.id;

  const { subRequestId, rawToken } = db.transaction(() => {
    db.prepare("UPDATE week_assignments SET status = 'needs_sub' WHERE id = ?").run(weekAssignmentId);
    tokenStore.invalidateTokensForAssignment(weekAssignmentId);

    // self_arranged = 1 unconditionally: this whole function IS the
    // self-arranged ("I found a sub") path, as opposed to createSubRequest()'s
    // normal fan-out or adminFlagNeedsSub() — see schema.sql's comment on
    // this column for why it has to be stamped here rather than re-derived
    // later from sub_offers row counts.
    const reqInfo = db
      .prepare(
        `INSERT INTO sub_requests (week_assignment_id, status, initiated_by, requesting_player_id, fanout_sent_at, self_arranged)
         VALUES (?, 'open', 'player', ?, datetime('now'), 1)`
      )
      .run(weekAssignmentId, player.id);
    const subRequestId = reqInfo.lastInsertRowid;

    if (wasBallDuty) {
      db.prepare(
        "UPDATE weeks SET ball_duty_player_id = NULL, needs_attention = 1, notes = ? WHERE id = ?"
      ).run(`Ball duty needs reassignment (was ${fullName(player)}, now needs a sub)`, week.id);
    }

    // was_new_person mirrors `isNewPerson` computed above — see schema.sql's
    // comment on sub_offers.was_new_person. Only ever 1 in the
    // candidateType === 'broader' branch (a brand-new person can only ever
    // be added to the broader sub list, never directly onto the roster), but
    // stamped from the actual flag either way rather than assumed from branch
    // shape, so this stays correct if that ever changes.
    const raw = generateRawToken();
    if (candidate.candidateType === 'player') {
      db.prepare(
        "INSERT INTO sub_offers (sub_request_id, candidate_player_id, token, status, was_new_person, source) VALUES (?, ?, ?, ?, ?, 'self_arranged')"
      ).run(subRequestId, candidate.id, hashToken(raw), 'pending', isNewPerson ? 1 : 0);
    } else {
      db.prepare(
        "INSERT INTO sub_offers (sub_request_id, broader_list_id, token, status, was_new_person, source) VALUES (?, ?, ?, ?, ?, 'self_arranged')"
      ).run(subRequestId, candidate.id, hashToken(raw), 'pending', isNewPerson ? 1 : 0);
    }

    return { subRequestId, rawToken: raw };
  })();

  adoptPendingSubThread(weekAssignmentId, subRequestId);

  // Activity log — "I found a sub" itself (Kyle, 2026-09-09), separate from
  // the isNewPerson-only entry below: this fires every time regardless of
  // whether the named sub was already on file. The named person's own
  // confirm click is logged separately, in claimSub() above.
  logPlayerActivity({
    playerName: fullName(player),
    action: 'sub.self_arranged',
    description: `${fullName(player)} arranged for ${candidate.fullName} to sub for them on ${week.match_date} (awaiting their confirmation)`,
    sessionId: session.id,
  });
  if (isNewPerson) {
    // Activity log — admin-facing, full names (Kyle, 2026-09-07).
    logPlayerActivity({
      playerName: fullName(player),
      action: 'sub.self_arranged_new_person',
      description: `${fullName(player)} added ${candidate.fullName} (${candidate.email}) to the sub list after arranging them as a sub for ${week.match_date}`,
      sessionId: session.id,
    });
  }

  // Ordered (Kyle, 2026-09-29): the invite to the named sub and the admin
  // alert go out first, the requester's own confirmation last.
  // The follow-up timeline (reminder / warning / open-up times) the
  // confirmation and invite spell out — Kyle, 2026-09-30.
  const timeline = selfArrangedTimeline(db.prepare('SELECT * FROM sub_requests WHERE id = ?').get(subRequestId), week, session);
  await withSubRequestLock(subRequestId, async () => {
    await email.sendSelfArrangedSubInvite({
      deadlineAt: timeline.late ? null : timeline.deadlineAt,
      recipient: candidate,
      week,
      session,
      claimToken: rawToken,
      requestingPlayerName: fullName(player),
      threadKey: subThreadKey(subRequestId),
    });
    if (isNewPerson && session.admin_report_emails) {
      await email.sendNewSubListEntryAlert({
        session,
        week,
        newPersonName: candidate.fullName,
        newPersonEmail: candidate.email,
        addedByPlayerName: fullName(player),
        threadKey: subThreadKey(subRequestId),
      });
    }
    await email.sendSelfArrangedSubConfirmation({ player, week, session, subName: candidate.fullName, timeline, threadKey: subThreadKey(subRequestId) });
  });

  return { ok: true, week, session, candidate, isNewPerson, subRequestId };
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
 *
 * `opts.resolution` (Kyle, 2026-09-10): pass `'double_booking'` when this
 * close is a side effect of the joint cross-session conflict resolver fixing
 * a real double-booking by moving players between weeks (jointSolver.js's
 * applyResolutions()) rather than an admin manually reassigning/confirming a
 * slot. That's a schedule correction, not a substitution — the two players
 * involved are still each playing their own week, just possibly a different
 * one than before — so it's recorded as 'resolved_double_booking' instead of
 * 'resolved_manually'. The Stats page's Sub History query filters that status
 * out entirely rather than showing it as a sub. Left as a plain optional
 * param (not a new function) so every other call site keeps working
 * unchanged. See docs/HISTORY.md's "Sub History vs. double-booking reworks" note
 * for the real incident this fixed (Jim Newell/Kyle Krieg, week of 10/7/26).
 */
function closeActiveSubRequestForAssignment(weekAssignmentId, opts = {}) {
  const active = db
    .prepare(`SELECT * FROM sub_requests WHERE week_assignment_id = ? AND status IN ('open', 'escalated', 'unfilled')`)
    .get(weekAssignmentId);
  if (!active) return false;
  const status = opts.resolution === 'double_booking' ? 'resolved_double_booking' : 'resolved_manually';
  db.prepare(`UPDATE sub_requests SET status = ? WHERE id = ?`).run(status, active.id);
  // Shared requests (Kyle, 2026-10-02): this request's links may also be
  // serving another player's still-open request in the same group — leave
  // them live in that case (a click just fills the other one). The named
  // sub's invite on an "I found a sub" request was for this player only, so
  // that always closes.
  db.prepare(`UPDATE sub_offers SET status = 'closed' WHERE sub_request_id = ? AND status = 'pending' AND source = 'self_arranged'`).run(active.id);
  const poolId = poolIdOf(active);
  if (openPoolMembers(poolId).length === 0) {
    const ids = poolMembers(poolId).map((m) => m.id);
    db.prepare(`UPDATE sub_offers SET status = 'closed' WHERE status = 'pending' AND sub_request_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
  return true;
}

/**
 * Kyle, 2026-09-10: a direct admin Reassign that pulls from this session's
 * sub list, or slots in a one-time sub (and, on a locked week, the
 * equivalent "Correct player" action — see admin.js), is a real
 * substitution — someone who was scheduled didn't play, someone else did
 * instead — but until now it left no trace in sub_requests at all, so it
 * never showed up on the Stats page's Sub History table (built entirely
 * from that table, see admin.js's rawSubHistory query). Kyle confirmed he
 * wants these logged there too, after noticing a real case (Ed Bourneuf
 * subbing for Jon Deuchler via a sub-list Reassign, 2026-09-07) missing from
 * Sub History despite being a genuine sub. Deliberately does NOT extend to
 * a plain roster-to-roster Reassign (swapping who occupies a still-upcoming
 * slot before anyone's played) — that's correcting who's on the roster, not
 * "someone needed a sub," so it stays outside Sub History same as before.
 *
 * Call this ONLY when the reassign branch itself is what created the "sub"
 * event — i.e. closeActiveSubRequestForAssignment() on the same assignment
 * just returned false (there was no pre-existing open/escalated/unfilled
 * request on it to close). If one *was* there, that call already marked it
 * resolved_manually and it's already a real Sub History row — inserting a
 * second one here would double-count the same event.
 *
 * weekAssignmentId is the OLD (now subbed_out) assignment's id, matching
 * every other sub_requests row (always keyed off the original slot, not the
 * incoming sub's new row). requestingPlayerId is snapshotted into
 * requesting_player_id the same way createSubRequest()/adminFlagNeedsSub()
 * already do, so this row's "Original player" column never drifts if the
 * slot changes hands again later (see the rawSubHistory query's own doc
 * comment on why that snapshot matters). status starts straight at
 * 'resolved_manually' — an admin already decided the outcome by picking
 * this exact replacement, so there's no open/escalating window to model.
 */
function recordAdminReassignAsSub(weekAssignmentId, requestingPlayerId) {
  db.prepare(
    `INSERT INTO sub_requests (week_assignment_id, status, initiated_by, requesting_player_id)
     VALUES (?, 'resolved_manually', 'admin', ?)`
  ).run(weekAssignmentId, requestingPlayerId);
}

/** Cron entry point: for any sub_request still open once we're within this
 * session's configured escalation_lead_hours *before* its week's match
 * day/time (i.e. the original 5 didn't fill it in time), fan out to the
 * broader escalation list. Per-session, not hardcoded (Kyle, 2026-09-08) —
 * defaults to 24h, same as the app's original fixed behavior, but each
 * session can widen or narrow that window from Admin -> Sessions -> Edit.
 * Uses the same timezone-aware wall-clock conversion as the reminder emails
 * (tz.js) rather than raw SQLite datetime math, since match_time is stored
 * as local wall time, not UTC. */
async function escalateOverdueRequests() {
  // Joins through to sessions so an archived session's stray open request
  // (e.g. archived mid-season, before it was actually resolved) doesn't
  // still escalate and email the broader sub list — archiving is meant to
  // go fully quiet, not just hide from the dashboard.
  const openRequests = db
    .prepare(
      `SELECT sr.id
       FROM sub_requests sr
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       WHERE sr.status = 'open' AND s.archived_at IS NULL
       ORDER BY sr.id`
    )
    .all();

  let escalatedCount = 0;
  for (const { id } of openRequests) {
    // Queued behind any of this request's emails still going out (Kyle,
    // 2026-09-29), and re-checked inside escalateOneRequest() since the
    // request may have been escalated or filled while it waited.
    const { result } = await withSubRequestLock(id, () => escalateOneRequest(id, { onlyIfDue: true }));
    if (result === 'escalated' || result === 'unfilled') escalatedCount++;
  }
  return escalatedCount;
}

/**
 * Escalate one open sub request to its session's sub list, if it's due
 * (matchAt - escalation_lead_hours has passed). Returns { result, emailed }:
 * result is 'escalated' | 'unfilled' | 'not_due' | 'not_open' | 'suspended',
 * emailed is the list of sub-list candidates actually emailed. Callers run it
 * inside withSubRequestLock(). Split out of escalateOverdueRequests()
 * (Kyle, 2026-09-29) so createSubRequest() can escalate a request made
 * inside the escalation window right after its roster fan-out, before the
 * requester's confirmation — instead of the cron doing it separately and the
 * emails interleaving. Uses the same timezone-aware wall-clock conversion as
 * the reminder emails (tz.js).
 */
async function escalateOneRequest(subRequestId, { onlyIfDue = true, ignoreSuspend = false } = {}) {
  const req = db
    .prepare(
      `SELECT sr.*, w.id as week_id, s.archived_at
       FROM sub_requests sr
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       WHERE sr.id = ?`
    )
    .get(subRequestId);
  if (!req || req.status !== 'open' || req.archived_at) return { result: 'not_open', emailed: [] };

  // Shared requests (Kyle, 2026-10-02). An admin-flagged request still
  // waiting for its roster email joins the week's open group if there is
  // one, instead of emailing the sub list on its own.
  if (!req.shared_at && !inNamedSubWindow(req)) {
    const joinId = joinablePoolForWeek(req.week_id, req.id);
    if (joinId) {
      joinPool(req.id, joinId);
      return { result: 'joined', emailed: [] };
    }
  }
  // Part of a group whose sub-list email already went out: nothing new to
  // send — just count this request as escalated too.
  if (req.shared_at && poolEscalated(poolIdOf(req), req.id)) {
    db.prepare("UPDATE sub_requests SET status = 'escalated', escalated_at = COALESCE(escalated_at, datetime('now')) WHERE id = ?").run(req.id);
    return { result: 'joined', emailed: [] };
  }

  const tz = getTimezone();
  const now = new Date();
  const week = getWeekWithSession(req.week_id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  const matchAt = zonedTimeToUtc(week.match_date, session.match_time, tz);
  // "I found a sub" requests have their own timeline (Kyle, 2026-09-30):
  // they never escalate on escalation_lead_hours — processSelfArrangedSubs()
  // opens them up at session.self_arranged_deadline_hours instead, calling
  // this with onlyIfDue: false.
  // (Only while the named sub still has time — one that has opened up and
  // joined a group escalates with that group, Kyle 2026-10-02.)
  if (onlyIfDue && inNamedSubWindow(req)) return { result: 'not_due', emailed: [] };
  const escalateAt = new Date(matchAt.getTime() - session.escalation_lead_hours * 60 * 60 * 1000);
  if (onlyIfDue && now < escalateAt) return { result: 'not_due', emailed: [] };

  // Admin suspended this week's sub escalation from the Status page (Kyle,
  // 2026-09-27) — leave the request 'open' and don't email the broader
  // sub list; logged once as "Suspended — did not fire". Lazy require to
  // avoid any load-order cycle.
  // ignoreSuspend: the Status page's "Send now" (Kyle, 2026-09-30) — an
  // explicit admin click overrides the suspension (sendNow clears it).
  if (!ignoreSuspend && require('./automationSuspend').skipIfSuspended(week, session, 'escalation')) return { result: 'suspended', emailed: [] };

  // Per-session sub pool (broader_sub_list + real players, see
  // sessionSubList()'s doc comment), not the whole master list. Looked up
  // per request (not hoisted above the loop) since different open
  // requests can belong to different sessions with different sub lists.
  let sessionSubs = sessionSubList(session.id);

  // Skip a player-type candidate who's told the app they can't play this
  // exact date. Deliberately NOT the same session-scoped blackoutSet +
  // carriedOverBlackoutsForSession() pattern fanOutSubRequest() uses for
  // the initial roster fan-out — that carryover helper only looks at
  // players currently enrolled on the TARGET session's own roster (see
  // its doc comment in sessionHelper.js), which a sub *candidate*
  // (assigned via session_sub_players, not session_players) never is by
  // definition. A direct, session-agnostic lookup is both simpler and
  // more correct here: per Kyle's own 2026-08-27 call on blackout dates
  // ("a blackout date is a blackout date... it doesn't need any
  // context"), a real player's blackout entry is meant to be universal
  // regardless of which session's page it was entered from, so this
  // checks every blackout_dates row for that exact calendar date, not
  // just ones tied to this specific session. broader_sub_list candidates
  // are unaffected — they have no blackout dates of their own to check
  // (they're not a `players` row, and thus not enrolled anywhere, until
  // they actually claim something).
  const blackedOutPlayerIds = new Set(
    db.prepare('SELECT DISTINCT player_id FROM blackout_dates WHERE date = ?').all(week.match_date).map((r) => r.player_id)
  );
  sessionSubs = sessionSubs.filter((s) => s.candidateType !== 'player' || !blackedOutPlayerIds.has(s.id));
  // A sub-list player who already has a row this week (playing, or gave
  // their own spot up) can't take this one — UNIQUE(week_id, player_id).
  const inWeek = new Set(db.prepare('SELECT player_id FROM week_assignments WHERE week_id = ?').all(week.id).map((r) => r.player_id));
  sessionSubs = sessionSubs.filter((s) => s.candidateType !== 'player' || !inWeek.has(s.id));
  // Skip anyone already offered this spot (the named sub on an "I found a
  // sub" request, or a roster player from the fan-out) — Kyle, 2026-09-30.
  // Across the whole group (Kyle, 2026-10-02), so nobody already holding a
  // link for this match gets a second one.
  const poolIds = poolMembers(poolIdOf(req)).map((m) => m.id);
  const priorOffers = db
    .prepare(`SELECT candidate_player_id, broader_list_id FROM sub_offers WHERE sub_request_id IN (${poolIds.map(() => '?').join(',')})`)
    .all(...poolIds);
  const offeredPlayers = new Set(priorOffers.filter((o) => o.candidate_player_id).map((o) => o.candidate_player_id));
  const offeredBroader = new Set(priorOffers.filter((o) => o.broader_list_id).map((o) => o.broader_list_id));
  sessionSubs = sessionSubs.filter((c) => (c.candidateType === 'player' ? !offeredPlayers.has(c.id) : !offeredBroader.has(c.id)));

  if (sessionSubs.length === 0) {
    db.prepare("UPDATE sub_requests SET status = 'unfilled' WHERE id = ?").run(req.id);
    // Nobody left to ask (Kyle, 2026-09-30): no sub list, or everyone on it
    // is blacked out / already in this week, and nobody from the roster is
    // still holding a link. Tell the player and admins now instead of
    // waiting for the 4-hour "still open" alert.
    const pending = poolOfferCounts(poolIdOf(req)).pending || 0;
    if (pending === 0) {
      // A self-arranged request's player is told in the "your spot is open"
      // email that goes right after this, so only the admins get this one.
      await sendStillOpenAlert(req.id, { reason: 'nobody_left', adminsOnly: !!req.self_arranged });
    }
    return { result: 'unfilled', emailed: [] };
  }

  // shared_at/pool_id: an admin-flagged request escalating before its roster
  // email ever went out still becomes a group others can join and claim from.
  db.prepare(
    `UPDATE sub_requests SET status = 'escalated', escalated_at = datetime('now'),
            shared_at = COALESCE(shared_at, datetime('now')), pool_id = COALESCE(pool_id, id) WHERE id = ?`
  ).run(req.id);
  // One sub-list email for the whole group (Kyle, 2026-10-02): the other
  // open requests in it count as escalated now too.
  db.prepare(
    `UPDATE sub_requests SET status = 'escalated', escalated_at = COALESCE(escalated_at, datetime('now'))
     WHERE (id = ? OR pool_id = ?) AND id != ? AND status = 'open' AND shared_at IS NOT NULL`
  ).run(poolIdOf(req), poolIdOf(req), req.id);

  const emailed = [];
  for (const candidate of sessionSubs) {
    if (!poolStillOpenFor(req.id)) break;
    const raw = generateRawToken();
    if (candidate.candidateType === 'player') {
      db.prepare(
        "INSERT INTO sub_offers (sub_request_id, candidate_player_id, token, status, source) VALUES (?, ?, ?, ?, 'escalation')"
      ).run(req.id, candidate.id, hashToken(raw), 'pending');
    } else {
      db.prepare(
        "INSERT INTO sub_offers (sub_request_id, broader_list_id, token, status, source) VALUES (?, ?, ?, ?, 'escalation')"
      ).run(req.id, candidate.id, hashToken(raw), 'pending');
    }
    await email.sendEscalationEmail({ recipient: candidate, week, session, claimToken: raw, threadKey: subThreadKey(req.id) });
    emailed.push(candidate);
  }
  return { result: 'escalated', emailed };
}

/**
 * "I found a sub" follow-up timeline (Kyle, 2026-09-30). Worked out from
 * when the sub was arranged (sub_requests.created_at, UTC) and the
 * session's two settings:
 *
 *   deadlineAt = match time − self_arranged_deadline_hours (default 4).
 *                If the named sub still hasn't confirmed, the spot opens to
 *                the roster and the sub list here.
 *   warnAt     = deadlineAt − 1 hour. The requester gets "this opens up at
 *                <deadline> unless <sub> confirms or you contact an admin",
 *                and the sub gets one more nudge.
 *   reminderAt = arrangedAt + self_arranged_reminder_hours (default 4). A
 *                "please confirm" reminder to both. Dropped (null) when it
 *                would land less than 15 minutes before the warning, since
 *                the warning covers it.
 *   late       = arranged at or after warnAt (i.e. less than deadline + 1
 *                hours before the match). Nothing automatic happens at all —
 *                the admin gets one email and the requester's confirmation
 *                says so. A sub arranged that close to the match has almost
 *                certainly been talked to directly.
 *
 * Self-arranged requests never use escalation_lead_hours (see
 * escalateOneRequest()'s early return).
 */
const HOUR_MS = 60 * 60 * 1000;
function selfArrangedTimeline(subRequest, week, session) {
  const tz = getTimezone();
  const arrangedAt = new Date(String(subRequest.created_at).replace(' ', 'T') + 'Z');
  const matchAt = zonedTimeToUtc(week.match_date, session.match_time, tz);
  const deadlineAt = new Date(matchAt.getTime() - (session.self_arranged_deadline_hours || 4) * HOUR_MS);
  const warnAt = new Date(deadlineAt.getTime() - HOUR_MS);
  const late = arrangedAt >= warnAt;
  let reminderAt = new Date(arrangedAt.getTime() + (session.self_arranged_reminder_hours || 4) * HOUR_MS);
  if (late || reminderAt.getTime() > warnAt.getTime() - 15 * 60 * 1000) reminderAt = null;
  return { arrangedAt, matchAt, deadlineAt, warnAt, reminderAt, late };
}

/** The named sub's still-pending invite on a self-arranged request, with
 * who they are — or null once it's been claimed/closed. */
function pendingSelfArrangedOffer(subRequestId) {
  const offer = db
    .prepare(
      `SELECT * FROM sub_offers WHERE sub_request_id = ? AND status = 'pending'
       AND (source = 'self_arranged' OR (source IS NULL AND id = (SELECT MIN(id) FROM sub_offers WHERE sub_request_id = ?)))
       ORDER BY id LIMIT 1`
    )
    .get(subRequestId, subRequestId);
  if (!offer) return null;
  let person;
  if (offer.candidate_player_id) {
    person = db.prepare('SELECT * FROM players WHERE id = ?').get(offer.candidate_player_id);
  } else {
    person = db.prepare('SELECT * FROM broader_sub_list WHERE id = ?').get(offer.broader_list_id);
  }
  if (!person) return null;
  return { offer, person, name: fullName(person) };
}

/** Mint a second claim link for the named sub (keeps the original working). */
function mintOfferNudgeToken(offerId) {
  const raw = generateRawToken();
  db.prepare('UPDATE sub_offers SET nudge_token = ? WHERE id = ?').run(hashToken(raw), offerId);
  return raw;
}

/**
 * Cron pass (every tick, from cron.js's processEscalations()): walks every
 * still-open "I found a sub" request and does whichever step of
 * selfArrangedTimeline() is due. Each step stamps its own column on
 * sub_requests so it runs once. Runs inside withSubRequestLock() so its
 * emails never interleave with a claim's "sub found" emails.
 */
async function processSelfArrangedSubs() {
  const rows = db
    .prepare(
      `SELECT sr.id FROM sub_requests sr
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       WHERE sr.status = 'open' AND sr.self_arranged = 1 AND sr.shared_at IS NULL AND s.archived_at IS NULL AND w.locked = 0`
    )
    .all();
  for (const { id } of rows) {
    try {
      await withSubRequestLock(id, () => stepSelfArrangedRequest(id));
    } catch (err) {
      console.error(`[cron] self-arranged sub request ${id} failed:`, err);
    }
  }
}

async function stepSelfArrangedRequest(subRequestId, now = new Date()) {
  const sr = db.prepare('SELECT * FROM sub_requests WHERE id = ?').get(subRequestId);
  // shared_at set = already opened up (possibly joined another request's
  // group while still 'open') — nothing left for this timeline to do.
  if (!sr || !inNamedSubWindow(sr)) return 'not_open';
  const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(sr.week_assignment_id);
  const week = getWeekWithSession(assignment.week_id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  const requester = db.prepare('SELECT * FROM players WHERE id = ?').get(sr.requesting_player_id || assignment.player_id);
  const named = pendingSelfArrangedOffer(sr.id);
  const t = selfArrangedTimeline(sr, week, session);
  const threadKey = subThreadKey(sr.id);
  const requesterName = fullName(requester);
  const subName = named ? named.name : 'your sub';

  if (t.late) {
    if (!sr.self_arranged_late_alert_sent_at) {
      db.prepare("UPDATE sub_requests SET self_arranged_late_alert_sent_at = datetime('now') WHERE id = ?").run(sr.id);
      await email.sendSelfArrangedLateAlert({ session, week, requesterName, subName, threadKey });
      logPlayerActivity({
        playerName: requesterName,
        action: 'sub.self_arranged_late',
        description: `${requesterName} named ${subName} as their sub for ${week.match_date} less than ${session.self_arranged_deadline_hours + 1} hours before the match — no automatic follow-up; admin notified`,
        sessionId: session.id,
      });
    }
    return 'late';
  }

  if (now >= t.deadlineAt) {
    // Admin suspended this week's escalation on the Status page — leave it
    // open, logged once as "Suspended — did not fire" (same as any other
    // escalation).
    if (require('./automationSuspend').skipIfSuspended(week, session, 'escalation')) return 'suspended';
    await openUpSelfArranged({ sr, week, session, requester, subName, deadlineAt: t.deadlineAt });
    return 'escalated';
  }

  if (now >= t.warnAt) {
    if (!sr.self_arranged_warning_sent_at) {
      db.prepare("UPDATE sub_requests SET self_arranged_warning_sent_at = datetime('now') WHERE id = ?").run(sr.id);
      await email.sendSelfArrangedRequesterUpdate({ player: requester, week, session, subName, stage: 'warning', deadlineAt: t.deadlineAt, threadKey });
      if (named) {
        const raw = mintOfferNudgeToken(named.offer.id);
        await email.sendSelfArrangedSubNudge({ recipient: named.person, week, session, claimToken: raw, requestingPlayerName: requesterName, deadlineAt: t.deadlineAt, final: true, threadKey });
      }
    }
    return 'warned';
  }

  if (t.reminderAt && now >= t.reminderAt && !sr.self_arranged_reminder_sent_at) {
    db.prepare("UPDATE sub_requests SET self_arranged_reminder_sent_at = datetime('now') WHERE id = ?").run(sr.id);
    if (named) {
      const raw = mintOfferNudgeToken(named.offer.id);
      await email.sendSelfArrangedSubNudge({ recipient: named.person, week, session, claimToken: raw, requestingPlayerName: requesterName, deadlineAt: t.deadlineAt, final: false, threadKey });
    }
    await email.sendSelfArrangedRequesterUpdate({ player: requester, week, session, subName, stage: 'reminder', deadlineAt: t.deadlineAt, threadKey });
    return 'reminded';
  }
  return 'waiting';
}

/**
 * Opens an "I found a sub" request up: roster fan-out + sub list, then the
 * requester's "your spot is open" email. Run inside withSubRequestLock().
 * Used at the deadline by stepSelfArrangedRequest(), and early by the
 * Status page's "Send now" (`early: true`, Kyle 2026-09-30), which words the
 * requester's email as an admin opening it ahead of schedule.
 */
async function openUpSelfArranged({ sr, week, session, requester, subName, deadlineAt, early = false }) {
  const requesterName = fullName(requester);
  const threadKey = subThreadKey(sr.id);
  // Joins another player's open sub request this week if there is one
  // (Kyle, 2026-10-02) — no new emails then, and it reaches the sub list
  // with that group (unless an admin clicked Send now, which means now).
  const roster = await startOutreach(sr.id, requesterName);
  const esc = !roster.joined || early ? await escalateOneRequest(sr.id, { onlyIfDue: false, ignoreSuspend: early }) : { emailed: [] };
  const emailedNames = [...roster.candidates, ...(esc.emailed || [])].map((c) => fullName(c));
  await email.sendSelfArrangedRequesterUpdate({
    player: requester, week, session, subName, stage: 'escalated', deadlineAt, emailedNames, early, threadKey,
    joined: roster.joined ? { alreadyAsked: pendingAskedNames(roster.poolId) } : null,
  });
  logPlayerActivity({
    playerName: requesterName,
    action: 'sub.self_arranged_escalated',
    description: roster.joined
      ? `${subName} didn't confirm the sub ${requesterName} arranged for ${week.match_date}${early ? ' (opened early by an admin)' : ''} — added to the sub request already open that week (${emailedNames.length ? `${emailedNames.length} emailed` : 'no new emails'})`
      : early
      ? `Admin opened ${requesterName}'s ${week.match_date} spot (named sub ${subName} hadn't confirmed) to the roster and sub list ahead of schedule (${emailedNames.length} emailed)`
      : `${subName} didn't confirm the sub ${requesterName} arranged for ${week.match_date} — opened to the roster and sub list (${emailedNames.length} emailed)`,
    sessionId: session.id,
  });
  return emailedNames;
}

/**
 * Status page "Send now" for a week's sub escalation (Kyle, 2026-09-30:
 * "we might want to escalate ... to the broader sub list and not wait until
 * X amount of hours before a match"). Does exactly what the cron pass would
 * do when the time arrives, just now, for every still-open request in the
 * week, each inside its request lock:
 *
 *   - normal request: roster fan-out first if it hasn't gone out yet (an
 *     admin-flagged request waits for the reminder time otherwise), then
 *     the sub-list escalation — same emails, same fresh claim links.
 *   - "I found a sub" request: opens it to the roster + sub list and tells
 *     the requester (worded as an admin opening it early).
 *
 * Returns [{ playerName, emailedNames, result }].
 */
async function escalateNowForWeek(weekId) {
  const rows = db
    .prepare(
      `SELECT sr.id FROM sub_requests sr
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       WHERE wa.week_id = ? AND sr.status = 'open'
       ORDER BY sr.id`
    )
    .all(weekId);
  const out = [];
  for (const { id } of rows) {
    const r = await withSubRequestLock(id, async () => {
      const sr = db.prepare('SELECT * FROM sub_requests WHERE id = ?').get(id);
      if (!sr || sr.status !== 'open') return null;
      const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(sr.week_assignment_id);
      const week = getWeekWithSession(assignment.week_id);
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
      const requester = db.prepare('SELECT * FROM players WHERE id = ?').get(sr.requesting_player_id || assignment.player_id);
      const playerName = requester ? fullName(requester) : 'a player';
      if (inNamedSubWindow(sr)) {
        const named = pendingSelfArrangedOffer(sr.id);
        const t = selfArrangedTimeline(sr, week, session);
        const emailedNames = await openUpSelfArranged({
          sr, week, session, requester, subName: named ? named.name : 'your sub', deadlineAt: t.deadlineAt, early: true,
        });
        return { playerName, emailedNames, result: 'escalated' };
      }
      let rosterNames = [];
      if (!sr.shared_at) {
        // Joins the week's open group if there is one (Kyle, 2026-10-02).
        const roster = await startOutreach(sr.id, playerName);
        rosterNames = roster.candidates.map((c) => fullName(c));
      }
      const esc = await escalateOneRequest(sr.id, { onlyIfDue: false, ignoreSuspend: true });
      return { playerName, emailedNames: [...rosterNames, ...(esc.emailed || []).map((c) => fullName(c))], result: esc.result };
    });
    if (r) out.push(r);
  }
  return out;
}

/**
 * Admin confirms the named sub on their behalf (Kyle, 2026-09-30: "unless
 * Kyle contacts an admin to confirm Shawn is playing"). Same claim as the
 * sub clicking their own link — status, emails, Sub History all identical.
 * Works while the request is open or already escalated, as long as the
 * named sub's invite is still pending.
 */
async function adminConfirmSelfArrangedSub(subRequestId) {
  const sr = db.prepare('SELECT * FROM sub_requests WHERE id = ?').get(subRequestId);
  if (!sr || !sr.self_arranged) return { ok: false, reason: 'not_self_arranged' };
  if (!isClaimableRequest(sr)) return { ok: false, reason: 'no_pending_invite' };
  const named = pendingSelfArrangedOffer(sr.id);
  if (!named) return { ok: false, reason: 'no_pending_invite' };
  const result = await claimOffer(named.offer, { byAdmin: true });
  return { ...result, subName: named.name };
}

/**
 * "Still open" alert (Kyle, 2026-09-30): "If nobody from that session's
 * roster nor the broader sub list says they can sub, is there any email ...
 * back to the original player?" There wasn't. Now one email goes to the
 * requesting player and one to the session's admin_report_emails, once per
 * request (sub_requests.still_open_alert_sent_at):
 *
 *   - at session.still_open_alert_hours before the match (default 4), if
 *     the spot still isn't taken (processStillOpenSubs, every cron tick), or
 *   - right away when nobody is left to ask (escalateOneRequest finds no
 *     one on the sub list and no roster links are still out).
 *
 * `adminsOnly` skips the player's copy when they were just told the same
 * thing by another email (an "I found a sub" request opening up).
 * Deliberately no email to the rest of that week's players (Kyle).
 */
async function sendStillOpenAlert(subRequestId, { reason = 'deadline', adminsOnly = false } = {}) {
  const sr = db.prepare('SELECT * FROM sub_requests WHERE id = ?').get(subRequestId);
  if (!sr || sr.still_open_alert_sent_at) return false;
  if (!['open', 'escalated', 'unfilled'].includes(sr.status)) return false;
  db.prepare("UPDATE sub_requests SET still_open_alert_sent_at = datetime('now') WHERE id = ?").run(sr.id);
  const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(sr.week_assignment_id);
  const week = getWeekWithSession(assignment.week_id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(sr.requesting_player_id || assignment.player_id);
  // Whole group (Kyle, 2026-10-02): a request that joined another player's
  // has no offers of its own.
  const counts = poolOfferCounts(poolIdOf(sr));
  const threadKey = subThreadKey(sr.id);
  if (!adminsOnly && player) {
    await email.sendSubStillOpen({ player, week, session, reason, threadKey });
  }
  await email.sendSubStillOpenAdmin({
    session,
    week,
    playerName: player ? fullName(player) : 'A player',
    reason,
    asked: counts.asked || 0,
    pending: counts.pending || 0,
    threadKey,
  });
  const { logSystemActivity } = require('./activityLog');
  logSystemActivity({
    action: 'sub.still_open',
    description: `Sub still needed for ${player ? fullName(player) : 'a player'}'s ${week.match_date} spot — ${
      reason === 'nobody_left' ? 'nobody left to ask' : `${session.still_open_alert_hours}h before the match`
    }; alerted ${adminsOnly ? 'admins' : 'the player and admins'} (${counts.asked || 0} asked, ${counts.pending || 0} links still open)`,
    sessionId: session.id,
  });
  return true;
}

/** Cron pass: the timed half of the "still open" alert. See sendStillOpenAlert(). */
async function processStillOpenSubs(now = new Date()) {
  const rows = db
    .prepare(
      `SELECT sr.id FROM sub_requests sr
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       WHERE sr.status IN ('open', 'escalated', 'unfilled') AND sr.still_open_alert_sent_at IS NULL
         AND s.archived_at IS NULL AND w.locked = 0`
    )
    .all();
  let sent = 0;
  for (const { id } of rows) {
    try {
      const did = await withSubRequestLock(id, () => stillOpenStep(id, now));
      if (did) sent++;
    } catch (err) {
      console.error(`[cron] still-open alert for sub request ${id} failed:`, err);
    }
  }
  return sent;
}

async function stillOpenStep(subRequestId, now) {
  const sr = db.prepare('SELECT * FROM sub_requests WHERE id = ?').get(subRequestId);
  if (!sr || sr.still_open_alert_sent_at || !['open', 'escalated', 'unfilled'].includes(sr.status)) return false;
  const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(sr.week_assignment_id);
  const week = getWeekWithSession(assignment.week_id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  const matchAt = zonedTimeToUtc(week.match_date, session.match_time, getTimezone());
  const alertAt = new Date(matchAt.getTime() - (session.still_open_alert_hours || 4) * HOUR_MS);
  if (now < alertAt || now >= matchAt) return false;
  let adminsOnly = false;
  if (sr.self_arranged) {
    const t = selfArrangedTimeline(sr, week, session);
    // Named too close to the match: admins already got the late alert.
    if (t.late) return false;
    // Still inside the named sub's window: it has its own warning and
    // opens up at its deadline; this alert waits until after that.
    if (inNamedSubWindow(sr)) return false;
    // If it opened up at or after the alert time, the player just got the
    // "your spot is open to other players" email — only tell the admins.
    const openedAt = sr.escalated_at ? new Date(String(sr.escalated_at).replace(' ', 'T') + 'Z') : now;
    adminsOnly = openedAt.getTime() >= alertAt.getTime() - 5 * 60 * 1000;
  }
  return sendStillOpenAlert(sr.id, { reason: 'deadline', adminsOnly });
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

/**
 * "Who actually filled this sub request" — three tiers of decreasing
 * certainty, originally built for the Stats page's Sub History "Filled by"
 * column (Kyle, 2026-09-10) and pulled out here (2026-09-15) so
 * playerBehaviorStats.js's subRequestStats() can use the exact same
 * resolution instead of risking a second heuristic that quietly drifts from
 * the Sub History table's own answer. Needed at all because a
 * `resolved_manually` (admin-placed) sub_requests row has no sub_offers
 * winner to read, and — per Kyle, 2026-09-15: "count a sub as a sub, no
 * matter if it got a sub_offers record tied to it or an admin did the
 * coordination" — should still be counted:
 *
 *   1. Real link: another week_assignments row whose replaces_assignment_id
 *      points straight at this one — set by claimSub() for every
 *      self-service/escalation/self-arranged claim, and by admin Reassign's
 *      sub-list/one-time-sub/Correct-player branches (see
 *      recordAdminReassignAsSub()'s call sites). Exact, no guessing.
 *   2. In-place reassign: a plain numeric Reassign swaps wa.player_id
 *      directly on the SAME row (no new row, no replaces_assignment_id) — if
 *      the assignment's current occupant differs from who was originally on
 *      it when the request was opened, that current occupant filled it.
 *   3. Legacy heuristic fallback: pre-dates both mechanisms above (e.g. the
 *      real Ed Bourneuf/Jon Deuchler case from 2026-09-07 that motivated
 *      logging admin placements to Sub History at all — see docs/HISTORY.md's "Sub
 *      History gap" entry) — same week/team/court, an is_sub row with no
 *      replaces_assignment_id of its own, and exactly one such
 *      still-unclaimed candidate. Each candidate can only fill one original
 *      slot, so an ambiguous multi-candidate week resolves to "unknown"
 *      (null) rather than guessing.
 *
 * `weekAssignments` is every week_assignments row for that one week
 * (id, player_id, team, court, is_sub, replaces_assignment_id) — callers
 * fetch/cache this once per week rather than this function re-querying it on
 * every call. `claimedFillerIds` is a Set this function both reads and adds
 * to, shared across every call in one resolution pass, so two ambiguous
 * requests that share a tier-3 candidate don't both claim the same row.
 * Returns a player_id, or null if nothing resolves.
 */
function resolveSubRequestFiller({ assignmentId, team, court, currentPlayerId, originalPlayerId, weekAssignments, claimedFillerIds }) {
  const linked = weekAssignments
    .filter((x) => x.replaces_assignment_id === assignmentId)
    .sort((a, b) => b.id - a.id)[0];
  if (linked) return linked.player_id;
  if (currentPlayerId !== originalPlayerId) return currentPlayerId;
  const candidates = weekAssignments.filter(
    (x) => x.is_sub && !x.replaces_assignment_id && x.team === team && x.court === court && !claimedFillerIds.has(x.id)
  );
  if (candidates.length === 1) {
    claimedFillerIds.add(candidates[0].id);
    return candidates[0].player_id;
  }
  return null;
}

/**
 * Email Log grouping (Kyle, 2026-09-27): every email that belongs to one sub
 * request's trail — the requester's verification + own notice, the roster
 * fan-out, the sub-list escalation, the "sub confirmed" notices, and the
 * "I found a sub" invite/notice/admin alert — is tagged with this key in
 * email_log.thread_key, so /admin/email-log can show the whole trail as one
 * group. See admin.js's GET /email-log and emailThreads.js.
 */
function subThreadKey(subRequestId) {
  return `sub:${subRequestId}`;
}

/** The self-service verification emails (Request a Sub / "I found a sub"
 * from My Page) go out *before* the sub request exists, so public.js tags
 * them 'pending-sub:<assignment id>'. Once the real request is created this
 * re-tags them into its trail. */
function pendingSubThreadKey(weekAssignmentId) {
  return `pending-sub:${weekAssignmentId}`;
}
function adoptPendingSubThread(weekAssignmentId, subRequestId) {
  db.prepare('UPDATE email_log SET thread_key = ? WHERE thread_key = ?').run(
    subThreadKey(subRequestId),
    pendingSubThreadKey(weekAssignmentId)
  );
}

module.exports = {
  processStillOpenSubs,
  escalateOneRequest,
  escalateNowForWeek,
  stillOpenStep,
  sendStillOpenAlert,
  processSelfArrangedSubs,
  stepSelfArrangedRequest,
  selfArrangedTimeline,
  pendingSelfArrangedOffer,
  adminConfirmSelfArrangedSub,
  subThreadKey,
  pendingSubThreadKey,
  createSubRequest,
  adminFlagNeedsSub,
  fanOutPendingAdminFlagsForWeek,
  claimSub,
  subClaimStatus,
  closeActiveSubRequestForAssignment,
  recordAdminReassignAsSub,
  escalateOverdueRequests,
  flagStillUnfilled,
  upcomingWeeksPreview,
  getWeekWithSession,
  hasActiveConcurrentSubRequest,
  hasActiveSubRequestForAssignment,
  inNamedSubWindow,
  isSharedRequest,
  claimTargetPlayerName,
  sessionSubList,
  eligibleSelfArrangedCandidates,
  arrangeSelfSub,
  resolveSubRequestFiller,
};
