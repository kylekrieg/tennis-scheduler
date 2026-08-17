'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../middleware/adminAuth');
const { findAdminByPassword, hashPassword } = require('../services/auth');
const { getTimezone, setTimezone } = require('../services/settings');
const { zonedTimeToUtc } = require('../services/tz');
const { runScheduler, ensureWeeksExist } = require('../services/scheduleRun');
const adhocFlow = require('../services/adhocFlow');
const { generateRawToken, hashToken } = require('../services/tokens');
const tokenStore = require('../services/tokenStore');
const email = require('../services/email');
const subFlow = require('../services/subFlow');
const cron = require('../services/cron');
const backup = require('../services/backup');
const statusPage = require('../services/statusPage');
const { findOverlappingSessionEnrollments, findActualDoubleBookings, doubleBookingMapForSession, carriedOverBlackoutsForSession } = require('../services/sessionHelper');
const { logActivity } = require('../services/activityLog');
const swapFlow = require('../services/swapFlow');
const { asyncHandler } = require('../middleware/asyncHandler');

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

router.post('/login', (req, res) => {
  const admin = findAdminByPassword(req.body.password);
  if (admin) {
    req.session.isAdmin = true;
    req.session.adminId = admin.id;
    req.session.adminName = admin.name;
    return res.redirect('/admin');
  }
  res.render('admin/login', { title: 'Admin Login', error: 'Incorrect password.' });
});

router.post('/logout', (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin/login');
});

router.use(requireAdmin);

// --- Dashboard ----------------------------------------------------------

router.get('/', (req, res) => {
  const sessions = db.prepare("SELECT * FROM sessions WHERE archived_at IS NULL AND session_type = 'regular' ORDER BY start_date DESC").all();
  // Ad-hoc sessions have none of the flags below (no targets, no blackout,
  // no confirm/sub flow) — a simpler, separate section instead of trying to
  // force them through the same flags shape. See "Ad-hoc sessions" in
  // CLAUDE.md.
  const adhocSessions = db
    .prepare("SELECT * FROM sessions WHERE archived_at IS NULL AND session_type = 'adhoc' ORDER BY start_date DESC")
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
    return { session: s, unconfirmed, unfilledSubs, unfilledBallDuty, needsAttention, conflicts, overlapping, doubleBooked, staleSwaps };
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

router.post('/sessions/:id/archive', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).send('Session not found');
  db.prepare(`UPDATE sessions SET archived_at = datetime('now') WHERE id = ?`).run(session.id);
  logActivity(req, { action: 'session.archive', description: `Archived session "${session.name}"`, sessionId: session.id });
  flash(req, `"${session.name}" archived — hidden from the dashboard and player-facing pages, but nothing was deleted.`);
  res.redirect('/admin');
});

router.post('/sessions/:id/unarchive', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).send('Session not found');
  db.prepare('UPDATE sessions SET archived_at = NULL WHERE id = ?').run(session.id);
  logActivity(req, { action: 'session.unarchive', description: `Restored session "${session.name}" from archive`, sessionId: session.id });
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
  logActivity(req, { action: 'session.lock_schedule', description: `Locked the schedule for "${session.name}"`, sessionId: session.id });
  flash(req, `"${session.name}"'s schedule is locked — this doesn't stop you from making further changes, it's just a marker that this version is the one you're standing behind.`);
  res.redirect(`/admin/sessions/${session.id}`);
});

router.post('/sessions/:id/unlock-schedule', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).send('Session not found');
  db.prepare('UPDATE sessions SET schedule_locked_at = NULL WHERE id = ?').run(session.id);
  logActivity(req, { action: 'session.unlock_schedule', description: `Unlocked the schedule for "${session.name}"`, sessionId: session.id });
  flash(req, `"${session.name}"'s schedule is unlocked again.`);
  res.redirect(`/admin/sessions/${session.id}`);
});

router.get('/settings', (req, res) => {
  res.render('admin/settings', {
    title: 'Settings',
    timezone: getTimezone(),
    flashMsg: popFlash(req),
  });
});

router.post('/settings', (req, res) => {
  const oldTz = getTimezone();
  setTimezone(req.body.timezone);
  if (oldTz !== req.body.timezone) {
    logActivity(req, { action: 'settings.timezone', description: `Changed timezone from ${oldTz} to ${req.body.timezone}` });
  }
  flash(req, 'Settings updated.');
  res.redirect('/admin/settings');
});

