'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../middleware/adminAuth');
const { findAdminByCredentials, hashPassword } = require('../services/auth');
const { USERNAME_RE, usernameTaken, generateUniqueUsername } = require('../services/adminUsername');
const { getTimezone, setTimezone, getSiteTitle, setSiteTitle } = require('../services/settings');
const { zonedTimeToUtc, utcToZonedParts } = require('../services/tz');
const { runScheduler, ensureWeeksExist } = require('../services/scheduleRun');
const adhocFlow = require('../services/adhocFlow');
const { generateRawToken, hashToken } = require('../services/tokens');
const tokenStore = require('../services/tokenStore');
const email = require('../services/email');
const subFlow = require('../services/subFlow');
const adminReport = require('../services/adminReport');
const cron = require('../services/cron');
const backup = require('../services/backup');
const offsiteBackup = require('../services/offsiteBackup');
const statusPage = require('../services/statusPage');
const { findOverlappingSessionEnrollments, findActualDoubleBookings, doubleBookingMapForSession, carriedOverBlackoutsForSession, getBlackoutViewableSessions, sessionRosterStats, SESSION_DISPLAY_ORDER } = require('../services/sessionHelper');
const { logActivity } = require('../services/activityLog');
const swapFlow = require('../services/swapFlow');
const { SLUG_RE, slugTaken, generateUniqueSlug, broaderSubSlugTaken, generateUniqueBroaderSubSlug } = require('../services/playerSlug');
const { asyncHandler } = require('../middleware/asyncHandler');
const jointSolver = require('../services/jointSolver');
const testEmail = require('../services/testEmail');
const { rateLimiter } = require('../middleware/rateLimiter');

// Pre-launch security review (Kyle, 2026-08-29): POST /admin/login had no
// abuse protection at all — bcrypt slows an individual guess but does
// nothing against a patient or distributed attacker, and it's the single
// highest-value target on the whole site since it's reachable straight off
// the public Cloudflare Tunnel URL with no token gating anything else does.
// Reuses the same hand-rolled limiter already proven out on /request-sub/start
// and /swap/start (see rateLimiter.js, CLAUDE.md's "Rate limiting" section) —
// tighter than those two (8/15min vs. 10/hour) since this route has no
// legitimate reason to be hit anywhere near that often by a real admin
// fat-fingering their password a few times.
const adminLoginLimiter = rateLimiter({ name: 'admin-login', windowMs: 15 * 60 * 1000, max: 8 });

// Turns findOverlappingSessionEnrollments() rows scoped to one session into a
// human-readable sentence for a flash message — e.g. "Heads up: Kyle is also
// enrolled in 'Second Half' (Wed 5:30 PM, overlapping dates)." Grouped by
// player so one player showing up against multiple other sessions doesn't
// produce a repeated near-duplicate sentence per pair.
// Priority is advisory only (see scheduleRun.js's doc comment — the
// scheduler never auto-excludes anyone based on it, reverted 2026-08-11), so
// this warning fires and reads the same regardless of whether priority is
// set: the point is just "these two could end up double-booked, here's who
// you've indicated should probably yield if it happens."
function overlapWarningText(sessionId) {
  const rows = findOverlappingSessionEnrollments(sessionId);
  if (rows.length === 0) return null;
  const byPlayer = new Map();
  for (const r of rows) {
    const other = r.sessionA.id === Number(sessionId) ? r.sessionB : r.sessionA;
    const thisWins = r.resolution === 'a_wins' ? r.sessionA.id === Number(sessionId) : r.resolution === 'b_wins' ? r.sessionB.id === Number(sessionId) : null;
    let status;
    if (r.resolution === 'unresolved') status = 'no priority set';
    else if (r.resolution === 'tied') status = 'priority tied';
    else status = thisWins ? 'this session set as higher priority' : `${other.name} set as higher priority`;
    if (!byPlayer.has(r.player.id)) byPlayer.set(r.player.id, { name: r.player.name, others: [] });
    byPlayer.get(r.player.id).others.push(`${other.name}, ${status}`);
  }
  const parts = [...byPlayer.values()].map((p) => `${p.name} (also in ${[...new Set(p.others)].join('; ')})`);
  return `Heads up: ${parts.length} player(s) are enrolled in another session on the same day of week with overlapping dates — nothing prevents the scheduler from double-booking them automatically, so check the schedule once both are generated: ${parts.join('; ')}.`;
}

// sessionRosterStats() (per-player target/played/sub-bonus/ball-duty
// breakdown) now lives in sessionHelper.js, shared by the per-session Stats
// page, the all-active-sessions Stats Summary page, and (as of 2026-09-05)
// the public player-stats page in public.js — see that file's doc comment.

function flash(req, message, type = 'ok') {
  req.session.flash = { message, type };
}
function popFlash(req) {
  const f = req.session.flash;
  delete req.session.flash;
  return f;
}

// --- Auth -------------------------------------------------------------

router.get('/login', (req, res) => {
  res.render('admin/login', { title: 'Admin Login', error: null });
});

router.post('/login', adminLoginLimiter, (req, res) => {
  const admin = findAdminByCredentials(req.body.username, req.body.password);
  if (admin) {
    // Regenerate the session ID on a successful login rather than reusing
    // whatever session (if any) the browser already had — standard defense
    // against session fixation (an attacker planting a known session ID in
    // a victim's browser ahead of time, then reusing it themselves once the
    // victim logs in). regenerate() gives a fresh ID; the admin fields are
    // set on the new session inside the callback since regenerate() replaces
    // req.session with a new, empty one.
    return req.session.regenerate((err) => {
      if (err) {
        return res.render('admin/login', { title: 'Admin Login', error: 'Login failed — please try again.' });
      }
      req.session.isAdmin = true;
      req.session.adminId = admin.id;
      req.session.adminName = admin.name;
      // Logged via the normal logActivity() (not logSystemActivity()) since
      // req.session.adminId/adminName are already set above — a login is
      // always attributable to a specific admin, unlike the cron-triggered
      // backup scripts logSystemActivity() exists for. Attributing it to
      // "System (automatic)" would throw away the one thing worth knowing:
      // which admin actually logged in.
      logActivity(req, { action: 'admin.login', description: `${admin.name} (${admin.username}) logged in` });
      res.redirect('/admin');
    });
  }
  res.render('admin/login', { title: 'Admin Login', error: 'Incorrect username or password.' });
});

router.post('/logout', (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin/login');
});

router.use(requireAdmin);

// --- Dashboard ----------------------------------------------------------

router.get('/', (req, res) => {
  const sessions = db.prepare(`SELECT * FROM sessions WHERE archived_at IS NULL AND session_type = 'regular' ${SESSION_DISPLAY_ORDER}`).all();
  // Ad-hoc sessions have none of the flags below (no targets, no blackout,
  // no confirm/sub flow) — a simpler, separate section instead of trying to
  // force them through the same flags shape. See "Ad-hoc sessions" in
  // CLAUDE.md.
  const adhocSessions = db
    .prepare(`SELECT * FROM sessions WHERE archived_at IS NULL AND session_type = 'adhoc' ${SESSION_DISPLAY_ORDER}`)
    .all()
    .map((s) => {
      const upcomingWeeks = db
        .prepare(`SELECT * FROM weeks WHERE session_id = ? AND locked = 0 AND match_date >= date('now') ORDER BY match_date LIMIT 4`)
        .all(s.id);
      const weekSummaries = upcomingWeeks.map((w) => {
        const groups = adhocFlow.courtGroupsForWeek(w.id);
        const finalized = db.prepare('SELECT COUNT(*) as n FROM week_assignments WHERE week_id = ?').get(w.id).n > 0;
        return { week: w, courts: groups.courts.length, waiting: groups.waiting.length, finalized };
      });
      return { session: s, weekSummaries };
    });
  // Archived sessions aren't deleted — just hidden from the main list above.
  // Shown in their own muted section at the bottom so they're still findable
  // (to view stats/history or to unarchive), without cluttering the primary
  // week-to-week view with seasons that are done.
  const archivedSessions = db
    .prepare('SELECT * FROM sessions WHERE archived_at IS NOT NULL ORDER BY archived_at DESC')
    .all();

  const flags = sessions.map((s) => {
    // Only counts as "unconfirmed" once the reminder email has actually gone
    // out for that assignment — otherwise every future week would show as
    // unconfirmed the moment the season is scheduled, long before anyone had
    // a chance to respond.
    const unconfirmed = db
      .prepare(
        `SELECT COUNT(*) as n FROM week_assignments wa
         JOIN weeks w ON w.id = wa.week_id
         JOIN players p ON p.id = wa.player_id
         WHERE w.session_id = ? AND wa.status = 'scheduled' AND w.match_date >= date('now')
           AND EXISTS (
             SELECT 1 FROM email_log el
             WHERE el.category = 'reminder' AND el.related_week_id = w.id AND el.to_email = p.email
           )`
      )
      .get(s.id).n;
    const unfilledSubs = db
      .prepare(
        `SELECT COUNT(*) as n FROM sub_requests sr JOIN week_assignments wa ON wa.id = sr.week_assignment_id
         JOIN weeks w ON w.id = wa.week_id WHERE w.session_id = ? AND sr.status IN ('open','escalated','unfilled')`
      )
      .get(s.id).n;
    // Weeks flagged needs_attention — most commonly an understaffed week the
    // scheduler auto-handled (see "Understaffed weeks" in CLAUDE.md), but
    // also covers e.g. a week whose ball duty needs reassignment after its
    // holder requested a sub (subFlow.js). Distinct from `conflicts` below:
    // conflicts means the *entire* scheduling run failed and nothing was
    // written; this means the run succeeded but a specific week still needs
    // a human. Without this, the only trace of an understaffed week on the
    // dashboard was a one-time flash message right after scheduling — gone
    // the next time anyone loads the page.
    const needsAttention = db
      .prepare(
        `SELECT COUNT(*) as n FROM weeks WHERE session_id = ? AND needs_attention = 1 AND locked = 0 AND match_date >= date('now')`
      )
      .get(s.id).n;
    // Excludes needs_attention weeks — those already get their own, more
    // specific flag above ("missing ball duty" on an understaffed week with
    // zero players is a misleading way to describe the actual problem).
    const unfilledBallDuty = db
      .prepare(
        `SELECT COUNT(*) as n FROM weeks WHERE session_id = ? AND ball_duty_player_id IS NULL AND needs_attention = 0 AND match_date >= date('now')`
      )
      .get(s.id).n;
    // ball_duty_player_id set, but pointing at someone not actually playing
    // that week anymore — invisible to unfilledBallDuty above (which only
    // catches NULL). Real bug found by Kyle 2026-09-01: a same-session swap
    // accepted from the joint conflict resolver ("Accept all suggested
    // changes") moved a player off a week that had them down for ball duty,
    // leaving the column stale — see "Ball duty left stale after a
    // joint-resolver swap" in CLAUDE.md. That resolver path now auto-hands
    // ball duty to whoever moved in, but this flag stays as a safety net for
    // any other way this could happen (a plain Reassign, a direct manual DB
    // edit, etc.) so it's never silently invisible again.
    const staleBallDuty = db
      .prepare(
        `SELECT COUNT(*) as n FROM weeks w WHERE w.session_id = ? AND w.ball_duty_player_id IS NOT NULL
         AND w.locked = 0 AND w.match_date >= date('now') AND NOT EXISTS (
           SELECT 1 FROM week_assignments wa WHERE wa.week_id = w.id AND wa.player_id = w.ball_duty_player_id
             AND wa.status IN ('scheduled','confirmed')
         )`
      )
      .get(s.id).n;
    const conflicts = s.schedule_conflicts ? JSON.parse(s.schedule_conflicts) : [];
    // Distinct players enrolled in another session on the same day of week
    // with overlapping dates (see sessionHelper.js
    // findOverlappingSessionEnrollments) — deduped by player, since the same
    // person could show up against more than one other overlapping session.
    // Counts every pair regardless of priority/resolution: priority is
    // advisory only (scheduler doesn't auto-exclude based on it — see
    // scheduleRun.js), so a "resolved" pair is exactly as much at risk of an
    // actual double-booking as an unresolved one. `findActualDoubleBookings`
    // below is the sharper, confirmed-conflict signal once both sessions are
    // actually scheduled; this is the earlier, enrollment-level heads-up.
    const overlapping = new Set(findOverlappingSessionEnrollments(s.id).map((c) => c.player.id)).size;
    // Confirmed (not just risked) cross-session double-bookings — see
    // findActualDoubleBookings' doc comment. Deduped by player since the
    // same player could theoretically show up double-booked on more than
    // one date.
    const doubleBooked = new Set(findActualDoubleBookings(s.id).map((d) => d.player.id)).size;
    // A pending direct swap that's been nudged and still hasn't gotten a
    // response (see swapFlow.js's nudgeOverdueSwaps()) — the swap equivalent
    // of unfilledSubs above. Once it either resolves or expires it drops out
    // of this count on its own (status leaves 'pending'), same self-clearing
    // pattern as every other live-computed flag here.
    const staleSwaps = db
      .prepare(
        `SELECT COUNT(*) as n FROM swap_requests sw
         JOIN week_assignments ia ON ia.id = sw.initiator_assignment_id
         JOIN weeks iw ON iw.id = ia.week_id
         WHERE iw.session_id = ? AND sw.status = 'pending' AND sw.nudged_at IS NOT NULL`
      )
      .get(s.id).n;
    return { session: s, unconfirmed, unfilledSubs, unfilledBallDuty, staleBallDuty, needsAttention, conflicts, overlapping, doubleBooked, staleSwaps };
  });

  res.render('admin/dashboard', { title: 'Admin', flags, adhocSessions, archivedSessions, flashMsg: popFlash(req) });
});

// Admin-only process walkthrough — static content, no DB queries needed. The
// player-facing equivalent (`GET /help`) deliberately has no admin content in
// it (Kyle, 2026-08-12: "admin items hidden from the players help"); rather
// than gating a single shared page on session/auth state, this just lives
// under the already-authenticated /admin section like every other admin
// page, so a player can never reach it and there's no conditional-rendering
// logic to get wrong.
router.get('/guide', (req, res) => {
  res.render('admin/guide', { title: 'Admin Guide' });
});

// Dedicated "to-do list + is this actually running" page — flattens every
// needs-attention item across all sessions into one list, and previews what
// the cron loop is about to do over the next N days (reminders, follow-ups,
// escalations, week locks) without sending anything. See statusPage.js.
router.get('/status', (req, res) => {
  const days = Number(req.query.days) || 21;
  const attention = statusPage.getAttentionItems();
  const upcoming = statusPage.getUpcomingActions(days);
  res.render('admin/status', { title: 'Status', attention, upcoming, days, flashMsg: popFlash(req) });
});

// All-active-sessions stats summary (Kyle, 2026-09-01): "if we were going to
// write a 1 page stats summary for all the active sessions, where would that
// go?" — one row per session rather than reproducing the full per-player
// target/played/ball-duty table from the per-session Stats page (that page
// already has its own per-player table plus the partner matrix; repeating
// that here for every active session's whole roster is exactly what would
// stop this from fitting on one page). Each row links into that session's
// own Stats page for the per-player detail. Regular sessions only — ad-hoc
// sessions have no target/confirm/sub/ball-duty concepts for any of these
// columns to mean anything (see "Ad-hoc sessions" in CLAUDE.md), same reason
// the per-session Stats page is never linked from an ad-hoc session's detail
// page. Scoped to scheduled/active (not draft, which has no schedule yet —
// every column would just read zero).
router.get('/stats', (req, res) => {
  const sessions = db
    .prepare(
      `SELECT * FROM sessions WHERE archived_at IS NULL AND session_type = 'regular' AND status IN ('scheduled', 'active') ${SESSION_DISPLAY_ORDER}`
    )
    .all();

  const rows = sessions.map((s) => {
    const players = db.prepare('SELECT COUNT(*) as n FROM session_players WHERE session_id = ?').get(s.id).n;
    const weeksTotal = db.prepare('SELECT COUNT(*) as n FROM weeks WHERE session_id = ?').get(s.id).n;
    const weeksPlayed = db.prepare('SELECT COUNT(*) as n FROM weeks WHERE session_id = ? AND locked = 1').get(s.id).n;

    // Confirmation status of every assignment on a week that hasn't happened
    // yet — the same "scheduled vs. confirmed" split the dashboard's
    // unconfirmed flag tracks, just the full breakdown rather than one count.
    const statusCounts = db
      .prepare(
        `SELECT wa.status, COUNT(*) as n FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id
         WHERE w.session_id = ? AND w.locked = 0 GROUP BY wa.status`
      )
      .all(s.id);
    const statusMap = new Map(statusCounts.map((r) => [r.status, r.n]));

    // Same definition as the dashboard's unfilledSubs flag.
    const openSubs = db
      .prepare(
        `SELECT COUNT(*) as n FROM sub_requests sr JOIN week_assignments wa ON wa.id = sr.week_assignment_id
         JOIN weeks w ON w.id = wa.week_id WHERE w.session_id = ? AND sr.status IN ('open','escalated','unfilled')`
      )
      .get(s.id).n;

    // Same definitions as the dashboard's unfilledBallDuty/staleBallDuty
    // flags (see "Ball duty left stale after a joint-resolver swap" in
    // CLAUDE.md for staleBallDuty) — combined into one "needs attention"
    // count here since this is a summary row, not a to-do list; either kind
    // means the same actionable thing at this level of detail.
    const missingBallDuty = db
      .prepare(
        `SELECT COUNT(*) as n FROM weeks WHERE session_id = ? AND ball_duty_player_id IS NULL AND needs_attention = 0 AND match_date >= date('now')`
      )
      .get(s.id).n;
    const staleBallDuty = db
      .prepare(
        `SELECT COUNT(*) as n FROM weeks w WHERE w.session_id = ? AND w.ball_duty_player_id IS NOT NULL
         AND w.locked = 0 AND w.match_date >= date('now') AND NOT EXISTS (
           SELECT 1 FROM week_assignments wa WHERE wa.week_id = w.id AND wa.player_id = w.ball_duty_player_id
             AND wa.status IN ('scheduled','confirmed')
         )`
      )
      .get(s.id).n;

    // Full per-player target/played/ball-duty breakdown — Kyle, 2026-09-01,
    // right after the summary table above shipped: "let's build the full
    // per-player breakdown under the summary you just built." Same
    // sessionRosterStats() helper the per-session Stats page uses, so the
    // two pages can never disagree on what "played" or "ball duty" means.
    const playerStats = sessionRosterStats(s.id);

    return {
      session: s,
      players,
      weeksTotal,
      weeksPlayed,
      confirmed: statusMap.get('confirmed') || 0,
      unconfirmed: statusMap.get('scheduled') || 0,
      needsSub: statusMap.get('needs_sub') || 0,
      openSubs,
      ballDutyIssues: missingBallDuty + staleBallDuty,
      playerStats,
    };
  });

  res.render('admin/all_stats', { title: 'Stats Summary', rows, flashMsg: popFlash(req) });
});

