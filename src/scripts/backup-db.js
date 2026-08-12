'use strict';
// Usage: node src/scripts/backup-db.js
// Takes a consistent snapshot of data/tennis.db into backups/, then prunes
// old backups beyond the retention count. Meant to be run from cron for
// automatic daily backups, but safe to run by hand anytime too — see
// "Backing up the database" in README.md for the full setup (including why
// a backup sitting on the same SD card as the Pi doesn't protect you if the
// Pi itself dies, and what to do about that).
require('dotenv').config();
const { createBackup, pruneBackups, DEFAULT_RETENTION } = require('../services/backup');

try {
  const result = createBackup();
  const pruned = pruneBackups(DEFAULT_RETENTION);
  const kb = (result.size / 1024).toFixed(1);
  console.log(`[backup] ${new Date().toISOString()} wrote ${result.filename} (${kb} KB)${pruned ? `, pruned ${pruned} old backup(s)` : ''}`);
} catch (err) {
  console.error(`[backup] failed: ${err.message}`);
  process.exit(1);
}
