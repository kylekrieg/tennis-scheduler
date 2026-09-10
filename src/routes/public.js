'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db');
const { resolveSession, doubleBookingMapForSession, carriedOverBlackoutsForSession, sessionRosterStats, sessionsForPlayer, orderAssignmentsWithSubGroups, SESSION_DISPLAY_ORDER } = require('../services/sessionHelper');
const weather = require('../services/weather');
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
const { logPlayerActivity, logGroupScoreActivity } = require('../services/activityLog');
const { fullName } = require('../services/playerName');
const gameScores = require('../services/gameScores');
const { getTimezone } = require('../services/settings');
const { utcToZonedParts } = require('../services/tz');

// Separate buckets (10/hour/IP each, generous for real use — a household
// sharing an IP could submit several times without ever tripping this) so
// a script can't enumerate assignment_id values and mass-trigger
// verification emails across the whole roster in one sitting. See
// rateLimiter.js's doc comment and "Rate limiting" in CLAUDE.md.
const requestSubStartLimiter = rateLimiter({ name: 'request-sub-start', windowMs: 60 * 60 * 1000, max: 10 });
const swapStartLimiter = rateLimiter({ name: 'swap-start', windowMs: 60 * 60 * 1000, max: 10 });
const foundSubStartLimiter = rateLimiter({ name: 'found-sub-start', windowMs: 60 * 60 * 1000, max: 10 });
// Pre-launch security review (Kyle, 2026-08-29): POST /blackout had no abuse
// protection of any kind — unlike every other public mutation in this app,
// it isn't gated by an unguessable token, just a session_id/player_id pair
// (small, sequential, guessable integers) taken straight from the request
// body. That's a deliberate, documented tradeoff (the email-confirmation
// step here was removed for UX reasons — see "Blackout dates" in CLAUDE.md)
// but going live to real players raises the stakes of leaving it completely
// undefended, so it gets the same honeypot + rate limiter already proven out
// on the two routes above rather than reopening the confirmation-email
// question.
const blackoutLimiter = rateLimiter({ name: 'blackout-post', windowMs: 60 * 60 * 1000, max: 20 });
// Same trust level as blackoutLimiter above — POST /scores/:idOrSlug has no
// email-confirmation step either, just a guessable slug/numeric id and an
// assignment id, and gameScores.setGameScore() itself already rejects an
// assignment that isn't this player's own. Generous (20/hour/IP) since a
// player fixing several weeks' backlog of scores in one sitting is normal
// use, not abuse.
const scoreEntryLimiter = rateLimiter({ name: 'score-entry', windowMs: 60 * 60 * 1000, max: 20 });

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
    // Kyle, 2026-09-08: "Can we do that same type of thing on the public
    // schedule page so players know who is subbing for whom?" — same
    // reordering/indenting the admin session-detail page already does (see
    // sessionHelper.js's orderAssignmentsWithSubGroups doc comment), but with
    // `(p) => p.name` so a sub's replacesPlayerName reads the short public
    // name here instead of admin.js's full name.
    let assignments = db
      .prepare(
        `SELECT wa.*, p.name FROM week_assignments wa JOIN players p ON p.id = wa.player_id
         WHERE wa.week_id = ? ORDER BY wa.court, wa.team`
      )
      .all(w.id);
    assignments = orderAssignmentsWithSubGroups(assignments, (p) => p.name);
    stampDoubleBookings(assignments, w.match_date, dbMap);
    const ballDuty = w.ball_duty_player_id
      ? db.prepare('SELECT name FROM players WHERE id = ?').get(w.ball_duty_player_id)
      : null;
    // Always attached (cheap indexed PK lookup), whether or not the session
    // currently has weather turned on — the views gate display on
    // session.weather_enabled themselves, same "compute here, decide in the
    // view" split as ballDutyName/doubleBooked above. A disabled session
    // just means the cache was never populated in the first place, so this
    // is null either way.
    return { week: w, assignments, ballDutyName: ballDuty ? ballDuty.name : null, weather: weather.getCachedWeather(w.id) };
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
  // Preferences (text size) is shared functionality for players and admins
  // alike, but it lives under the public router with no requireAdmin gate —
  // an admin clicking "Preferences" from the admin nav was always rendered
  // with the public header, which swapped every nav link over to the public
  // site and made it look like they'd been logged out (Kyle, 2026-08-31:
  // "it doesn't log you out... but brings the top header links back to the
  // 'public site'"). req.session is the same session store either router
  // uses, so isAdmin (set at admin login, see admin.js) is already reliably
  // available here — no new auth logic needed, just pick the right header
  // partial to include.
  res.render('preferences', { title: 'Preferences', isAdmin: !!(req.session && req.session.isAdmin) });
});

// Kyle, 2026-09-05: "I'd like to build a 'player stats' on the public site.
// Maybe I like the stats we built for each session under the admin panel
// but I think we need to remove the session stats at the top and just
// display the exploded view of each session with each player." That's
// admin.js's GET /stats (Stats Summary) — its top summary row (open subs,
// ball-duty issues, confirmation counts) is genuinely admin-only "needs
// attention" info, but the per-player Target/Played/Sub bonus/Ball duty
// table underneath each session is exactly the kind of thing a player
// already wants to know ("how am I doing this season") and isn't sensitive
// at all — every number in it is already derivable from the public
// schedule/PDF/calendar. Reuses the exact same sessionRosterStats() helper
// (now in sessionHelper.js) so this page and both admin stats pages can
// never disagree on what "played" or "ball duty" means.
//
// Scope is active/scheduled regular sessions only — same as
// getViewableSessions()'s definition of "worth showing on public pages"
// (archived sessions are meant to go fully quiet, and ad-hoc sessions have
// no target/ball-duty concept for this table to describe at all).
router.get('/stats', (req, res) => {
  const sessions = db
    .prepare(
      `SELECT * FROM sessions WHERE archived_at IS NULL AND session_type = 'regular' AND status IN ('scheduled', 'active') ${SESSION_DISPLAY_ORDER}`
    )
    .all();
  const rows = sessions.map((s) => {
    const { roster: playerStats, subs: subStats } = sessionRosterStats(s.id);
    return { session: s, playerStats, subStats };
  });
  res.render('player_stats', { title: 'Player Stats', rows });
});

