'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db');
const { resolveSession, doubleBookingMapForSession, carriedOverBlackoutsForSession } = require('../services/sessionHelper');
const { hashToken } = require('../services/tokens');
const tokenStore = require('../services/tokenStore');
const { buildPlayerICS, buildPlayerFeedICS } = require('../services/ics');
const { streamSeasonPDF, streamAllSessionsPDF } = require('../services/pdf');
const subFlow = require('../services/subFlow');
const swapFlow = require('../services/swapFlow');
const email = require('../services/email');
const { ensureWeeksExist } = require('../services/scheduleRun');
const adhocFlow = require('../services/adhocFlow');
const { asyncHandler } = require('../middleware/asyncHandler');
const { rateLimiter } = require('../middleware/rateLimiter');
const honeypot = require('../services/honeypot');

// Separate buckets (10/hour/IP each, generous for real use — a household
// sharing an IP could submit several times without ever tripping this) so
// a script can't enumerate assignment_id values and mass-trigger
// verification emails across the whole roster in one sitting. See
// rateLimiter.js's doc comment and "Rate limiting" in CLAUDE.md.
const requestSubStartLimiter = rateLimiter({ name: 'request-sub-start', windowMs: 60 * 60 * 1000, max: 10 });
const swapStartLimiter = rateLimiter({ name: 'swap-start', windowMs: 60 * 60 * 1000, max: 10 });

// Stamps each assignment row with `doubleBooked` (the other session it
// collides with, from doubleBookingMapForSession) when that player is also
// actually assigned to play somewhere else on the same date — see
// sessionHelper.js's doc comment. Shared by every player-facing view that
// lists assignments (schedule, lookahead, My Page) so the flag reads
// identically everywhere.
function stampDoubleBookings(assignments, matchDate, dbMap) {
  assignments.forEach((a) => {
    const other = dbMap.get(`${a.player_id}|${matchDate}`);
    if (other) a.doubleBooked = other;
  });
  return assignments;
}

function weekRowsForSession(sessionId, { limit } = {}) {
  let sql = `SELECT * FROM weeks WHERE session_id = ? ORDER BY match_date`;
  if (limit) sql += ` LIMIT ${Number(limit)}`;
  const weeks = db.prepare(sql).all(sessionId);
  const dbMap = doubleBookingMapForSession(sessionId);
  return weeks.map((w) => {
    const assignments = db
      .prepare(
        `SELECT wa.*, p.name FROM week_assignments wa JOIN players p ON p.id = wa.player_id
         WHERE wa.week_id = ? ORDER BY wa.court, wa.team`
      )
      .all(w.id);
    stampDoubleBookings(assignments, w.match_date, dbMap);
    const ballDuty = w.ball_duty_player_id
      ? db.prepare('SELECT name FROM players WHERE id = ?').get(w.ball_duty_player_id)
      : null;
    return { week: w, assignments, ballDutyName: ballDuty ? ballDuty.name : null };
  });
}

router.get('/', (req, res) => res.redirect('/schedule'));

// A player-facing orientation page — static content, no DB queries needed —
// covering every self-service feature in one skimmable page with jump-link
// sections rather than a full manual. Added 2026-08-11 at Kyle's request so a
// new player doesn't need someone else to explain where things are.
router.get('/help', (req, res) => {
  res.render('help', { title: 'How It Works' });
});

// Text-size/high-contrast is a per-browser preference (localStorage, applied
// via data-text-size on <html> — see style.css) rather than anything stored
// server-side, so this route just renders the control; no DB, no auth
// needed. Kyle, 2026-08-27: originally this lived directly in the header
// nav on every page, but he found that didn't work well in practice and
// asked for it to move to its own dedicated page instead.
router.get('/preferences', (req, res) => {
  res.render('preferences', { title: 'Preferences' });
});

router.get('/schedule', (req, res) => {
  const { session, sessions } = resolveSession(req);
  if (!session) return res.render('no_session', { title: 'Season Schedule' });
  const rows = weekRowsForSession(session.id);
  res.render('schedule', { title: 'Season Schedule', session, sessions, rows, multiCourt: session.players_per_week > 4 });
});

router.get('/lookahead', (req, res) => {
  const { session, sessions } = resolveSession(req);
  if (!session) return res.render('no_session', { title: 'Next 4 Weeks' });
  const todayIso = new Date().toISOString().slice(0, 10);
  const weeks = db
    .prepare(`SELECT * FROM weeks WHERE session_id = ? AND match_date >= ? ORDER BY match_date LIMIT ?`)
    .all(session.id, todayIso, session.lookahead_weeks || 4);
  const dbMap = doubleBookingMapForSession(session.id);
  const rows = weeks.map((w) => {
    const assignments = db
      .prepare(
        `SELECT wa.*, p.name FROM week_assignments wa JOIN players p ON p.id = wa.player_id
         WHERE wa.week_id = ? ORDER BY wa.court, wa.team`
      )
      .all(w.id);
    stampDoubleBookings(assignments, w.match_date, dbMap);
    const ballDuty = w.ball_duty_player_id
      ? db.prepare('SELECT name FROM players WHERE id = ?').get(w.ball_duty_player_id)
      : null;
    return { week: w, assignments, ballDutyName: ballDuty ? ballDuty.name : null };
  });
  res.render('lookahead', { title: 'Next 4 Weeks', session, sessions, rows, multiCourt: session.players_per_week > 4 });
});

