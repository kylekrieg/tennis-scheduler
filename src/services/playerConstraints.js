'use strict';
const db = require('../db');

const TYPES = ['never_together', 'always_together'];

/** Always stores/looks up a pair with the lower player id first, so a given
 * pair can't accidentally be entered twice in reversed order and every
 * lookup only has to check one direction. */
function orderedPair(playerAId, playerBId) {
  const a = Number(playerAId);
  const b = Number(playerBId);
  return a < b ? [a, b] : [b, a];
}

/**
 * All player-pair constraints for a session, both as raw rows (for the admin
 * list/edit UI) and pre-shaped into the [[playerAId, playerBId], ...] arrays
 * the scheduling engine (scheduler/engine.js) takes directly as
 * `neverTogether`/`alwaysTogether`.
 */
function getConstraintsForSession(sessionId) {
  const rows = db
    .prepare(
      `SELECT pc.id, pc.player_a_id, pc.player_b_id, pc.type,
              pa.name as player_a_name, pa.full_name as player_a_full_name,
              pb.name as player_b_name, pb.full_name as player_b_full_name
       FROM player_constraints pc
       JOIN players pa ON pa.id = pc.player_a_id
       JOIN players pb ON pb.id = pc.player_b_id
       WHERE pc.session_id = ?
       ORDER BY pa.name, pb.name`
    )
    .all(sessionId);

  const neverTogether = rows.filter((r) => r.type === 'never_together').map((r) => [r.player_a_id, r.player_b_id]);
  const alwaysTogether = rows.filter((r) => r.type === 'always_together').map((r) => [r.player_a_id, r.player_b_id]);

  return { rows, neverTogether, alwaysTogether };
}

/**
 * Adds a constraint, or is a no-op if that exact pair+type already exists
 * (the UNIQUE(session_id, player_a_id, player_b_id, type) constraint on the
 * table, paired with orderedPair() above, makes "already there" the only way
 * this can conflict). Returns { ok:true } or { ok:false, error } — never
 * throws, so the route can just flash the error back to the admin.
 */
function addConstraint(sessionId, playerAId, playerBId, type) {
  if (!TYPES.includes(type)) return { ok: false, error: 'Unknown constraint type.' };
  const [a, b] = orderedPair(playerAId, playerBId);
  if (a === b) return { ok: false, error: 'A player can’t be constrained against themselves.' };

  try {
    db.prepare(
      'INSERT INTO player_constraints (session_id, player_a_id, player_b_id, type) VALUES (?, ?, ?, ?)'
    ).run(sessionId, a, b, type);
    return { ok: true };
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      return { ok: false, error: 'That constraint already exists for this pair.' };
    }
    throw err;
  }
}

function removeConstraint(sessionId, constraintId) {
  db.prepare('DELETE FROM player_constraints WHERE id = ? AND session_id = ?').run(constraintId, sessionId);
}

module.exports = { getConstraintsForSession, addConstraint, removeConstraint, orderedPair, TYPES };