// Games-won leaderboard (Kyle, 2026-09-09): "a running total can be seen
// with a player leader board." Session-scoped, same session_picker pattern
// as /schedule/lookahead — resolveSession() picks the active session by
// default, or whichever ?session= is passed, and the view offers a switcher
// when more than one is viewable. See gameScores.js's sessionLeaderboard()
// doc comment for exactly how ties are broken.
router.get('/leaderboard', (req, res) => {
  const { session, sessions } = resolveSession(req);
  if (!session) return res.render('no_session', { title: 'Leaderboard' });
  const board = gameScores.sessionLeaderboard(session.id);
  res.render('leaderboard', { title: 'Leaderboard', session, sessions, board });
});

// Group score entry (Kyle, 2026-09-10): "instead of a dropdown and everybody
// entering their own score, show everybody confirmed for that week with
// input boxes, so one person can fill in the whole group's scores." Session-
// scoped like /schedule and /lookahead (resolveSession + session_picker),
// defaulting to that session's most recently played week and offering any
// other still-not-fully-scored week as a pick-list (?week=<id>) so a week
// nobody got to right after it happened doesn't just fall off the page once
// a newer one locks. The old per-player page (look up your name, see/edit
// just your own scores across every week you've played) still lives at
// /scores/lookup and /scores/:idOrSlug below, for anyone who'd rather do it
// that way.
router.get('/scores', (req, res) => {
  const { session, sessions } = resolveSession(req);
  if (!session) return res.render('no_session', { title: 'Enter Scores' });

  const weeks = gameScores.scoreEntryWeeksForSession(session.id);
  const requestedId = Number(req.query.week);
  const selectedWeek = weeks.length ? weeks.find((w) => w.id === requestedId) || weeks[0] : null;
  const rows = selectedWeek
    ? gameScores.scoreRowsForWeek(selectedWeek.id).map((r) => ({ assignment: r, canEdit: gameScores.canPlayerEdit(r) }))
    : [];

  res.render('scores_week', {
    title: 'Enter Scores',
    session,
    sessions,
    weeks,
    selectedWeek,
    rows,
    saved: Number(req.query.saved) || 0,
    errorCode: req.query.error || null,
    maxGames: gameScores.MAX_GAMES,
  });
});

// Batch save for the group entry grid above — one form post carries any
// number of boxes as two position-paired arrays, assignment_id[] and
// games_won[] (see the array-vs-bracket-object comment below for why it's
// shaped this way instead of games_won[<assignmentId>]); a blank box is left
// untouched rather than treated as "clear this score," so someone filling in
// just their own box on an otherwise-empty week doesn't wipe anyone else's.
// Each box still goes through gameScores.setGameScore()'s normal scoreable +
// 24h-window gate — playerId is deliberately omitted (see that function's
// doc comment for why the group page skips the ownership check on purpose)
// — and one bad or locked box doesn't stop the rest of the grid from saving.
router.post('/scores', scoreEntryLimiter, (req, res) => {
  const weekId = Number(req.body.week_id);
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId);
  if (!week) {
    return res.render('message', {
      title: 'Enter Scores',
      heading: 'Week not found',
      body: "That week couldn't be found.",
      tone: 'error',
    });
  }

  // Two parallel arrays (assignment_id[], games_won[]) rather than a single
  // bracket-keyed object (games_won[<assignmentId>]) — assignment ids are
  // plain autoincrement integers, and qs (the parser behind
  // express.urlencoded({extended:true})) treats a purely-numeric bracket key
  // as an array index and silently compacts/reorders the result, which
  // scrambled real assignment ids onto the wrong rows in testing. Position-
  // paired arrays sidestep that entirely: qs only ever appends to them in
  // submission order. Array.isArray guards the single-row case, where some
  // parsers hand back a bare string instead of a one-element array.
  const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const assignmentIds = toArray(req.body.assignment_id);
  const gamesWonValues = toArray(req.body.games_won);
  let savedCount = 0;
  let lastErrorCode = null;
  for (let i = 0; i < assignmentIds.length; i++) {
    const assignmentIdRaw = assignmentIds[i];
    const rawValue = gamesWonValues[i];
    if (rawValue === '' || rawValue === undefined || rawValue === null) continue; // blank box = leave it alone
    try {
      const { row, wasFirstEntry } = gameScores.setGameScore({
        assignmentId: Number(assignmentIdRaw),
        gamesWon: rawValue,
      });
      const player = db.prepare('SELECT * FROM players WHERE id = ?').get(row.player_id);
      // logGroupScoreActivity, not logPlayerActivity — whoever is filling in
      // this box on the group page may not be `player` themselves (see that
      // function's doc comment), so the log shouldn't claim "self-service".
      logGroupScoreActivity({
        playerName: fullName(player),
        action: wasFirstEntry ? 'score.enter' : 'score.update',
        description: `${fullName(player)}'s games won for ${week.match_date} ${wasFirstEntry ? 'entered' : 'updated'} to ${row.games_won} via the group entry page`,
        sessionId: row.session_id,
      });
      savedCount++;
    } catch (err) {
      if (err instanceof gameScores.ScoreError) {
        lastErrorCode = err.code;
        continue;
      }
      throw err;
    }
  }

  const qs = new URLSearchParams({ session: String(week.session_id), week: String(weekId) });
  if (savedCount > 0) qs.set('saved', String(savedCount));
  if (lastErrorCode) qs.set('error', lastErrorCode);
  return res.redirect(`/scores?${qs.toString()}`);
});

