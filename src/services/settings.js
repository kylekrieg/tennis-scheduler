'use strict';
const db = require('../db');

function getTimezone() {
  const row = db.prepare('SELECT timezone FROM app_settings WHERE id = 1').get();
  return row ? row.timezone : 'America/Chicago';
}

function setTimezone(tz) {
  db.prepare('UPDATE app_settings SET timezone = ? WHERE id = 1').run(tz);
}

// The brand text in the upper-left corner of every public page (see
// partials/header.ejs) — was hardcoded until Kyle asked (2026-09-01) for it
// to be admin-configurable from Settings, same place timezone already
// lives. Falls back to the same string that was hardcoded before this, in
// case a row somehow predates the column (shouldn't happen — ensureColumn
// backfills it — but matches getTimezone()'s own defensive fallback above).
function getSiteTitle() {
  const row = db.prepare('SELECT site_title FROM app_settings WHERE id = 1').get();
  return row && row.site_title ? row.site_title : '🎾 Doubles Schedule';
}

function setSiteTitle(title) {
  db.prepare('UPDATE app_settings SET site_title = ? WHERE id = 1').run(title);
}

module.exports = { getTimezone, setTimezone, getSiteTitle, setSiteTitle };