router.post('/sessions/:id/archive', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).send('Session not found');
  db.prepare(`UPDATE sessions SET archived_at = datetime('now') WHERE id = ?`).run(session.id);
  logActivity(req, { action: 'session.archive', description: `Archived session "${email.sessionFullTitle(session)}"`, sessionId: session.id });
  flash(req, `"${session.name}" archived — hidden from the dashboard and player-facing pages, but nothing was deleted.`);
  res.redirect('/admin');
});

router.post('/sessions/:id/unarchive', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).send('Session not found');
  db.prepare('UPDATE sessions SET archived_at = NULL WHERE id = ?').run(session.id);
  logActivity(req, { action: 'session.unarchive', description: `Restored session "${email.sessionFullTitle(session)}" from archive`, sessionId: session.id });
  flash(req, `"${session.name}" restored — visible again on the dashboard and player-facing pages.`);
  res.redirect('/admin');
});

// "Lock this schedule" (Kyle, 2026-08-13) — a deliberate, manual marker that
// the admin considers the current schedule final, distinct from the
// automatic draft -> scheduled status flip that already happens on the first
// "Schedule these players" click. Doesn't restrict any further edits (roster,
// re-scheduling, blackout dates all still work exactly the same after
// locking) — it's a timestamp and, eventually, a gate for behavior that
// should wait for a stable schedule (e.g. a deferred sub-needed
// notification), not a hard block. See "Lock this schedule" in CLAUDE.md.
router.post('/sessions/:id/lock-schedule', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).send('Session not found');
  // Ad-hoc sessions have no "Schedule these players" run to finalize — there's
  // no equivalent moment this would mark. Not shown on that session's page
  // either, but refused here too rather than relying on the UI alone.
  if (session.session_type === 'adhoc') {
    flash(req, 'Ad-hoc sessions don\'t have a schedule to lock — there\'s no season-long schedule generated for them.', 'error');
    return res.redirect(`/admin/sessions/${session.id}`);
  }
  db.prepare(`UPDATE sessions SET schedule_locked_at = datetime('now') WHERE id = ?`).run(session.id);
  logActivity(req, { action: 'session.lock_schedule', description: `Locked the schedule for "${email.sessionFullTitle(session)}"`, sessionId: session.id });
  flash(req, `"${session.name}"'s schedule is locked — this doesn't stop you from making further changes, it's just a marker that this version is the one you're standing behind.`);
  res.redirect(`/admin/sessions/${session.id}`);
});

router.post('/sessions/:id/unlock-schedule', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).send('Session not found');
  db.prepare('UPDATE sessions SET schedule_locked_at = NULL WHERE id = ?').run(session.id);
  logActivity(req, { action: 'session.unlock_schedule', description: `Unlocked the schedule for "${email.sessionFullTitle(session)}"`, sessionId: session.id });
  flash(req, `"${session.name}"'s schedule is unlocked again.`);
  res.redirect(`/admin/sessions/${session.id}`);
});

router.get('/settings', (req, res) => {
  res.render('admin/settings', {
    title: 'Settings',
    timezone: getTimezone(),
    siteTitle: getSiteTitle(),
    flashMsg: popFlash(req),
  });
});

router.post('/settings', (req, res) => {
  const oldTz = getTimezone();
  setTimezone(req.body.timezone);
  if (oldTz !== req.body.timezone) {
    logActivity(req, { action: 'settings.timezone', description: `Changed timezone from ${oldTz} to ${req.body.timezone}` });
  }

  // Site title: reject blank (an empty brand link would look broken, not
  // "not set") the same way every other required-text field in this app
  // does, but otherwise accept anything typed — it's free text, including
  // emoji, not a slug/username needing a format check.
  const newTitle = (req.body.site_title || '').trim();
  if (!newTitle) {
    flash(req, 'Site title cannot be blank.', 'error');
    return res.redirect('/admin/settings');
  }
  const oldTitle = getSiteTitle();
  setSiteTitle(newTitle);
  if (oldTitle !== newTitle) {
    logActivity(req, { action: 'settings.site_title', description: `Changed site title from "${oldTitle}" to "${newTitle}"` });
  }

  flash(req, 'Settings updated.');
  res.redirect('/admin/settings');
});

// --- Admin accounts ---------------------------------------------------

// Blank is always fine (auto-generate from the name on create; leave
// unchanged on edit) — only validated when the admin has actually typed
// something into the field, same "manual override for the rare real
// collision" treatment as invalidSlugField() gives players.slug. Format is
// intentionally a little more permissive than SLUG_RE (allows single `.`/`_`
// separators too, not just `-`) since usernames more often look like
// "kyle.krieg" or "kyle_k" than a URL slug does.
function invalidUsernameField(rawUsername, excludeAdminId) {
  const username = (rawUsername || '').trim().toLowerCase();
  if (!username) return null;
  if (!USERNAME_RE.test(username)) {
    return 'Username can only contain lowercase letters, numbers, and single . _ - separators (e.g. "kyle.krieg").';
  }
  if (usernameTaken(db, username, excludeAdminId)) {
    return 'That username is already taken by another admin — pick a different one.';
  }
  return null;
}

router.get('/admins', (req, res) => {
  const admins = db.prepare('SELECT * FROM admins ORDER BY active DESC, name').all();
  res.render('admin/admins', { title: 'Admins', admins, currentAdminId: req.session.adminId, flashMsg: popFlash(req) });
});

router.post('/admins', (req, res) => {
  const name = (req.body.name || '').trim();
  const password = req.body.password || '';
  if (!name || password.length < 8) {
    flash(req, 'Name is required and password must be at least 8 characters.', 'error');
    return res.redirect('/admin/admins');
  }
  const usernameError = invalidUsernameField(req.body.username, null);
  if (usernameError) {
    flash(req, usernameError, 'error');
    return res.redirect('/admin/admins');
  }
  const submittedUsername = (req.body.username || '').trim().toLowerCase();
  const username = submittedUsername || generateUniqueUsername(db, name, null);
  db.prepare('INSERT INTO admins (name, email, username, password_hash, active) VALUES (?, ?, ?, ?, 1)').run(
    name,
    req.body.email || null,
    username,
    hashPassword(password)
  );
  logActivity(req, { action: 'admin.create', description: `Added admin "${name}" (username "${username}")` });
  flash(req, `${name} added — they can log in at /admin with the username "${username}" and the password you just set.`);
  res.redirect('/admin/admins');
});

// Pure identity edit (name/email/username) — deliberately separate from
// reset-password below, same "one form, one job" split every other admin
// page in this app already uses. Username is deliberately NOT auto-
// regenerated when the name changes (same reasoning as players.slug) — an
// admin who already knows their username shouldn't have it silently change
// out from under them because their display name got corrected.
router.post('/admins/:id/edit', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    flash(req, 'Name is required.', 'error');
    return res.redirect('/admin/admins');
  }
  const before = db.prepare('SELECT name, email, username FROM admins WHERE id = ?').get(req.params.id);
  if (!before) {
    flash(req, 'That admin no longer exists.', 'error');
    return res.redirect('/admin/admins');
  }
  const submittedUsername = (req.body.username || '').trim().toLowerCase();
  let newUsername = before.username;
  if (submittedUsername && submittedUsername !== before.username) {
    const usernameError = invalidUsernameField(submittedUsername, req.params.id);
    if (usernameError) {
      flash(req, usernameError, 'error');
      return res.redirect('/admin/admins');
    }
    newUsername = submittedUsername;
  }
  const newEmail = (req.body.email || '').trim() || null;
  db.prepare('UPDATE admins SET name = ?, email = ?, username = ? WHERE id = ?').run(name, newEmail, newUsername, req.params.id);
  if (before.name !== name || before.email !== newEmail || before.username !== newUsername) {
    logActivity(req, {
      action: 'admin.edit',
      description: `Updated admin "${before.name}" (username "${before.username}") → "${name}" (username "${newUsername}")`,
    });
  }
  // Editing your own name/username doesn't need to log you out — unlike
  // deactivation, the session still points at the same admin id, and
  // req.session.adminName is only used for display/log attribution, not
  // for re-authenticating anything on the next request.
  if (Number(req.params.id) === req.session.adminId) {
    req.session.adminName = name;
  }
  flash(req, 'Admin updated.');
  res.redirect('/admin/admins');
});

