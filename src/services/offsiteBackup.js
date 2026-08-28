'use strict';

// Pushes everything in backups/ to a remote machine over rsync+ssh. Reads
// its destination from four .env vars (OFFSITE_SSH_HOST/USER/PATH, plus
// optional PORT/KEY) rather than hardcoding a destination, since this app
// has no built-in notion of "Kyle's other computer" — see the "Get backups
// off the Pi" section in README.md for how to generate a key, authorize it
// on the remote machine, and set these.
//
// Uses the system `rsync` binary via child_process rather than a new npm
// dependency (rsync ships preinstalled on Raspberry Pi OS / Debian) — rsync
// is the right tool here, not scp, because it only transfers files that
// changed since the last push, so a nightly run after pruning is cheap even
// as backups/ accumulates.

const { spawnSync } = require('child_process');
const { BACKUP_DIR } = require('./backup');

function offsiteConfig() {
  return {
    host: process.env.OFFSITE_SSH_HOST || '',
    user: process.env.OFFSITE_SSH_USER || '',
    remotePath: process.env.OFFSITE_SSH_PATH || '',
    port: process.env.OFFSITE_SSH_PORT || '22',
    keyPath: process.env.OFFSITE_SSH_KEY || '',
  };
}

function isConfigured(cfg = offsiteConfig()) {
  return !!(cfg.host && cfg.user && cfg.remotePath);
}

// Pushes the local backups/ directory to the configured remote path.
// Returns { skipped: true, reason } if not configured, or
// { skipped: false, stdout } on a successful push. Throws on failure.
function pushBackupsOffsite() {
  const cfg = offsiteConfig();
  if (!isConfigured(cfg)) {
    return {
      skipped: true,
      reason: 'OFFSITE_SSH_HOST/OFFSITE_SSH_USER/OFFSITE_SSH_PATH not set in .env — off-site push is disabled',
    };
  }

  const sshOptsParts = ['-p', cfg.port, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  if (cfg.keyPath) sshOptsParts.push('-i', cfg.keyPath);
  const sshCommand = `ssh ${sshOptsParts.map((part) => `'${part.replace(/'/g, "'\\''")}'`).join(' ')}`;

  const src = BACKUP_DIR.endsWith('/') ? BACKUP_DIR : `${BACKUP_DIR}/`;
  const remoteDir = cfg.remotePath.endsWith('/') ? cfg.remotePath : `${cfg.remotePath}/`;
  const remote = `${cfg.user}@${cfg.host}:${remoteDir}`;

  const result = spawnSync('rsync', ['-avz', '-e', sshCommand, src, remote], {
    encoding: 'utf8',
    timeout: 5 * 60 * 1000, // 5 minutes — generous for a folder of small SQLite snapshots over SSH
  });

  if (result.error) {
    const hint = result.error.code === 'ENOENT' ? ' (is rsync installed? try: sudo apt install rsync)' : '';
    throw new Error(`could not run rsync: ${result.error.message}${hint}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim().slice(0, 2000);
    throw new Error(`rsync exited with code ${result.status}${stderr ? `: ${stderr}` : ''}`);
  }
  return { skipped: false, stdout: result.stdout };
}

module.exports = { offsiteConfig, isConfigured, pushBackupsOffsite };
