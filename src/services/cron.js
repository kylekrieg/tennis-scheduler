'use strict';
const db = require('../db');
const { zonedTimeToUtc, addDays } = require('./tz');
const { getTimezone } = require('./settings');
const tokenStore = require('./tokenStore');
const email = require('./email');
const subFlow = require('./subFlow');
const swapFlow = require('./swapFlow');

const CHECK_INTERVAL_MS = 60 * 1000; // check every minute

/**
 * Sends the confirmation reminder to everyone still 'scheduled' or
 * 'confirmed' in a given week who hasn't already gotten one (dedup is by
 * email_log, same as the automatic path, so this is safe to call more than
 * once — it only ever emails someone who hasn't already been reminded for
 * this week). Shared by the automatic cron pass and the admin's manual
 * "Send reminders now" button.
 */
async function sendReminderEmailsForWeek(week, session) {
  const assignments = db
    .prepare(
      `SELECT wa.*, p.name, p.email FROM week_assignments wa JOIN players p ON p.id = wa.player_id
       WHERE wa.week_id = ? AND wa.status IN ('scheduled', 'confirmed')`
    )
    .all(week.id);

  const upcoming = subFlow.upcomingWeeksPreview(session.id, week.match_date, 3);
  let sentCount = 0;

  for (const a of assignments) {
    const already = db
      .prepare(`SELECT id FROM email_log WHERE category = 'reminder' AND related_week_id = ? AND to_email = ?`)
      .get(week.id, a.email);
    if (already) continue;

    // A fresh token identifies the row; /confirm/:token and /need-sub/:token
    // are distinguished by URL path, not by having separate tokens. This
    // does NOT invalidate any token already issued for this assignment
    // (there shouldn't be one yet, since dedup above means this only fires
    // once per week/player) — see tokenStore.js.
    const raw = tokenStore.issueToken(a.id);

    await email.sendConfirmationReminder({
      player: a,
      week,
      session,
      confirmToken: raw,
      needSubToken: raw,
      upcomingWeeks: upcoming,
    });
    sentCount++;
  }

  return sentCount;
}

/**
 * Sends the confirmation reminder for every week that's due and hasn't gone
 * out yet. "Due" is checked as "should this have gone out already?" rather
 * than "is it this exact minute?" — so a missed tick (e.g. Pi restart) still
 * results in the email going out once the process is back up, per
 * Technical_Architecture.md §10.
 */
async function processReminders() {
  const tz = getTimezone();
  // archived_at IS NULL: an archived session is meant to go fully quiet, not
  // just disappear from the dashboard — see "Archiving" in CLAUDE.md.
  // reminders_enabled = 1: the per-session pause toggle (see CLAUDE.md
  // "Pausing automatic reminders") — off means skip the automatic pass
  // entirely; manual Resend link / Send reminders now are separate code
  // paths and don't check this flag.
  const sessions = db
    .prepare(`SELECT * FROM sessions WHERE status IN ('scheduled', 'active') AND archived_at IS NULL AND reminders_enabled = 1`)
    .all();
  const now = new Date();

  for (const session of sessions) {
    try {
      const weeks = db
        .prepare(`SELECT * FROM weeks WHERE session_id = ? AND locked = 0 ORDER BY match_date`)
        .all(session.id);

      for (const week of weeks) {
        const reminderDate = addDays(week.match_date, -session.reminder_days_before);
        const reminderAt = zonedTimeToUtc(reminderDate, session.reminder_time, tz);
        if (now < reminderAt) continue;

        await sendReminderEmailsForWeek(week, session);
      }
    } catch (err) {
      // One session with bad/legacy data (e.g. a malformed reminder_time
      // from before invalidTimeFields existed) shouldn't stop every other
      // session's reminders from going out — log and move on rather than
      // letting the exception propagate out of the loop.
      console.error(`[cron] processReminders failed for session ${session.id} (${session.name}):`, err.message);
    }
  }
}

/**
 * Admin-triggered: send this week's confirmation reminders right now,
 * regardless of the configured reminder_days_before/reminder_time schedule.
 * Still skips anyone already reminded for this week, so it's safe to use as
 * a "did everyone get it yet?" catch-all rather than a forced re-send.
 */
async function sendRemindersNowForWeek(weekId) {
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId);
  if (!week) throw new Error('Week not found');
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  return sendReminderEmailsForWeek(week, session);
}

const FOLLOW_UP_TIME = '09:00'; // morning-of nudge time, local to app_settings.timezone

/**
 * A still-unconfirmed player (status still 'scheduled', never clicked either
 * link from the original reminder) gets one automatic follow-up nudge on the
 * morning of match day. This does not change their status or trigger a sub
 * request on its own — it's purely a reminder; you stay in control of
 * whether/when to reassign someone who never responds (see the admin
 * dashboard's "unconfirmed" flag for that).
 */