router.get('/blackout', (req, res) => {
  // includeDraft: true — this is the one public page that must show a
  // session before it's been scheduled, since blackout dates need to be
  // collected while still in draft (see ensureWeeksExist note below).
  const { session, sessions } = resolveSession(req, { includeDraft: true });
  if (!session) return res.render('no_session', { title: 'Blackout Dates' });
  // Weeks normally only get created by the first "Schedule these players"
  // run, but blackout dates are meant to be collected *before* that run
  // ever happens — without this, a never-yet-scheduled session would show
  // an empty checkbox list here with nothing to select. Idempotent and
  // harmless to call every time; only matters while still in draft.
  if (session.status === 'draft') ensureWeeksExist(session.id);
  const players = db
    .prepare(
      `SELECT p.* FROM session_players sp JOIN players p ON p.id = sp.player_id
       WHERE sp.session_id = ? AND p.active = 1 ORDER BY p.name`
    )
    .all(session.id);
  const weeks = db.prepare(`SELECT * FROM weeks WHERE session_id = ? ORDER BY match_date`).all(session.id);

  const selectedPlayerId = Number(req.query.player) || null;
  let existingBlackouts = new Set();
  if (selectedPlayerId) {
    existingBlackouts = new Set(
      db
        .prepare('SELECT date FROM blackout_dates WHERE session_id = ? AND player_id = ?')
        .all(session.id, selectedPlayerId)
        .map((r) => r.date)
    );
  }

  const carriedOverMap = carriedOverBlackoutsForSession(session.id);

  // Once a season's scheduled, the checkbox grid below is read-only (every
  // box disabled) — easy to misread at a glance, especially for someone
  // scanning a long season for the handful of dates that matter. A plain
  // comma-joined list (own blackout dates + anything carried over from
  // another session, merged and sorted) gives an unambiguous answer to
  // "what did I actually block off" without having to scan every row.
  let myBlackoutDatesList = null;
  if (selectedPlayerId) {
    const merged = new Set(existingBlackouts);
    for (const w of weeks) {
      if (carriedOverMap.has(`${selectedPlayerId}|${w.match_date}`)) merged.add(w.match_date);
    }
    myBlackoutDatesList = [...merged].sort();
  }

  res.render('blackout', {
    title: 'Blackout Dates',
    session,
    sessions,
    players,
    weeks,
    selectedPlayerId,
    existingBlackouts,
    carriedOverMap,
    myBlackoutDatesList,
    schedulingLocked: session.status !== 'draft',
    saved: req.query.saved === '1',
    locked: req.query.locked === '1',
  });
});

router.post('/blackout', asyncHandler(async (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(req.body.session_id));
  const playerId = Number(req.body.player_id);
  if (!session || !playerId) return res.redirect('/blackout');

  // Once a season's been scheduled, blackout dates are frozen — changing one
  // after the fact wouldn't retroactively re-run the scheduler, so it'd just
  // silently disagree with the actual schedule. Enforced here too, not just
  // by disabling the form, since this is a public POST route.
  if (session.status !== 'draft') {
    return res.redirect(`/blackout?session=${session.id}&player=${playerId}&locked=1`);
  }

  // Only dates that are real match weeks for this session are accepted —
  // defense against a fabricated request with dates that don't correspond
  // to anything the scheduler would ever check.
  const validDates = new Set(
    db.prepare('SELECT match_date FROM weeks WHERE session_id = ?').all(session.id).map((w) => w.match_date)
  );
  const selectedDates = [].concat(req.body.dates || []).filter((d) => validDates.has(d));

  // Player must actually be enrolled in this session — not just any
  // player_id the form happens to submit.
  const player = db
    .prepare(
      `SELECT p.* FROM session_players sp JOIN players p ON p.id = sp.player_id
       WHERE sp.session_id = ? AND sp.player_id = ? AND p.active = 1`
    )
    .get(session.id, playerId);
  if (!player) return res.redirect('/blackout');

  // Saves directly — no email-confirmation step (removed per product
  // decision; see "Blackout dates" in CLAUDE.md for the anti-abuse tradeoff
  // this gives up: a fabricated player_id in the form now takes effect
  // immediately instead of requiring that player to click a link first).
  // Only touches this player's own `source = 'self'` rows, so it can never
  // clobber a blackout date the admin set directly for them.
  db.transaction(() => {
    db.prepare('DELETE FROM blackout_dates WHERE session_id = ? AND player_id = ? AND source = ?').run(
      session.id,
      playerId,
      'self'
    );
    const insert = db.prepare(
      'INSERT OR IGNORE INTO blackout_dates (session_id, player_id, date, source) VALUES (?, ?, ?, ?)'
    );
    for (const date of selectedDates) insert.run(session.id, playerId, date, 'self');
  })();

  res.redirect(`/blackout?session=${session.id}&player=${playerId}&saved=1`);
}));

