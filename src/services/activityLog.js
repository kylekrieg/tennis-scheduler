'use strict';
const db = require('../db');

/**
 * Records one admin-triggered change to admin_activity_log. Call this at the
 * point of the actual mutation in each admin.js route, with a short
 * machine-readable `action` tag (e.g. 'session.schedule', 'week.reassign')
 * and a human-readable `description` (e.g. "Reassigned Wed 9/9 slot from
 * Kyle Krieg to John Gunther") — this is meant to read as a plain history,
 * not a technical event stream, so put the readable summary in `description`
 * and let `action` just be a stable tag for future filtering.
 *
 * Reads the acting admin from req.session (set at login — see admin.js's
 * POST /login) rather than requiring every call site to look it up itself.
 * `sessionId` is optional — omit it for actions that aren't tied to one
 * session (admin account management, global settings).
 */
function logActivity(req, { action, description, sessionId = null }) {
  db.prepare(
    `INSERT INTO admin_activity_log (admin_id, admin_name, action, description, session_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(req.session.adminId || null, req.session.adminName || 'Unknown admin', action, description, sessionId);
}

/**
 * Same log, same table, for a *player*-initiated action rather than an
 * admin one — currently just direct swaps (swapFlow.js), which players
 * trigger themselves with no admin session in scope. Kyle asked for these to
 * show up in the same Activity Log as everything else, so this reuses
 * admin_activity_log rather than a separate table: admin_id is left NULL
 * (there's no admin to attribute it to) and admin_name is stamped as
 * "<player> (player self-service)" so it's unmistakable in the log which
 * actions were a player acting on their own behalf versus an admin.
 */
function logPlayerActivity({ playerName, action, description, sessionId = null }) {
  db.prepare(
    `INSERT INTO admin_activity_log (admin_id, admin_name, action, description, session_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(null, `${playerName} (player self-service)`, action, description, sessionId);
}

/**
 * Same log, same table, for an action triggered by a cron job / standalone
 * script rather than through the Express app — currently just the nightly
 * backup scripts (src/scripts/backup-db.js, backup-offsite.js), which run
 * from the Pi's own crontab with no HTTP request and therefore no
 * req.session to read an admin from. logActivity() can't be reused here
 * since it dereferences req.session directly; this mirrors logPlayerActivity
 * above (admin_id left NULL, a fixed label standing in for "who did this")
 * so a scheduled backup shows up in the same Activity Log as everything
 * else instead of being invisible just because nothing was logged in.
 */
function logSystemActivity({ action, description, sessionId = null }) {
  db.prepare(
    `INSERT INTO admin_activity_log (admin_id, admin_name, action, description, session_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(null, 'System (automatic)', action, description, sessionId);
}

module.exports = { logActivity, logPlayerActivity, logSystemActivity };
