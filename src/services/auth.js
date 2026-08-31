'use strict';
const bcrypt = require('bcryptjs');
const db = require('../db');

/**
 * The login form originally only asked for a password (no username, to keep
 * the page simple for a small club) — a login was resolved by checking the
 * candidate password against every *active* admin's own hash and returning
 * whichever one matched. Kyle, 2026-08-29, expecting "quite a few admins"
 * going forward: "Let's make sure any changes or activity is logged under
 * their username." Password-only matching had a real correctness gap for
 * that scale — if two admins ever happened to pick the same password,
 * whichever admin's row the loop reached first would silently absorb both
 * people's logins and every action either of them took would get
 * misattributed to that one admin. Resolving identity by an exact,
 * app-level-unique username *first*, then checking only that one admin's
 * password, closes that gap outright — see adminUsername.js's doc comment.
 */
function findAdminByCredentials(username, password) {
  if (!username || !password) return null;
  const admin = db
    .prepare('SELECT * FROM admins WHERE LOWER(username) = ? AND active = 1')
    .get(String(username).trim().toLowerCase());
  if (!admin) return null;
  return bcrypt.compareSync(password, admin.password_hash) ? admin : null;
}

function hashPassword(candidate) {
  return bcrypt.hashSync(candidate, 12);
}

module.exports = { findAdminByCredentials, hashPassword };
