'use strict';
const db = require('../db');
const { logActivity, logSystemActivity } = require('./activityLog');

/**
 * Suspend checkboxes for the admin Status page's "Upcoming automated
 * actions" table (Kyle, 2026-09-27). See the suspended_actions comment in
 * schema.sql for the full lifecycle. In short:
 *
 *   - Admin checks the box -> row inserted, logged as who suspended it.
 *   - Admin unchecks before it's due -> row deleted, logged, action resumes.
 *   - Due time arrives while suspended -> the cron pass calls
 *     skipIfSuspended(), which logs "Suspended — did not fire" once
 *     (stamping skipped_at) and tells the caller to skip. From then on the
 *     action is complete: every later tick keeps skipping it silently, and
 *     it can no longer be un-suspended. An admin finishes the job manually.
 */

const SUSPENDABLE = ['reminder', 'followup', 'escalation'];

const LABELS = {
  reminder: 'Reminder email',
  followup: 'Follow-up nudge',
  escalation: 'Sub escalation',
};

function getSuspension(weekId, actionType) {
  return db.prepare('SELECT * FROM suspended_actions WHERE week_id = ? AND action_type = ?').get(weekId, actionType) || null;
}

/** Map keyed `${weekId}:${actionType}` for the Status page. */
function suspensionMap() {
  const rows = db.prepare('SELECT * FROM suspended_actions').all();
  return new Map(rows.map((r) => [`${r.week_id}:${r.action_type}`, r]));
}

function describeWeek(week, session) {
  // Avoid a require cycle with email.js at module load; resolve lazily.
  const { sessionFullTitle } = require('./email');
  return `${sessionFullTitle(session)} — week of ${week.match_date}`;
}

/**
 * Called by each cron pass at the moment it has decided an action is due
 * for this week. Returns true if the action is suspended (caller must skip
 * it). Logs "Suspended — did not fire" exactly once per suspension.
 */
function skipIfSuspended(week, session, actionType) {
  const row = getSuspension(week.id, actionType);
  if (!row) return false;
  if (!row.skipped_at) {
    const res = db
      .prepare(`UPDATE suspended_actions SET skipped_at = datetime('now') WHERE id = ? AND skipped_at IS NULL`)
      .run(row.id);
    if (res.changes > 0) {
      logSystemActivity({
        action: 'automation.suspended_skip',
        description: `Suspended — did not fire: ${LABELS[actionType]} for ${describeWeek(week, session)} (suspended by ${row.suspended_by_name} on ${row.suspended_at} UTC). Needs to be handled manually.`,
        sessionId: session.id,
      });
    }
  }
  return true;
}

function suspend(req, weekId, actionType) {
  if (!SUSPENDABLE.includes(actionType)) throw new Error('That action can’t be suspended.');
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId);
  if (!week) throw new Error('Week not found');
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  if (getSuspension(week.id, actionType)) return { already: true, week, session };
  db.prepare(
    `INSERT INTO suspended_actions (week_id, action_type, suspended_by_id, suspended_by_name) VALUES (?, ?, ?, ?)`
  ).run(week.id, actionType, req.session.adminId || null, req.session.adminName || 'Unknown admin');
  logActivity(req, {
    action: 'automation.suspend',
    description: `Suspended automated action: ${LABELS[actionType]} for ${describeWeek(week, session)}`,
    sessionId: session.id,
  });
  return { already: false, week, session };
}

function unsuspend(req, weekId, actionType) {
  const row = getSuspension(weekId, actionType);
  if (!row) return { notFound: true };
  if (row.skipped_at) return { completed: true };
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);
  db.prepare('DELETE FROM suspended_actions WHERE id = ? AND skipped_at IS NULL').run(row.id);
  logActivity(req, {
    action: 'automation.unsuspend',
    description: `Resumed automated action: ${LABELS[actionType]} for ${describeWeek(week, session)}`,
    sessionId: session.id,
  });
  return { ok: true, week, session };
}

module.exports = { SUSPENDABLE, LABELS, getSuspension, suspensionMap, skipIfSuspended, suspend, unsuspend };