// Old per-player lookup, kept alongside the new group entry page above for
// anyone who'd rather look up just their own name (Kyle, 2026-09-10) — same
// shape as GET /me: ?player= redirects to the nice bookmarkable /scores/<slug>
// URL; with nothing selected yet, shows a name picker.
router.get('/scores/lookup', (req, res) => {
  const playerId = Number(req.query.player);
  if (playerId) {
    const p = db.prepare('SELECT slug FROM players WHERE id = ?').get(playerId);
    return res.redirect(`/scores/${(p && p.slug) || playerId}`);
  }
  const allPlayers = db.prepare('SELECT id, slug, name FROM players WHERE active = 1 ORDER BY name').all();
  res.render('scores_lookup', { title: 'Enter Scores', allPlayers });
});

// A player's own "enter your games won" page — accepts either their slug or
// numeric id, exactly like GET /me/:idOrSlug (see that route's doc comment
// for the slug-vs-id resolution rule). Unlike My Page, this looks
// *backward*: every already-played (locked), actually-played
// (scheduled/confirmed) match across every session this player has one in,
// most recent first, grouped by session — the games-won mirror of My Page's
// forward-looking "upcoming matches" list.
router.get('/scores/:idOrSlug', (req, res) => {
  const raw = req.params.idOrSlug;
  let player = db.prepare('SELECT * FROM players WHERE slug = ?').get(raw);
  if (!player && /^\d+$/.test(raw)) {
    player = db.prepare('SELECT * FROM players WHERE id = ?').get(Number(raw));
  }
  if (!player) {
    return res.render('message', {
      title: 'Enter Scores',
      heading: 'Player not found',
      body: "This link doesn't match a known player.",
      tone: 'error',
    });
  }

  const sessions = gameScores.sessionsWithScoresForPlayer(player.id);
  const allRows = gameScores.scoreRowsForPlayer(player.id);
  const rowsBySession = new Map();
  for (const r of allRows) {
    if (!rowsBySession.has(r.session_id)) rowsBySession.set(r.session_id, []);
    rowsBySession.get(r.session_id).push(r);
  }

  // lockAt is a UTC instant (see gameScores.js's lockInfo) — converted to
  // this app's configured timezone before handing to the view, same
  // utcToZonedParts -> fmtDate/fmtTime chain admin.js's subHistory display
  // already uses for other stored UTC timestamps, so "editable until ..."
  // reads in Kyle's own local time rather than raw UTC.
  const tz = getTimezone();
  const sessionCards = sessions.map((session) => {
    const rows = (rowsBySession.get(session.id) || []).map((r) => {
      const info = gameScores.lockInfo(r);
      const lockAtParts = info.lockAt ? utcToZonedParts(info.lockAt, tz) : null;
      return {
        assignment: r,
        canEdit: gameScores.canPlayerEdit(r),
        alreadyEntered: r.games_won !== null,
        lockAtDate: lockAtParts ? lockAtParts.date : null,
        lockAtTime: lockAtParts ? lockAtParts.time : null,
      };
    });
    return { session, rows };
  });

  res.render('scores', {
    title: 'Enter Scores',
    player,
    sessionCards,
    saved: req.query.saved === '1',
    errorCode: req.query.error || null,
    maxGames: gameScores.MAX_GAMES,
  });
});

