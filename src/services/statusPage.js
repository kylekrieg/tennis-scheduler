'use strict';
const db = require('../db');
const { zonedTimeToUtc, addDays, utcToZonedParts } = require('./tz');
const { getTimezone } = require('./settings');
const { findOverlappingSessionEnrollments, findActualDoubleBookings, SESSION_DISPLAY_ORDER } = require('./sessionHelper');

/**
 * Flattens every "needs a human" item across all non-archived sessions into
 * one actionable list, grouped by category. The main admin dashboard already
 * shows a per-session count for most of these (`GET /admin`'s `flags`), but
 * a count isn't a to-do list — this returns the actual specifics (who,
 * which week, which session) so the whole thing can be worked through
 * without clicking into every session one at a time. Archived sessions are
 * excluded throughout, same as the dashboard, since archiving is meant to go
 * fully quiet.
 */
function getAttentionItems() {
  const sessions = db.prepare(`SELECT * FROM sessions WHERE archived_at IS NULL ${SESSION_DISPLAY_ORDER}`).all();
  const pausedSessions = sessions.filter((s) => !s.reminders_enabled);

  // Session-level conflicts: an entire "Schedule these players" run failed
  // and nothing was written for the open weeks — see engine.js/scheduleRun.js.
  // Most urgent category, since it's not just one week, it's the whole
  // remaining season sitting unscheduled.
  const conflicts = [];
  for (const s of sessions) {
    if (!s.schedule_conflicts) continue;
    let parsed;
    try {
      parsed = JSON.parse(s.schedule_conflicts);
    } catch (err) {
      continue; // shouldn't happen (we control what's written here), but don't let a bad row break the whole page
    }
    for (const c of parsed) {
      conflicts.push({ session: s, type: c.type, detail: c.detail });
    }
  }

  if (sessions.length === 0) {
    return { conflicts: [], needsAttentionWeeks: [], unconfirmed: [], unfilledSubs: [], missingBallDuty: [], pausedSessions: [], overlappingEnrollments: [], doubleBookings: [], staleSwaps: [] };
  }

  // Players enrolled in two non-archived sessions on the same day of week
  // with overlapping dates — see sessionHelper.js
  // findOverlappingSessionEnrollments(). Called with no sessionId here so it
  // checks every non-archived session against every other, once, rather than
  // per-session (which would double-count each pair). Shows every pair
  // regardless of priority/resolution — priority is advisory only (the
  // scheduler doesn't auto-exclude based on it, see scheduleRun.js), so a
  // "resolved" pair is just as much a to-do item as an unresolved one.
  const overlappingEnrollments = findOverlappingSessionEnrollments();

  // Confirmed double-bookings (not just enrollment-level risk — see
  // findActualDoubleBookings' doc comment), e.g. from an accepted direct
  // swap (swapFlow.js) that happened to land a player on a date they're
  // already playing elsewhere. Also called with no sessionId for the same
  // no-double-counting reason as above.
  const doubleBookings = findActualDoubleBookings();

  const sessionIds = sessions.map((s) => s.id);
  const placeholders = sessionIds.map(() => '?').join(',');

  // Weeks flagged needs_attention — most commonly an understaffed week the
  // scheduler auto-handled (see "Understaffed weeks" in CLAUDE.md), but also
  // covers e.g. a week whose ball duty needs reassignment after its holder
  // requested a sub. Locked (already-played) weeks are excluded — nothing
  // left to do about the past.
  const needsAttentionWeeks = db
    .prepare(
      `SELECT w.*, s.id as session_id, s.name as session_name
       FROM weeks w JOIN sessions s ON s.id = w.session_id
       WHERE w.session_id IN (${placeholders}) AND w.needs_attention = 1 AND w.locked = 0
       ORDER BY w.match_date`
    )
    .all(...sessionIds);

  // Same "actually been reminded" condition the dashboard's unconfirmed
  // count uses, just returning the rows instead of a count.
  const unconfirmed = db
    .prepare(
      `SELECT wa.id as assignment_id, p.name as player_name, w.match_date, w.id as week_id,
              s.id as session_id, s.name as session_name
       FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = wa.player_id
       JOIN sessions s ON s.id = w.session_id
       WHERE w.session_id IN (${placeholders}) AND wa.status = 'scheduled' AND w.match_date >= date('now')
         AND EXISTS (
           SELECT 1 FROM email_log el
           WHERE el.category = 'reminder' AND el.related_week_id = w.id AND el.to_email = p.email
         )
       ORDER BY w.match_date, p.name`
    )
    .all(...sessionIds);

  const unfilledSubs = db
    .prepare(
      `SELECT sr.id, sr.status, w.match_date, w.id as week_id,
              s.id as session_id, s.name as session_name, p.name as original_player_name
       FROM sub_requests sr
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       JOIN players p ON p.id = wa.player_id
       WHERE w.session_id IN (${placeholders}) AND sr.status IN ('open', 'escalated', 'unfilled')
       ORDER BY w.match_date`
    )
    .all(...sessionIds);

  // Excludes needs_attention weeks — those already show up above with a more
  // specific reason; "missing ball duty" on a week with zero players is a
  // misleading way to describe the real problem (see the dashboard's
  // identical exclusion, added for the same reason).
  const missingBallDuty = db
    .prepare(
      `SELECT w.*, s.id as session_id, s.name as session_name
       FROM weeks w JOIN sessions s ON s.id = w.session_id
       WHERE w.session_id IN (${placeholders}) AND w.ball_duty_player_id IS NULL AND w.needs_attention = 0
         AND w.match_date >= date('now')
       ORDER BY w.match_date`
    )
    .all(...sessionIds);

  // Pending direct swaps that have already been nudged (see swapFlow.js's
  // nudgeOverdueSwaps()) and still have no answer — the swap equivalent of
  // unfilledSubs above, flattened to specifics the same way. Self-clearing:
  // once the target player responds (or the admin cancels it), status leaves
  // 'pending' and it drops out of this query on its own.
  const staleSwaps = db
    .prepare(
      `SELECT sw.id, sw.nudged_at,
              ip.name as initiator_name, tp.name as target_name,
              iw.match_date as initiator_match_date, tw.match_date as target_match_date,
              s.id as session_id, s.name as session_name
       FROM swap_requests sw
       JOIN week_assignments ia ON ia.id = sw.initiator_assignment_id
       JOIN week_assignments ta ON ta.id = sw.target_assignment_id
       JOIN weeks iw ON iw.id = ia.week_id
       JOIN weeks tw ON tw.id = ta.week_id
       JOIN sessions s ON s.id = iw.session_id
       JOIN players ip ON ip.id = ia.player_id
       JOIN players tp ON tp.id = ta.player_id
       WHERE s.id IN (${placeholders}) AND sw.status = 'pending' AND sw.nudged_at IS NOT NULL
       ORDER BY sw.nudged_at`
    )
    .all(...sessionIds);

  return { conflicts, needsAttentionWeeks, unconfirmed, unfilledSubs, missingBallDuty, pausedSessions, overlappingEnrollments, doubleBookings, staleSwaps };
}