router.post('/admins/:id/deactivate', (req, res) => {
  const activeCount = db.prepare('SELECT COUNT(*) as n FROM admins WHERE active = 1').get().n;
  if (activeCount <= 1) {
    flash(req, "Can't deactivate the last remaining admin — add another admin first.", 'error');
    return res.redirect('/admin/admins');
  }
  const target = db.prepare('SELECT name FROM admins WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE admins SET active = 0 WHERE id = ?').run(req.params.id);
  // Logged before the possible session invalidation below, while
  // req.session.adminId/adminName (the acting admin) is still populated —
  // this matters specifically for the self-deactivation case.
  logActivity(req, { action: 'admin.deactivate', description: `Deactivated admin "${target ? target.name : `#${req.params.id}`}"` });
  if (Number(req.params.id) === req.session.adminId) {
    req.session.isAdmin = false;
    return res.redirect('/admin/login');
  }
  flash(req, 'Admin deactivated.');
  res.redirect('/admin/admins');
});

router.post('/admins/:id/activate', (req, res) => {
  const target = db.prepare('SELECT name FROM admins WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE admins SET active = 1 WHERE id = ?').run(req.params.id);
  logActivity(req, { action: 'admin.activate', description: `Reactivated admin "${target ? target.name : `#${req.params.id}`}"` });
  flash(req, 'Admin reactivated.');
  res.redirect('/admin/admins');
});

router.post('/admins/:id/reset-password', (req, res) => {
  const password = req.body.password || '';
  if (password.length < 8) {
    flash(req, 'Password must be at least 8 characters.', 'error');
    return res.redirect('/admin/admins');
  }
  const target = db.prepare('SELECT name FROM admins WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.params.id);
  // Never log the password itself — just who it was reset for.
  logActivity(req, { action: 'admin.reset_password', description: `Reset password for admin "${target ? target.name : `#${req.params.id}`}"` });
  flash(req, 'Password updated.');
  res.redirect('/admin/admins');
});

// --- Database backups -------------------------------------------------

router.get('/backup', (req, res) => {
  // b.mtime is a real Date (from fs.statSync), an absolute instant -- no
  // string-parsing gotcha the way email_log's raw SQLite string needed, just
  // the same utcToZonedParts() conversion so "Created" reads in the site's
  // one configured timezone instead of raw UTC, per Kyle's "no UTC anywhere"
  // rule (see also the Activity Log and Stats page fixes alongside this one).
  const backupTz = getTimezone();
  const backups = backup.listBackups().map((b) => {
    const parts = utcToZonedParts(b.mtime, backupTz);
    return { ...b, createdDisplay: `${email.fmtDate(parts.date)}, ${email.fmtTime(parts.time)}` };
  });
  res.render('admin/backup', {
    title: 'Backup',
    backups,
    retention: backup.DEFAULT_RETENTION,
    offsiteConfigured: offsiteBackup.isConfigured(),
    flashMsg: popFlash(req),
  });
});

router.post('/backup', (req, res) => {
  try {
    const result = backup.createBackup();
    backup.pruneBackups(backup.DEFAULT_RETENTION);
    flash(req, `Backup created: ${result.filename} (${(result.size / 1024).toFixed(1)} KB). Download it below and save it somewhere off this Pi.`);
    logActivity(req, { action: 'backup.create', description: `Created backup ${result.filename} (${(result.size / 1024).toFixed(1)} KB)` });
  } catch (err) {
    flash(req, `Backup failed: ${err.message}`, 'error');
    logActivity(req, { action: 'backup.create', description: `Backup creation failed: ${err.message}` });
  }
  res.redirect('/admin/backup');
});

router.post('/backup/push-offsite', (req, res) => {
  try {
    const result = offsiteBackup.pushBackupsOffsite();
    if (result.skipped) {
      flash(req, `Off-site push is not configured — set OFFSITE_SSH_HOST/USER/PATH in .env first. (${result.reason})`, 'error');
    } else {
      flash(req, 'Pushed backups/ to the off-site machine.');
      logActivity(req, { action: 'backup.push_offsite', description: 'Pushed backups/ to the off-site machine' });
    }
  } catch (err) {
    flash(req, `Off-site push failed: ${err.message}`, 'error');
    logActivity(req, { action: 'backup.push_offsite', description: `Off-site push failed: ${err.message}` });
  }
  res.redirect('/admin/backup');
});

router.get('/backup/download/:filename', (req, res) => {
  const { filename } = req.params;
  if (!backup.isValidBackupFilename(filename)) return res.status(400).send('Invalid filename');
  const filePath = path.join(backup.BACKUP_DIR, filename);
  if (path.dirname(filePath) !== backup.BACKUP_DIR || !fs.existsSync(filePath)) {
    return res.status(404).send('Backup not found');
  }
  logActivity(req, { action: 'backup.download', description: `Downloaded backup ${filename}` });
  res.download(filePath, filename);
});

router.post('/backup/:filename/delete', (req, res) => {
  const { filename } = req.params;
  if (!backup.isValidBackupFilename(filename)) return res.status(400).send('Invalid filename');
  const filePath = path.join(backup.BACKUP_DIR, filename);
  if (path.dirname(filePath) === backup.BACKUP_DIR && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    flash(req, 'Backup deleted.');
    logActivity(req, { action: 'backup.delete', description: `Deleted backup ${filename}` });
  }
  res.redirect('/admin/backup');
});

// --- Sessions -------------------------------------------------------------

router.get('/sessions/new', (req, res) => {
  const players = db.prepare('SELECT * FROM players WHERE active = 1 ORDER BY name').all();
  res.render('admin/session_form', {
    title: 'New Session',
    session: null,
    players,
    enrolled: new Map(),
    enrolledPriority: new Map(),
    collidingSessionsByPlayer: new Map(),
    playedCounts: new Map(),
    lockedWeeksCount: 0,
    flashMsg: popFlash(req),
  });
});

// A doubles court needs exactly 4 players, so any multi-court session's
// players-per-week has to be a multiple of 4 or the scheduling engine can't
// split it into whole courts (it now rejects this itself as infeasible, but
// catching it here means the admin gets an immediate, specific message
// instead of a "scheduling failed" conflict after clicking through).
function invalidPlayersPerWeek(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 4 || n % 4 !== 0) {
    return 'Players per week must be a multiple of 4 (one doubles court = 4 players) — e.g. 4, 8, 12.';
  }
  return null;
}

// Both match_time and reminder_time flow into src/services/tz.js's
// zonedTimeToUtc() throughout cron.js, which does raw 'HH:MM'.split(':')
// arithmetic — a blank or malformed value there doesn't just fail to parse,
// it produces an Invalid Date that then compares as neither < nor >= any
// real date, silently flipping "should this have gone out yet?" checks to
// the wrong answer everywhere they're used (e.g. an empty reminder_time made
// cron treat every week's reminder as permanently overdue instead of never
// due, and an empty match_time would have made processWeekLocking lock every
// week immediately). tz.js now throws on bad input as a second line of
// defense, but this is the one that stops it from ever reaching the DB.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function invalidTimeFields(b) {
  if (!TIME_RE.test(b.match_time || '')) return 'Match time must be a valid time (HH:MM).';
  if (!TIME_RE.test(b.reminder_time || '')) return 'Reminder email time-of-day must be a valid time (HH:MM).';
  return null;
}

// start_date/end_date flow into src/services/scheduleRun.js's
// datesForDayOfWeek(), which builds a JS Date from the raw string — a blank
// or malformed date doesn't throw there either, it just produces an Invalid
// Date that fails every `<=` comparison in that function's while loop, so
// the session silently gets zero weeks with no error anywhere telling the
// admin the schedule is empty. Catching it here, before it's ever saved, is
// the only place that actually stops it.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function invalidSessionDates(b) {
  if (!DATE_RE.test(b.start_date || '')) return 'Start date is required.';
  if (!DATE_RE.test(b.end_date || '')) return 'End date is required.';
  if (b.end_date < b.start_date) return 'End date must be on or after the start date.';
  const dow = Number(b.match_day_of_week);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) return 'Match day of week is invalid.';
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function invalidPlayerFields(b) {
  const name = (b.name || '').trim();
  const email = (b.email || '').trim();
  if (!name) return 'Name is required.';
  if (!EMAIL_RE.test(email)) return 'A valid email address is required.';
  return null;
}

// URL slug for "My Page" (/me/<slug>) — see playerSlug.js's doc comment.
// Blank is always fine (auto-generate on create, leave unchanged on edit);
// only validated when the admin has actually typed something into the
// field, so this is purely a manual override for the rare real collision
// (e.g. two "Brian B"s) Kyle asked to be able to resolve by hand.
function invalidSlugField(rawSlug, excludePlayerId) {
  const slug = (rawSlug || '').trim();
  if (!slug) return null;
  if (!SLUG_RE.test(slug)) return 'URL slug can only contain lowercase letters, numbers, and hyphens (e.g. "brian-b").';
  if (slugTaken(db, slug, excludePlayerId)) return 'That URL slug is already in use by another player — pick a different one.';
  return null;
}

// Same idea, for broader_sub_list.slug (Kyle, 2026-09-01) — see
// playerSlug.js's broaderSubSlugTaken() doc comment for why this checks
// both tables (players.slug, the real namespace this lands in once
// claimed, and every other broader_sub_list.slug, so two pending entries
// can't collide with each other before either one ever claims a spot).
function invalidBroaderSubSlugField(rawSlug, excludeListId) {
  const slug = (rawSlug || '').trim();
  if (!slug) return null;
  if (!SLUG_RE.test(slug)) return 'URL slug can only contain lowercase letters, numbers, and hyphens (e.g. "brian-b").';
  if (broaderSubSlugTaken(db, slug, excludeListId)) return 'That URL slug is already in use — pick a different one.';
  return null;
}

// Ad-hoc sessions (session_type = 'adhoc') have no target-games math to
// validate, but do have three lead-hour fields (see "Ad-hoc sessions" in
// CLAUDE.md) that need to count down in the same order Kyle actually runs
// them — invite, then a reminder if sign-ups are still short, then the
// final roster/"not enough" email — or the timing wouldn't make sense
// (e.g. a "reminder" that fires after the "final" email already went out).
// Admin pre-match status report (Kyle, 2026-08-26): admin_report_emails is a
// simple comma-separated text field rather than a separate table — this app
// already stores club_name/court_info the same plain-text way, and a handful
// of admin addresses per session doesn't need normalizing. Blank is always
// valid (feature off); only validated when the admin has actually typed
// something in. admin_report_lead_hours has no ordering to check against
// (unlike the three ad-hoc lead-hour fields above, which must count down in
// sequence) — just a plain positive whole number of hours before match time.
function invalidAdminReportFields(b) {
  const raw = (b.admin_report_emails || '').trim();
  if (raw) {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0 || !parts.every((e) => EMAIL_RE.test(e))) {
      return 'Admin report email(s) must be a comma-separated list of valid addresses.';
    }
  }
  const hours = Number(b.admin_report_lead_hours);
  if (b.admin_report_lead_hours !== undefined && (!Number.isInteger(hours) || hours <= 0)) {
    return 'Status report lead time must be a whole number of hours before match time, greater than 0.';
  }
  return null;
}

// Follow-up nudge lead time (Kyle, 2026-08-27) — same "plain positive whole
// number of hours before match time" shape as admin_report_lead_hours above,
// no ordering to check against.
function invalidFollowUpLeadHours(b) {
  const hours = Number(b.follow_up_lead_hours);
  if (b.follow_up_lead_hours !== undefined && (!Number.isInteger(hours) || hours <= 0)) {
    return 'Follow-up lead time must be a whole number of hours before match time, greater than 0.';
  }
  return null;
}

function invalidAdhocLeadHours(b) {
  const invite = Number(b.adhoc_invite_lead_hours);
  const reminder = Number(b.adhoc_reminder_lead_hours);
  const final = Number(b.adhoc_final_lead_hours);
  if (![invite, reminder, final].every((n) => Number.isInteger(n) && n > 0)) {
    return 'Ad-hoc email timing must be whole numbers of hours before match time, greater than 0.';
  }
  if (!(invite > reminder && reminder > final)) {
    return 'Ad-hoc email timing must count down toward match time: invite lead time > reminder lead time > final roster lead time (e.g. 56 / 30 / 24).';
  }
  return null;
}

// Ad-hoc roster management is deliberately simpler than saveRoster() below —
// just "who's in the pool that gets invited," no target_games/priority math
// (session_players.target_games is stored as 0 and ignored for adhoc rows;
// the column stays NOT NULL so it's set rather than left out). Can be edited
// at any time, unlike the regular roster's draft-only enrollment window —
// ad-hoc has no draft/scheduled lock-in step to begin with.
function saveAdhocRoster(sessionId, body) {
  const playerIds = new Set([].concat(body.adhoc_player_id || []).map(Number).filter(Boolean));
  const existing = new Set(
    db.prepare('SELECT player_id FROM session_players WHERE session_id = ?').all(sessionId).map((r) => r.player_id)
  );
  for (const pid of playerIds) {
    if (!existing.has(pid)) {
      db.prepare('INSERT INTO session_players (session_id, player_id, target_games, priority) VALUES (?, ?, 0, NULL)').run(
        sessionId,
        pid
      );
    }
  }
  for (const pid of existing) {
    if (!playerIds.has(pid)) {
      db.prepare('DELETE FROM session_players WHERE session_id = ? AND player_id = ?').run(sessionId, pid);
    }
  }
}

router.post('/sessions', (req, res) => {
  const b = req.body;
  const sessionType = b.session_type === 'adhoc' ? 'adhoc' : 'regular';
  const ppwError = invalidPlayersPerWeek(b.players_per_week || 4);
  if (ppwError) {
    flash(req, ppwError, 'error');
    return res.redirect('/admin/sessions/new');
  }
  const timeError = invalidTimeFields(b);
  if (timeError) {
    flash(req, timeError, 'error');
    return res.redirect('/admin/sessions/new');
  }
  const dateError = invalidSessionDates(b);
  if (dateError) {
    flash(req, dateError, 'error');
    return res.redirect('/admin/sessions/new');
  }
  if (sessionType === 'adhoc') {
    const leadError = invalidAdhocLeadHours(b);
    if (leadError) {
      flash(req, leadError, 'error');
      return res.redirect('/admin/sessions/new');
    }
  }
  const reportError = invalidAdminReportFields(b);
  if (reportError) {
    flash(req, reportError, 'error');
    return res.redirect('/admin/sessions/new');
  }
  const followUpError = invalidFollowUpLeadHours(b);
  if (followUpError) {
    flash(req, followUpError, 'error');
    return res.redirect('/admin/sessions/new');
  }
  const info = db
    .prepare(
      `INSERT INTO sessions (name, start_date, end_date, match_day_of_week, match_time, reminder_time,
        reminder_days_before, follow_up_lead_hours, reminders_enabled, courts, players_per_week, lookahead_weeks, club_name, court_info, color,
        session_type, adhoc_invite_lead_hours, adhoc_reminder_lead_hours, adhoc_final_lead_hours,
        admin_report_emails, admin_report_lead_hours, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      b.name,
      b.start_date,
      b.end_date,
      Number(b.match_day_of_week),
      b.match_time,
      b.reminder_time,
      Number(b.reminder_days_before || 2),
      Number(b.follow_up_lead_hours || 27),
      b.reminders_enabled ? 1 : 0,
      Number(b.courts || 1),
      Number(b.players_per_week || 4),
      Number(b.lookahead_weeks || 4),
      b.club_name || '',
      b.court_info || '',
      b.color || null,
      sessionType,
      Number(b.adhoc_invite_lead_hours || 56),
      Number(b.adhoc_reminder_lead_hours || 30),
      Number(b.adhoc_final_lead_hours || 24),
      (b.admin_report_emails || '').trim() || null,
      Number(b.admin_report_lead_hours || 8),
      // Ad-hoc has no "Schedule these players" step to promote it out of
      // draft — it's ready to start inviting the moment it's saved, so it
      // skips straight to 'active'. Regular sessions keep starting 'draft'.
      sessionType === 'adhoc' ? 'active' : 'draft'
    );
  const sessionId = info.lastInsertRowid;
  if (sessionType === 'adhoc') {
    saveAdhocRoster(sessionId, b);
  } else {
    saveRoster(sessionId, b);
  }
  logActivity(req, {
    action: 'session.create',
    // A fresh SELECT rather than building a session-shaped object out of raw
    // `b` (the just-submitted form body) -- guarantees the exact same
    // day/time/court/club values sessionFullTitle() would compose anywhere
    // else, with no risk of a stray type/field-name mismatch between the
    // form body's raw strings and what's actually now in the sessions table.
    description: `Created ${sessionType === 'adhoc' ? 'ad-hoc ' : ''}session "${email.sessionFullTitle(db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId))}"`,
    sessionId,
  });
  const overlapWarning = overlapWarningText(sessionId);
  const baseMsg =
    sessionType === 'adhoc'
      ? 'Ad-hoc session created. Sign-up invites go out automatically before each match based on the timing you set — nothing else to click.'
      : 'Session created. Add blackout dates, then click "Schedule these players" when ready.';
  flash(req, overlapWarning ? `${baseMsg} ${overlapWarning}` : baseMsg, overlapWarning ? 'error' : 'ok');
  res.redirect(`/admin/sessions/${sessionId}`);
});

function saveRoster(sessionId, body) {
  const playerIds = [].concat(body.player_id || []);
  const targets = [].concat(body.target_games || []);
  // Parallel to player_id/target_games (same index = same roster row). Blank
  // input submits '' — left as NULL (not yet decided), same as a brand new
  // enrollment; only an explicit non-blank number counts as "resolved".
  // Advisory only — see scheduleRun.js's doc comment on why this doesn't
  // drive any automatic scheduling behavior.
  const priorities = [].concat(body.priority || []);
  const existing = new Set(
    db.prepare('SELECT player_id FROM session_players WHERE session_id = ?').all(sessionId).map((r) => r.player_id)
  );
  const seen = new Set();
  playerIds.forEach((pidRaw, idx) => {
    const pid = Number(pidRaw);
    const target = Number(targets[idx] || 0);
    if (!pid || target <= 0) return;
    const priorityRaw = priorities[idx];
    const priority = priorityRaw === undefined || priorityRaw === '' ? null : Number(priorityRaw);
    seen.add(pid);
    if (existing.has(pid)) {
      db.prepare('UPDATE session_players SET target_games = ?, priority = ? WHERE session_id = ? AND player_id = ?').run(
        target,
        priority,
        sessionId,
        pid
      );
    } else {
      // original_target is set here, at first enrollment, and only here —
      // the UPDATE branch above deliberately never touches it, even if
      // target_games later gets edited down to "remaining open weeks" after
      // a mid-season roster change. See db/index.js's ensureColumn comment.
      db.prepare(
        'INSERT INTO session_players (session_id, player_id, target_games, original_target, priority) VALUES (?, ?, ?, ?, ?)'
      ).run(sessionId, pid, target, target, priority);
    }
  });
  for (const pid of existing) {
    if (!seen.has(pid)) {
      db.prepare('DELETE FROM session_players WHERE session_id = ? AND player_id = ?').run(sessionId, pid);
    }
  }
}

router.get('/sessions/:id/edit', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).send('Session not found');
  const players = db.prepare('SELECT * FROM players WHERE active = 1 ORDER BY name').all();
  const enrolledRows = db
    .prepare('SELECT player_id, target_games, priority FROM session_players WHERE session_id = ?')
    .all(session.id);
  const enrolled = new Map(enrolledRows.map((r) => [r.player_id, r.target_games]));
  const enrolledPriority = new Map(enrolledRows.map((r) => [r.player_id, r.priority]));

  // For the roster table's priority column: which player(s) here also might
  // want a priority hint set because they're enrolled in another session that
  // collides on day-of-week + date range (see findOverlappingSessionEnrollments
  // in sessionHelper.js). Priority is advisory only — see scheduleRun.js's
  // doc comment — but still worth setting so whoever fixes an actual
  // double-booking by hand knows who should probably yield.
  // Keyed by player_id -> list of { sessionId, sessionName } for the *other*
  // session(s) in the conflict, so the form can show "also in <name>" next to
  // the input rather than the admin having to cross-reference the warning
  // card separately.
  const collidingSessionsByPlayer = new Map();
  for (const c of findOverlappingSessionEnrollments(session.id)) {
    const other = c.sessionA.id === Number(session.id) ? c.sessionB : c.sessionA;
    if (!collidingSessionsByPlayer.has(c.player.id)) collidingSessionsByPlayer.set(c.player.id, []);
    collidingSessionsByPlayer.get(c.player.id).push({ sessionId: other.id, sessionName: other.name });
  }

  // Games each player has already banked in *locked* (completed) weeks — shown
  // next to the target input so it's obvious how much of each player's
  // original target is already spoken for when rebalancing after a roster
  // change mid-season.
  const playedRows = db
    .prepare(
      `SELECT wa.player_id, COUNT(*) as n FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       WHERE w.session_id = ? AND w.locked = 1 AND wa.status != 'subbed_out'
       GROUP BY wa.player_id`
    )
    .all(session.id);
  const playedCounts = new Map(playedRows.map((r) => [r.player_id, r.n]));

  const lockedWeeksCount = db
    .prepare('SELECT COUNT(*) as n FROM weeks WHERE session_id = ? AND locked = 1')
    .get(session.id).n;

  res.render('admin/session_form', {
    title: 'Edit Session',
    session,
    players,
    enrolled,
    enrolledPriority,
    collidingSessionsByPlayer,
    playedCounts,
    lockedWeeksCount,
    flashMsg: popFlash(req),
  });
});

router.post('/sessions/:id', (req, res) => {
  const b = req.body;
  const existingSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!existingSession) return res.status(404).send('Session not found');
  // session_type is fixed for the life of a session (see "Ad-hoc sessions"
  // in CLAUDE.md) — read from the DB, never from the submitted form, so
  // there's no path to flip a session's type after creation.
  const sessionType = existingSession.session_type;

  const ppwError = invalidPlayersPerWeek(b.players_per_week || 4);
  if (ppwError) {
    flash(req, ppwError, 'error');
    return res.redirect(`/admin/sessions/${req.params.id}/edit`);
  }
  const timeError = invalidTimeFields(b);
  if (timeError) {
    flash(req, timeError, 'error');
    return res.redirect(`/admin/sessions/${req.params.id}/edit`);
  }
  const dateError = invalidSessionDates(b);
  if (dateError) {
    flash(req, dateError, 'error');
    return res.redirect(`/admin/sessions/${req.params.id}/edit`);
  }
  if (sessionType === 'adhoc') {
    const leadError = invalidAdhocLeadHours(b);
    if (leadError) {
      flash(req, leadError, 'error');
      return res.redirect(`/admin/sessions/${req.params.id}/edit`);
    }
  }
  const reportError = invalidAdminReportFields(b);
  if (reportError) {
    flash(req, reportError, 'error');
    return res.redirect(`/admin/sessions/${req.params.id}/edit`);
  }
  const followUpError = invalidFollowUpLeadHours(b);
  if (followUpError) {
    flash(req, followUpError, 'error');
    return res.redirect(`/admin/sessions/${req.params.id}/edit`);
  }
  db.prepare(
    `UPDATE sessions SET name=?, start_date=?, end_date=?, match_day_of_week=?, match_time=?, reminder_time=?,
     reminder_days_before=?, follow_up_lead_hours=?, reminders_enabled=?, courts=?, players_per_week=?, lookahead_weeks=?, club_name=?, court_info=?, color=?,
     adhoc_invite_lead_hours=?, adhoc_reminder_lead_hours=?, adhoc_final_lead_hours=?,
     admin_report_emails=?, admin_report_lead_hours=? WHERE id=?`
  ).run(
    b.name,
    b.start_date,
    b.end_date,
    Number(b.match_day_of_week),
    b.match_time,
    b.reminder_time,
    Number(b.reminder_days_before || 2),
    Number(b.follow_up_lead_hours || 27),
    b.reminders_enabled ? 1 : 0,
    Number(b.courts || 1),
    Number(b.players_per_week || 4),
    Number(b.lookahead_weeks || 4),
    b.club_name || '',
    b.court_info || '',
    b.color || null,
    Number(b.adhoc_invite_lead_hours || 56),
    Number(b.adhoc_reminder_lead_hours || 30),
    Number(b.adhoc_final_lead_hours || 24),
    (b.admin_report_emails || '').trim() || null,
    Number(b.admin_report_lead_hours || 8),
    req.params.id
  );
  if (sessionType === 'adhoc') {
    saveAdhocRoster(req.params.id, b);
  } else {
    saveRoster(req.params.id, b);
  }
  logActivity(req, { action: 'session.update', description: `Updated session "${email.sessionFullTitle(db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id))}" (dates, roster, or settings)`, sessionId: Number(req.params.id) });
  const overlapWarning = overlapWarningText(req.params.id);
  const baseMsg =
    sessionType === 'adhoc'
      ? 'Ad-hoc session updated.'
      : 'Session updated. Click "Schedule these players" to (re)generate the schedule for open weeks.';
  flash(req, overlapWarning ? `${baseMsg} ${overlapWarning}` : baseMsg, overlapWarning ? 'error' : 'ok');
  res.redirect(`/admin/sessions/${req.params.id}`);
});

router.post('/sessions/:id/schedule', (req, res) => {
  try {
    const result = runScheduler(req.params.id);
    // Fetched once up front and reused by both possible logActivity() calls
    // below, so the description text itself always names the session (not
    // just the separate Session column) — Kyle, 2026-09-02: "make the full
    // session title show up in the activity log... easier to troubleshoot
    // with multiple different admins."
    const sessionForLog = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!result.feasible) {
      logActivity(req, {
        action: 'session.schedule_failed',
        description: `Ran "Schedule these players" for "${email.sessionFullTitle(sessionForLog)}" — failed with ${result.conflicts.length} conflict(s)`,
        sessionId: Number(req.params.id),
      });
      flash(req, `Scheduling failed: ${result.conflicts.length} conflict(s) found — see below.`, 'error');
    } else {
      // Both notes below are independent of each other (an understaffed week
      // and an auto-absorbed target are different root causes — see
      // scheduleRun.js/engine.js) and independent of whether the run was
      // otherwise clean, so both get appended to the same base message rather
      // than being mutually exclusive branches.
      let msg = `Scheduled ${result.weeksScheduled} week(s).`;
      let attention = false;

      if (result.understaffedWeeksCount > 0) {
        // At least one week didn't have enough available (non-blacked-out)
        // players to fill normally — it was still scheduled with whoever was
        // available rather than blocking the rest of the season, and flagged
        // on the week card below. Nobody's target_games was adjusted to
        // compensate, so anyone it affected is now short of their season
        // target — named here so it's not a surprise later on the Stats page.
        attention = true;
        const weekWord = result.understaffedWeeksCount === 1 ? 'week was' : 'weeks were';
        const shortfallNote = result.shortfallSummary.length
          ? ` ${result.shortfallSummary.length} player(s) are short of their target this run: ${result.shortfallSummary.join(', ')}.`
          : '';
        msg += ` ${result.understaffedWeeksCount} ${weekWord} short-staffed — scheduled with who's available and flagged below.${shortfallNote}`;
      }

      if (result.cappedSummary.length > 0) {
        // A player's own blackout dates made their configured target
        // unreachable — engine.js's attemptAutoAbsorb() capped them down and
        // handed the exact shortfall to someone else with room, rather than
        // failing the whole run. Named explicitly here since it's a real,
        // if small, deviation from what was configured — not something that
        // should only be discoverable by comparing the Stats page to memory.
        attention = true;
        msg += ` Target(s) auto-adjusted due to blackout dates: ${result.cappedSummary.join(', ')}.`;
        if (result.absorbedSummary.length > 0) {
          msg += ` Picked up the extra game(s) to keep courts full: ${result.absorbedSummary.join(', ')}.`;
        }
      }

      // Reuses the same human-readable `msg` built for the flash above as the
      // log description — it's already a clean summary, no reason to build a
      // second, near-duplicate string just for the log.
      logActivity(req, { action: 'session.schedule', description: `Ran "Schedule these players" for "${email.sessionFullTitle(sessionForLog)}": ${msg}`, sessionId: Number(req.params.id) });
      flash(req, msg, attention ? 'error' : 'ok');
    }
  } catch (err) {
    flash(req, `Error: ${err.message}`, 'error');
  }
  res.redirect(`/admin/sessions/${req.params.id}`);
});

router.post('/sessions/:id/delete', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).send('Session not found');

  const deleteSession = db.transaction((sessionId) => {
    // email_log rows for this session's weeks have no ON DELETE CASCADE to
    // weeks (a sent-email record should outlive a deleted session, e.g. for
    // support questions like "did that reminder actually go out?"), so
    // detach them before the cascade delete below, or the FK constraint
    // blocks deleting those weeks.
    db.prepare(
      `UPDATE email_log SET related_week_id = NULL WHERE related_week_id IN (SELECT id FROM weeks WHERE session_id = ?)`
    ).run(sessionId);
    // Same reasoning as email_log just above — a change record should
    // outlive the session it was made on, for history/support purposes.
    // admin_activity_log.session_id has no ON DELETE CASCADE (see
    // schema.sql), so this has to be detached first or the delete below
    // would hit a FOREIGN KEY constraint failure.
    db.prepare('UPDATE admin_activity_log SET session_id = NULL WHERE session_id = ?').run(sessionId);
    // Everything else session-scoped cascades via ON DELETE CASCADE:
    // session_players, blackout_dates, blackout_pending, weeks ->
    // week_assignments -> week_assignment_tokens, and weeks' sub_requests ->
    // sub_offers. The global `players` table is NOT touched — a player row
    // isn't owned by any one session (session_players is just a join table),
    // so deleting a session never removes a player who's enrolled elsewhere.
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  });
  deleteSession(session.id);

  // No sessionId on this entry — the session is gone by the time this runs,
  // and every already-existing entry that referenced it was just detached
  // above, so there's nothing left to point this new row at either.
  logActivity(req, { action: 'session.delete', description: `Deleted session "${email.sessionFullTitle(session)}"` });
  flash(req, `"${session.name}" was deleted. Players were not removed — only this session's schedule, roster enrollment, and history.`);
  res.redirect('/admin');
});