// --- Admin accounts ---------------------------------------------------

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
  db.prepare('INSERT INTO admins (name, email, password_hash, active) VALUES (?, ?, ?, 1)').run(
    name,
    req.body.email || null,
    hashPassword(password)
  );
  logActivity(req, { action: 'admin.create', description: `Added admin "${name}"` });
  flash(req, `${name} added — they can log in at /admin with the password you just set.`);
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
  res.render('admin/backup', {
    title: 'Backup',
    backups: backup.listBackups(),
    retention: backup.DEFAULT_RETENTION,
    flashMsg: popFlash(req),
  });
});

router.post('/backup', (req, res) => {
  try {
    const result = backup.createBackup();
    backup.pruneBackups(backup.DEFAULT_RETENTION);
    flash(req, `Backup created: ${result.filename} (${(result.size / 1024).toFixed(1)} KB). Download it below and save it somewhere off this Pi.`);
  } catch (err) {
    flash(req, `Backup failed: ${err.message}`, 'error');
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
  res.download(filePath, filename);
});

router.post('/backup/:filename/delete', (req, res) => {
  const { filename } = req.params;
  if (!backup.isValidBackupFilename(filename)) return res.status(400).send('Invalid filename');
  const filePath = path.join(backup.BACKUP_DIR, filename);
  if (path.dirname(filePath) === backup.BACKUP_DIR && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    flash(req, 'Backup deleted.');
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

// Ad-hoc sessions (session_type = 'adhoc') have no target-games math to
// validate, but do have three lead-hour fields (see "Ad-hoc sessions" in
// CLAUDE.md) that need to count down in the same order Kyle actually runs
// them — invite, then a reminder if sign-ups are still short, then the
// final roster/"not enough" email — or the timing wouldn't make sense
// (e.g. a "reminder" that fires after the "final" email already went out).
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
  const info = db
    .prepare(
      `INSERT INTO sessions (name, start_date, end_date, match_day_of_week, match_time, reminder_time,
        reminder_days_before, reminders_enabled, courts, players_per_week, lookahead_weeks, club_name, court_info, color,
        session_type, adhoc_invite_lead_hours, adhoc_reminder_lead_hours, adhoc_final_lead_hours, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      b.name,
      b.start_date,
      b.end_date,
      Number(b.match_day_of_week),
      b.match_time,
      b.reminder_time,
      Number(b.reminder_days_before || 2),
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
    description: `Created ${sessionType === 'adhoc' ? 'ad-hoc ' : ''}session "${b.name}"`,
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
  db.prepare(
    `UPDATE sessions SET name=?, start_date=?, end_date=?, match_day_of_week=?, match_time=?, reminder_time=?,
     reminder_days_before=?, reminders_enabled=?, courts=?, players_per_week=?, lookahead_weeks=?, club_name=?, court_info=?, color=?,
     adhoc_invite_lead_hours=?, adhoc_reminder_lead_hours=?, adhoc_final_lead_hours=? WHERE id=?`
  ).run(
    b.name,
    b.start_date,
    b.end_date,
    Number(b.match_day_of_week),
    b.match_time,
    b.reminder_time,
    Number(b.reminder_days_before || 2),
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
    req.params.id
  );
  if (sessionType === 'adhoc') {
    saveAdhocRoster(req.params.id, b);
  } else {
    saveRoster(req.params.id, b);
  }
  logActivity(req, { action: 'session.update', description: `Updated session "${b.name}" (dates, roster, or settings)`, sessionId: Number(req.params.id) });
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
    if (!result.feasible) {
      logActivity(req, {
        action: 'session.schedule_failed',
        description: `Ran "Schedule these players" — failed with ${result.conflicts.length} conflict(s)`,
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
      logActivity(req, { action: 'session.schedule', description: `Ran "Schedule these players": ${msg}`, sessionId: Number(req.params.id) });
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
  logActivity(req, { action: 'session.delete', description: `Deleted session "${session.name}"` });
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
    const openSubRequest = db
      .prepare(
        `SELECT sr.* FROM sub_requests sr JOIN week_assignments wa ON wa.id = sr.week_assignment_id
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
      openSubRequest,
      openSwapRequest,
      blackedOutNames: blackedOutByDate.get(w.match_date) || [],
    };
  });

  const conflicts = session.schedule_conflicts ? JSON.parse(session.schedule_conflicts) : [];
  const overlapConflicts = findOverlappingSessionEnrollments(session.id);
  const doubleBookings = findActualDoubleBookings(session.id);

  res.render('admin/session_detail', {
    title: session.name,
    session,
    weekRows,
    roster,
    conflicts,
    overlapConflicts,
    doubleBookings,
    multiCourt: session.players_per_week > 4,
    flashMsg: popFlash(req),
  });
});

