'use strict';
const bcrypt = require('bcryptjs');
const db = require('../db');

/**
 * The login form only asks for a password (no username, to keep the page
 * simple for a small club) — so a login is resolved by checking the
 * candidate password against every *active* admin's own hash and returning
 * whichever one matches. Each person still has their own distinct password
 * (so one can be revoked from Admin -> Admins without affecting anyone
 * else's), it's just not selected up front.
 */
function findAdminByPassword(candidate) {
  if (!candidate) return null;
  const admins = db.prepare('SELECT * FROM admins WHERE active = 1').all();
  for (const admin of admins) {
    if (bcrypt.compareSync(candidate, admin.password_hash)) return admin;
  }
  return null;
}

function hashPassword(candidate) {
  return bcrypt.hashSync(candidate, 12);
}

module.exports = { findAdminByPassword, hashPassword };