router.get('/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).send('Session not found');

  // Ad-hoc sessions have a completely different shape (no targets, no
  // blackout dates, no confirm/sub flow) — rather than threading isAdhoc
  // conditionals through the already-large regular session_detail.ejs,
  // this branches to its own dedicated view+route data. See
  // "Ad-hoc sessions" in CLAUDE.md.
  if (session.session_type === 'adhoc') {
    ensureWeeksExist(session.id);
    const weeks = db.prepare('SELECT * FROM weeks WHERE session_id = ? ORDER BY match_date').all(session.id);
    const roster = db
      .prepare(`SELECT p.* FROM session_players sp JOIN players p ON p.id = sp.player_id WHERE sp.session_id = ? AND p.active = 1 ORDER BY p.name`)
      .all(session.id);
    const tz = getTimezone();
    const weekRows = weeks.map((w) => {
      const groups = adhocFlow.courtGroupsForWeek(w.id);
      const finalized = db.prepare('SELECT COUNT(*) as n FROM week_assignments WHERE week_id = ?').get(w.id).n > 0;
      const finalizedAssignments = finalized
        ? db
            .prepare(
              `SELECT wa.*, p.name FROM week_assignments wa JOIN players p ON p.id = wa.player_id WHERE wa.week_id = ? ORDER BY wa.court, wa.team`
            )
            .all(w.id)
        : [];
      let matchAt = null;
      try {
        matchAt = zonedTimeToUtc(w.match_date, session.match_time, tz);
      } catch (e) {
        matchAt = null;
      }
      return { week: w, ...groups, finalized, finalizedAssignments, matchAt };
    });
    return res.render('admin/adhoc_session_detail', {
      title: session.name,
      session,
      roster,
      weekRows,
      flashMsg: popFlash(req),
    });
  }

  const weeks = db.prepare('SELECT * FROM weeks WHERE session_id = ? ORDER BY match_date').all(session.id);
  const roster = db
    .prepare(
      `SELECT p.* FROM session_players sp JOIN players p ON p.id = sp.player_id WHERE sp.session_id = ? AND p.active = 1 ORDER BY p.name`
    )
    .all(session.id);

  // Every blackout date for the session, grouped by date, so each week's
  // card can show who's unavailable — handy context before manually
  // reassigning someone (the reassign dropdown itself doesn't filter these
  // out, since an admin override is still allowed). One query for the whole
  // session rather than one per week.
  const blackoutRows = db
    .prepare(
      `SELECT bd.date, p.name FROM blackout_dates bd JOIN players p ON p.id = bd.player_id WHERE bd.session_id = ? ORDER BY p.name`
    )
    .all(session.id);
  const blackedOutByDate = new Map();
  for (const row of blackoutRows) {
    if (!blackedOutByDate.has(row.date)) blackedOutByDate.set(row.date, []);
    blackedOutByDate.get(row.date).push(row.name);
  }

  // Also fold in carried-over blackouts from another session (see
  // sessionHelper.js's carriedOverBlackoutsForSession()) — a real blackout
  // date entered on a *different* session still makes this session's own
  // scheduling engine and sub-fanout treat the player as unavailable on the
  // matching date (both already call carriedOverBlackoutsForSession()
  // themselves), so this week card should say so too rather than looking
  // clear. Labeled distinctly from a locally-entered blackout so it's clear
  // where to actually edit it, same pattern as the admin/self-service
  // blackout pages. Skipped if the player already has a real row here for
  // this date (own-session row already lists them, avoid duplicating).
  const carriedOverForDetail = carriedOverBlackoutsForSession(session.id);
  for (const [key, srcSession] of carriedOverForDetail.entries()) {
    const [playerIdStr, date] = key.split('|');
    const player = roster.find((p) => p.id === Number(playerIdStr));
    if (!player) continue;
    const existing = blackedOutByDate.get(date) || [];
    if (existing.includes(player.name)) continue;
    if (!blackedOutByDate.has(date)) blackedOutByDate.set(date, []);
    blackedOutByDate.get(date).push(`${player.name} (carried over from ${srcSession.name})`);
  }

  // Per-assignment double-booking lookup, from this session's point of view —
  // same helper the player-facing schedule/lookahead/My Page pages use (see
  // sessionHelper.js's doubleBookingMapForSession). Computed once for the
  // whole session rather than per week. Kyle asked (2026-08-11) for this to
  // show inline on each week's card too, not just the aggregate "Double-
  // booked" summary above the week list — so it's visible at the exact row
  // an admin would act on (Reassign/Mark confirmed) without having to
  // cross-reference the summary card's date against the week below it.
  const doubleBookingMap = doubleBookingMapForSession(session.id);

  const weekRows = weeks.map((w) => {
    const assignments = db
      .prepare(
        `SELECT wa.*, p.name, p.email FROM week_assignments wa JOIN players p ON p.id = wa.player_id WHERE wa.week_id = ? ORDER BY wa.court, wa.team`
      )
      .all(w.id);
    assignments.forEach((a) => {
      const other = doubleBookingMap.get(`${a.player_id}|${w.match_date}`);
      if (other) a.doubleBooked = other;
    });

    // Whether (and how many times) each person has actually been reminded
    // for this week — not tracked as part of wa.status (status is the
    // player's own commitment state; whether we've nudged them about it is
    // a separate fact, already logged per-send in email_log) — so this is
    // one query per week rather than a new column, keyed by to_email since
    // email_log doesn't carry a player_id.
    const reminderRows = db
      .prepare(
        `SELECT to_email, category FROM email_log WHERE related_week_id = ? AND category IN ('reminder', 'followup_reminder')`
      )
      .all(w.id);
    const remindedEmails = new Set(reminderRows.filter((r) => r.category === 'reminder').map((r) => r.to_email));
    const followedUpEmails = new Set(
      reminderRows.filter((r) => r.category === 'followup_reminder').map((r) => r.to_email)
    );
    assignments.forEach((a) => {
      a.reminded = remindedEmails.has(a.email);
      a.followedUp = followedUpEmails.has(a.email);
    });

    const ballDuty = w.ball_duty_player_id
      ? db.prepare('SELECT name FROM players WHERE id = ?').get(w.ball_duty_player_id)
      : null;
    // `weeks.ball_duty_player_id` can end up pointing at someone no longer
    // actually playing this week (e.g. a manual Reassign, or — the real bug
    // this was built to catch, see "Ball duty left stale after a joint-
    // resolver swap" in CLAUDE.md — a same-session swap accepted from the
    // joint conflict resolver that moved the ball-duty player to a
    // different week entirely). Checked against `assignments` with an
    // active status only, same "actually playing" definition the rest of
    // this app uses (subbed_out doesn't count). Flagged here so the
    // session-detail template can show it plainly instead of the ball-duty
    // <select> silently defaulting to whichever player happens to be first
    // in the list, which used to look like a real (but meaningless) answer.
    const ballDutyMismatch =
      !!w.ball_duty_player_id &&
      !assignments.some((a) => a.player_id === w.ball_duty_player_id && (a.status === 'scheduled' || a.status === 'confirmed'));
    // playerName joined in here specifically so the week-card badge can say
    // whose slot is open ("sub open — Alice") rather than just "sub open"
    // with no way to tell which of the week's players it's about without
    // scanning every row's own status badge separately (Kyle, 2026-08-13).
    const openSubRequest = db
      .prepare(
        `SELECT sr.*, p.name as playerName FROM sub_requests sr
         JOIN week_assignments wa ON wa.id = sr.week_assignment_id
         JOIN players p ON p.id = wa.player_id
         WHERE wa.week_id = ? AND sr.status IN ('open','escalated','unfilled') LIMIT 1`
      )
      .get(w.id);
    // Same idea, for a pending direct swap touching either side of this
    // week (either this week's player gave up their slot, or someone from
    // another week is trying to take one of this week's slots) — see
    // swapFlow.js. Joined both ways since either assignment_id column could
    // point at a slot in this particular week.
    const openSwapRequest = db
      .prepare(
        `SELECT sw.* FROM swap_requests sw
         JOIN week_assignments wa ON wa.id = sw.initiator_assignment_id OR wa.id = sw.target_assignment_id
         WHERE wa.week_id = ? AND sw.status = 'pending' LIMIT 1`
      )
      .get(w.id);
    return {
      week: w,
      assignments,
      ballDutyName: ballDuty ? ballDuty.name : null,
      ballDutyMismatch,
      openSubRequest,
      openSwapRequest,
      blackedOutNames: blackedOutByDate.get(w.match_date) || [],
    };
  });

  const conflicts = session.schedule_conflicts ? JSON.parse(session.schedule_conflicts) : [];
  const overlapConflicts = findOverlappingSessionEnrollments(session.id);

  // Double-bookings, grouped by (player, other session) with dates joined
  // onto one line — same "one row per player per source, not one row per
  // date" consolidation as the carried-over-blackouts table (Kyle,
  // 2026-08-27: both this and the overlap-enrollment list below were
  // taking up too much room as a stack of one-box-per-row flags). A player
  // double-booked against the *same* other session on 3 dates collapses to
  // a single row; double-booked against two different other sessions still
  // gets two rows, since that's two distinct facts to act on separately.
  const doubleBookingsRaw = findActualDoubleBookings(session.id);
  const doubleBookingRows = [];
  {
    const byKey = new Map();
    for (const d of doubleBookingsRaw) {
      const other = d.sessionA.id === session.id ? d.sessionB : d.sessionA;
      const key = `${d.player.id}|${other.id}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { playerName: d.player.name, other, dates: [] };
        byKey.set(key, entry);
        doubleBookingRows.push(entry);
      }
      entry.dates.push(d.date);
    }
    for (const entry of doubleBookingRows) entry.dates.sort();
    doubleBookingRows.sort((a, b) => a.playerName.localeCompare(b.playerName) || a.other.name.localeCompare(b.other.name));
  }

  // One "Resolve conflicts…" entry point per distinct *other* session, not
  // per player row — the joint resolver (jointSolver.js) always works on a
  // pair of sessions at a time and resolves every double-booked player
  // between them in one pass, so a button per player row was misleading
  // (Kyle asked directly whether it was scoped per-player; it wasn't —
  // every row pointing at the same other session led to the identical
  // page). Consolidated here so there's exactly one link per other session,
  // deduped from doubleBookingRows rather than a second query.
  const distinctOtherSessions = [];
  {
    const seen = new Set();
    for (const row of doubleBookingRows) {
      if (seen.has(row.other.id)) continue;
      seen.add(row.other.id);
      distinctOtherSessions.push(row.other);
    }
    distinctOtherSessions.sort((a, b) => a.name.localeCompare(b.name));
  }

  res.render('admin/session_detail', {
    title: session.name,
    session,
    weekRows,
    roster,
    conflicts,
    overlapConflicts,
    doubleBookingRows,
    distinctOtherSessions,
    multiCourt: session.players_per_week > 4,
    flashMsg: popFlash(req),
  });
});

// Advisory-only cross-session conflict resolver — see jointSolver.js's doc
// comment for the full design rationale (Kyle, 2026-08-28). Purely a GET:
// computes suggestions live on every request, writes nothing, so it's safe
// to refresh or revisit after making some of the changes it suggests (it'll
// just show fewer/different conflicts next time).
router.get('/sessions/:id/resolve-conflicts', (req, res) => {
  const sessionAId = Number(req.params.id);
  const sessionBId = Number(req.query.with);
  const sessionA = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionAId);
  const sessionB = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionBId);
  if (!sessionA || !sessionB) {
    flash(req, 'Could not find both sessions to compare.', 'error');
    return res.redirect(`/admin/sessions/${sessionAId}`);
  }

  const result = jointSolver.resolveConflicts(sessionAId, sessionBId);
  res.render('admin/resolve_conflicts', {
    title: `Resolve conflicts: ${sessionA.name} & ${sessionB.name}`,
    result,
    flashMsg: popFlash(req),
  });
});

// Applies every currently-resolvable suggestion from the page above for real
// (Kyle, 2026-08-28: "Let's put a button on the resolve conflict to accept
// all the suggested changes."). See jointSolver.js's applyResolutions() doc
// comment — it re-runs the resolver fresh rather than trusting anything from
// the form, so this always applies exactly what's true right now, not
// whatever the page happened to show whenever it was loaded. Anything left
// unresolved (no valid same-session swap) is untouched, same as before.
router.post('/sessions/:id/resolve-conflicts/apply', (req, res) => {
  const sessionAId = Number(req.params.id);
  const sessionBId = Number(req.query.with || req.body.with);
  const sessionA = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionAId);
  const sessionB = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionBId);
  if (!sessionA || !sessionB) {
    flash(req, 'Could not find both sessions to compare.', 'error');
    return res.redirect(`/admin/sessions/${sessionAId}`);
  }

  const { appliedCount } = jointSolver.applyResolutions(sessionAId, sessionBId);

  if (appliedCount === 0) {
    flash(req, 'Nothing to apply — no automatically-resolvable suggestions right now.', 'error');
  } else {
    logActivity(req, {
      action: 'session.joint_resolve_apply',
      description: `Applied ${appliedCount} suggested change(s) from the joint conflict resolver between "${email.sessionFullTitle(sessionA)}" and "${email.sessionFullTitle(sessionB)}"`,
      sessionId: sessionAId,
    });
    flash(
      req,
      `Applied ${appliedCount} suggested change(s). Affected players weren't emailed directly, but they'll get a normal reminder for their new date at the usual time. Re-run this page any time to check for anything still outstanding.`
    );
  }
  res.redirect(`/admin/sessions/${sessionAId}/resolve-conflicts?with=${sessionBId}`);
});

router.post('/sessions/:id/weeks/:weekId/reassign', (req, res) => {
  const { assignment_id, new_player_id } = req.body;
  const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(assignment_id);
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(req.params.weekId);
  if (!assignment || !week) return res.status(404).send('Not found');

  // "Needs a sub" in the dropdown, instead of picking a specific replacement
  // — a completely different action from the rest of this route, so it's
  // branched off first. See subFlow.js's adminFlagNeedsSub() doc comment:
  // this is meant to stay a rare, edge-case admin action (players have
  // Request a Sub / Swap a Week for the normal path), sends no email at all
  // right now, and defers the actual candidate fan-out to that week's normal
  // reminder time.
  if (new_player_id === 'needs_sub') {
    const result = subFlow.adminFlagNeedsSub(assignment.id);
    if (result.blocked) {
      const reasonText =
        result.reason === 'locked'
          ? "Can't flag — this week is already locked (already played)."
          : 'Another sub request is already open for this week — resolve that one first.';
      flash(req, reasonText, 'error');
      return res.redirect(`/admin/sessions/${req.params.id}`);
    }
    logActivity(req, {
      action: 'week.admin_flag_needs_sub',
      description: `Flagged ${email.fmtDate(week.match_date)} slot (${result.playerName}) as needing a sub — no emails sent yet, will fan out to the roster at this week's normal reminder time`,
      sessionId: Number(req.params.id),
    });
    flash(
      req,
      `${result.playerName}'s slot for ${email.fmtDate(week.match_date)} is flagged as needing a sub. No emails have gone out yet — the roster will be notified when this week's normal reminders fire.`
    );
    return res.redirect(`/admin/sessions/${req.params.id}`);
  }

  // "One-time sub (not on roster)" in the dropdown — Kyle, 2026-08-28: a
  // player sometimes arranges their own sub entirely outside the app (a
  // friend, a neighbor), and that sub is often nobody already in the
  // system at all, not even on the broader sub list. The normal player
  // dropdown above only ever lists this session's own roster, so there was
  // previously no way to slot in someone outside it without a separate
  // trip to Admin -> Players first. This creates a minimal player row on
  // the spot (reusing exactly the same "broader-list sub claims a slot"
  // pattern subFlow.js's claimSub() already uses — a real player row is
  // the only way anything downstream, from badges to Stats, knows how to
  // represent someone who actually played) and slots them in immediately.
  if (new_player_id === 'one_time_sub') {
    if (week.locked) {
      flash(req, "Can't add a one-time sub — this week is already locked (already played).", 'error');
      return res.redirect(`/admin/sessions/${req.params.id}`);
    }
    const oneTimeName = (req.body.one_time_sub_name || '').trim();
    if (!oneTimeName) {
      flash(req, 'Enter a name for the one-time sub.', 'error');
      return res.redirect(`/admin/sessions/${req.params.id}`);
    }
    const oldPlayerForOneTime = db.prepare('SELECT name FROM players WHERE id = ?').get(assignment.player_id);

    // players.email is NOT NULL UNIQUE — a placeholder @no-email.invalid
    // address satisfies that without requiring a real one from the admin
    // (Kyle chose name-only for speed). email.js's sendMail() recognizes
    // this domain and skips ever actually trying to send there, so this
    // player just never gets a reminder for this match, as expected.
    const placeholderEmail = `onetime-${crypto.randomBytes(6).toString('hex')}@${email.NO_EMAIL_DOMAIN}`;
    const oneTimeSlug = generateUniqueSlug(db, oneTimeName, null);
    const oneTimePlayer = db
      .prepare('INSERT INTO players (name, email, slug) VALUES (?, ?, ?)')
      .run(oneTimeName, placeholderEmail, oneTimeSlug);
    const oneTimePlayerId = oneTimePlayer.lastInsertRowid;

    // Same semantics as a real claimed sub (subFlow.js's claimSub()), not a
    // plain reassign: the original player's row is preserved as history
    // (subbed_out) rather than overwritten, and a fresh is_sub=1 row is
    // inserted for the sub — so Stats and every other is_sub-aware view
    // treat this identically to a sub that came in through the normal
    // email flow, not as if the one-time sub had their own season target.
    db.prepare("UPDATE week_assignments SET status = 'subbed_out' WHERE id = ?").run(assignment.id);
    tokenStore.invalidateTokensForAssignment(assignment.id);
    db.prepare(
      `INSERT INTO week_assignments (week_id, player_id, team, court, is_sub, status, confirmed_at)
       VALUES (?, ?, ?, ?, 1, 'confirmed', datetime('now'))`
    ).run(assignment.week_id, oneTimePlayerId, assignment.team, assignment.court);

    const subWasResolvedOneTime = subFlow.closeActiveSubRequestForAssignment(assignment.id);
    const swapWasCancelledOneTime = swapFlow.adminCancelSwap(assignment.id);

    logActivity(req, {
      action: 'week.one_time_sub',
      description: `Added one-time sub "${oneTimeName}" (no email on file) for ${email.fmtDate(week.match_date)} — covering ${oldPlayerForOneTime ? oldPlayerForOneTime.name : `player #${assignment.player_id}`}'s slot`,
      sessionId: Number(req.params.id),
    });

    const suffixOneTime =
      (subWasResolvedOneTime ? ' Its open sub request was closed out too — those invite links are now dead.' : '') +
      (swapWasCancelledOneTime ? ' A pending swap request on that slot was cancelled — it would no longer have gone through.' : '');
    flash(req, `Added "${oneTimeName}" as a one-time sub — no email on file, so they won't receive any reminder for this match.${suffixOneTime}`);
    return res.redirect(`/admin/sessions/${req.params.id}`);
  }

  const newPlayerId = Number(new_player_id);

  // Same landmine as the ball-duty route: a blank dropdown submits '', which
  // Number() turns into 0 rather than NaN — a numeric-looking but nonexistent
  // player id that would otherwise sail past the checks below and only fail
  // once it hits the FK constraint on week_assignments.player_id, as a raw
  // 500 instead of a flash message.
  const newPlayer = newPlayerId ? db.prepare('SELECT id, name FROM players WHERE id = ?').get(newPlayerId) : null;
  if (!newPlayer) {
    flash(req, 'Pick a player to reassign to.', 'error');
    return res.redirect(`/admin/sessions/${req.params.id}`);
  }
  const oldPlayer = db.prepare('SELECT name FROM players WHERE id = ?').get(assignment.player_id);

  // week_assignments has a UNIQUE(week_id, player_id) constraint — without
  // this check, reassigning onto someone already playing that week (on
  // another court/team) throws a raw SQLite "UNIQUE constraint failed"
  // error instead of a normal flash message.
  const alreadyInWeek = db
    .prepare('SELECT 1 FROM week_assignments WHERE week_id = ? AND player_id = ? AND id != ?')
    .get(week.id, newPlayerId, assignment.id);
  if (alreadyInWeek) {
    flash(req, "Can't reassign — that player is already scheduled for this week on another spot.", 'error');
    return res.redirect(`/admin/sessions/${req.params.id}`);
  }

  const blackout = db
    .prepare('SELECT 1 FROM blackout_dates WHERE session_id = ? AND player_id = ? AND date = ?')
    .get(week.session_id, newPlayerId, week.match_date);

  db.prepare('UPDATE week_assignments SET player_id = ?, status = ? WHERE id = ?').run(
    newPlayerId,
    'scheduled',
    assignment_id
  );
  // The slot now belongs to a different player — any link already out for
  // the previous occupant shouldn't still work against this assignment row.
  tokenStore.invalidateTokensForAssignment(assignment.id);
  // If the player being replaced had an open/escalated/unfilled sub request
  // out (that's usually *why* the admin is reassigning), this manual swap
  // satisfies it. Without closing it, the "sub open" flag never clears and
  // the sub-invite links still out to other players stay claimable — see
  // closeActiveSubRequestForAssignment in subFlow.js.
  const subWasResolved = subFlow.closeActiveSubRequestForAssignment(assignment.id);
  // Same reasoning, for a pending direct swap instead of a sub request: this
  // assignment now belongs to a different player than whoever the swap's two
  // participants actually agreed to trade with. respondToSwap() already
  // refuses to execute a swap once either side's current occupant no longer
  // matches who proposed/was targeted (see swapFlow.js's identity-drift
  // check) — that's the real safety net — but leaving the row sitting there
  // as "pending" would mean the other player's still-live accept/decline
  // link quietly does nothing when clicked, with no visibility into why.
  // Cancelling it here up front closes the loop cleanly instead.
  const swapWasCancelled = swapFlow.adminCancelSwap(assignment.id);

  logActivity(req, {
    action: 'week.reassign',
    description: `Reassigned ${email.fmtDate(week.match_date)} slot from ${oldPlayer ? oldPlayer.name : `player #${assignment.player_id}`} to ${newPlayer.name}${blackout ? ' (blackout override)' : ''}`,
    sessionId: Number(req.params.id),
  });

  const suffix =
    (subWasResolved ? ' Its open sub request was closed out too — those invite links are now dead.' : '') +
    (swapWasCancelled ? ' A pending swap request on that slot was cancelled — it would no longer have gone through.' : '');
  if (blackout) {
    flash(req, `Reassigned — note: that player marked this date as a blackout date. Admin override applied.${suffix}`, 'error');
  } else {
    flash(req, `Player reassigned.${suffix}`);
  }
  res.redirect(`/admin/sessions/${req.params.id}`);
});

