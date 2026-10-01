'use strict';
const db = require('../db');
const { logActivity } = require('./activityLog');
const { SUSPENDABLE, LABELS, getSuspension } = require('./automationSuspend');

/**
 * "Send now" buttons on the admin Status page's "Upcoming automated
 * actions" table (Kyle, 2026-09-30): "we might want to escalate an email
 * like sending a sub request to the broader sub list and not wait until X
 * amount of hours before a match. All the correct links should be sent."
 *
 * Each one runs the exact same send the cron pass would run when the
 * action's time arrives — same templates, freshly minted links, same
 * email_log dedup — just right now:
 *
 *   reminder   -> cron.sendReminderEmailsForWeek() (only players not yet
 *                 reminded, i.e. the "Who" column), plus the roster fan-out
 *                 for any admin-flagged sub request that was waiting on
 *                 reminder time, same as processReminders().
 *   followup   -> cron.sendFollowUpsForWeek() (still unconfirmed, already
 *                 got the reminder, not yet nudged).
 *   escalation -> subFlow.escalateNowForWeek() (sub list + any roster
 *                 fan-out not yet sent; "I found a sub" requests open up).
 *
 * Because those sends dedup (email_log / sub_requests status), the cron
 * pass won't send them a second time when the scheduled time comes. A
 * pending Suspend on the same line is cleared — the admin explicitly chose
 * to send it.
 */
async function sendNow(req, weekId, actionType) {
  if (!SUSPENDABLE.includes(actionType)) throw new Error('That action can’t be sent early.');
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId);
  if (!week) throw new Error('Week not found');
  if (week.locked) throw new Error('That week has already been played (locked) — nothing to send.');
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  const { sessionFullTitle } = require('./email');
  const where = `${sessionFullTitle(session)} — week of ${week.match_date}`;

  const suspension = getSuspension(week.id, actionType);
  const clearedSuspension = !!(suspension && !suspension.skipped_at);
  if (clearedSuspension) db.prepare('DELETE FROM suspended_actions WHERE id = ? AND skipped_at IS NULL').run(suspension.id);

  const cron = require('./cron');
  const subFlow = require('./subFlow');
  let message;
  let logLine;
  let sentAnything = false;

  if (actionType === 'reminder') {
    const count = await cron.sendReminderEmailsForWeek(week, session);
    const flagged = await subFlow.fanOutPendingAdminFlagsForWeek(week.id);
    sentAnything = count > 0 || flagged > 0;
    message = count > 0
      ? `Reminder email sent now to ${count} player(s) for ${where}.`
      : `Nothing sent — everyone in ${where} has already been reminded.`;
    if (flagged > 0) message += ` Also sent the roster email for ${flagged} admin-flagged sub request(s) that was waiting on reminder time.`;
    logLine = `${count} reminder(s)${flagged ? ` + ${flagged} admin-flagged sub fan-out(s)` : ''}`;
  } else if (actionType === 'followup') {
    const { sent, skippedNoReminder } = await cron.sendFollowUpsForWeek(week, session);
    sentAnything = sent > 0;
    message = sent > 0
      ? `Follow-up nudge sent now to ${sent} player(s) for ${where}.`
      : `No follow-up nudge sent for ${where}.`;
    if (skippedNoReminder > 0) {
      message += ` ${skippedNoReminder} unconfirmed player(s) skipped because they haven't gotten the original reminder yet — use Send now on that week's reminder line instead.`;
    }
    logLine = `${sent} follow-up nudge(s)`;
  } else {
    const results = await subFlow.escalateNowForWeek(week.id);
    if (results.length === 0) {
      message = `No open sub request for ${where} — it may have just been filled or already escalated.`;
    } else {
      const parts = results.map((r) => {
        if (r.result === 'escalated') {
          return `${r.playerName}'s slot: emailed ${r.emailedNames.length} (${r.emailedNames.join(', ')})`;
        }
        if (r.result === 'unfilled') {
          return `${r.playerName}'s slot: nobody left on the sub list to ask${r.emailedNames.length ? ` (roster emailed: ${r.emailedNames.join(', ')})` : ''} — the player and admins were alerted`;
        }
        return `${r.playerName}'s slot: ${r.result}`;
      });
      sentAnything = results.some((r) => r.emailedNames.length > 0 || r.result === 'unfilled');
      message = `Sub escalation sent now for ${where}. ${parts.join('; ')}.`;
      logLine = parts.join('; ');
    }
  }

  if (clearedSuspension) message += ' (Its Suspend was cleared.)';
  if (sentAnything || clearedSuspension) {
    logActivity(req, {
      action: 'automation.send_now',
      description: `${req.session.adminName || 'An admin'} used Send now (ahead of schedule): ${LABELS[actionType]} for ${where}${logLine ? ` — ${logLine}` : ''}${clearedSuspension ? ' (cleared its Suspend)' : ''}`,
      sessionId: session.id,
    });
  }
  return { message };
}

module.exports = { sendNow };
