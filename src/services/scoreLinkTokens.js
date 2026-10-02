'use strict';
const db = require('../db');
const { generateRawToken, hashToken } = require('./tokens');

/**
 * Score-reminder link attribution (Kyle, 2026-10-02): when the ball-duty
 * "scores still needed" email's link is used to enter scores, the Activity
 * Log should say who it was. Someone who goes to /scores on their own still
 * gets the plain "(group entry)" entry, unchanged.
 *
 * Each email gets its own random token (raw value only in the link, SHA-256
 * hash stored, per this app's token rule). The token is attribution only:
 * it never gates anything, so an unknown/mismatched token just falls back to
 * the generic entry instead of an error page.
 */
function issue(playerId, weekId) {
  const raw = generateRawToken();
  db.prepare('INSERT INTO score_link_tokens (player_id, week_id, token) VALUES (?, ?, ?)').run(playerId, weekId, hashToken(raw));
  return raw;
}

/** Player row for a raw token, only if it was issued for `weekId`; else null. */
function resolve(raw, weekId) {
  if (!raw || typeof raw !== 'string' || !/^[0-9a-f]{64}$/.test(raw)) return null;
  const row = db.prepare('SELECT player_id, week_id FROM score_link_tokens WHERE token = ?').get(hashToken(raw));
  if (!row || row.week_id !== Number(weekId)) return null;
  return db.prepare('SELECT * FROM players WHERE id = ?').get(row.player_id) || null;
}

module.exports = { issue, resolve };