router.post('/sessions/:id/weeks/:weekId/clear-sub-request', (req, res) => {
  // Reassign and Mark confirmed both close out an active sub request as a
  // side effect of resolving the underlying assignment to a *different*
  // outcome they've already decided on (a new player, or an explicit
  // confirmation) — this route is the plain "undo" for when nothing else
  // should change: the request itself was a mistake or got called off (the
  // player picked the wrong week, or asked for a sub and then found out they
  // can play after all). Kyle, 2026-08-25: in that case the player's status
  // needs to go back to 'scheduled' — not stay stuck on 'needs_sub' — so
  // they're back in the normal reminder/follow-up flow and get emailed like
  // anyone else, rather than silently falling through the cracks. Only one
  // open/escalated/unfilled sub_requests row can exist per week at a time
  // (hasActiveConcurrentSubRequest), so weekId alone is enough to find it.
  //
  // This assumes the original player is the one actually playing again. If
  // instead someone else stepped in outside the app (a text message, a
  // phone call) and the slot needs to show a different player, use Reassign
  // instead of this button — it records who's really playing and closes the
  // request as part of the same action, rather than resetting to the
  // original player.
  const active = db
    .prepare(
      `SELECT sr.id, sr.week_assignment_id, w.match_date, p.name as player_name
       FROM sub_requests sr
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = wa.player_id
       WHERE wa.week_id = ? AND sr.status IN ('open', 'escalated', 'unfilled')`
    )
    .get(req.params.weekId);
  if (!active) {
    flash(req, 'No open sub request found for this week.', 'error');
    return res.redirect(`/admin/sessions/${req.params.id}`);
  }
  subFlow.closeActiveSubRequestForAssignment(active.week_assignment_id);
  // Only resets if still 'needs_sub' — defensive in case this somehow fires
  // after the slot already moved on some other way, so it can never clobber
  // a 'subbed_out'/'confirmed' status set by something else in the meantime.
  db.prepare(`UPDATE week_assignments SET status = 'scheduled' WHERE id = ? AND status = 'needs_sub'`).run(
    active.week_assignment_id
  );
  logActivity(req, {
    action: 'week.clear_sub_request',
    description: `Cleared sub request for ${active.player_name}'s ${email.fmtDate(active.match_date)} slot — status reset to scheduled`,
    sessionId: Number(req.params.id),
  });
  flash(req, `Sub request cleared — ${active.player_name} is back to "scheduled" for that week. If someone else is actually playing instead, use Reassign below.`);
  res.redirect(`/admin/sessions/${req.params.id}`);
});

router.post('/sessions/:id/weeks/:weekId/cancel-swap', (req, res) => {
  // Mirrors clear-sub-request above, for the swap-request equivalent (see
  // swapFlow.js's adminCancelSwap). Only one pending swap can touch a given
  // assignment at a time, so weekId alone is enough to find it — the token
  // link stops working immediately since respondToSwap() only ever acts on
  // a still-'pending' row.
  const active = db
    .prepare(
      `SELECT sw.id, sw.initiator_assignment_id, sw.target_assignment_id
       FROM swap_requests sw
       JOIN week_assignments wa ON wa.id = sw.initiator_assignment_id OR wa.id = sw.target_assignment_id
       WHERE wa.week_id = ? AND sw.status = 'pending' LIMIT 1`
    )
    .get(req.params.weekId);
  if (!active) {
    flash(req, 'No pending swap request found for this week.', 'error');
    return res.redirect(`/admin/sessions/${req.params.id}`);
  }
  const initiator = swapFlow.getAssignmentContext(active.initiator_assignment_id);
  const target = swapFlow.getAssignmentContext(active.target_assignment_id);
  swapFlow.adminCancelSwap(active.initiator_assignment_id);
  logActivity(req, {
    action: 'week.cancel_swap',
    description: `Cancelled a pending swap between ${initiator ? initiator.player.name : 'a player'} and ${target ? target.player.name : 'a player'}`,
    sessionId: Number(req.params.id),
  });
  flash(req, 'Swap request cancelled — its link is now dead.');
  res.redirect(`/admin/sessions/${req.params.id}`);
});

router.post('/sessions/:id/weeks/:weekId/add-player', (req, res) => {
  // The one gap "Reassign" doesn't cover: it only ever swaps who's in an
  // *existing* assignment row, so a week with zero assignments — most
  // commonly an understaffed week the scheduler flagged (see
  // scheduleRun.js/engine.js) rather than blocking the whole season — had no
  // in-app way to manually fill it at all. This adds a brand-new
  // week_assignments row instead of swapping one.
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(req.params.weekId);
  if (!week) return res.status(404).send('Not found');
  if (week.locked) {
    flash(req, "Can't add a player — this week is already locked (completed).", 'error');
    return res.redirect(`/admin/sessions/${req.params.id}`);
  }

  const playerId = Number(req.body.player_id);
  const player = playerId ? db.prepare('SELECT id, name FROM players WHERE id = ?').get(playerId) : null;
  if (!player) {
    flash(req, 'Pick a player to add.', 'error');
    return res.redirect(`/admin/sessions/${req.params.id}`);
  }

  const already = db
    .prepare('SELECT 1 FROM week_assignments WHERE week_id = ? AND player_id = ?')
    .get(week.id, playerId);
  if (already) {
    flash(req, 'That player is already scheduled for this week.', 'error');
    return res.redirect(`/admin/sessions/${req.params.id}`);
  }

  const count = db.prepare('SELECT COUNT(*) as n FROM week_assignments WHERE week_id = ?').get(week.id).n;
  const sessionForCap = db.prepare('SELECT players_per_week FROM sessions WHERE id = ?').get(req.params.id);
  // A court never plays more than 4 — this route exists to fill a
  // short-staffed week back up to normal, not to go past it. The "Add a
  // player" button is already hidden once a week is full (see
  // session_detail.ejs), but this is the actual enforcement, not just a UI
  // nicety, since the button's visibility alone doesn't stop a direct POST.
  if (count >= sessionForCap.players_per_week) {
    flash(req, 'This week is already fully scheduled — use Reassign to swap someone instead.', 'error');
    return res.redirect(`/admin/sessions/${req.params.id}`);
  }
  // Slot them into whichever court/team position is next in line — same
  // chunks-of-4, first-two-vs-last-two convention splitIntoCourtTeams uses,
  // so a manually-added player looks like any other assignment, not a
  // special case. NOT marked is_sub: that flag specifically means "this
  // person stepped in to cover someone else's dropped slot" (claimSub in
  // subFlow.js) and drives the "(sub)" label everywhere plus the Stats
  // page's target-vs-played accounting, which buckets is_sub games as a
  // separate "sub bonus" instead of counting them toward the player's own
  // season target. This route only ever shows up on a week that's
  // genuinely short a player (see the capacity check above and the
  // session_detail.ejs visibility rule), so whoever gets added here is
  // filling their own real slot, not subbing for anyone — it should count
  // toward their target like any other scheduled game.
  const court = Math.floor(count / 4) + 1;
  const team = count % 4 < 2 ? 'A' : 'B';

  db.prepare(
    'INSERT INTO week_assignments (week_id, player_id, team, court, is_sub, status) VALUES (?, ?, ?, ?, 0, ?)'
  ).run(week.id, playerId, team, court, 'scheduled');

  // If this fill brings the week up to its normal full size, the "needs
  // attention" flag has served its purpose — clear it the same way a full
  // schedule regeneration would. A week that's still short after this add
  // stays flagged, since it's still short.
  if (count + 1 >= sessionForCap.players_per_week) {
    db.prepare('UPDATE weeks SET needs_attention = 0, notes = NULL WHERE id = ?').run(week.id);
  }

  const blackout = db
    .prepare('SELECT 1 FROM blackout_dates WHERE session_id = ? AND player_id = ? AND date = ?')
    .get(week.session_id, playerId, week.match_date);

  logActivity(req, {
    action: 'week.add_player',
    description: `Added ${player.name} to the ${email.fmtDate(week.match_date)} slot${blackout ? ' (blackout override)' : ''}`,
    sessionId: Number(req.params.id),
  });

  if (blackout) {
    flash(req, 'Player added — note: that player marked this date as a blackout date. Admin override applied.', 'error');
  } else {
    flash(req, 'Player added to this week.');
  }
  res.redirect(`/admin/sessions/${req.params.id}`);
});