router.post('/scores/:idOrSlug', scoreEntryLimiter, (req, res) => {
  const raw = req.params.idOrSlug;
  let player = db.prepare('SELECT * FROM players WHERE slug = ?').get(raw);
  if (!player && /^\d+$/.test(raw)) {
    player = db.prepare('SELECT * FROM players WHERE id = ?').get(Number(raw));
  }
  if (!player) {
    return res.render('message', {
      title: 'Enter Scores',
      heading: 'Player not found',
      body: "This link doesn't match a known player.",
      tone: 'error',
    });
  }

  try {
    const { row, wasFirstEntry } = gameScores.setGameScore({
      assignmentId: Number(req.body.assignment_id),
      gamesWon: req.body.games_won,
      playerId: player.id,
    });
    const week = db.prepare('SELECT match_date FROM weeks WHERE id = ?').get(row.week_id);
    // Admin-facing Activity Log entry (Kyle, 2026-09-09) — same pattern as
    // every other self-service action (blackout.self_report,
    // player.confirm, sub.*): a searchable breadcrumb of what players did to
    // their own record, not just what admins did.
    logPlayerActivity({
      playerName: fullName(player),
      action: wasFirstEntry ? 'score.enter' : 'score.update',
      description: `${fullName(player)} ${wasFirstEntry ? 'entered' : 'updated'} their games won for ${week ? week.match_date : `week #${row.week_id}`} to ${row.games_won}`,
      sessionId: row.session_id,
    });
    return res.redirect(`/scores/${raw}?saved=1`);
  } catch (err) {
    if (err instanceof gameScores.ScoreError) {
      return res.redirect(`/scores/${raw}?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
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
    let assignments = db
      .prepare(
        `SELECT wa.*, p.name FROM week_assignments wa JOIN players p ON p.id = wa.player_id
         WHERE wa.week_id = ? ORDER BY wa.court, wa.team`
      )
      .all(w.id);
    assignments = orderAssignmentsWithSubGroups(assignments, (p) => p.name);
    stampDoubleBookings(assignments, w.match_date, dbMap);
    const ballDuty = w.ball_duty_player_id
      ? db.prepare('SELECT name FROM players WHERE id = ?').get(w.ball_duty_player_id)
      : null;
    return { week: w, assignments, ballDutyName: ballDuty ? ballDuty.name : null, weather: weather.getCachedWeather(w.id) };
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

  // Kyle, 2026-08-31: "is there a way we can have a checkbox under 'your
  // name' drop down that shows ALL blackout dates for that player?" —
  // myBlackoutDatesList above is scoped to this session's own weeks (plus
  // anything carried over onto one of those specific dates); a player
  // enrolled in several sessions may have real blackout_dates rows tied to a
  // date that isn't one of *this* session's weeks at all, so it'd never show
  // up there. A blackout date is one universal fact per player+date
  // regardless of which session it was entered under (see "Blackout date
  // carryover across sessions" in CLAUDE.md), so this is a plain, no-join
  // query — every date on record for this player, full stop — gated behind
  // an opt-in checkbox rather than always shown, since most players only
  // care about the current session's dates.
  let allBlackoutDatesList = null;
  if (selectedPlayerId && req.query.showAll === '1') {
    allBlackoutDatesList = db
      .prepare('SELECT DISTINCT date FROM blackout_dates WHERE player_id = ? ORDER BY date')
      .all(selectedPlayerId)
      .map((r) => r.date);
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
    allBlackoutDatesList,
    showAll: req.query.showAll === '1',
    schedulingLocked: session.status !== 'draft',
    saved: req.query.saved === '1',
    locked: req.query.locked === '1',
  });
});

router.post('/blackout', blackoutLimiter, asyncHandler(async (req, res) => {
  // Honeypot check first, before any DB work — same pattern as
  // /request-sub/start and /swap/start (see honeypot.js). A bot that filled
  // in the hidden field lands on the exact same "saved" redirect a real
  // submission would (built from its own raw, unvalidated session_id/
  // player_id), so there's no visible difference to react to, and nothing
  // is actually read or written.
  if (honeypot.isBot(req)) {
    return res.redirect(`/blackout?session=${Number(req.body.session_id) || ''}&player=${Number(req.body.player_id) || ''}&saved=1`);
  }
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

  // Activity log (Kyle, 2026-09-09: searchable breadcrumb of player
  // actions) — only reached once the transaction above has actually
  // committed, never on the honeypot/locked/invalid-input early returns
  // above. Names the resulting date count rather than the full list (which
  // can run long over a season) — the per-player self-report table already
  // on /admin/blackouts and this session's own blackouts.ejs page is where
  // an admin goes to see the actual dates.
  logPlayerActivity({
    playerName: fullName(player),
    action: 'blackout.self_report',
    description: selectedDates.length
      ? `${fullName(player)} set ${selectedDates.length} blackout date${selectedDates.length === 1 ? '' : 's'} for themselves`
      : `${fullName(player)} cleared all their own blackout dates`,
    sessionId: session.id,
  });

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
      `SELECT wa.*, p.name, p.email, p.slug, p.full_name FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = wa.player_id
       WHERE wa.id = ? AND w.locked = 0 AND wa.status IN ('scheduled', 'confirmed')`
    )
    .get(assignmentId);
  if (!assignment) return res.redirect('/request-sub');

  const week = subFlow.getWeekWithSession(assignment.week_id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  const raw = tokenStore.issueToken(assignment.id);
  // full_name included (Kyle, 2026-09-07) — this verification email is a
  // trusted-system email, so email.js's sendSubRequestVerification() greets
  // by full name, not the public short form.
  await email.sendSubRequestVerification({
    player: { name: assignment.name, full_name: assignment.full_name, email: assignment.email },
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

/**
 * My-Page-initiated entry point for "I found a sub" (Kyle, 2026-09-07,
 * point 2) — same bot-protection shape as /request-sub/start above (My Page
 * has no login, so nothing here proves the browser belongs to the named
 * player): honeypot check first, then mint a fresh token and email a
 * verification link to that player's own address on file. Only clicking
 * through from that email actually opens the /found-sub/:token candidate
 * picker. The reminder/follow-up email's own "I found a sub" button skips
 * this gate entirely, since that link already reused a token that was
 * itself emailed to the right inbox.
 */
router.post('/found-sub/start', foundSubStartLimiter, asyncHandler(async (req, res) => {
  if (honeypot.isBot(req)) {
    return res.render('message', {
      title: 'I found a sub',
      heading: 'Check your email',
      body: "If that was a valid request, we've sent a confirmation link to the email on file. Nothing has changed yet.",
      tone: 'ok',
    });
  }
  const assignmentId = Number(req.body.assignment_id);
  const assignment = db
    .prepare(
      `SELECT wa.*, p.name, p.email, p.slug, p.full_name FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = wa.player_id
       WHERE wa.id = ? AND w.locked = 0 AND wa.status IN ('scheduled', 'confirmed')`
    )
    .get(assignmentId);
  if (!assignment) return res.redirect('/me');

  const week = subFlow.getWeekWithSession(assignment.week_id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  const raw = tokenStore.issueToken(assignment.id);
  // full_name included (Kyle, 2026-09-07) — same reasoning as the sub-request
  // verification email above: a trusted-system email, so greet by full name.
  await email.sendFoundSubVerification({
    player: { name: assignment.name, full_name: assignment.full_name, email: assignment.email },
    week,
    session,
    foundSubToken: raw,
  });

  res.render('message', {
    title: 'I found a sub',
    heading: 'Check your email',
    body: `We've sent a confirmation link to the email on file for ${assignment.name} — click it to pick who's covering this week. Nothing has changed yet.`,
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
    sessionId: initiatorCtx.session.id,
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
    sessionId: initiatorCtx && initiatorCtx.session.id,
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
      sessionId: result.sessionId,
    });
  }
  if (!result.accepted) {
    return res.render('message', {
      title: 'Swap a Week',
      heading: 'Swap declined',
      body: "You've declined the swap. Nothing changed for you — the other player has been notified.",
      tone: 'ok',
      myPageId: result.respondingPlayerId,
      sessionId: result.sessionId,
    });
  }
  res.render('message', {
    title: 'Swap a Week',
    heading: "Swap confirmed!",
    body: "You're all set — both of you have been emailed the details, and My Page has your updated schedule.",
    tone: 'ok',
    myPageId: result.respondingPlayerId,
    sessionId: result.sessionId,
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

  // Kyle, 2026-09-07: the "Back to schedule" button on this result page used
  // to always land on /schedule with no session selected, so a player in
  // more than one session had to re-pick which one they'd just confirmed
  // for. week.session_id (from the assignment's own week) lets us link
  // straight to /schedule?session=<id> instead, landing them right on the
  // week they just acted on.
  const week = subFlow.getWeekWithSession(assignment.week_id);
  const sessionId = week ? week.session_id : null;

  db.prepare("UPDATE week_assignments SET token_used_at = datetime('now') WHERE id = ?").run(assignment.id);

  if (assignment.status === 'confirmed') {
    return res.render('message', { title: 'Confirm', heading: "You're already confirmed", body: 'No action needed — see you on the court!', tone: 'ok', myPageId: assignment.slug || assignment.player_id, sessionId });
  }
  if (assignment.status === 'subbed_out') {
    return res.render('message', { title: 'Confirm', heading: 'Already subbed out', body: 'A substitute already took this slot.', tone: 'error', myPageId: assignment.slug || assignment.player_id, sessionId });
  }
  if (assignment.status === 'needs_sub') {
    return res.render('message', { title: 'Confirm', heading: 'Sub already requested', body: "You've already requested a sub for this week. Contact the admin if you'd like to undo that.", tone: 'error', myPageId: assignment.slug || assignment.player_id, sessionId });
  }

  db.prepare("UPDATE week_assignments SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?").run(assignment.id);

  // Activity log — player self-service "I'm playing" confirm (Kyle,
  // 2026-09-09: searchable breadcrumb of player actions in the same
  // Activity Log as admin actions). Only fires on an actual status change,
  // not the already-confirmed no-op above. Admin-facing, full name.
  logPlayerActivity({
    playerName: fullName(assignment),
    action: 'player.confirm',
    description: `${fullName(assignment)} confirmed they're playing ${week ? week.match_date : ''}`,
    sessionId,
  });

  res.render('message', { title: 'Confirm', heading: "You're confirmed!", body: 'Thanks — see you on the court.', tone: 'ok', myPageId: assignment.slug || assignment.player_id, sessionId });
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

  // Same reasoning as POST /confirm/:token above (Kyle, 2026-09-07): send
  // the player back to their own session/week instead of a bare /schedule.
  const week = subFlow.getWeekWithSession(assignment.week_id);
  const sessionId = week ? week.session_id : null;

  db.prepare("UPDATE week_assignments SET token_used_at = datetime('now') WHERE id = ?").run(assignment.id);

  if (assignment.status === 'subbed_out') {
    return res.render('message', { title: 'Need a sub', heading: 'Already subbed out', body: 'A substitute has already taken this slot.', tone: 'error', myPageId: assignment.slug || assignment.player_id, sessionId });
  }
  if (assignment.status === 'needs_sub') {
    return res.render('message', { title: 'Need a sub', heading: 'Already requested', body: 'A sub request is already out for this week — no need to do anything else.', tone: 'ok', myPageId: assignment.slug || assignment.player_id, sessionId });
  }

  const result = await subFlow.createSubRequest(assignment.id);
  if (result.blocked) {
    return res.render('message', {
      title: 'Need a sub',
      heading: 'Please contact the admin',
      body: 'Another player already needs a sub for this same week. To keep things simple, the admin will sort out multiple sub requests in the same week manually — reach out directly.',
      tone: 'error',
      myPageId: assignment.slug || assignment.player_id,
      sessionId,
    });
  }
  res.render('message', {
    title: 'Need a sub',
    heading: 'Sub request sent',
    body: `An email went out to the ${result.offerCount} other player(s) not already playing that week. First to confirm gets the spot.`,
    tone: 'ok',
    myPageId: assignment.slug || assignment.player_id,
    sessionId,
  });
}));

