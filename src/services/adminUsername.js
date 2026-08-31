'use strict';

const { slugify } = require('./playerSlug');

/**
 * NOTE: every function here takes `db` as an explicit parameter rather than
 * requiring the singleton module — same reasoning as playerSlug.js: db/
 * index.js needs these functions for its own one-time backfill while it's
 * still mid-initialization, before module.exports is assigned, so a
 * top-level `require('../db')` here would see an incomplete module and
 * crash. Every other caller (admin.js) just passes the normal `db` singleton
 * it already imports.
 *
 * Admin usernames (Kyle, 2026-08-29): "Can we add a username to the admin
 * console? I think we are going to have quite a few admins for the
 * sessions. Let's make sure any changes or activity is logged under their
 * username." The login page previously asked for a password only —
 * auth.js's findAdminByPassword() checked the candidate against every
 * *active* admin's own hash and returned whichever one matched. That worked
 * fine for one or two people, but it has a real correctness gap once there
 * are "quite a few": if two admins ever happened to pick the same password,
 * every action either of them took would get silently attributed to
 * whichever one's row the query happened to reach first — the exact
 * opposite of what Kyle is asking for here. Requiring an explicit,
 * per-admin username at login (see auth.js's findAdminByCredentials())
 * closes that gap outright: identity is resolved by an exact, unique
 * username match *before* the password is even checked, so there's no
 * scenario where two admins' actions can be confused with each other.
 *
 * `admins.username` is app-level-unique (not DB-constrained, same
 * deliberate choice as players.slug — see db/index.js's ensureColumn
 * comment on why this app never adds a hard UNIQUE constraint after the
 * fact) and, like players.slug, generated once from the admin's name at
 * creation time and never auto-regenerated on a later name edit — an admin
 * who's told their username shouldn't have it change out from under them
 * just because their display name got corrected.
 */

const USERNAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Returns true if `username` is already in use by some admin other than
 * `excludeAdminId` (pass null/undefined when checking a brand-new admin).
 * Comparison is case-insensitive — usernames are always stored lowercase
 * (see generateUniqueUsername() and admin.js's invalidUsernameField()), so
 * a plain equality check is enough once both sides are lowercased. */
function usernameTaken(db, username, excludeAdminId) {
  const lower = String(username || '').toLowerCase();
  const row = excludeAdminId
    ? db.prepare('SELECT id FROM admins WHERE LOWER(username) = ? AND id != ?').get(lower, excludeAdminId)
    : db.prepare('SELECT id FROM admins WHERE LOWER(username) = ?').get(lower);
  return !!row;
}

/** Generates a username from `name` that's not currently in use, appending
 * -2, -3, ... on collision — same graceful-degradation pattern
 * generateUniqueSlug() uses for players.slug. */
function generateUniqueUsername(db, name, excludeAdminId) {
  const base = slugify(name);
  let candidate = base;
  let n = 2;
  while (usernameTaken(db, candidate, excludeAdminId)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

module.exports = { USERNAME_RE, usernameTaken, generateUniqueUsername };