router.post('/sessions/:id/weeks/:weekId/ball-duty', (req, res) => {
  const playerId = Number(req.body.player_id);
  // A blank <select> submits '' — Number('') is 0, not NaN, and player ids
  // start at 1, so this doesn't fail to parse, it becomes a nonexistent-but-
  // numeric id that then trips the FK constraint on weeks.ball_duty_player_id
  // and throws a raw "FOREIGN KEY constraint failed" 500 instead of a normal
  // flash message. Checking the player actually exists catches both a blank
  // selection and any other bogus id before it reaches the DB.
  const player = playerId ? db.prepare('SELECT id, name FROM players WHERE id = ?').get(playerId) : null;
  if (!player) {
    flash(req, 'Pick a player for ball duty.', 'error');
    return res.redirect(`/admin/sessions/${req.params.id}`);
  }
  const week = db.prepare('SELECT match_date FROM weeks WHERE id = ?').get(req.params.weekId);
  db.prepare('UPDATE weeks SET ball_duty_player_id = ?, needs_attention = 0, notes = NULL WHERE id = ?').run(
    playerId,
    req.params.weekId
  );
  logActivity(req, {
    action: 'week.ball_duty',
    description: `Set ball duty for ${week ? email.fmtDate(week.match_date) : `week #${req.params.weekId}`} to ${player.name}`,
    sessionId: Number(req.params.id),
  });
  flash(req, 'Ball duty updated.');
  res.redirect(`/admin/sessions/${req.params.id}`);
});

router.post('/sessions/:id/weeks/:weekId/resend/:assignmentId', asyncHandler(async (req, res) => {
  const assignment = db.prepare('SELECT wa.*, p.name, p.email, p.slug FROM week_assignments wa JOIN players p ON p.id = wa.player_id WHERE wa.id = ?').get(req.params.assignmentId);
  const week = subFlow.getWeekWithSession(req.params.weekId);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  if (!assignment) return res.status(404).send('Not found');

  // Mints an additional valid link — any earlier one (original reminder,
  // a follow-up nudge) keeps working too rather than getting silently
  // killed by this resend. See tokenStore.js.
  const raw = tokenStore.issueToken(assignment.id);
  const upcoming = subFlow.upcomingWeeksPreview(session.id, week.match_date, 3);
  await email.sendConfirmationReminder({ player: assignment, week, session, confirmToken: raw, needSubToken: raw, upcomingWeeks: upcoming });

  flash(req, `Confirmation link resent to ${assignment.name}.`);
  res.redirect(`/admin/sessions/${req.params.id}`);
}));

router.post('/sessions/:id/weeks/:weekId/send-reminders', asyncHandler(async (req, res) => {
  try {
    const count = await cron.sendRemindersNowForWeek(req.params.weekId);
    if (count === 0) {
      flash(req, 'Nothing to send — everyone scheduled for this week has already been reminded.');
    } else {
      flash(req, `Sent ${count} reminder email(s) for this week just now.`);
    }
  } catch (err) {
    flash(req, `Error: ${err.message}`, 'error');
  }
  res.redirect(`/admin/sessions/${req.params.id}`);
}));

// Manual trigger for the same status-report send cron.js's
// processAdminReports() fires automatically — shares adminReport.js's
// sendReportForWeek() directly (same dedup-by-email_log, so calling this
// doesn't double-send to an address already reported to for this week; it's
// mainly here so the admin can check what the report looks like without
// waiting for the configured lead time). No-ops with a clear message if the
// session has no admin_report_emails configured, rather than a silent 0-sent.
router.post('/sessions/:id/weeks/:weekId/send-admin-report', asyncHandler(async (req, res) => {
  try {
    const session = db.prepare('SELECT admin_report_emails FROM sessions WHERE id = ?').get(req.params.id);
    if (!session || !(session.admin_report_emails || '').trim()) {
      flash(req, 'No admin report email(s) configured for this session — add one on the Edit page first.', 'error');
      return res.redirect(`/admin/sessions/${req.params.id}`);
    }
    const count = await adminReport.sendReportForWeek(req.params.weekId);
    if (count === 0) {
      flash(req, 'Nothing to send — every configured address has already gotten this week\'s report.');
    } else {
      flash(req, `Sent the status report to ${count} address(es) just now.`);
    }
  } catch (err) {
    flash(req, `Error: ${err.message}`, 'error');
  }
  res.redirect(`/admin/sessions/${req.params.id}`);
}));

router.post('/sessions/:id/weeks/:weekId/mark-confirmed/:assignmentId', (req, res) => {
  const assignment = db
    .prepare(
      `SELECT wa.id, p.name as player_name, w.match_date FROM week_assignments wa
       JOIN players p ON p.id = wa.player_id JOIN weeks w ON w.id = wa.week_id
       WHERE wa.id = ?`
    )
    .get(req.params.assignmentId);
  db.prepare(`UPDATE week_assignments SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?`).run(
    req.params.assignmentId
  );
  // Covers the "player asked for a sub, then told the admin directly they
  // can make it after all" case — same reasoning as the reassign route above.
  const subWasResolved = subFlow.closeActiveSubRequestForAssignment(req.params.assignmentId);
  logActivity(req, {
    action: 'week.mark_confirmed',
    description: assignment
      ? `Manually confirmed ${assignment.player_name} for ${email.fmtDate(assignment.match_date)}`
      : `Manually confirmed assignment #${req.params.assignmentId}`,
    sessionId: Number(req.params.id),
  });
  flash(req, subWasResolved ? 'Marked confirmed. Its open sub request was closed out too — those invite links are now dead.' : 'Marked confirmed.');
  res.redirect(`/admin/sessions/${req.params.id}`);
});

// --- Blackouts (admin, on behalf of a player) -----------------------------

router.post('/sessions/:id/notify-blackouts', asyncHandler(async (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).send('Session not found');

  // Blackout dates only mean anything while the session is still draft (see
  // public.js's /blackout route and the schedulingLocked flag it passes to
  // blackout.ejs) — notifying players once it's scheduled would just point
  // them at a locked page.
  if (session.status !== 'draft') {
    flash(req, "This session's already been scheduled, so blackout dates are locked for players — notifying the roster now would just point them at a dead end.", 'error');
    return res.redirect(`/admin/sessions/${session.id}/blackouts`);
  }

  const roster = db
    .prepare(`SELECT p.* FROM session_players sp JOIN players p ON p.id = sp.player_id WHERE sp.session_id = ? AND p.active = 1 ORDER BY p.name`)
    .all(session.id);
  if (roster.length === 0) {
    flash(req, 'No enrolled players to notify yet — add a roster from Edit session & roster first.', 'error');
    return res.redirect(`/admin/sessions/${session.id}/blackouts`);
  }

  for (const player of roster) {
    await email.sendBlackoutNotice({ recipient: player, session });
  }

  flash(req, `Notified ${roster.length} player(s) to enter their blackout dates.`);
  res.redirect(`/admin/sessions/${session.id}/blackouts`);
}));

// All players, across every active session, in one place — Kyle, 2026-08-28:
// "can we add an 'all players' [view] which shows all the blackout dates
// for all the active sessions?" Distinct from the per-session page below:
// this is read-only (editing still only happens from a specific session's
// own blackout page, same as the "Carried over" consolidation elsewhere),
// and it's session-agnostic by construction rather than needing any
// carriedOverBlackoutsForSession() reconciliation — blackout_dates rows are
// already a universal per-player fact (see "Blackout date carryover" in
// CLAUDE.md), so querying every row for a player directly already gives the
// complete picture with no session_id filtering needed at all.
router.get('/blackouts', (req, res) => {
  const sessions = getBlackoutViewableSessions();

  // Union of every active session's roster — a player enrolled in more than
  // one active session appears once, with every session they're on listed.
  const playerSessions = new Map(); // playerId -> { name, sessions: [session] }
  if (sessions.length) {
    const placeholders = sessions.map(() => '?').join(',');
    const rosterRows = db
      .prepare(
        `SELECT sp.session_id, p.id as player_id, p.name FROM session_players sp
         JOIN players p ON p.id = sp.player_id
         WHERE sp.session_id IN (${placeholders}) AND p.active = 1
         ORDER BY p.name`
      )
      .all(...sessions.map((s) => s.id));
    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    for (const row of rosterRows) {
      let entry = playerSessions.get(row.player_id);
      if (!entry) {
        entry = { name: row.name, sessions: [] };
        playerSessions.set(row.player_id, entry);
      }
      entry.sessions.push(sessionById.get(row.session_id));
    }
  }

  // Every real blackout_dates row for any of those players — no session_id
  // filter at all, since a blackout date is one universal fact regardless of
  // which session's page it was originally entered from.
  //
  // Deduped per player by date, via a Set rather than a plain array — same
  // safeguard the per-session blackouts.ejs page already has (see "Blackout
  // date carryover across sessions" in CLAUDE.md). Kyle found a real bug
  // here (2026-08-28): for a player enrolled in two same-day sessions, this
  // page was listing the same date twice. Root cause is legacy data, not
  // live logic — before dates became universally editable (2026-08-27), each
  // session's blackout page did its own independent delete-then-insert with
  // no awareness of the other session, so a player who'd checked the same
  // date under both sessions back then ended up with two real
  // blackout_dates rows (one per session_id) for the exact same
  // player+date. Both the admin per-session save route and the self-service
  // page now prevent that going forward (see the same CLAUDE.md section),
  // but any row pairs created before that fix are still sitting in the
  // table, and this page's raw SELECT had no session_id filter to hide
  // behind. Rather than destructively deleting the leftover duplicate rows,
  // this just dedupes on display — cheaper, safer, and it's what every other
  // consumer of blackout_dates already effectively does (the scheduler folds
  // everything into a Set keyed by player+date, so a duplicate row was never
  // actually a scheduling problem, only a display one, here).
  const datesByPlayer = new Map();
  if (playerSessions.size) {
    const playerIds = [...playerSessions.keys()];
    const placeholders = playerIds.map(() => '?').join(',');
    const dateRows = db
      .prepare(`SELECT player_id, date FROM blackout_dates WHERE player_id IN (${placeholders})`)
      .all(...playerIds);
    for (const row of dateRows) {
      if (!datesByPlayer.has(row.player_id)) datesByPlayer.set(row.player_id, new Set());
      datesByPlayer.get(row.player_id).add(row.date);
    }
  }

  // Kyle, 2026-08-31: "I'm not liking the format... is there a way to clean
  // that up a bit to show what dates correspond to sessions?" The old
  // layout (one row per player, a flat comma-joined date list next to a
  // flat session list) never actually correlated the two — a player in two
  // sessions with different weeks had no way to tell which blackout date
  // belonged to which session from this page alone. Restructured to be
  // organized by session first (matching the "by session" mental model the
  // per-session blackouts.ejs page already uses), with each session's own
  // table showing only the players/dates that actually fall on *that*
  // session's own match weeks — a direct date-to-week intersection, not a
  // flat dump.
  const weeksBySession = new Map(); // sessionId -> Set(match_date)
  for (const s of sessions) {
    const dates = db.prepare('SELECT match_date FROM weeks WHERE session_id = ?').all(s.id).map((w) => w.match_date);
    weeksBySession.set(s.id, new Set(dates));
  }

  const bySession = sessions.map((s) => {
    const playerRows = [];
    for (const [playerId, entry] of playerSessions) {
      if (!entry.sessions.some((es) => es.id === s.id)) continue;
      const playerDates = datesByPlayer.get(playerId) || new Set();
      const matching = [...playerDates].filter((d) => weeksBySession.get(s.id).has(d)).sort();
      if (matching.length > 0) playerRows.push({ name: entry.name, dates: matching });
    }
    playerRows.sort((a, b) => a.name.localeCompare(b.name));
    return { session: s, playerRows };
  });

  // Anything left over — a real blackout date on record for a player that
  // doesn't land on any of *their* currently active sessions' own match
  // weeks (a date entered for a since-archived session, a date beyond the
  // currently generated week range, or simple leftover from before a
  // session's schedule existed). Still real data worth showing, just not
  // tied to a specific session's table above.
  const otherRows = [];
  for (const [playerId, entry] of playerSessions) {
    const playerDates = datesByPlayer.get(playerId) || new Set();
    const accounted = new Set();
    for (const es of entry.sessions) {
      for (const d of weeksBySession.get(es.id)) accounted.add(d);
    }
    const leftover = [...playerDates].filter((d) => !accounted.has(d)).sort();
    if (leftover.length > 0) otherRows.push({ name: entry.name, dates: leftover });
  }
  otherRows.sort((a, b) => a.name.localeCompare(b.name));

  res.render('admin/all_blackouts', {
    title: 'All Blackout Dates',
    sessions,
    bySession,
    otherRows,
  });
});

router.get('/sessions/:id/blackouts', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (session.status === 'draft') ensureWeeksExist(session.id); // see note in public.js's /blackout route
  const roster = db
    .prepare(`SELECT p.* FROM session_players sp JOIN players p ON p.id = sp.player_id WHERE sp.session_id = ? ORDER BY p.name`)
    .all(session.id);
  const weeks = db.prepare('SELECT * FROM weeks WHERE session_id = ? ORDER BY match_date').all(session.id);
  const selectedPlayerId = Number(req.query.player) || null;

  // Blackout dates are a single universal fact per player+date, not tied to
  // whichever session they happened to be entered under (Kyle, 2026-08-27:
  // "it doesn't matter which session it was marked, it's a blackout date").
  // carriedOverBlackoutsForSession() finds every (player, date) that's
  // really stored under a *different* session but still lands on one of
  // this session's own match dates for a player on this roster — folded
  // straight into both the summary table and the per-player checklist
  // below so there's exactly one unified view, not two.
  const carriedOverMap = carriedOverBlackoutsForSession(session.id);

  let existing = new Set();
  if (selectedPlayerId) {
    existing = new Set(
      db.prepare('SELECT date FROM blackout_dates WHERE session_id = ? AND player_id = ?').all(session.id, selectedPlayerId).map((r) => r.date)
    );
    for (const key of carriedOverMap.keys()) {
      const [pid, date] = key.split('|');
      if (Number(pid) === selectedPlayerId) existing.add(date);
    }
  }

  // All blackout dates for the whole session, by player, for the summary
  // list — starts from this session's own rows, then folds in carried-over
  // ones so a player's row always shows every date they're actually
  // unavailable for, regardless of which session the real row lives under.
  const allBlackouts = db
    .prepare(
      `SELECT p.id as player_id, p.name, bd.date FROM blackout_dates bd
       JOIN players p ON p.id = bd.player_id
       WHERE bd.session_id = ? ORDER BY p.name, bd.date`
    )
    .all(session.id);
  const blackoutsByPlayer = [];
  const byPlayerId = new Map();
  for (const row of allBlackouts) {
    let entry = byPlayerId.get(row.player_id);
    if (!entry) {
      entry = { name: row.name, dates: [] };
      byPlayerId.set(row.player_id, entry);
      blackoutsByPlayer.push(entry);
    }
    entry.dates.push(row.date);
  }
  const nameById = new Map(roster.map((p) => [p.id, p.name]));
  for (const key of carriedOverMap.keys()) {
    const [playerIdStr, date] = key.split('|');
    const playerId = Number(playerIdStr);
    const name = nameById.get(playerId);
    if (!name) continue; // not on this session's current roster
    let entry = byPlayerId.get(playerId);
    if (!entry) {
      entry = { name, dates: [] };
      byPlayerId.set(playerId, entry);
      blackoutsByPlayer.push(entry);
    }
    if (!entry.dates.includes(date)) entry.dates.push(date);
  }
  for (const entry of blackoutsByPlayer) entry.dates.sort();
  blackoutsByPlayer.sort((a, b) => a.name.localeCompare(b.name));

  res.render('admin/blackouts', {
    title: 'Blackout Dates',
    session,
    roster,
    weeks,
    selectedPlayerId,
    existing,
    blackoutsByPlayer,
    flashMsg: popFlash(req),
  });
});

