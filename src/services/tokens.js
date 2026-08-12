'use strict';
const crypto = require('crypto');

// Tokens embedded in email links are long, random, single-use, and unguessable
// (crypto.randomBytes, never a sequential/predictable id — see Technical_Architecture.md §3).
// Only a SHA-256 hash of the token is stored in the DB, so a database read alone
// can't be used to forge working links.

function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = { generateRawToken, hashToken };
