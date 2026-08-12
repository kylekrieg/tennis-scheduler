'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', '..', 'data', 'tennis.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');
const DEFAULT_RETENTION = 30; // keep the most recent 30 backups by default (~1 month at one/day)

function timestampedFilename() {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  // Milliseconds included so two backups triggered in quick succession (e.g.
  // a double-click on "Create backup") never collide on the same filename —
  // VACUUM INTO refuses to write over a file that already exists.
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
  return `tennis-backup-${stamp}.db`;
}

/**
 * Uses SQLite's own VACUUM INTO to take a consistent snapshot of the live
 * database — including anything still sitting in the WAL file. A plain file
 * copy of tennis.db while the app is running can silently miss recently
 * committed rows because src/db/index.js runs in WAL mode; VACUUM INTO reads
 * through a proper internal snapshot instead, so it's safe to run at any
 * time without stopping the app. It also defragments, so backups are
 * typically smaller than the live file. Opens its own read-only connection
 * so it never competes with the app's own connection for the write lock.
 */
function createBackup(attempt = 0) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const filename = timestampedFilename();
  const outPath = path.join(BACKUP_DIR, filename);
  if (fs.existsSync(outPath)) {
    // Filename collision (millisecond clock resolution, or two backups
    // fired back-to-back programmatically) — retry with a fresh timestamp
    // rather than failing, since VACUUM INTO refuses to overwrite.
    if (attempt >= 5) throw new Error('could not generate a unique backup filename');
    return createBackup(attempt + 1);
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return { filename, path: outPath, size: fs.statSync(outPath).size };
}

function listBackups() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, size: stat.size, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** Deletes backups beyond the most recent `retention` count, oldest first —
 * so a daily cron job doesn't fill up the Pi's SD card over months of runs. */
function pruneBackups(retention = DEFAULT_RETENTION) {
  const backups = listBackups();
  const toDelete = backups.slice(retention);
  for (const b of toDelete) {
    fs.unlinkSync(path.join(BACKUP_DIR, b.filename));
  }
  return toDelete.length;
}

/** Only ever called with filenames this module itself generated (see
 * timestampedFilename), but validated anyway since it backs the admin
 * download route, which takes the filename from the URL. */
function isValidBackupFilename(filename) {
  return /^tennis-backup-\d{8}-\d{9}\.db$/.test(filename);
}

module.exports = { createBackup, listBackups, pruneBackups, isValidBackupFilename, BACKUP_DIR, DEFAULT_RETENTION };