router.post('/sessions/:id/blackouts', (req, res) => {
  const sessionId = Number(req.params.id);
  const playerId = Number(req.body.player_id);
  const checkedDates = new Set([].concat(req.body.dates || []));

  // Blackout dates are meant to be genuinely universal per player+date, not
  // tied to whichever session they happened to be entered under (Kyle,
  // 2026-08-27: "I don't care which session they are added in, they just
  // need to be universal for the day for all the sessions"). Previously a
  // carried-over date (see sessionHelper.js's carriedOverBlackoutsForSession)
  // rendered as a disabled checkbox here — correct data-wise, but it forced
  // the admin to go find whichever session it was *originally* entered
  // under just to change it. Every checkbox on this page is now a normal,
  // editable one regardless of where the real row lives: unchecking a
  // carried-over date deletes it at its actual source session (not a copy
  // here), and checking a not-yet-set date only inserts a new row if one
  // doesn't already exist anywhere — so there's still exactly one real row
  // per player+date, it's just editable from any session's page now.
  const weeks = db.prepare('SELECT match_date FROM weeks WHERE session_id = ?').all(sessionId);
  const existingOwn = new Set(
    db.prepare('SELECT date FROM blackout_dates WHERE session_id = ? AND player_id = ?').all(sessionId, playerId).map((r) => r.date)
  );
  const carriedOverMap = carriedOverBlackoutsForSession(sessionId);

  let added = 0;
  let removed = 0;
  db.transaction(() => {
    const insert = db.prepare('INSERT OR IGNORE INTO blackout_dates (session_id, player_id, date, source) VALUES (?, ?, ?, ?)');
    const del = db.prepare('DELETE FROM blackout_dates WHERE session_id = ? AND player_id = ? AND date = ?');
    for (const w of weeks) {
      const date = w.match_date;
      const hasOwn = existingOwn.has(date);
      const carried = carriedOverMap.get(`${playerId}|${date}`);
      if (checkedDates.has(date)) {
        if (!hasOwn && !carried) {
          insert.run(sessionId, playerId, date, 'admin');
          added++;
        }
      } else {
        if (hasOwn) {
          del.run(sessionId, playerId, date);
          removed++;
        }
        if (carried) {
          del.run(carried.id, playerId, date);
          removed++;
        }
      }
    }
  })();

  const blackoutPlayer = db.prepare('SELECT name FROM players WHERE id = ?').get(playerId);
  logActivity(req, {
    action: 'blackout.admin_edit',
    description: `Updated blackout dates for ${blackoutPlayer ? blackoutPlayer.name : `player #${playerId}`} (+${added}, -${removed})`,
    sessionId,
  });
  flash(req, 'Blackout dates updated.');
  res.redirect(`/admin/sessions/${sessionId}/blackouts?player=${playerId}`);
});

// --- Ad-hoc sign-up manual overrides -----------------------------------
//
// Deliberately narrower than the regular session's Reassign flow: covers
// "someone told me in person they're in" (before a court fills — same
// self-service-plus-admin-override shape as everything else in this app)
// and undoing that. Once a week is finalized (real week_assignments rows
// exist), editing who's on a court goes through no dedicated UI yet —
// noted as a gap in CLAUDE.md rather than built here, given how narrow the
// need is (a finalized ad-hoc week is a firm pickup game, not something
// that gets reshuffled the way a season-long roster does).

router.post('/sessions/:id/weeks/:weekId/adhoc/signup', (req, res) => {
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(req.params.weekId);
  if (!week) return res.status(404).send('Week not found');
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(Number(req.body.player_id) || 0);
  if (!player) {
    flash(req, 'Pick a player to sign up.', 'error');
    return res.redirect(`/admin/sessions/${req.params.id}`);
  }
  let signupRow = db
    .prepare('SELECT * FROM adhoc_signups WHERE week_id = ? AND player_id = ?')
    .get(week.id, player.id);
  if (!signupRow) {
    const raw = generateRawToken();
    db.prepare('INSERT INTO adhoc_signups (week_id, player_id, token) VALUES (?, ?, ?)').run(week.id, player.id, hashToken(raw));
    signupRow = db.prepare('SELECT * FROM adhoc_signups WHERE week_id = ? AND player_id = ?').get(week.id, player.id);
  }
  if (!signupRow.signed_up_at) {
    db.prepare("UPDATE adhoc_signups SET signed_up_at = datetime('now') WHERE id = ?").run(signupRow.id);
  }
  logActivity(req, {
    action: 'adhoc.manual_signup',
    description: `Manually signed up ${player.name} for ${week.match_date}`,
    sessionId: Number(req.params.id),
  });
  flash(req, `${player.name} is signed up for ${week.match_date}.`);
  res.redirect(`/admin/sessions/${req.params.id}`);
});

router.post('/sessions/:id/weeks/:weekId/adhoc/withdraw', (req, res) => {
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(req.params.weekId);
  if (!week) return res.status(404).send('Week not found');
  const alreadyFinalized = db.prepare('SELECT COUNT(*) as n FROM week_assignments WHERE week_id = ?').get(week.id).n > 0;
  if (alreadyFinalized) {
    flash(req, 'This week already finalized — withdrawing a sign-up here no longer has anything to do.', 'error');
    return res.redirect(`/admin/sessions/${req.params.id}`);
  }
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(Number(req.body.player_id) || 0);
  if (!player) {
    flash(req, 'Pick a player to withdraw.', 'error');
    return res.redirect(`/admin/sessions/${req.params.id}`);
  }
  db.prepare('UPDATE adhoc_signups SET signed_up_at = NULL WHERE week_id = ? AND player_id = ?').run(week.id, player.id);
  logActivity(req, {
    action: 'adhoc.manual_withdraw',
    description: `Withdrew ${player.name} from ${week.match_date}`,
    sessionId: Number(req.params.id),
  });
  flash(req, `${player.name} withdrawn from ${week.match_date}.`);
  res.redirect(`/admin/sessions/${req.params.id}`);
});

// --- Stats ------------------------------------------------------------

router.get('/sessions/:id/stats', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  // original_target is snapshotted once at first enrollment and never
  // touched again, even if target_games itself later gets edited down to
  // "remaining open weeks" after a mid-season roster change — see
  // db/index.js's ensureColumn comment. Shown here so the season-long number
  // isn't lost the moment an admin has to resubmit the roster form for an
  // unrelated reason.
  const stats = sessionRosterStats(session.id);
  const roster = stats.map((s) => s.player);

  // Partner matrix. Keyed by week + court + team, not just week + team — with
  // more than one court, "Team A" on court 1 and "Team A" on court 2 are
  // different pairs of people, not the same team, so team alone would
  // wrongly merge two unrelated pairs into a single 4-person "partnership."
  const teams = db
    .prepare(
      `SELECT wa.week_id, wa.court, wa.team, wa.player_id FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id
       WHERE w.session_id = ? AND wa.status != 'subbed_out' ORDER BY wa.week_id, wa.court, wa.team`
    )
    .all(session.id);
  const byWeekTeam = new Map();
  for (const t of teams) {
    const key = `${t.week_id}-${t.court}-${t.team}`;
    if (!byWeekTeam.has(key)) byWeekTeam.set(key, []);
    byWeekTeam.get(key).push(t.player_id);
  }
  const partnerCounts = new Map();
  for (const pair of byWeekTeam.values()) {
    if (pair.length !== 2) continue;
    const key = pair[0] < pair[1] ? `${pair[0]}_${pair[1]}` : `${pair[1]}_${pair[0]}`;
    partnerCounts.set(key, (partnerCounts.get(key) || 0) + 1);
  }

  // "Original player" resolves through sr.requesting_player_id — a snapshot
  // of who was actually on the assignment when this request was created —
  // rather than through the assignment's *current* wa.player_id. Those two
  // can diverge for an old, resolved request once its slot gets reassigned
  // or swapped to someone else later (Reassign, the joint conflict resolver,
  // etc.): joining on the live occupant would silently relabel that history
  // under the new person's name. COALESCE falls back to wa.player_id only
  // for the edge case of a pre-migration row that somehow still has no
  // snapshot (shouldn't happen post-backfill, but defensive regardless).
  const rawSubHistory = db
    .prepare(
      `SELECT sr.id, sr.status, sr.created_at, sr.escalated_at, w.match_date, p.name as original_player
       FROM sub_requests sr JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = COALESCE(sr.requesting_player_id, wa.player_id)
       WHERE w.session_id = ? ORDER BY w.match_date DESC`
    )
    .all(session.id);
  // created_at/escalated_at are plain SQLite datetime('now') -- UTC, same
  // shape as email_log.sent_at/admin_activity_log.created_at -- converted
  // the same way per Kyle's "no UTC anywhere" rule. escalated_at is
  // nullable (only set once a request actually escalates), left as '—' in
  // the view when absent rather than converted.
  const statsTz = getTimezone();
  const subHistory = rawSubHistory.map((s) => {
    const requestedParts = utcToZonedParts(new Date(`${s.created_at.replace(' ', 'T')}Z`), statsTz);
    const escalatedDisplay = s.escalated_at
      ? (() => {
          const p = utcToZonedParts(new Date(`${s.escalated_at.replace(' ', 'T')}Z`), statsTz);
          return `${email.fmtDate(p.date)}, ${email.fmtTime(p.time)}`;
        })()
      : null;
    return {
      ...s,
      requestedDisplay: `${email.fmtDate(requestedParts.date)}, ${email.fmtTime(requestedParts.time)}`,
      escalatedDisplay,
    };
  });

  res.render('admin/stats', { title: 'Stats', session, stats, roster, partnerCounts, subHistory });
});

// --- Players (global roster) ------------------------------------------

router.get('/players', (req, res) => {
  const players = db.prepare('SELECT * FROM players ORDER BY active DESC, name').all();
  res.render('admin/players', { title: 'Players', players, flashMsg: popFlash(req) });
});

router.post('/players', (req, res) => {
  const fieldError = invalidPlayerFields(req.body);
  if (fieldError) {
    flash(req, fieldError, 'error');
    return res.redirect('/admin/players');
  }
  const slugError = invalidSlugField(req.body.slug, null);
  if (slugError) {
    flash(req, slugError, 'error');
    return res.redirect('/admin/players');
  }
  try {
    const name = req.body.name.trim();
    const submittedSlug = (req.body.slug || '').trim();
    const slug = submittedSlug || generateUniqueSlug(db, name, null);
    db.prepare('INSERT INTO players (name, email, slug) VALUES (?, ?, ?)').run(
      name,
      req.body.email.trim(),
      slug
    );
    logActivity(req, { action: 'player.create', description: `Added player ${name} (${req.body.email.trim()})` });
    flash(req, 'Player added.');
  } catch (err) {
    flash(req, `Error: ${err.message}`, 'error');
  }
  res.redirect('/admin/players');
});

router.post('/players/:id/edit', (req, res) => {
  // Pure identity swap: name/email change only, every existing assignment,
  // ball duty slot, and blackout date carries over untouched (Full_Scope_Of_Work.md §7).
  // Slug is deliberately NOT auto-regenerated when the name changes (Kyle,
  // 2026-08-26 — see playerSlug.js's doc comment): a bookmarked/emailed My
  // Page link should keep working through a name correction. It's only
  // touched here if the admin explicitly types a different value into the
  // URL slug field, e.g. to resolve a real "two Brian B's" collision.
  const fieldError = invalidPlayerFields(req.body);
  if (fieldError) {
    flash(req, fieldError, 'error');
    return res.redirect('/admin/players');
  }
  const before = db.prepare('SELECT name, email, slug FROM players WHERE id = ?').get(req.params.id);
  const newName = req.body.name.trim();
  const newEmail = req.body.email.trim();
  const submittedSlug = (req.body.slug || '').trim();
  let newSlug = before ? before.slug : null;
  if (before && submittedSlug && submittedSlug !== before.slug) {
    const slugError = invalidSlugField(submittedSlug, req.params.id);
    if (slugError) {
      flash(req, slugError, 'error');
      return res.redirect('/admin/players');
    }
    newSlug = submittedSlug;
  }
  db.prepare('UPDATE players SET name = ?, email = ?, slug = ? WHERE id = ?').run(
    newName,
    newEmail,
    newSlug,
    req.params.id
  );
  if (before && (before.name !== newName || before.email !== newEmail || before.slug !== newSlug)) {
    logActivity(req, {
      action: 'player.edit',
      description: `Updated player ${before.name} (${before.email}) → ${newName} (${newEmail})${before.slug !== newSlug ? `, URL slug "${before.slug}" → "${newSlug}"` : ''}`,
    });
  }
  flash(req, 'Player identity updated — all existing assignments carried over as-is.');
  res.redirect('/admin/players');
});