async function processFollowUps() {
  const tz = getTimezone();
  // See processReminders above for both filters — same reasoning applies to
  // the follow-up nudge, since it's still part of "reminders" from the
  // player's perspective.
  const sessions = db
    .prepare(`SELECT * FROM sessions WHERE status IN ('scheduled', 'active') AND archived_at IS NULL AND reminders_enabled = 1`)
    .all();
  const now = new Date();

  for (const session of sessions) {
    try {
      const weeks = db
        .prepare(`SELECT * FROM weeks WHERE session_id = ? AND locked = 0 ORDER BY match_date`)
        .all(session.id);

      for (const week of weeks) {
        const followUpAt = zonedTimeToUtc(week.match_date, FOLLOW_UP_TIME, tz);
        const matchAt = zonedTimeToUtc(week.match_date, session.match_time, tz);
        if (now < followUpAt || now >= matchAt) continue;

        const assignments = db
          .prepare(
            `SELECT wa.*, p.name, p.email FROM week_assignments wa JOIN players p ON p.id = wa.player_id
             WHERE wa.week_id = ? AND wa.status = 'scheduled'`
          )
          .all(week.id);

        for (const a of assignments) {
          const originalReminderSent = db
            .prepare(`SELECT id FROM email_log WHERE category = 'reminder' AND related_week_id = ? AND to_email = ?`)
            .get(week.id, a.email);
          if (!originalReminderSent) continue; // don't nudge before the original reminder has even gone out

          const alreadyNudged = db
            .prepare(
              `SELECT id FROM email_log WHERE category = 'followup_reminder' AND related_week_id = ? AND to_email = ?`
            )
            .get(week.id, a.email);
          if (alreadyNudged) continue;

          // Mints an ADDITIONAL valid link rather than replacing the original
          // reminder's — that original link stays live too (see tokenStore.js
          // and the module docstring above). This is the fix for a real bug:
          // the follow-up used to overwrite the single stored token, so
          // clicking the *original* reminder email after the follow-up had
          // gone out landed on "Link not found" for a player who'd never
          // clicked anything yet.
          const raw = tokenStore.issueToken(a.id);

          await email.sendFollowUpReminder({ player: a, week, session, confirmToken: raw, needSubToken: raw });
        }
      }
    } catch (err) {
      console.error(`[cron] processFollowUps failed for session ${session.id} (${session.name}):`, err.message);
    }
  }
}

async function processEscalations() {
  await subFlow.escalateOverdueRequests();
  subFlow.flagStillUnfilled();
  // Direct-swap equivalent (Kyle, 2026-08-11): a pending swap otherwise has
  // no timeout at all — see swapFlow.js's nudgeOverdueSwaps()/
  // expireStaleSwaps() doc comments for the full reasoning. Grouped into the
  // same escalation pass as subs since both are "is this stuck?" checks, not
  // routine reminders.
  await swapFlow.nudgeOverdueSwaps();
  swapFlow.expireStaleSwaps();
}

/**
 * Locks every week whose match time has already passed. This is what makes
 * "locked" mean anything in practice: session_detail.ejs already hides
 * Reassign/Resend link/Mark confirmed/ball-duty edits for locked weeks, and
 * runScheduler() already skips locked weeks when regenerating a schedule —
 * but until a week is actually marked locked, both of those checks are
 * no-ops. Without this, re-running "Schedule these players" after any match
 * has already happened would silently wipe and regenerate that match's real
 * assignments/confirmations along with the genuinely-open future weeks.
 * Same timezone-aware `matchAt` comparison used for follow-ups/escalations,
 * so a week locks the moment its scheduled match time arrives, not at
 * midnight. Also kills every outstanding confirm/need-sub link for that
 * week's assignments (tokenStore.invalidateTokensForWeek), so a player who
 * never opened a reminder or follow-up email can't come back days later and
 * use an old link to "confirm" or "need a sub" for a match that already
 * happened.
 */
function processWeekLocking() {
  const tz = getTimezone();
  // Deliberately NOT filtering out archived sessions here, unlike
  // processReminders/processFollowUps above — locking is silent bookkeeping
  // (no email, no dashboard flag), so there's no reason an archived session's
  // past weeks shouldn't still lock normally; it keeps things consistent if
  // it's ever unarchived later.
  const sessions = db.prepare(`SELECT * FROM sessions WHERE status IN ('scheduled', 'active')`).all();
  const now = new Date();
  let lockedCount = 0;

  for (const session of sessions) {
    try {
      const weeks = db
        .prepare(`SELECT * FROM weeks WHERE session_id = ? AND locked = 0 ORDER BY match_date`)
        .all(session.id);

      for (const week of weeks) {
        const matchAt = zonedTimeToUtc(week.match_date, session.match_time, tz);
        if (now < matchAt) continue;
        db.prepare('UPDATE weeks SET locked = 1 WHERE id = ?').run(week.id);
        tokenStore.invalidateTokensForWeek(week.id);
        lockedCount++;
      }
    } catch (err) {
      console.error(`[cron] processWeekLocking failed for session ${session.id} (${session.name}):`, err.message);
    }
  }

  return lockedCount;
}

let running = false;
async function tick() {
  if (running) return; // avoid overlap if a previous tick is still finishing
  running = true;
  try {
    await processReminders();
    await processFollowUps();
    await processEscalations();
    processWeekLocking();
  } catch (err) {
    console.error('[cron] tick error:', err);
  } finally {
    running = false;
  }
}

function start() {
  tick(); // run once immediately on boot so a missed window is caught right away
  setInterval(tick, CHECK_INTERVAL_MS);
  console.log('[cron] internal check loop started (every 60s)');
}

module.exports = {
  start,
  tick,
  processReminders,
  processFollowUps,
  processEscalations,
  processWeekLocking,
  sendRemindersNowForWeek,
  // Exported so statusPage.js's read-only preview of upcoming automated
  // actions can compute the exact same follow-up time cron actually uses,
  // instead of a second hardcoded '09:00' that could quietly drift out of
  // sync with this one.
  FOLLOW_UP_TIME,
};
