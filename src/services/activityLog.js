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
 * For the Activity Log page (and, if scoped, a future per-session activity
 * view). Pass `sessionId` to scope to one session's history; omit for the
 * full cross-session log, most-recent first.
 */
function getRecentActivity({ sessionId = null, limit = 200 } = {}) {
  if (sessionId) {
    return db
      .prepare(`SELECT * FROM admin_activity_log WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(sessionId, limit);
  }
  return db.prepare(`SELECT * FROM admin_activity_log ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit);
}

module.exports = { logActivity, logPlayerActivity, getRecentActivity };