router.post('/players/:id/deactivate', (req, res) => {
  const player = db.prepare('SELECT name FROM players WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE players SET active = 0 WHERE id = ?').run(req.params.id);
  logActivity(req, { action: 'player.deactivate', description: `Deactivated player ${player ? player.name : `#${req.params.id}`}` });
  flash(req, 'Player deactivated.');
  res.redirect('/admin/players');
});

router.post('/players/:id/activate', (req, res) => {
  const player = db.prepare('SELECT name FROM players WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE players SET active = 1 WHERE id = ?').run(req.params.id);
  logActivity(req, { action: 'player.activate', description: `Reactivated player ${player ? player.name : `#${req.params.id}`}` });
  flash(req, 'Player reactivated.');
  res.redirect('/admin/players');
});

// --- Broader sub list ---------------------------------------------------

router.get('/sub-list', (req, res) => {
  const list = db.prepare('SELECT * FROM broader_sub_list ORDER BY name').all();
  // Which sessions each master-list person is currently assigned to, purely
  // for visibility on this page — one query rather than one per row. Actual
  // assignment happens on each session's own /subs page, not here. Selects
  // the whole session row (not just id/name) so the view can call
  // sessionFullTitle() on it — Kyle, 2026-08-30: with every session now
  // deliberately given a generic name (see "Dashboard session titles" in
  // CLAUDE.md — day/time/court/club come from the composed title, not the
  // name field anymore), a bare session name alone isn't enough to tell two
  // sessions apart here.
  const rows = db
    .prepare(
      `SELECT ssl.broader_list_id, s.*
       FROM session_sub_list ssl JOIN sessions s ON s.id = ssl.session_id
       WHERE s.archived_at IS NULL ORDER BY s.name`
    )
    .all();
  const sessionsByListId = new Map();
  for (const r of rows) {
    if (!sessionsByListId.has(r.broader_list_id)) sessionsByListId.set(r.broader_list_id, []);
    sessionsByListId.get(r.broader_list_id).push(r);
  }
  res.render('admin/sub_list', { title: 'Broader Sub List', list, sessionsByListId, flashMsg: popFlash(req) });
});

router.post('/sub-list', (req, res) => {
  const fieldError = invalidPlayerFields(req.body);
  if (fieldError) {
    flash(req, fieldError, 'error');
    return res.redirect('/admin/sub-list');
  }
  const slugError = invalidBroaderSubSlugField(req.body.slug, null);
  if (slugError) {
    flash(req, slugError, 'error');
    return res.redirect('/admin/sub-list');
  }
  try {
    const name = req.body.name.trim();
    const submittedSlug = (req.body.slug || '').trim();
    const slug = submittedSlug || generateUniqueBroaderSubSlug(db, name, null);
    db.prepare('INSERT INTO broader_sub_list (name, email, slug) VALUES (?, ?, ?)').run(
      name,
      req.body.email.trim(),
      slug
    );
    logActivity(req, { action: 'sublist.add', description: `Added ${name} (${req.body.email.trim()}) to the broader sub list` });
    flash(req, 'Added to sub list.');
  } catch (err) {
    flash(req, `Error: ${err.message}`, 'error');
  }
  res.redirect('/admin/sub-list');
});

router.post('/sub-list/:id/edit', (req, res) => {
  // Slug deliberately NOT auto-regenerated when the name changes, same
  // reasoning as players.slug (see invalidSlugField's doc comment) —
  // only touched here if the admin explicitly types a different value in,
  // e.g. to resolve a real collision between two pending sub-list entries.
  const fieldError = invalidPlayerFields(req.body);
  if (fieldError) {
    flash(req, fieldError, 'error');
    return res.redirect('/admin/sub-list');
  }
  const before = db.prepare('SELECT name, email, slug FROM broader_sub_list WHERE id = ?').get(req.params.id);
  if (!before) {
    flash(req, 'That sub-list entry no longer exists.', 'error');
    return res.redirect('/admin/sub-list');
  }
  const newName = req.body.name.trim();
  const newEmail = req.body.email.trim();
  const submittedSlug = (req.body.slug || '').trim();
  let newSlug = before.slug;
  if (submittedSlug && submittedSlug !== before.slug) {
    const slugError = invalidBroaderSubSlugField(submittedSlug, req.params.id);
    if (slugError) {
      flash(req, slugError, 'error');
      return res.redirect('/admin/sub-list');
    }
    newSlug = submittedSlug;
  }
  db.prepare('UPDATE broader_sub_list SET name = ?, email = ?, slug = ? WHERE id = ?').run(newName, newEmail, newSlug, req.params.id);
  logActivity(req, {
    action: 'sublist.edit',
    description: `Edited sub-list entry: ${before.name} (${before.email}) → ${newName} (${newEmail})${before.slug !== newSlug ? `, URL slug "${before.slug}" → "${newSlug}"` : ''}`,
  });
  flash(req, 'Sub-list entry updated.');
  res.redirect('/admin/sub-list');
});

router.post('/sub-list/:id/remove', (req, res) => {
  const entry = db.prepare('SELECT name FROM broader_sub_list WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM broader_sub_list WHERE id = ?').run(req.params.id);
  logActivity(req, { action: 'sublist.remove', description: `Removed ${entry ? entry.name : `#${req.params.id}`} from the broader sub list` });
  flash(req, 'Removed from sub list.');
  res.redirect('/admin/sub-list');
});

// --- Per-session sub list ------------------------------------------------
//
// Which master-list people (broader_sub_list) actually get emailed when
// *this* session's sub requests escalate — see subFlow.js's
// sessionSubList()/escalateOverdueRequests() and "Per-session sub list" in
// CLAUDE.md. The master list itself is still managed globally at
// /admin/sub-list; this page just picks a subset of it per session, same
// checkbox-list-tied-to-a-session UX as the ad-hoc roster picker.

router.get('/sessions/:id/subs', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).send('Session not found');
  const masterList = db.prepare('SELECT * FROM broader_sub_list ORDER BY name').all();
  // Real players available to pick as this session's subs (Kyle,
  // 2026-09-02) — every active player EXCEPT anyone already enrolled on
  // this session's own roster, since a player subbing for their own
  // session's own roster makes no sense. Deliberately not scoped to "only
  // players on some OTHER session's roster" — a player with no session at
  // all yet is a legitimate pick too (e.g. someone the admin knows can
  // sub around but hasn't put on any roster).
  const playerList = db
    .prepare(
      `SELECT * FROM players WHERE active = 1 AND id NOT IN (SELECT player_id FROM session_players WHERE session_id = ?) ORDER BY name`
    )
    .all(session.id);
  // Read the two join tables directly for checkbox state rather than
  // subFlow.sessionSubList()'s combined shape — that list mixes
  // broader_sub_list and players rows together, whose `id` columns can
  // collide (broader_sub_list id 1 and players id 1 are unrelated rows),
  // so a single merged Set would mark the wrong checkboxes.
  const assignedBroaderIds = new Set(
    db.prepare('SELECT broader_list_id FROM session_sub_list WHERE session_id = ?').all(session.id).map((r) => r.broader_list_id)
  );
  const assignedPlayerIds = new Set(
    db.prepare('SELECT player_id FROM session_sub_players WHERE session_id = ?').all(session.id).map((r) => r.player_id)
  );
  res.render('admin/session_subs', {
    title: 'Session Subs',
    session,
    masterList,
    playerList,
    assignedBroaderIds,
    assignedPlayerIds,
    flashMsg: popFlash(req),
  });
});

router.post('/sessions/:id/subs', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).send('Session not found');
  const selectedBroaderIds = [].concat(req.body.sub_ids || []).map(Number);
  const selectedPlayerIds = [].concat(req.body.player_ids || []).map(Number);
  db.transaction(() => {
    db.prepare('DELETE FROM session_sub_list WHERE session_id = ?').run(session.id);
    const insertBroader = db.prepare('INSERT OR IGNORE INTO session_sub_list (session_id, broader_list_id) VALUES (?, ?)');
    for (const id of selectedBroaderIds) insertBroader.run(session.id, id);
    db.prepare('DELETE FROM session_sub_players WHERE session_id = ?').run(session.id);
    const insertPlayer = db.prepare('INSERT OR IGNORE INTO session_sub_players (session_id, player_id) VALUES (?, ?)');
    for (const id of selectedPlayerIds) insertPlayer.run(session.id, id);
  })();
  const total = selectedBroaderIds.length + selectedPlayerIds.length;
  logActivity(req, {
    action: 'subs.session_assign',
    description: `Set ${total} sub(s) for ${email.sessionFullTitle(session)} (${selectedBroaderIds.length} from the broader list, ${selectedPlayerIds.length} players)`,
    sessionId: session.id,
  });
  flash(req, `Sub list updated for ${session.name} — ${total} assigned.`);
  res.redirect(`/admin/sessions/${session.id}/subs`);
});

// --- Custom email ---------------------------------------------------------

router.get('/email', (req, res) => {
  const players = db.prepare('SELECT * FROM players WHERE active = 1 ORDER BY name').all();
  const sessions = db.prepare(`SELECT * FROM sessions ${SESSION_DISPLAY_ORDER}`).all();
  const templates = testEmail.listTemplates();
  res.render('admin/custom_email', { title: 'Send Email', players, sessions, templates, flashMsg: popFlash(req) });
});

// recipient_type='session' fans the same message out to every active
// player currently on that session's roster (session_players — the same
// "who's the roster" query used everywhere else in this app: blackout
// notices, ad-hoc invites, etc.), instead of a single player_id. One
// sendCustomEmail() call per recipient, so email_log gets one row per
// person same as any other bulk send — nothing new to reconcile there.
//
// recipient_type='template_test' (Kyle, 2026-09-01: "Is there a way to send
// test messages for all the email templates we've made?... if we wanted to
// send a test email to confirm an email is working to someone on the
// roster, we could") is a third, distinct branch — it doesn't touch
// subject/body at all, it fires one of the app's real ~21 email templates
// (reminder, sub request, swap, ad-hoc, admin report, etc.) at a chosen
// roster player via testEmail.js's sendTestEmail(), which builds real-ish
// content from that player's own current schedule but forces every send
// into "test mode" (see email.js's sendMail() and testEmail.js's own doc
// comment) — a distinct 'test' email_log category so it can never satisfy a
// cron dedup check, and fake/inert tokens so no link in the email can
// actually mutate anything if clicked. Default behavior for this page (the
// two branches above) is completely unchanged.
router.post('/email', asyncHandler(async (req, res) => {
  if (req.body.recipient_type === 'template_test') {
    const result = await testEmail.sendTestEmail(req.body.template_key, Number(req.body.test_player_id) || 0);
    if (!result.ok) {
      flash(req, result.error || 'Could not send test email.', 'error');
      return res.redirect('/admin/email');
    }
    const tpl = testEmail.TEMPLATES[req.body.template_key];
    const player = db.prepare('SELECT name FROM players WHERE id = ?').get(Number(req.body.test_player_id) || 0);
    flash(req, `Test email ("${tpl ? tpl.label : req.body.template_key}") sent to ${player ? player.name : 'player'}. Links in it are inert — clicking them won't confirm, claim, or change anything real.`);
    return res.redirect('/admin/email');
  }

  const subject = req.body.subject;
  const body = req.body.body;

  // recipient_type='week' (Kyle, 2026-09-02: "pick a session and be able to
  // email all the players scheduled (or subbed in) for that week. If the
  // scheduled match that week has past, it selects the next weeks scheduled
  // (or subbed in) players. All players should be in the to field.") — unlike
  // every other recipient mode here (one sendCustomEmail() call per person),
  // this is genuinely one email with every recipient in the same `to` field,
  // since Kyle explicitly asked for that rather than individual sends.
  // "Scheduled (or subbed in)" -> week_assignments.status IN
  // ('scheduled','confirmed') — this naturally excludes 'needs_sub' (not
  // actually playing until someone replaces them) and 'subbed_out' (already
  // replaced; the sub who took over shows up as their own 'confirmed' or
  // 'scheduled' row instead). "If that week has past, the next week" reuses
  // weeks.locked exactly as cron.js's processWeekLocking() already
  // maintains it — the earliest not-yet-locked week for this session is
  // "the next one that hasn't happened yet", so no separate date math is
  // needed here.
  if (req.body.recipient_type === 'week') {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(req.body.week_session_id) || 0);
    if (!session) {
      flash(req, 'Session not found.', 'error');
      return res.redirect('/admin/email');
    }
    const week = db
      .prepare('SELECT * FROM weeks WHERE session_id = ? AND locked = 0 ORDER BY match_date ASC LIMIT 1')
      .get(session.id);
    if (!week) {
      flash(req, `No upcoming (unlocked) week found for "${session.name}" — nothing sent.`, 'error');
      return res.redirect('/admin/email');
    }
    const roster = db
      .prepare(
        `SELECT p.* FROM week_assignments wa JOIN players p ON p.id = wa.player_id
         WHERE wa.week_id = ? AND wa.status IN ('scheduled', 'confirmed') ORDER BY p.name`
      )
      .all(week.id);
    if (roster.length === 0) {
      flash(req, `Nobody is currently scheduled or confirmed for "${session.name}"'s ${week.match_date} match — nothing sent.`, 'error');
      return res.redirect('/admin/email');
    }
    // A one-time sub with no real email on file (see "One-time sub" in
    // CLAUDE.md) shouldn't end up literally in the To: field — sendMail()
    // already no-ops a single send to a @no-email.invalid address, but that
    // guard doesn't apply to one address buried inside a joined multi-address
    // string, so it's filtered out here before joining.
    const recipients = roster.filter((p) => !p.email.endsWith('@no-email.invalid'));
    if (recipients.length === 0) {
      flash(req, `Everyone scheduled for "${session.name}"'s ${week.match_date} match has no email on file — nothing sent.`, 'error');
      return res.redirect('/admin/email');
    }
    const toList = recipients.map((p) => p.email).join(', ');
    await email.sendCustomEmail({ to: toList, subject, body, session, week });
    flash(req, `Email sent to ${recipients.length} player(s) scheduled for "${session.name}" on ${week.match_date} (all in one To: field).`);
    return res.redirect('/admin/email');
  }

  if (req.body.recipient_type === 'session') {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(req.body.session_id) || 0);
    if (!session) {
      flash(req, 'Session not found.', 'error');
      return res.redirect('/admin/email');
    }
    const roster = db
      .prepare(
        `SELECT p.* FROM session_players sp JOIN players p ON p.id = sp.player_id
         WHERE sp.session_id = ? AND p.active = 1 ORDER BY p.name`
      )
      .all(session.id);
    if (roster.length === 0) {
      flash(req, `No active players enrolled in "${session.name}" — nothing sent.`, 'error');
      return res.redirect('/admin/email');
    }
    for (const player of roster) {
      await email.sendCustomEmail({ to: player.email, subject, body, session });
    }
    flash(req, `Email sent to ${roster.length} player(s) in "${session.name}".`);
    return res.redirect('/admin/email');
  }

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.body.player_id);
  if (!player) {
    flash(req, 'Player not found.', 'error');
    return res.redirect('/admin/email');
  }
  await email.sendCustomEmail({ to: player.email, subject, body });
  flash(req, `Email sent to ${player.name}.`);
  res.redirect('/admin/email');
}));

// --- Email log / reporting -------------------------------------------------

router.get('/email-log', (req, res) => {
  const { category, status, q } = req.query;

  const clauses = [];
  const params = [];
  if (category) {
    clauses.push('el.category = ?');
    params.push(category);
  }
  if (status) {
    clauses.push('el.status = ?');
    params.push(status);
  }
  if (q) {
    clauses.push('el.to_email LIKE ?');
    params.push(`%${q}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // Selects the session's own day/time/court/club columns alongside name (not
  // s.*, which would collide with el.id) so the view can call
  // sessionFullTitle() on each row's linked session — same fix already
  // applied to the Activity Log, Sub List, and All Blackout Dates pages, and
  // now a standing rule (Kyle, 2026-09-02): wherever a session name is shown,
  // include name/day/time/court/club together, not the bare name alone.
  const rows = db
    .prepare(
      `SELECT el.*, w.match_date, s.id as session_id, s.name as session_name,
              s.match_day_of_week as session_match_day_of_week, s.match_time as session_match_time,
              s.court_info as session_court_info, s.club_name as session_club_name
       FROM email_log el
       LEFT JOIN weeks w ON w.id = el.related_week_id
       LEFT JOIN sessions s ON s.id = w.session_id
       ${where}
       ORDER BY el.sent_at DESC
       LIMIT 300`
    )
    .all(...params);
  rows.forEach((r) => {
    r.sessionForTitle = r.session_id && r.session_name
      ? {
          name: r.session_name,
          match_day_of_week: r.session_match_day_of_week,
          match_time: r.session_match_time,
          court_info: r.session_court_info,
          club_name: r.session_club_name,
        }
      : null;
  });

  // email_log.sent_at is stored via SQLite's plain `datetime('now')`, which
  // is UTC — never converted anywhere on the way in (see schema.sql and
  // email.js's sendMail()). Kyle, 2026-08-28, asking whether this page shows
  // UTC or local: it was UTC, unconverted, unlike every other time shown to
  // a human elsewhere in the app (match/reminder times, the Status page's
  // upcoming-actions preview) which all go through tz.js first. Converted
  // here to the app's one configured timezone (app_settings, same value
  // every other display conversion uses) via the same utcToZonedParts()
  // built for the Status page's lead-hours preview — the stored string has
  // no 'Z'/'T', so it's explicitly parsed as UTC first (a bare
  // 'YYYY-MM-DD HH:MM:SS' string would otherwise be parsed as *local server
  // time* by JS's Date constructor, which is wrong here since it's UTC).
  const emailLogTz = getTimezone();
  rows.forEach((r) => {
    const utcInstant = new Date(`${r.sent_at.replace(' ', 'T')}Z`);
    const parts = utcToZonedParts(utcInstant, emailLogTz);
    r.sentDateDisplay = email.fmtDate(parts.date);
    r.sentTimeDisplay = email.fmtTime(parts.time);
  });

  const categories = db.prepare('SELECT DISTINCT category FROM email_log ORDER BY category').all().map((r) => r.category);
  const counts = db
    .prepare('SELECT status, COUNT(*) as n FROM email_log GROUP BY status')
    .all()
    .reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});

  res.render('admin/email_log', {
    title: 'Email Log',
    wideMain: true,
    rows,
    categories,
    counts,
    filters: { category: category || '', status: status || '', q: q || '' },
    emailLogTz,
  });
});

// --- Admin activity log ----------------------------------------------------
// Read-only history of admin-triggered changes — see activityLog.js and the
// admin_activity_log table in schema.sql for what gets logged and why.
router.get('/activity-log', (req, res) => {
  const { session: sessionId, action, admin, q } = req.query;

  const clauses = [];
  const params = [];
  if (sessionId) {
    clauses.push('al.session_id = ?');
    params.push(sessionId);
  }
  if (action) {
    clauses.push('al.action = ?');
    params.push(action);
  }
  if (admin) {
    clauses.push('al.admin_name = ?');
    params.push(admin);
  }
  if (q) {
    clauses.push('al.description LIKE ?');
    params.push(`%${q}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // Selects the session's own name/day/time/court/club columns (not s.*,
  // which would collide with al.id) so the view can call sessionFullTitle()
  // on each row's linked session — Kyle, 2026-08-31: with every session now
  // deliberately given a generic internal name (see "Dashboard session
  // titles" in CLAUDE.md), the bare name alone wasn't enough to tell two
  // sessions apart here, same fix already applied to the Sub List and All
  // Blackout Dates pages.
  const rawRows = db
    .prepare(
      `SELECT al.*, s.name as session_name, s.match_day_of_week as session_match_day_of_week,
              s.match_time as session_match_time, s.court_info as session_court_info,
              s.club_name as session_club_name
       FROM admin_activity_log al
       LEFT JOIN sessions s ON s.id = al.session_id
       ${where}
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT 300`
    )
    .all(...params);
  // created_at is plain SQLite datetime('now') -- UTC, same shape as
  // email_log.sent_at -- so it needs the identical explicit-UTC-parse +
  // utcToZonedParts() conversion before display, per Kyle's "no UTC anywhere"
  // rule. This page's "When" column had never been converted at all before.
  const activityLogTz = getTimezone();
  const rows = rawRows.map((r) => {
    const utcInstant = new Date(`${r.created_at.replace(' ', 'T')}Z`);
    const parts = utcToZonedParts(utcInstant, activityLogTz);
    return {
      ...r,
      createdDisplay: `${email.fmtDate(parts.date)}, ${email.fmtTime(parts.time)}`,
      sessionForTitle: r.session_id && r.session_name
        ? {
            name: r.session_name,
            match_day_of_week: r.session_match_day_of_week,
            match_time: r.session_match_time,
            court_info: r.session_court_info,
            club_name: r.session_club_name,
          }
        : null,
    };
  });

  const actions = db.prepare('SELECT DISTINCT action FROM admin_activity_log ORDER BY action').all().map((r) => r.action);
  const admins = db.prepare('SELECT DISTINCT admin_name FROM admin_activity_log ORDER BY admin_name').all().map((r) => r.admin_name);
  // Full session rows (not just id/name) so the filter dropdown can also
  // show the composed title, same reasoning as above.
  const sessions = db.prepare(`SELECT * FROM sessions ${SESSION_DISPLAY_ORDER}`).all();

  res.render('admin/activity_log', {
    title: 'Activity Log',
    wideMain: true,
    rows,
    actions,
    admins,
    sessions,
    filters: { session: sessionId || '', action: action || '', admin: admin || '', q: q || '' },
  });
});

module.exports = router;
