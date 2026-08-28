'use strict';
// Usage: node src/scripts/backup-offsite.js
//
// Pushes everything in backups/ to a remote machine over rsync+ssh, using
// OFFSITE_SSH_HOST/OFFSITE_SSH_USER/OFFSITE_SSH_PATH (and optionally
// OFFSITE_SSH_PORT/OFFSITE_SSH_KEY) from .env. Meant to run right after
// `npm run backup` in the same cron line, so every night's local backup
// also lands on a second machine — see "Get backups off the Pi" in
// README.md for full setup (generating an SSH key, authorizing it on the
// remote machine, and the exact crontab line).
//
// If off-site push isn't configured yet, this exits 0 and prints a
// one-line reminder rather than failing the cron job — the local backup
// from backup-db.js has already succeeded by the time this runs, so a
// missing off-site config shouldn't be treated as a hard failure.
require('dotenv').config();
const { pushBackupsOffsite } = require('../services/offsiteBackup');

try {
  const result = pushBackupsOffsite();
  if (result.skipped) {
    console.log(`[backup-offsite] ${new Date().toISOString()} skipped: ${result.reason}`);
  } else {
    console.log(`[backup-offsite] ${new Date().toISOString()} pushed backups/ to remote via rsync`);
  }
} catch (err) {
  console.error(`[backup-offsite] failed: ${err.message}`);
  process.exit(1);
}