router.post('/sessions/:id/weeks/:weekId/reassign', (req, res) => {
  const { assignment_id, new_player_id } = req.body;
  const assignment = db.prepare('SELECT * FROM week_assignments WHERE id = ?').get(assignment_id);
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(req.params.weekId);
  if (!assignment || !week) return res.status(404).send('Not found');

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
  // side effect of resolving the underlying assignment (see
  // subFlow.closeActiveSubRequestForAssignment) — this route is for when the
  // admin just wants the "sub open" flag gone directly, without necessarily
  // touching who's assigned to that slot (e.g. an already-stuck flag from
  // before that fix existed, or a case that was actually sorted out outside
  // the app). Only one open/escalated/unfilled sub_requests row can exist
  // per week at a time (hasActiveConcurrentSubRequest), so weekId alone is
  // enough to find it.
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
  logActivity(req, {
    action: 'week.clear_sub_request',
    description: `Cleared sub request for ${active.player_name}'s ${email.fmtDate(active.match_date)} slot`,
    sessionId: Number(req.params.id),
  });
  flash(req, 'Sub request cleared — its invite links are now dead. If that slot still needs a player, use Reassign below.');
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
  const assignment = db.prepare('SELECT wa.*, p.name, p.email FROM week_assignments wa JOIN players p ON p.id = wa.player_id WHERE wa.id = ?').get(req.params.assignmentId);
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

router.get('/sessions/:id/blackouts', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (session.status === 'draft') ensureWeeksExist(session.id); // see note in public.js's /blackout route
  const roster = db
    .prepare(`SELECT p.* FROM session_players sp JOIN players p ON p.id = sp.player_id WHERE sp.session_id = ? ORDER BY p.name`)
    .all(session.id);
  const weeks = db.prepare('SELECT * FROM weeks WHERE session_id = ? ORDER BY match_date').all(session.id);
  const selectedPlayerId = Number(req.query.player) || null;
  let existing = new Set();
  if (selectedPlayerId) {
    existing = new Set(
      db.prepare('SELECT date FROM blackout_dates WHERE session_id = ? AND player_id = ?').all(session.id, selectedPlayerId).map((r) => r.date)
    );
  }

  // All blackout dates for the whole session, grouped by player, for the
  // summary list — one query rather than one per roster player.
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

  // Carried over from another session's real blackout dates (see
  // sessionHelper.js's carriedOverBlackoutsForSession()) — a player doesn't
  // need to re-enter a date here if it's already blacked out for them
  // elsewhere on the same calendar date. Grouped by player for the summary
  // list, same shape as blackoutsByPlayer above, plus a flat Map for the
  // per-player edit checklist below.
  const carriedOverMap = carriedOverBlackoutsForSession(session.id);
  const carriedOverByPlayer = [];
  if (carriedOverMap.size > 0) {
    const nameById = new Map(roster.map((p) => [p.id, p.name]));
    const byPlayer = new Map();
    for (const [key, srcSession] of carriedOverMap.entries()) {
      const [playerId, date] = key.split('|');
      const name = nameById.get(Number(playerId));
      if (!name) continue; // not on this session's current roster
      let entry = byPlayer.get(playerId);
      if (!entry) {
        entry = { name, items: [] };
        byPlayer.set(playerId, entry);
        carriedOverByPlayer.push(entry);
      }
      entry.items.push({ date, sourceName: srcSession.name });
    }
  }

  res.render('admin/blackouts', {
    title: 'Blackout Dates',
    session,
    roster,
    weeks,
    selectedPlayerId,
    existing,
    blackoutsByPlayer,
    carriedOverByPlayer,
    carriedOverMap,
    flashMsg: popFlash(req),
  });
});

router.post('/sessions/:id/blackouts', (req, res) => {
  const sessionId = req.params.id;
  const playerId = Number(req.body.player_id);
  const dates = [].concat(req.body.dates || []);
  db.transaction(() => {
    db.prepare('DELETE FROM blackout_dates WHERE session_id = ? AND player_id = ?').run(sessionId, playerId);
    const insert = db.prepare('INSERT OR IGNORE INTO blackout_dates (session_id, player_id, date, source) VALUES (?, ?, ?, ?)');
    for (const d of dates) insert.run(sessionId, playerId, d, 'admin');
  })();
  const blackoutPlayer = db.prepare('SELECT name FROM players WHERE id = ?').get(playerId);
  logActivity(req, {
    action: 'blackout.admin_edit',
    description: `Set ${dates.length} blackout date(s) for ${blackoutPlayer ? blackoutPlayer.name : `player #${playerId}`}`,
    sessionId: Number(sessionId),
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
  const roster = db
    .prepare(`SELECT p.* FROM session_players sp JOIN players p ON p.id = sp.player_id WHERE sp.session_id = ? ORDER BY p.name`)
    .all(session.id);
  const targets = db
    .prepare('SELECT player_id, target_games, original_target FROM session_players WHERE session_id = ?')
    .all(session.id);
  const targetMap = new Map(targets.map((t) => [t.player_id, t.target_games]));
  // original_target is snapshotted once at first enrollment and never
  // touched again, even if target_games itself later gets edited down to
  // "remaining open weeks" after a mid-season roster change — see
  // db/index.js's ensureColumn comment. Shown here so the season-long number
  // isn't lost the moment an admin has to resubmit the roster form for an
  // unrelated reason.
  const originalTargetMap = new Map(targets.map((t) => [t.player_id, t.original_target]));

  const playedCounts = db
    .prepare(
      `SELECT player_id, COUNT(*) as n FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id
       WHERE w.session_id = ? AND wa.status != 'subbed_out' AND wa.is_sub = 0 GROUP BY player_id`
    )
    .all(session.id);
  const playedMap = new Map(playedCounts.map((r) => [r.player_id, r.n]));

  const subBonusCounts = db
    .prepare(
      `SELECT player_id, COUNT(*) as n FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id
       WHERE w.session_id = ? AND wa.is_sub = 1 AND wa.status != 'subbed_out' GROUP BY player_id`
    )
    .all(session.id);
  const subBonusMap = new Map(subBonusCounts.map((r) => [r.player_id, r.n]));

  const ballDutyCounts = db
    .prepare(
      `SELECT ball_duty_player_id as player_id, COUNT(*) as n FROM weeks
       WHERE session_id = ? AND ball_duty_player_id IS NOT NULL GROUP BY ball_duty_player_id`
    )
    .all(session.id);
  const ballDutyMap = new Map(ballDutyCounts.map((r) => [r.player_id, r.n]));

  const stats = roster.map((p) => ({
    player: p,
    target: targetMap.get(p.id) || 0,
    originalTarget: originalTargetMap.get(p.id),
    played: playedMap.get(p.id) || 0,
    subBonus: subBonusMap.get(p.id) || 0,
    ballDuty: ballDutyMap.get(p.id) || 0,
  }));

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

  const subHistory = db
    .prepare(
      `SELECT sr.id, sr.status, sr.created_at, sr.escalated_at, w.match_date, p.name as original_player
       FROM sub_requests sr JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       JOIN weeks w ON w.id = wa.week_id JOIN players p ON p.id = wa.player_id
       WHERE w.session_id = ? ORDER BY w.match_date DESC`
    )
    .all(session.id);

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
  try {
    db.prepare('INSERT INTO players (name, email) VALUES (?, ?)').run(
      req.body.name.trim(),
      req.body.email.trim()
    );
    logActivity(req, { action: 'player.create', description: `Added player ${req.body.name.trim()} (${req.body.email.trim()})` });
    flash(req, 'Player added.');
  } catch (err) {
    flash(req, `Error: ${err.message}`, 'error');
  }
  res.redirect('/admin/players');
});

router.post('/players/:id/edit', (req, res) => {
  // Pure identity swap: name/email change only, every existing assignment,
  // ball duty slot, and blackout date carries over untouched (Full_Scope_Of_Work.md §7).
  const fieldError = invalidPlayerFields(req.body);
  if (fieldError) {
    flash(req, fieldError, 'error');
    return res.redirect('/admin/players');
  }
  const before = db.prepare('SELECT name, email FROM players WHERE id = ?').get(req.params.id);
  const newName = req.body.name.trim();
  const newEmail = req.body.email.trim();
  db.prepare('UPDATE players SET name = ?, email = ? WHERE id = ?').run(
    newName,
    newEmail,
    req.params.id
  );
  if (before && (before.name !== newName || before.email !== newEmail)) {
    logActivity(req, {
      action: 'player.edit',
      description: `Updated player ${before.name} (${before.email}) → ${newName} (${newEmail})`,
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
  // assignment happens on each session's own /subs page, not here.
  const rows = db
    .prepare(
      `SELECT ssl.broader_list_id, s.id as session_id, s.name as session_name
       FROM session_sub_list ssl JOIN sessions s ON s.id = ssl.session_id
       WHERE s.archived_at IS NULL ORDER BY s.name`
    )
    .all();
  const sessionsByListId = new Map();
  for (const r of rows) {
    if (!sessionsByListId.has(r.broader_list_id)) sessionsByListId.set(r.broader_list_id, []);
    sessionsByListId.get(r.broader_list_id).push({ id: r.session_id, name: r.session_name });
  }
  res.render('admin/sub_list', { title: 'Broader Sub List', list, sessionsByListId, flashMsg: popFlash(req) });
});

router.post('/sub-list', (req, res) => {
  const fieldError = invalidPlayerFields(req.body);
  if (fieldError) {
    flash(req, fieldError, 'error');
    return res.redirect('/admin/sub-list');
  }
  try {
    db.prepare('INSERT INTO broader_sub_list (name, email) VALUES (?, ?)').run(
      req.body.name.trim(),
      req.body.email.trim()
    );
    logActivity(req, { action: 'sublist.add', description: `Added ${req.body.name.trim()} (${req.body.email.trim()}) to the broader sub list` });
    flash(req, 'Added to sub list.');
  } catch (err) {
    flash(req, `Error: ${err.message}`, 'error');
  }
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
  const assigned = new Set(subFlow.sessionSubList(session.id).map((s) => s.id));
  res.render('admin/session_subs', { title: 'Session Subs', session, masterList, assigned, flashMsg: popFlash(req) });
});

router.post('/sessions/:id/subs', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).send('Session not found');
  const selectedIds = [].concat(req.body.sub_ids || []).map(Number);
  db.transaction(() => {
    db.prepare('DELETE FROM session_sub_list WHERE session_id = ?').run(session.id);
    const insert = db.prepare('INSERT OR IGNORE INTO session_sub_list (session_id, broader_list_id) VALUES (?, ?)');
    for (const id of selectedIds) insert.run(session.id, id);
  })();
  logActivity(req, {
    action: 'subs.session_assign',
    description: `Set ${selectedIds.length} sub(s) for ${session.name}`,
    sessionId: session.id,
  });
  flash(req, `Sub list updated for ${session.name} — ${selectedIds.length} assigned.`);
  res.redirect(`/admin/sessions/${session.id}/subs`);
});

// --- Custom email ---------------------------------------------------------

router.get('/email', (req, res) => {
  const players = db.prepare('SELECT * FROM players WHERE active = 1 ORDER BY name').all();
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY start_date DESC').all();
  res.render('admin/custom_email', { title: 'Send Email', players, sessions, flashMsg: popFlash(req) });
});

// recipient_type='session' fans the same message out to every active
// player currently on that session's roster (session_players — the same
// "who's the roster" query used everywhere else in this app: blackout
// notices, ad-hoc invites, etc.), instead of a single player_id. One
// sendCustomEmail() call per recipient, so email_log gets one row per
// person same as any other bulk send — nothing new to reconcile there.
router.post('/email', asyncHandler(async (req, res) => {
  const subject = req.body.subject;
  const body = req.body.body;

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

  const rows = db
    .prepare(
      `SELECT el.*, w.match_date, s.id as session_id, s.name as session_name
       FROM email_log el
       LEFT JOIN weeks w ON w.id = el.related_week_id
       LEFT JOIN sessions s ON s.id = w.session_id
       ${where}
       ORDER BY el.sent_at DESC
       LIMIT 300`
    )
    .all(...params);

  const categories = db.prepare('SELECT DISTINCT category FROM email_log ORDER BY category').all().map((r) => r.category);
  const counts = db
    .prepare('SELECT status, COUNT(*) as n FROM email_log GROUP BY status')
    .all()
    .reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});

  res.render('admin/email_log', {
    title: 'Email Log',
    rows,
    categories,
    counts,
    filters: { category: category || '', status: status || '', q: q || '' },
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

  const rows = db
    .prepare(
      `SELECT al.*, s.name as session_name
       FROM admin_activity_log al
       LEFT JOIN sessions s ON s.id = al.session_id
       ${where}
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT 300`
    )
    .all(...params);

  const actions = db.prepare('SELECT DISTINCT action FROM admin_activity_log ORDER BY action').all().map((r) => r.action);
  const admins = db.prepare('SELECT DISTINCT admin_name FROM admin_activity_log ORDER BY admin_name').all().map((r) => r.admin_name);
  const sessions = db.prepare('SELECT id, name FROM sessions ORDER BY start_date DESC').all();

  res.render('admin/activity_log', {
    title: 'Activity Log',
    rows,
    actions,
    admins,
    sessions,
    filters: { session: sessionId || '', action: action || '', admin: admin || '', q: q || '' },
  });
});

module.exports = router;