/**
 * Read-only preview of what the cron loop (src/services/cron.js) is going to
 * do over the next `days` days, computed from the exact same eligibility
 * logic it uses — without sending anything or writing to the DB. This exists
 * so "is the reminder system actually working" is answerable by looking at a
 * page instead of waiting for match day and hoping. Mirrors, rather than
 * calls, cron.js's internals (its functions have their side effects — email
 * sends, DB writes — baked in, not separable from the eligibility checks), so
 * if cron.js's due-date logic ever changes, this needs to be updated too.
 *
 * Reminder events are precise (based on real current email_log state — that
 * can only move forward, never retroactively change). Follow-up and
 * escalation events are inherently speculative: they depend on who's
 * confirmed or whether a sub request is still open *by the time the event
 * would actually fire*, which can change between now and then. Those are
 * computed "as of right now" and labeled as such in the returned event's
 * `speculative` flag — the view is responsible for wording that clearly.
 */
function getUpcomingActions(days = 21) {
  const tz = getTimezone();
  const now = new Date();
  const windowEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const sessions = db
    .prepare(`SELECT * FROM sessions WHERE status IN ('scheduled', 'active') AND archived_at IS NULL`)
    .all();

  const events = [];

  for (const session of sessions) {
    const weeks = db.prepare(`SELECT * FROM weeks WHERE session_id = ? AND locked = 0 ORDER BY match_date`).all(session.id);

    for (const week of weeks) {
      let matchAt;
      try {
        matchAt = zonedTimeToUtc(week.match_date, session.match_time, tz);
      } catch (err) {
        continue; // malformed legacy row (predates invalidTimeFields) — skip rather than crash the whole page
      }

      // Reminder — gated by reminders_enabled, exactly like processReminders().
      if (session.reminders_enabled) {
        try {
          const reminderDate = addDays(week.match_date, -session.reminder_days_before);
          const reminderAt = zonedTimeToUtc(reminderDate, session.reminder_time, tz);
          if (reminderAt <= windowEnd) {
            const recipients = db
              .prepare(
                `SELECT p.name FROM week_assignments wa JOIN players p ON p.id = wa.player_id
                 WHERE wa.week_id = ? AND wa.status IN ('scheduled', 'confirmed')
                   AND NOT EXISTS (
                     SELECT 1 FROM email_log el
                     WHERE el.category = 'reminder' AND el.related_week_id = wa.week_id AND el.to_email = p.email
                   )
                 ORDER BY p.name`
              )
              .all(week.id);
            if (recipients.length > 0) {
              events.push({
                type: 'reminder',
                at: reminderAt,
                atDate: reminderDate,
                atTime: session.reminder_time,
                overdue: reminderAt < now,
                speculative: false,
                session,
                week,
                recipients: recipients.map((r) => r.name),
              });
            }
          }
        } catch (err) {
          // malformed reminder_time — invalidTimeFields blocks this at the
          // form now, but a pre-existing row could still hit it
        }

        // Follow-up nudge — "as of now" preview: whoever's still sitting at
        // 'scheduled' (not confirmed) for this week. The real cron run only
        // nudges someone who already got the original reminder, but at
        // preview time that reminder may not have gone out yet, which would
        // otherwise make an entirely legitimate upcoming nudge look like it
        // has 0 recipients. Speculative either way — showing "would nudge
        // these people if still unconfirmed" is the useful signal here.
        // follow_up_lead_hours is an arbitrary hour count (default 27), not a
        // clean day boundary like escalation's "24h before" below, so the
        // resulting instant's own local date/time (not week.match_date) is
        // what's actually correct to display — see tz.js's utcToZonedParts.
        const followUpAt = new Date(matchAt.getTime() - session.follow_up_lead_hours * 60 * 60 * 1000);
        const followUpLocal = utcToZonedParts(followUpAt, tz);
        // `now < matchAt`, not just `followUpAt <= matchAt` — mirrors
        // processFollowUps()'s own `now >= matchAt` skip exactly. Without
        // this, a week whose match has already fully passed (a genuinely
        // stuck/never-processed week) would still show a "not overdue"
        // follow-up entry, which is misleading — once match time is gone,
        // there's no realistic follow-up left to send; the reminder and
        // week-lock entries above already carry the "something's stuck"
        // signal for that case.
        if (followUpAt <= windowEnd && followUpAt <= matchAt && now < matchAt) {
          const stillUnconfirmed = db
            .prepare(
              `SELECT p.name FROM week_assignments wa JOIN players p ON p.id = wa.player_id
               WHERE wa.week_id = ? AND wa.status = 'scheduled'
                 AND NOT EXISTS (
                   SELECT 1 FROM email_log el
                   WHERE el.category = 'followup_reminder' AND el.related_week_id = wa.week_id AND el.to_email = p.email
                 )
               ORDER BY p.name`
            )
            .all(week.id);
          if (stillUnconfirmed.length > 0) {
            events.push({
              type: 'followup',
              at: followUpAt,
              atDate: followUpLocal.date,
              atTime: followUpLocal.time,
              overdue: followUpAt < now && matchAt > now,
              speculative: true,
              session,
              week,
              recipients: stillUnconfirmed.map((r) => r.name),
            });
          }
        }
      }

      // Escalation — NOT gated by reminders_enabled (see CLAUDE.md: sub
      // request escalation runs independently of the reminders toggle).
      // "As of now" preview: only a request that's currently open would
      // escalate; if it gets filled before the deadline, it never will.
      const openRequest = db
        .prepare(
          `SELECT sr.id, p.name as original_player_name FROM sub_requests sr
           JOIN week_assignments wa ON wa.id = sr.week_assignment_id
           JOIN players p ON p.id = wa.player_id
           WHERE wa.week_id = ? AND sr.status = 'open'`
        )
        .get(week.id);
      if (openRequest) {
        // 24h before match, on the wall clock, in this session's own
        // timezone — computed as a date/time pair (not just `matchAt` minus
        // a millisecond offset) so it stays a clean, correctly-labeled local
        // time even across a DST boundary in between.
        const escalateDate = addDays(week.match_date, -1);
        const escalateAt = zonedTimeToUtc(escalateDate, session.match_time, tz);
        if (escalateAt <= windowEnd) {
          events.push({
            type: 'escalation',
            at: escalateAt,
            atDate: escalateDate,
            atTime: session.match_time,
            overdue: escalateAt < now,
            speculative: true,
            session,
            week,
            recipients: [`sub request for ${openRequest.original_player_name}'s slot → broader sub list`],
          });
        }
      }

      // Week locking — deterministic, not speculative. A week showing up
      // here with `overdue: true` (match time already passed, still
      // unlocked) is a real, concrete signal the cron loop isn't running.
      if (matchAt <= windowEnd) {
        events.push({
          type: 'lock',
          at: matchAt,
          atDate: week.match_date,
          atTime: session.match_time,
          overdue: matchAt < now,
          speculative: false,
          session,
          week,
          recipients: [],
        });
      }
    }
  }

  events.sort((a, b) => a.at - b.at);
  return events;
}

module.exports = { getAttentionItems, getUpcomingActions };