/**
 * "I found a sub" (Kyle, 2026-09-07): a player who's already coordinated a
 * sub outside the app tells the system who it is, instead of the system
 * fanning out to a whole candidate pool and waiting for a claim. This token
 * is the exact same one already minted for Confirm/Need-a-sub in that same
 * reminder/follow-up email (see cron.js) — tokenStore.findAssignmentByToken()
 * doesn't care which route a token was used on, only which assignment it
 * points to — so this needs no new token type of its own. The My-Page
 * entry point (`POST /found-sub/start`, below) mints its own fresh token via
 * the same tokenStore, gated behind an email-verification step first, since
 * unlike the reminder email's link, nothing there already proves the
 * browser belongs to the named player.
 */
router.get('/found-sub/:token', (req, res) => {
  const assignment = tokenStore.findAssignmentByToken(req.params.token);
  if (!assignment) return res.render('message', { title: 'I found a sub', heading: 'Link not found', body: 'This link is invalid or has expired.', tone: 'error' });
  const week = subFlow.getWeekWithSession(assignment.week_id);
  const sessionId = week ? week.session_id : null;

  if (assignment.status === 'subbed_out') {
    return res.render('message', { title: 'I found a sub', heading: 'Already subbed out', body: 'A substitute has already taken this slot.', tone: 'error', myPageId: assignment.slug || assignment.player_id, sessionId });
  }
  if (assignment.status === 'needs_sub') {
    return res.render('message', { title: 'I found a sub', heading: 'Already requested', body: 'A sub request is already out for this week — no need to do anything else.', tone: 'ok', myPageId: assignment.slug || assignment.player_id, sessionId });
  }

  const candidates = subFlow.eligibleSelfArrangedCandidates(week.id);
  res.render('found_sub', { title: 'I found a sub', assignment, week, token: req.params.token, candidates });
});