router.get('/calendar', (req, res) => {
  const { session, sessions } = resolveSession(req);
  if (!session) return res.render('no_session', { title: 'Calendar' });
  const players = db
    .prepare(
      `SELECT p.* FROM session_players sp JOIN players p ON p.id = sp.player_id
       WHERE sp.session_id = ? AND p.active = 1 ORDER BY p.name`
    )
    .all(session.id);
  // For the subscribe feed below — unlike the one-time download, the feed
  // isn't scoped to whichever session happens to be selected at the top of
  // the page (it spans every session a player's enrolled in), so its name
  // dropdown needs the full active roster, not just this session's.
  const allPlayers = db.prepare('SELECT id, name FROM players WHERE active = 1 ORDER BY name').all();
  res.render('calendar', { title: 'Calendar', session, sessions, players, allPlayers });
});

router.get('/calendar/download', (req, res) => {
  const sessionId = Number(req.query.session);
  const playerId = Number(req.query.player);
  const { value, error } = buildPlayerICS(playerId, sessionId);
  if (error) return res.status(400).send(error);
  res.setHeader('Content-Type', 'text/calendar');
  res.setHeader('Content-Disposition', 'attachment; filename="tennis-schedule.ics"');
  res.send(value);
});

// Subscribable feed — a calendar app fetches this same URL repeatedly (its
// own choice of interval, not ours) rather than the player re-downloading a
// file after every re-schedule. See ics.js's buildPlayerFeedICS for why
// stable per-event UIDs are what actually make "subscribe" work correctly.
// `.ics` suffix on the route (rather than a query param) is deliberate —
// some calendar apps sniff the URL extension to decide whether a link is
// subscribable at all, and a query-string URL doesn't reliably pass that
// check. No token/auth, same as every other player-facing page here — a
// player's own schedule isn't sensitive data (it's already on the public
// schedule page), and this app has no login model to check against anyway.
router.get('/calendar/feed/:playerId.ics', (req, res) => {
  const playerId = Number(req.params.playerId);
  const { value, error } = buildPlayerFeedICS(playerId);
  if (error) return res.status(400).send(error);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  // Deliberately no Content-Disposition: attachment (unlike /calendar/download
  // above) — this URL is meant to be added as a standing subscription, not
  // saved as a one-off file.
  res.send(value);
});

router.get('/pdf', (req, res) => {
  const { session, sessions } = resolveSession(req);
  if (!session) return res.render('no_session', { title: 'PDF' });
  if (req.query.download === 'all') return streamAllSessionsPDF(res);
  if (req.query.download === '1') return streamSeasonPDF(session.id, res);
  res.render('pdf', { title: 'Season PDF', session, sessions });
});

// --- Self-service "request a sub" (proactive, doesn't wait for the reminder
// email) -------------------------------------------------------------------

router.get('/request-sub', (req, res) => {
  const { session, sessions } = resolveSession(req, { regularOnly: true });
  if (!session) return res.render('no_session', { title: 'Request a Sub' });

  const players = db
    .prepare(
      `SELECT p.* FROM session_players sp JOIN players p ON p.id = sp.player_id
       WHERE sp.session_id = ? AND p.active = 1 ORDER BY p.name`
    )
    .all(session.id);

  const selectedPlayerId = Number(req.query.player) || null;
  let upcomingAssignments = [];
  if (selectedPlayerId) {
    // Includes needs_sub/subbed_out now (not just scheduled/confirmed) so a
    // week the player already requested a sub for — or already got subbed
    // out of — still shows here with its real status, instead of silently
    // disappearing from the list. Kyle, 2026-08-18: "the status on the
    // request a sub page should change reflecting the player already
    // requested a sub for that week" / "once that sub request is filled,
    // the status ... should be changed to 'subbed out'". The "Need a sub"
    // button itself is still only rendered for scheduled/confirmed rows in
    // request_sub.ejs — no point offering it once a request is already out
    // or already filled.
    upcomingAssignments = db
      .prepare(
        `SELECT wa.*, w.match_date FROM week_assignments wa
         JOIN weeks w ON w.id = wa.week_id
         WHERE w.session_id = ? AND wa.player_id = ? AND w.locked = 0
           AND wa.status IN ('scheduled', 'confirmed', 'needs_sub', 'subbed_out')
         ORDER BY w.match_date`
      )
      .all(session.id, selectedPlayerId);
    // Same double-booking flag shown on /schedule, /lookahead, and My Page —
    // this is exactly the page a player uses to decide *which* week to drop,
    // so a week they're double-booked into should read "double booked," not
    // "scheduled," here too (Kyle, 2026-08-11).
    const dbMap = doubleBookingMapForSession(session.id);
    upcomingAssignments.forEach((a) => {
      const other = dbMap.get(`${a.player_id}|${a.match_date}`);
      if (other) a.doubleBooked = other;
    });
  }

  res.render('request_sub', {
    title: 'Request a Sub',
    session,
    sessions,
    players,
    selectedPlayerId,
    upcomingAssignments,
  });
});

