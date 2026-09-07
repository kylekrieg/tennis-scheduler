'use strict';
const db = require('../db');
const { generateRawToken, hashToken } = require('./tokens');
const tokenStore = require('./tokenStore');
const email = require('./email');
const { zonedTimeToUtc } = require('./tz');
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
 * CLAUDE.md.
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
      `SELECT w.*, s.match_time, s.name as session_name, s.id as session_id
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
      .prepare(`SELECT player_id FROM week_assignments WHERE week_id = ? AND status != 'subbed_out'`)
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
 * CLAUDE.md). Simplified to check the whole week with no exclusion at all —
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
async function fanOutSubRequest(subRequestId, requestingPlayerName) {
  const subRequest = db.prepare('SELECT * FROM sub_requests WHERE id = ?').get(subRequestId);
  const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(subRequest.week_assignment_id);
  const week = getWeekWithSession(assignment.week_id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);

  const alreadyPlaying = db
    .prepare(`SELECT player_id FROM week_assignments WHERE week_id = ? AND status != 'subbed_out'`)
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

  const candidates = allCandidates.filter((c) => !blackoutSet.has(`${c.id}|${week.match_date}`));

  const offers = db.transaction(() => {
    db.prepare(`UPDATE sub_requests SET fanout_sent_at = datetime('now') WHERE id = ?`).run(subRequestId);
    return candidates.map((c) => {
      const raw = generateRawToken();
      db.prepare(
        'INSERT INTO sub_offers (sub_request_id, candidate_player_id, token, status) VALUES (?, ?, ?, ?)'
      ).run(subRequestId, c.id, hashToken(raw), 'pending');
      return { candidate: c, rawToken: raw };
    });
  })();

  for (const { candidate, rawToken } of offers) {
    await email.sendSubRequestFanout({
      recipient: candidate,
      week,
      session,
      claimToken: rawToken,
      requestingPlayerName,
    });
  }

  // Kyle, 2026-08-27: returning the actual candidate list (not just a count)
  // so createSubRequest() below can tell the requesting player exactly who
  // was just emailed, instead of the old generic "the other players have
  // been emailed" with no names.
  return { count: offers.length, candidates };
}

/**
 * Kicks off a sub request for a given week_assignment: marks it needs_sub,
 * opens a sub_requests row, and emails every other enrolled player in the
 * session who isn't already playing that week (the "5 non-playing regulars"
 * in the example 9-player/4-per-week group; generalizes to roster size).
 * Player-initiated (self-service "Need a sub", or the emailed reminder link)
 * — fans out immediately. Compare adminFlagNeedsSub() below, which does the
 * same status transition but deliberately sends nothing right away.
 */
async function createSubRequest(weekAssignmentId) {
  const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(weekAssignmentId);
  if (!assignment) throw new Error('Assignment not found');
  const week = getWeekWithSession(assignment.week_id);
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(assignment.player_id);

  if (hasActiveConcurrentSubRequest(week.id)) {
    return { blocked: true, reason: 'concurrent' };
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
    // page's Sub History table) — see CLAUDE.md for the real case this fixed.
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

  const { count: offerCount, candidates } = await fanOutSubRequest(subRequestId, fullName(player));

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  // Safety net for a wrong-name mix-up (e.g. on the self-service "Request a
  // Sub" page): the affected player gets their own confirmation the moment
  // this fires, so a mistake surfaces immediately instead of after the fact.
  // Also tells them exactly who was just emailed and what happens next —
  // see sendSubRequestOwnConfirmation()'s own doc comment (Kyle, 2026-08-27).
  const sessionSubs = sessionSubList(session.id);
  await email.sendSubRequestOwnConfirmation({ player, week, session, candidates, sessionSubs });

  return { blocked: false, subRequestId, offerCount };
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
 */
function adminFlagNeedsSub(weekAssignmentId) {
  const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(weekAssignmentId);
  if (!assignment) throw new Error('Assignment not found');
  const week = getWeekWithSession(assignment.week_id);
  if (week.locked) return { blocked: true, reason: 'locked' };
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(assignment.player_id);

  if (hasActiveConcurrentSubRequest(week.id)) {
    return { blocked: true, reason: 'concurrent' };
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

  // Admin-facing (flash message + activity log at the admin.js call site) —
  // full name (Kyle, 2026-09-07).
  return { blocked: false, subRequestId, playerName: fullName(player) };
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
    await fanOutSubRequest(row.subRequestId, fullName(row));
  }

  return pending.length;
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
      `INSERT INTO week_assignments (week_id, player_id, team, court, is_sub, status, confirmed_at, replaces_assignment_id)
       VALUES (?, ?, ?, ?, 1, 'confirmed', datetime('now'), ?)`
    ).run(originalAssignment.week_id, subPlayer.id, originalAssignment.team, originalAssignment.court, originalAssignment.id);
  })();

  // Notify that week's full group of 4 (other 3 originals + the new sub)
  const groupRows = db
    .prepare(
      `SELECT p.id, p.name, p.full_name, p.email FROM week_assignments wa JOIN players p ON p.id = wa.player_id
       WHERE wa.week_id = ? AND wa.status != 'subbed_out'`
    )
    .all(originalAssignment.week_id);

  for (const recipient of groupRows) {
    await email.sendSubFilledNotice({ recipient, week, session, subName: fullName(subPlayer) });
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
    await email.sendSubFilledOriginalNotice({ recipient: originalPlayer, week, session, subName: fullName(subPlayer) });
  }

  return { ok: true, week, subPlayer };
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
 * escalateOverdueRequests()'s 24-hours-before-match fallback all work
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
 */
async function arrangeSelfSub(weekAssignmentId, selection = {}) {
  const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(weekAssignmentId);
  if (!assignment) return { ok: false, reason: 'not_found' };
  const week = getWeekWithSession(assignment.week_id);
  if (week.locked) return { ok: false, reason: 'locked' };
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(assignment.player_id);

  if (hasActiveConcurrentSubRequest(week.id)) {
    return { ok: false, reason: 'concurrent' };
  }

  // { candidateType: 'player'|'broader', id, name (public/short), email,
  // fullName (real full name — Kyle, 2026-09-07) }
  let candidate;
  let isNewPerson = false;

  if (selection.newPerson) {
    const name = String(selection.newPerson.name || '').trim();
    const rawEmail = String(selection.newPerson.email || '').trim();
    if (!name || !EMAIL_RE.test(rawEmail)) {
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

    const reqInfo = db
      .prepare(
        `INSERT INTO sub_requests (week_assignment_id, status, initiated_by, requesting_player_id, fanout_sent_at)
         VALUES (?, 'open', 'player', ?, datetime('now'))`
      )
      .run(weekAssignmentId, player.id);
    const subRequestId = reqInfo.lastInsertRowid;

    if (wasBallDuty) {
      db.prepare(
        "UPDATE weeks SET ball_duty_player_id = NULL, needs_attention = 1, notes = ? WHERE id = ?"
      ).run(`Ball duty needs reassignment (was ${fullName(player)}, now needs a sub)`, week.id);
    }

    const raw = generateRawToken();
    if (candidate.candidateType === 'player') {
      db.prepare(
        'INSERT INTO sub_offers (sub_request_id, candidate_player_id, token, status) VALUES (?, ?, ?, ?)'
      ).run(subRequestId, candidate.id, hashToken(raw), 'pending');
    } else {
      db.prepare(
        'INSERT INTO sub_offers (sub_request_id, broader_list_id, token, status) VALUES (?, ?, ?, ?)'
      ).run(subRequestId, candidate.id, hashToken(raw), 'pending');
    }

    return { subRequestId, rawToken: raw };
  })();

  await email.sendSelfArrangedSubInvite({
    recipient: candidate,
    week,
    session,
    claimToken: rawToken,
    requestingPlayerName: fullName(player),
  });

  await email.sendSelfArrangedSubConfirmation({ player, week, session, subName: candidate.fullName });

  if (isNewPerson) {
    // Activity log — admin-facing, full names (Kyle, 2026-09-07).
    const description = `${fullName(player)} added ${candidate.fullName} (${candidate.email}) to the sub list after arranging them as a sub for ${week.match_date}`;
    logPlayerActivity({
      playerName: fullName(player),
      action: 'sub.self_arranged_new_person',
      description,
      sessionId: session.id,
    });
    if (session.admin_report_emails) {
      await email.sendNewSubListEntryAlert({
        session,
        week,
        newPersonName: candidate.fullName,
        newPersonEmail: candidate.email,
        addedByPlayerName: fullName(player),
      });
    }
  }

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

    if (sessionSubs.length === 0) {
      db.prepare("UPDATE sub_requests SET status = 'unfilled' WHERE id = ?").run(req.id);
      continue;
    }

    db.prepare("UPDATE sub_requests SET status = 'escalated', escalated_at = datetime('now') WHERE id = ?").run(
      req.id
    );

    for (const candidate of sessionSubs) {
      const raw = generateRawToken();
      if (candidate.candidateType === 'player') {
        db.prepare(
          'INSERT INTO sub_offers (sub_request_id, candidate_player_id, token, status) VALUES (?, ?, ?, ?)'
        ).run(req.id, candidate.id, hashToken(raw), 'pending');
      } else {
        db.prepare(
          'INSERT INTO sub_offers (sub_request_id, broader_list_id, token, status) VALUES (?, ?, ?, ?)'
        ).run(req.id, candidate.id, hashToken(raw), 'pending');
      }
      await email.sendEscalationEmail({ recipient: candidate, week, session, claimToken: raw });
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
  adminFlagNeedsSub,
  fanOutPendingAdminFlagsForWeek,
  claimSub,
  closeActiveSubRequestForAssignment,
  escalateOverdueRequests,
  flagStillUnfilled,
  upcomingWeeksPreview,
  getWeekWithSession,
  hasActiveConcurrentSubRequest,
  sessionSubList,
  eligibleSelfArrangedCandidates,
  arrangeSelfSub,
};
