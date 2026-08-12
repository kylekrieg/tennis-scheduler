'use strict';
const db = require('../db');

function getTimezone() {
  const row = db.prepare('SELECT timezone FROM app_settings WHERE id = 1').get();
  return row ? row.timezone : 'America/Chicago';
}

function setTimezone(tz) {
  db.prepare('UPDATE app_settings SET timezone = ? WHERE id = 1').run(tz);
}

module.exports = { getTimezone, setTimezone };