// No state change occurs on page load, and this route itself never mutates
// anything either — /request-sub has no login (just a name picked from a
// dropdown), so nothing here can be trusted as "the real player clicked
// this." Instead of handing the browser a working confirm link directly
// (which a script could then also submit, no human involved at any point),
// this mints a token and EMAILS the link to that player's own address —
// the same /need-sub/:token GET/POST landing page + "Are you sure?"
// confirmation used by the reminder email's "need a sub" link. Only
// whoever actually has access to that inbox can get past this. Kyle,
// 2026-08-18: "I feel like bots could easily send out many emails by
// pressing that sub button. I want there to be some validation by the
// player." See email.js's sendSubRequestVerification() doc comment.
router.post('/request-sub/start', requestSubStartLimiter, asyncHandler(async (req, res) => {
  // Honeypot check first, before any DB work — a bot that filled in the
  // hidden field gets the exact same success-looking response a real
  // request would get (no name in it, since we haven't looked anything up
  // yet), so there's no visible difference to react to. See honeypot.js.
  if (honeypot.isBot(req)) {
    return res.render('message', {
      title: 'Request a Sub',
      heading: 'Check your email',
      body: "If that was a valid request, we've sent a confirmation link to the email on file. Nothing has been sent to any other players yet.",
      tone: 'ok',
    });
  }
  const assignmentId = Number(req.body.assignment_id);
  const assignment = db
    .prepare(
      `SELECT wa.*, p.name, p.email, p.slug FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = wa.player_id
       WHERE wa.id = ? AND w.locked = 0 AND wa.status IN ('scheduled', 'confirmed')`
    )
    .get(assignmentId);
  if (!assignment) return res.redirect('/request-sub');

  const week = subFlow.getWeekWithSession(assignment.week_id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  const raw = tokenStore.issueToken(assignment.id);
  await email.sendSubRequestVerification({
    player: { name: assignment.name, email: assignment.email },
    week,
    session,
    needSubToken: raw,
  });

  res.render('message', {
    title: 'Request a Sub',
    heading: 'Check your email',
    body: `We've sent a confirmation link to the email on file for ${assignment.name} — click it to finish requesting a sub for this week. Nothing has been sent to any other players yet.`,
    tone: 'ok',
    myPageId: assignment.slug || assignment.player_id,
  });
}));

// --- Direct player-to-player swaps (swapFlow.js) ---------------------------
// A two-way trade of two specific players' own weeks, distinct from Request
// a Sub above (a one-to-many fan-out where anyone can claim the open slot).
// Self-service, requires the other player's confirmation — see swapFlow.js's
// doc comment for the full design (Kyle, 2026-08-11).

router.get('/swap', (req, res) => {
  const { session, sessions } = resolveSession(req, { regularOnly: true });
  if (!session) return res.render('no_session', { title: 'Swap a Week' });

  const players = db
    .prepare(
      `SELECT p.* FROM session_players sp JOIN players p ON p.id = sp.player_id
       WHERE sp.session_id = ? AND p.active = 1 ORDER BY p.name`
    )
    .all(session.id);

  const selectedPlayerId = Number(req.query.player) || null;
  const selectedAssignmentId = Number(req.query.assignment) || null;
  const selectedTargetPlayerId = Number(req.query.target_player) || null;

  let ownAssignments = [];
  let selectedAssignment = null;
  let targetAssignments = [];

  if (selectedPlayerId) {
    ownAssignments = swapFlow.eligibleOwnAssignments(session.id, selectedPlayerId);
    // Same double-booking flag as /schedule, /lookahead, My Page, and Request
    // a Sub — this is exactly the page where a player picks which of their
    // own weeks to give up, so a double-booked week should be called out
    // here too, not just discovered after the fact (Kyle, 2026-08-11).
    const dbMap = doubleBookingMapForSession(session.id);
    ownAssignments.forEach((a) => {
      const other = dbMap.get(`${a.player_id}|${a.week.match_date}`);
      if (other) a.doubleBooked = other;
    });
  }
  if (selectedAssignmentId) {
    selectedAssignment = ownAssignments.find((a) => a.id === selectedAssignmentId) || null;
  }
  if (selectedAssignment && selectedTargetPlayerId) {
    targetAssignments = swapFlow.eligibleTargetAssignments(selectedAssignmentId, selectedTargetPlayerId);
  }

  res.render('swap', {
    title: 'Swap a Week',
    session,
    sessions,
    players,
    selectedPlayerId,
    selectedAssignmentId,
    selectedTargetPlayerId,
    ownAssignments,
    selectedAssignment,
    targetAssignments,
  });
});

// POST /swap/start no longer calls proposeSwap() directly — it's an
// unauthenticated public form (pick any two players from a dropdown), so a
// script could otherwise hit it repeatedly and immediately email real swap
// proposals to players who never asked for anything. It now only mints a
// pending swap_proposal_verifications row and emails the *initiator* a
// "confirm it's really you" link — proposeSwap() (and its two real emails,
// including the one to the target player) only fires from GET/POST
// /swap/verify/:token below, once that link is actually clicked. Same
// "email yourself first" pattern already used by /request-sub/start (Kyle,
// 2026-08-28: closing the same bot-spam gap on the swap side).
router.post('/swap/start', swapStartLimiter, asyncHandler(async (req, res) => {
  // Same honeypot check as /request-sub/start above, first thing, before any
  // DB work — same generic success-looking response either way.
  if (honeypot.isBot(req)) {
    return res.render('message', {
      title: 'Swap a Week',
      heading: 'Check your email',
      body: "If that was a valid proposal, we've sent a confirmation link to the email on file. Nothing has been sent to the other player yet.",
      tone: 'ok',
    });
  }
  const assignmentId = Number(req.body.assignment_id);
  const targetAssignmentId = Number(req.body.target_assignment_id);
  const result = swapFlow.issueProposalVerification(assignmentId, targetAssignmentId);
  if (!result.ok) {
    return res.render('message', {
      title: 'Swap a Week',
      heading: 'Swap not available',
      body: "That swap isn't available anymore — the week may have locked, gotten blacked out, or someone else's schedule changed since you loaded the page. Go back and try again.",
      tone: 'error',
    });
  }
  const { initiatorCtx, token } = result;
  await email.sendSwapProposalVerification({
    player: initiatorCtx.player,
    targetPlayer: result.targetCtx.player,
    initiatorWeek: initiatorCtx.week,
    targetWeek: result.targetCtx.week,
    session: initiatorCtx.session,
    verifyToken: token,
  });
  res.render('message', {
    title: 'Swap a Week',
    heading: 'Check your email',
    body: `We've sent a confirmation link to the email on file for ${initiatorCtx.player.name} — click it to actually send the proposal to ${result.targetCtx.player.name}. Nothing has been sent to them yet.`,
    tone: 'ok',
    myPageId: initiatorCtx.player.slug || initiatorCtx.player.id,
  });
}));

router.get('/swap/verify/:token', (req, res) => {
  const pending = swapFlow.findProposalVerificationByToken(req.params.token);
  if (!pending) {
    return res.render('message', { title: 'Swap a Week', heading: 'Link not found', body: 'This confirmation link is invalid or has expired.', tone: 'error' });
  }
  const initiatorCtx = swapFlow.getAssignmentContext(pending.initiator_assignment_id);
  const targetCtx = swapFlow.getAssignmentContext(pending.target_assignment_id);
  if (!initiatorCtx || !targetCtx) {
    return res.render('message', { title: 'Swap a Week', heading: 'No longer available', body: 'One side of this swap no longer exists — it may have been reassigned since you started this.', tone: 'error' });
  }
  res.render('swap_verify', { title: 'Swap a Week', token: req.params.token, initiatorCtx, targetCtx });
});

router.post('/swap/verify/:token', asyncHandler(async (req, res) => {
  const pending = swapFlow.findProposalVerificationByToken(req.params.token);
  if (!pending) {
    return res.render('message', { title: 'Swap a Week', heading: 'Link not found', body: 'This confirmation link is invalid or has expired.', tone: 'error' });
  }
  // Single-use regardless of outcome below — a second click of the same
  // emailed link (or someone re-submitting the confirm page) shouldn't be
  // able to propose the same swap twice.
  swapFlow.consumeProposalVerification(pending.id);

  const result = await swapFlow.proposeSwap(pending.initiator_assignment_id, pending.target_assignment_id);
  if (!result.ok) {
    return res.render('message', {
      title: 'Swap a Week',
      heading: 'Swap not available',
      body: "That swap isn't available anymore — the week may have locked, gotten blacked out, or someone else's schedule changed since you started this. Go back and try again.",
      tone: 'error',
    });
  }
  const initiatorCtx = swapFlow.getAssignmentContext(pending.initiator_assignment_id);
  res.render('message', {
    title: 'Swap a Week',
    heading: 'Swap request sent',
    body: "We've emailed the other player your proposal — you'll hear back once they accept or decline. Nothing changes until then.",
    tone: 'ok',
    myPageId: (initiatorCtx && initiatorCtx.player.slug) || (initiatorCtx && initiatorCtx.player.id),
  });
}));

router.get('/swap/respond/:token', (req, res) => {
  const swapRequest = swapFlow.findSwapRequestByToken(req.params.token);
  if (!swapRequest) {
    return res.render('message', { title: 'Swap a Week', heading: 'Link not found', body: 'This swap link is invalid or has expired.', tone: 'error' });
  }
  const initiatorCtx = swapFlow.getAssignmentContext(swapRequest.initiator_assignment_id);
  const targetCtx = swapFlow.getAssignmentContext(swapRequest.target_assignment_id);
  if (!initiatorCtx || !targetCtx) {
    return res.render('message', { title: 'Swap a Week', heading: 'No longer available', body: 'One side of this swap no longer exists — it may have been reassigned since this was proposed.', tone: 'error' });
  }
  res.render('swap_respond', {
    title: 'Swap a Week',
    token: req.params.token,
    swapRequest,
    initiatorCtx,
    targetCtx,
    alreadyResolved: swapRequest.status !== 'pending',
  });
});

router.post('/swap/respond/:token', asyncHandler(async (req, res) => {
  const accept = req.body.action === 'accept';
  const result = await swapFlow.respondToSwap(req.params.token, accept);
  if (!result.ok) {
    const messages = {
      invalid: 'This swap link is invalid or has expired.',
      already_resolved: 'This swap request has already been responded to.',
      no_longer_available: 'This swap is no longer available — something about the schedule changed since it was proposed.',
      expired: 'This swap request expired before it was answered — the week it was for has already passed.',
    };
    return res.render('message', {
      title: 'Swap a Week',
      heading: 'Not available',
      body: messages[result.reason] || 'This link is no longer valid.',
      tone: 'error',
      myPageId: result.respondingPlayerId,
    });
  }
  if (!result.accepted) {
    return res.render('message', {
      title: 'Swap a Week',
      heading: 'Swap declined',
      body: "You've declined the swap. Nothing changed for you — the other player has been notified.",
      tone: 'ok',
      myPageId: result.respondingPlayerId,
    });
  }
  res.render('message', {
    title: 'Swap a Week',
    heading: "Swap confirmed!",
    body: "You're all set — both of you have been emailed the details, and My Page has your updated schedule.",
    tone: 'ok',
    myPageId: result.respondingPlayerId,
  });
}));

// --- Token-driven action routes -------------------------------------------

router.get('/confirm/:token', (req, res) => {
  const assignment = tokenStore.findAssignmentByToken(req.params.token);
  if (!assignment) return res.render('message', { title: 'Confirm', heading: 'Link not found', body: 'This confirmation link is invalid or has expired.', tone: 'error' });
  const week = subFlow.getWeekWithSession(assignment.week_id);
  res.render('confirm', { title: 'Confirm', assignment, week, token: req.params.token });
});

router.post('/confirm/:token', (req, res) => {
  const assignment = tokenStore.findAssignmentByToken(req.params.token);
  if (!assignment) return res.render('message', { title: 'Confirm', heading: 'Link not found', body: 'This confirmation link is invalid or has expired.', tone: 'error' });

  db.prepare("UPDATE week_assignments SET token_used_at = datetime('now') WHERE id = ?").run(assignment.id);

  if (assignment.status === 'confirmed') {
    return res.render('message', { title: 'Confirm', heading: "You're already confirmed", body: 'No action needed — see you on the court!', tone: 'ok', myPageId: assignment.slug || assignment.player_id });
  }
  if (assignment.status === 'subbed_out') {
    return res.render('message', { title: 'Confirm', heading: 'Already subbed out', body: 'A substitute already took this slot.', tone: 'error', myPageId: assignment.slug || assignment.player_id });
  }
  if (assignment.status === 'needs_sub') {
    return res.render('message', { title: 'Confirm', heading: 'Sub already requested', body: "You've already requested a sub for this week. Contact the admin if you'd like to undo that.", tone: 'error', myPageId: assignment.slug || assignment.player_id });
  }

  db.prepare("UPDATE week_assignments SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?").run(assignment.id);
  res.render('message', { title: 'Confirm', heading: "You're confirmed!", body: 'Thanks — see you on the court.', tone: 'ok', myPageId: assignment.slug || assignment.player_id });
});

router.get('/need-sub/:token', (req, res) => {
  const assignment = tokenStore.findAssignmentByToken(req.params.token);
  if (!assignment) return res.render('message', { title: 'Need a sub', heading: 'Link not found', body: 'This link is invalid or has expired.', tone: 'error' });
  const week = subFlow.getWeekWithSession(assignment.week_id);
  res.render('need_sub', { title: 'Need a sub', assignment, week, token: req.params.token });
});

router.post('/need-sub/:token', asyncHandler(async (req, res) => {
  const assignment = tokenStore.findAssignmentByToken(req.params.token);
  if (!assignment) return res.render('message', { title: 'Need a sub', heading: 'Link not found', body: 'This link is invalid or has expired.', tone: 'error' });

  db.prepare("UPDATE week_assignments SET token_used_at = datetime('now') WHERE id = ?").run(assignment.id);

  if (assignment.status === 'subbed_out') {
    return res.render('message', { title: 'Need a sub', heading: 'Already subbed out', body: 'A substitute has already taken this slot.', tone: 'error', myPageId: assignment.slug || assignment.player_id });
  }
  if (assignment.status === 'needs_sub') {
    return res.render('message', { title: 'Need a sub', heading: 'Already requested', body: 'A sub request is already out for this week — no need to do anything else.', tone: 'ok', myPageId: assignment.slug || assignment.player_id });
  }

  const result = await subFlow.createSubRequest(assignment.id);
  if (result.blocked) {
    return res.render('message', {
      title: 'Need a sub',
      heading: 'Please contact the admin',
      body: 'Another player already needs a sub for this same week. To keep things simple, the admin will sort out multiple sub requests in the same week manually — reach out directly.',
      tone: 'error',
      myPageId: assignment.slug || assignment.player_id,
    });
  }
  res.render('message', {
    title: 'Need a sub',
    heading: 'Sub request sent',
    body: `An email went out to the ${result.offerCount} other player(s) not already playing that week. First to confirm gets the spot.`,
    tone: 'ok',
    myPageId: assignment.slug || assignment.player_id,
  });
}));

// --- "My Page" personal dashboard ------------------------------------------
// A single bookmarkable URL per player pulling together everything they'd
// otherwise have to hunt across separate pages for: upcoming matches and
// their confirm/sub status across every session they're currently enrolled
// in, upcoming ball duty, sessions still in draft where blackout dates are
// open, and calendar-subscribe links. No token/auth, same reasoning as the
// calendar feed above — a player's own schedule isn't sensitive, and this
// app has no login model to check against anyway.

router.get('/me', (req, res) => {
  const playerId = Number(req.query.player);
  if (playerId) {
    // Prefer the player's own slug for the redirect target where available,
    // so following this lookup form lands on the nice /me/<slug> URL rather
    // than the numeric one — the slug lookup is the one meant to be
    // bookmarked (Kyle, 2026-08-26).
    const p = db.prepare('SELECT slug FROM players WHERE id = ?').get(playerId);
    return res.redirect(`/me/${(p && p.slug) || playerId}`);
  }
  const allPlayers = db.prepare('SELECT id, slug, name FROM players WHERE active = 1 ORDER BY name').all();
  res.render('me_lookup', { title: 'My Page', allPlayers });
});

// Accepts either a player's URL slug (the normal, bookmarkable form,
// e.g. /me/brian-b) or their raw numeric id (kept working indefinitely for
// backward compatibility — every /me link generated before this feature,
// and every one built by other server-side code that doesn't have a slug
// handy, uses the numeric form). Slug is checked first; the numeric
// fallback only applies when the whole segment is digits, so a slug that
// happens to be purely numeric would never realistically collide with a
// real player id (ids are small, sequential, auto-incremented integers).
router.get('/me/:idOrSlug', (req, res) => {
  const raw = req.params.idOrSlug;
  let player = db.prepare('SELECT * FROM players WHERE slug = ?').get(raw);
  if (!player && /^\d+$/.test(raw)) {
    player = db.prepare('SELECT * FROM players WHERE id = ?').get(Number(raw));
  }
  if (!player) {
    return res.render('message', {
      title: 'My Page',
      heading: 'Player not found',
      body: "This link doesn't match a known player.",
      tone: 'error',
    });
  }
  const playerId = player.id;

  const todayIso = new Date().toISOString().slice(0, 10);

  // Mirrors buildPlayerFeedICS's scope in ics.js: every scheduled/active,
  // non-archived session this player is currently enrolled in.
  const sessions = db
    .prepare(
      `SELECT s.* FROM sessions s
       JOIN session_players sp ON sp.session_id = s.id
       WHERE sp.player_id = ? AND s.status IN ('scheduled', 'active') AND s.archived_at IS NULL
       ORDER BY s.match_day_of_week, s.match_time, s.name`
    )
    .all(playerId);

  const sessionCards = sessions.map((session) => {
    const upcoming = db
      .prepare(
        `SELECT wa.*, w.match_date, w.locked
         FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id
         WHERE wa.player_id = ? AND w.session_id = ? AND w.match_date >= ? AND wa.status != 'subbed_out'
         ORDER BY w.match_date`
      )
      .all(playerId, session.id, todayIso);
    const dbMap = doubleBookingMapForSession(session.id);
    upcoming.forEach((a) => {
      const other = dbMap.get(`${a.player_id}|${a.match_date}`);
      if (other) a.doubleBooked = other;
    });

    const ballDutyWeeks = db
      .prepare(
        `SELECT match_date FROM weeks WHERE session_id = ? AND ball_duty_player_id = ? AND match_date >= ?
         ORDER BY match_date`
      )
      .all(session.id, playerId, todayIso);
    const ballDutyDates = new Set(ballDutyWeeks.map((w) => w.match_date));

    return { session, upcoming, ballDutyDates };
  });

  // Draft sessions this player's enrolled in aren't in getViewableSessions
  // scope (nothing scheduled yet), but blackout dates are meant to be
  // collected before the first "Schedule these players" run — surface them
  // here as an action item rather than leaving the player to stumble onto
  // the emailed notify-blackouts link only.
  const draftSessions = db
    .prepare(
      `SELECT s.* FROM sessions s
       JOIN session_players sp ON sp.session_id = s.id
       WHERE sp.player_id = ? AND s.status = 'draft' AND s.archived_at IS NULL
       ORDER BY s.match_day_of_week, s.match_time, s.name`
    )
    .all(playerId);

  const feedUrlHttps = `${req.protocol}://${req.get('host')}/calendar/feed/${playerId}.ics`;
  const feedUrlWebcal = feedUrlHttps.replace(/^https?:\/\//, 'webcal://');

  res.render('me', {
    title: 'My Page',
    player,
    sessionCards,
    draftSessions,
    feedUrlHttps,
    feedUrlWebcal,
  });
});

router.get('/claim-sub/:token', (req, res) => {
  const hashed = hashToken(req.params.token);
  const offer = db.prepare('SELECT * FROM sub_offers WHERE token = ?').get(hashed);
  if (!offer) return res.render('message', { title: 'Claim sub', heading: 'Link not found', body: 'This link is invalid or has expired.', tone: 'error' });
  const subRequest = db.prepare('SELECT * FROM sub_requests WHERE id = ?').get(offer.sub_request_id);
  const originalAssignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(subRequest.week_assignment_id);
  const week = subFlow.getWeekWithSession(originalAssignment.week_id);
  res.render('claim_sub', { title: 'Claim sub', offer, week, token: req.params.token, alreadyClosed: offer.status !== 'pending' });
});

router.post('/claim-sub/:token', asyncHandler(async (req, res) => {
  const result = await subFlow.claimSub(req.params.token);
  if (!result.ok) {
    const messages = {
      invalid: 'This link is invalid or has expired.',
      already_claimed: 'This spot has already been claimed by someone else.',
      already_filled: 'This spot has already been filled.',
    };
    return res.render('message', { title: 'Claim sub', heading: 'Spot no longer available', body: messages[result.reason] || 'This link is no longer valid.', tone: 'error' });
  }
  res.render('message', { title: 'Claim sub', heading: "You're in!", body: `Thanks for subbing in for ${email.fmtDate(result.week.match_date)}. The rest of the group has been notified.`, tone: 'ok', myPageId: result.subPlayer.slug || result.subPlayer.id });
}));

// Ad-hoc pickup-game sign-up (see adhocFlow.js) — GET renders a landing page
// with an "I'm in" button, POST records the click. First-come-first-served:
// there's no status to change here beyond the one-time timestamp, so unlike
// /confirm there's nothing to "undo" from this page — a player who's already
// signed up just sees that back to them.
router.get('/adhoc-signup/:token', (req, res) => {
  const signup = adhocFlow.findSignupByToken(req.params.token);
  if (!signup) return res.render('message', { title: 'Sign up', heading: 'Link not found', body: 'This sign-up link is invalid or has expired.', tone: 'error' });
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(signup.session_id);
  const groups = adhocFlow.courtGroupsForWeek(signup.week_id);
  res.render('adhoc_signup', { title: 'Sign up', signup, session, token: req.params.token, totalSignedUp: groups.totalSignedUp });
});

router.post('/adhoc-signup/:token', (req, res) => {
  const signup = adhocFlow.findSignupByToken(req.params.token);
  if (!signup) return res.render('message', { title: 'Sign up', heading: 'Link not found', body: 'This sign-up link is invalid or has expired.', tone: 'error' });

  const alreadySignedUp = !!signup.signed_up_at;
  adhocFlow.recordSignup(req.params.token);

  res.render('message', {
    title: 'Sign up',
    heading: alreadySignedUp ? "You're already in" : "You're in!",
    body: alreadySignedUp
      ? "You'd already signed up for this one — no action needed."
      : "Thanks — you're in the running. You'll get an email once courts are finalized closer to match day, either with who you're playing with or letting you know if it didn't fill this time.",
    tone: 'ok',
    myPageId: signup.slug || signup.player_id,
  });
});

module.exports = router;