router.post('/found-sub/:token', asyncHandler(async (req, res) => {
  const assignment = tokenStore.findAssignmentByToken(req.params.token);
  if (!assignment) return res.render('message', { title: 'I found a sub', heading: 'Link not found', body: 'This link is invalid or has expired.', tone: 'error' });

  // Same reasoning as POST /confirm/:token and /need-sub/:token above
  // (Kyle, 2026-09-07): send the player back to their own session/week
  // instead of a bare /schedule.
  const week = subFlow.getWeekWithSession(assignment.week_id);
  const sessionId = week ? week.session_id : null;

  db.prepare("UPDATE week_assignments SET token_used_at = datetime('now') WHERE id = ?").run(assignment.id);

  if (assignment.status === 'subbed_out') {
    return res.render('message', { title: 'I found a sub', heading: 'Already subbed out', body: 'A substitute has already taken this slot.', tone: 'error', myPageId: assignment.slug || assignment.player_id, sessionId });
  }
  if (assignment.status === 'needs_sub') {
    return res.render('message', { title: 'I found a sub', heading: 'Already requested', body: 'A sub request is already out for this week — no need to do anything else.', tone: 'ok', myPageId: assignment.slug || assignment.player_id, sessionId });
  }

  const candidateKey = String(req.body.candidate_key || '').trim();
  const newName = String(req.body.new_name || '').trim();
  const newEmail = String(req.body.new_email || '').trim();

  let selection;
  if (newName || newEmail) {
    selection = { newPerson: { name: newName, email: newEmail } };
  } else if (candidateKey) {
    selection = { candidateKey };
  } else {
    return res.render('message', {
      title: 'I found a sub',
      heading: 'Pick someone',
      body: "Choose a name from the list, or enter a new person's name and email.",
      tone: 'error',
      myPageId: assignment.slug || assignment.player_id,
      sessionId,
    });
  }

  const result = await subFlow.arrangeSelfSub(assignment.id, selection);

  if (!result.ok) {
    const messages = {
      locked: "This week's schedule is locked — contact the admin directly.",
      concurrent: 'Another player already needs a sub for this same week. To keep things simple, the admin will sort out multiple sub requests in the same week manually — reach out directly.',
      invalid_new_person: 'Enter a valid name and email address for the new person.',
      invalid_candidate: 'That pick is no longer available — they may have been scheduled elsewhere since this page loaded. Please go back and try again.',
      self: "You can't name yourself as your own sub.",
      no_selection: "Choose a name from the list, or enter a new person's name and email.",
      not_found: 'This link is invalid or has expired.',
    };
    return res.render('message', {
      title: 'I found a sub',
      heading: 'Could not complete this',
      body: messages[result.reason] || 'Something went wrong — please try again or contact the admin.',
      tone: 'error',
      myPageId: assignment.slug || assignment.player_id,
      sessionId,
    });
  }

  res.render('message', {
    title: 'I found a sub',
    heading: 'Sub request sent',
    body: `We've emailed ${result.candidate.name} asking them to confirm they're covering for you. You'll get a separate email once they do — if they haven't confirmed within 24 hours of the match, this automatically opens up to the regular sub list, same as any other sub request.`,
    tone: 'ok',
    myPageId: assignment.slug || assignment.player_id,
    sessionId,
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

  // sessionsForPlayer() (sessionHelper.js) covers both roster enrollment
  // *and* any session a sub currently has a real upcoming assignment in
  // without ever being on that session's own roster — see its doc comment
  // (Kyle, 2026-09-07: Derek's confirmed sub slot was invisible here before
  // this fix, since he was never added to session_players).
  const sessions = sessionsForPlayer(playerId, todayIso);

  // Every real blackout_dates row on record for this player, regardless of
  // which session's page it was originally entered from — blackout dates are
  // a universal fact per (player, date), not owned by one session (see
  // "Blackout date carryover across sessions" in CLAUDE.md). Matched against
  // each session's own weeks.match_date below, so a date only ever shows
  // above a session whose schedule actually includes that calendar date —
  // this is what makes "a Monday blackout shows above a Monday session"
  // true without any day-of-week guesswork: weeks.match_date already *is*
  // the session's real matched dates.
  const allBlackoutDates = new Set(
    db.prepare('SELECT date FROM blackout_dates WHERE player_id = ?').all(playerId).map((r) => r.date)
  );

  const sessionCards = sessions.map((session) => {
    // Kyle, 2026-09-08: "Do the sub indents show up on 'my page' also?" —
    // they didn't; this page never reused orderAssignmentsWithSubGroups()
    // since it's shaped differently (one row for the viewer themselves,
    // plus a separate `others` list) rather than a single team/court table.
    // Same underlying fact either way (a sub row's `replaces_assignment_id`
    // names the row it took over), so both queries below join it in
    // directly rather than pulling in the whole helper: `replaces_name` is
    // the replaced player's short public name (never the full name — this
    // is an unauthenticated page), null on a normal, non-sub row.
    // Kyle, 2026-09-08: "if someone subs out a week, does that week drop
    // off their 'my page'? ... Is that by design?" It wasn't a deliberate
    // choice — `wa.status != 'subbed_out'` here simply excluded the row
    // outright, same as everywhere else in the app subbed_out rows get
    // filtered, but nobody had asked "should the original player still see
    // it" until now. His pick: keep it visible with a note naming who took
    // over, not hide it. So subbed_out rows are no longer excluded here —
    // `replaced_by_name` (via the real `replaces_assignment_id` link,
    // wherever a sub action set one) tells the view who to credit. A
    // legacy subbed_out row from before that column existed has no such
    // link, so a same-week/same-team/same-court fallback below fills in
    // `replaced_by_name` too, but only when there's exactly one unmatched
    // sub candidate — same ambiguity guard `orderAssignmentsWithSubGroups()`
    // uses, rather than risk naming the wrong person.
    const upcoming = db
      .prepare(
        `SELECT wa.*, w.match_date, w.locked, rp.name AS replaces_name, sp.name AS replaced_by_name
         FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id
         LEFT JOIN week_assignments rwa ON rwa.id = wa.replaces_assignment_id
         LEFT JOIN players rp ON rp.id = rwa.player_id
         LEFT JOIN week_assignments swa ON swa.replaces_assignment_id = wa.id
         LEFT JOIN players sp ON sp.id = swa.player_id
         WHERE wa.player_id = ? AND w.session_id = ? AND w.match_date >= ?
         ORDER BY w.match_date`
      )
      .all(playerId, session.id, todayIso);
    const dbMap = doubleBookingMapForSession(session.id);
    upcoming.forEach((a) => {
      const other = dbMap.get(`${a.player_id}|${a.match_date}`);
      if (other) a.doubleBooked = other;

      if (a.status === 'subbed_out' && !a.replaced_by_name) {
        const candidates = db
          .prepare(
            `SELECT p.name FROM week_assignments wa2 JOIN players p ON p.id = wa2.player_id
             WHERE wa2.week_id = ? AND wa2.team = ? AND wa2.court = ? AND wa2.is_sub = 1
               AND wa2.replaces_assignment_id IS NULL AND wa2.id != ?`
          )
          .all(a.week_id, a.team, a.court, a.id);
        if (candidates.length === 1) a.replaced_by_name = candidates[0].name;
      }

      // Mirror of the replaced_by_name fallback just above, for the other
      // direction (Kyle, 2026-09-09: Ed B's own "My Page" wasn't showing
      // "Subbing for Jon D" under his confirmed (sub) badge, even though the
      // reverse — Jon D's page correctly saying Ed B found/is now playing —
      // worked fine). An is_sub row with no real replaces_assignment_id link
      // (a legacy row, or a creation path — e.g. hand-seeded data — that
      // never set one) otherwise has no way to name who it replaced. Same
      // team/court guess as above, plus one more exclusion the reverse
      // direction gets for free from its own `replaces_assignment_id IS
      // NULL` filter: a subbed_out row already claimed by some *other* row's
      // real link (e.g. Erik T's row, already linked from Jim N's) must not
      // also count as a candidate here, or two subbed-out players on the
      // same team/court (Erik T *and* Jon D, both team B court 1 that week)
      // makes this ambiguous when it isn't — Jon D is the only one actually
      // still unclaimed. Same single-remaining-candidate ambiguity guard as
      // above otherwise.
      if (a.is_sub && !a.replaces_name) {
        const candidates = db
          .prepare(
            `SELECT p.name FROM week_assignments wa2 JOIN players p ON p.id = wa2.player_id
             WHERE wa2.week_id = ? AND wa2.team = ? AND wa2.court = ? AND wa2.status = 'subbed_out' AND wa2.id != ?
               AND NOT EXISTS (SELECT 1 FROM week_assignments wa3 WHERE wa3.replaces_assignment_id = wa2.id)`
          )
          .all(a.week_id, a.team, a.court, a.id);
        if (candidates.length === 1) a.replaces_name = candidates[0].name;
      }

      // Kyle, 2026-09-07: "is there a way to display who else is playing
      // that week and their status so when looking at 'my page', you can
      // see the other players and their current status?" Public name only
      // (this is an unauthenticated page) and excludes subbed_out rows —
      // that slot's real occupant is whoever replaced them, already its own
      // row in this same query. Nothing new here privacy-wise: /schedule
      // and /lookahead already show every player's name and status for
      // every week publicly; this is the same information, just surfaced
      // on the page a player actually has bookmarked.
      a.others = db
        .prepare(
          `SELECT p.name, wa.status, wa.is_sub, wa.team, wa.court, rp.name AS replaces_name
           FROM week_assignments wa JOIN players p ON p.id = wa.player_id
           LEFT JOIN week_assignments rwa ON rwa.id = wa.replaces_assignment_id
           LEFT JOIN players rp ON rp.id = rwa.player_id
           WHERE wa.week_id = ? AND wa.player_id != ? AND wa.status != 'subbed_out'
           ORDER BY p.name`
        )
        .all(a.week_id, playerId);

      // Same fallback as above, applied per row in the "also playing" list —
      // an other player's own is_sub row can be missing the real link just
      // as easily as the viewer's own row can (this was in fact the exact
      // case Kyle flagged: Ed B showed up unindented, with no "subbing for
      // Jon D" note, in Jim N's and Erik T's "Also playing this week" list).
      // Same already-claimed exclusion as the fallback above, for the same
      // reason (two subbed-out players on one team/court otherwise reads as
      // ambiguous when only one of them is actually still unlinked).
      a.others.forEach((o) => {
        if (o.is_sub && !o.replaces_name) {
          const candidates = db
            .prepare(
              `SELECT p.name FROM week_assignments wa2 JOIN players p ON p.id = wa2.player_id
               WHERE wa2.week_id = ? AND wa2.team = ? AND wa2.court = ? AND wa2.status = 'subbed_out'
                 AND NOT EXISTS (SELECT 1 FROM week_assignments wa3 WHERE wa3.replaces_assignment_id = wa2.id)`
            )
            .all(a.week_id, o.team, o.court);
          if (candidates.length === 1) o.replaces_name = candidates[0].name;
        }
      });
    });

    const ballDutyWeeks = db
      .prepare(
        `SELECT match_date FROM weeks WHERE session_id = ? AND ball_duty_player_id = ? AND match_date >= ?
         ORDER BY match_date`
      )
      .all(session.id, playerId, todayIso);
    const ballDutyDates = new Set(ballDutyWeeks.map((w) => w.match_date));

    // Upcoming blackout dates for this specific session: this session's own
    // remaining match dates, intersected with the player's universal
    // blackout set above. Only upcoming (>= today), matching the "upcoming
    // matches" table this sits next to — a past blackout date isn't
    // actionable information anymore.
    const upcomingSessionDates = db
      .prepare('SELECT match_date FROM weeks WHERE session_id = ? AND match_date >= ? ORDER BY match_date')
      .all(session.id, todayIso)
      .map((w) => w.match_date);
    const blackoutDates = upcomingSessionDates.filter((d) => allBlackoutDates.has(d));

    // Season-long stats for this session — same fields and same underlying
    // definitions as the reworked admin/public Stats pages (admin.js's GET
    // /sessions/:id/stats and GET /stats, public.js's own GET /stats, all
    // fed by sessionHelper.js's sessionRosterStats()), just scoped to this
    // one player via direct queries rather than computing the whole
    // session's roster and looking one row up. Kyle, 2026-09-09: "My page
    // needs to have some additional player stats under the full session
    // name" — expanded from target/played/ball-duty to the full six-field
    // set (target, scheduled, subbed out, played, sub bonus games, ball
    // duty) to match. "Scheduled" and "subbedOut" both key off is_sub = 0
    // (a player's own original slot, not a game they picked up as a sub) —
    // see sessionRosterStats()'s own doc comment for why "scheduled" never
    // changes once a week locks. Deliberately still no partner matrix here,
    // per Kyle (2026-08-28) — this is meant to be a quick glance, not a
    // repeat of the full admin Stats page.
    const sp = db
      .prepare('SELECT target_games, original_target FROM session_players WHERE session_id = ? AND player_id = ?')
      .get(session.id, playerId);
    const scheduledCount = db
      .prepare(
        `SELECT COUNT(*) as n FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id
         WHERE w.session_id = ? AND wa.player_id = ? AND wa.is_sub = 0`
      )
      .get(session.id, playerId).n;
    const subbedOutCount = db
      .prepare(
        `SELECT COUNT(*) as n FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id
         WHERE w.session_id = ? AND wa.player_id = ? AND wa.is_sub = 0 AND wa.status = 'subbed_out'`
      )
      .get(session.id, playerId).n;
    // Played/subBonus (Kyle, 2026-09-09, same day: "played should be how
    // many they actually played. So as the week locks and they are
    // confirmed, that counts as 'played'") — a plain 'scheduled' row never
    // counts, whether the match hasn't happened yet or the player simply
    // never clicked Confirm; only genuinely confirmed-and-locked rows do.
    // Matches sessionRosterStats()'s identical fix in sessionHelper.js.
    const played = db
      .prepare(
        `SELECT COUNT(*) as n FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id
         WHERE w.session_id = ? AND wa.player_id = ? AND wa.is_sub = 0 AND wa.status = 'confirmed' AND w.locked = 1`
      )
      .get(session.id, playerId).n;
    const subBonusCount = db
      .prepare(
        `SELECT COUNT(*) as n FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id
         WHERE w.session_id = ? AND wa.player_id = ? AND wa.is_sub = 1 AND wa.status = 'confirmed' AND w.locked = 1`
      )
      .get(session.id, playerId).n;
    const ballDutyCount = db
      .prepare('SELECT COUNT(*) as n FROM weeks WHERE session_id = ? AND ball_duty_player_id = ?')
      .get(session.id, playerId).n;
    const stats = {
      target: (sp && sp.target_games) || 0,
      originalTarget: sp ? sp.original_target : null,
      scheduled: scheduledCount,
      subbedOut: subbedOutCount,
      played,
      subBonus: subBonusCount,
      ballDuty: ballDutyCount,
    };

    return { session, upcoming, ballDutyDates, blackoutDates, stats };
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
       ${SESSION_DISPLAY_ORDER}`
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
  res.render('message', { title: 'Claim sub', heading: "You're in!", body: `Thanks for subbing in for ${email.fmtDate(result.week.match_date)}. The rest of the group has been notified.`, tone: 'ok', myPageId: result.subPlayer.slug || result.subPlayer.id, sessionId: result.week.session_id });
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
