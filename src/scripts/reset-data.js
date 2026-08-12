'use strict';
// Usage: node src/scripts/reset-data.js --confirm
//
// Wipes all season/player/schedule data for a fresh start (e.g. clearing out
// dummy/test data before switching to a real roster) while leaving admin
// logins and settings (timezone) untouched, so you don't get locked out.
// Takes an automatic backup first (see "Backing up the database" in
// README.md) in case anything here turns out to matter later.
require('dotenv').config();
const db = require('../db');
const { createBackup } = require('../services/backup');

if (!process.argv.includes('--confirm')) {
  console.log('This permanently deletes ALL players, sessions, schedules, blackout dates,');
  console.log('sub history, the broader sub list, and the email log.');
  console.log('');
  console.log('Admin logins and settings (timezone) are kept — you will NOT be locked out.');
  console.log('');
  console.log('A backup is taken automatically before deleting anything (Admin -> Backup');
  console.log('can restore from it), but this is still a one-way door for everything else.');
  console.log('Re-run with --confirm to proceed:');
  console.log('');
  console.log('  node src/scripts/reset-data.js --confirm');
  process.exit(1);
}

try {
  const backup = createBackup();
  console.log(`[reset] backed up first: ${backup.filename} (${(backup.size / 1024).toFixed(1)} KB)`);

  // Order matters here under PRAGMA foreign_keys = ON. sessions cascades away
  // most things (session_players, blackout_dates, blackout_pending, weeks ->
  // week_assignments -> week_assignment_tokens, and each week's sub_requests
  // -> sub_offers) — but two references have no cascade action defined
  // (deliberately, elsewhere, so a sent-email or a sub-invite record can
  // outlive the row that created it): email_log.related_week_id, and
  // sub_offers' candidate_player_id/broader_list_id. Left in place, either
  // would make the deletes below fail with "FOREIGN KEY constraint failed".
  // Clearing email_log before sessions, and players/broader_sub_list after
  // sessions (once sub_offers is already gone via the cascade), avoids both.
  const resetAll = db.transaction(() => {
    db.exec('DELETE FROM email_log');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM players');
    db.exec('DELETE FROM broader_sub_list');
  });
  resetAll();

  console.log('[reset] done — all season data cleared. Admin logins and settings were kept.');
  console.log('[reset] add your real roster from Admin -> Players, then create a session.');
} catch (err) {
  console.error(`[reset] failed: ${err.message}`);
  process.exit(1);
}
