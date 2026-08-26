// Uses Node's built-in node:sqlite (available Node >=22.5, no native compile step —
// deliberately chosen over better-sqlite3 so `npm install` has zero native build
// dependencies, which matters most on a Raspberry Pi.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', '..', 'data', 'tennis.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const raw = new DatabaseSync(DB_PATH);
raw.exec('PRAGMA journal_mode = WAL');
raw.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
raw.exec(schema);

// Lightweight migration guard: schema.sql's CREATE TABLE IF NOT EXISTS won't
// add new columns to a table that already exists from an earlier version of
// this app. There's no full migration system here (small single-admin app),
// so instead we just check for columns added after initial release and add
// them in place if missing, preserving existing data.
function ensureColumn(table, column, definition) {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true; // column was just added
  }
  return false; // already existed
}
function hasColumn(table, column) {
  return raw.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
ensureColumn('email_log', 'status', "TEXT NOT NULL DEFAULT 'sent'");
// Multi-court support: every existing row predates courts, so they're all
// implicitly court 1 — exactly what the default backfills.
ensureColumn('week_assignments', 'court', 'INTEGER NOT NULL DEFAULT 1');
// Archiving a session (hides it from the dashboard/session picker without
// deleting anything) — every existing row predates this, so NULL (not
// archived) is exactly the right default for them.
ensureColumn('sessions', 'archived_at', 'TEXT');
// Per-session toggle to pause the automatic reminder/follow-up cron pass
// (e.g. while testing) without touching manual sends — every existing row
// predates this, so defaulting to 1 (enabled) preserves current behavior.
ensureColumn('sessions', 'reminders_enabled', 'INTEGER NOT NULL DEFAULT 1');
// Cross-session double-booking guard: lets the admin rank which session a
// player belongs to on a given day when two of their sessions collide (same
// match_day_of_week, overlapping date ranges). NULL = unresolved (existing
// rows all predate this, so every one of them defaults to "not yet decided",
// which is the correct, safe default — see scheduleRun.js's
// crossSessionPriorityExclusions()). Lower number = higher priority.
ensureColumn('session_players', 'priority', 'INTEGER');
// Snapshot of who proposed a swap, taken at proposal time — lets
// respondToSwap() detect if an admin reassigned either side's slot to a
// different player while the request was still pending, instead of silently
// executing a trade with whoever currently happens to hold the assignment
// (see swapFlow.js's identity-drift check). Existing rows all predate this
// column and get NULL, which the check treats as "can't verify, refuse" —
// safe by construction since NULL never equals a real player id.
ensureColumn('swap_requests', 'initiator_player_id', 'INTEGER');
// Overdue-swap nudge + expiry (Kyle, 2026-08-11): a pending swap had no
// timeout or escalation at all — if the target player never responded, it
// just sat there forever with no admin visibility. `nudge_token`/`nudged_at`
// track the one-time reminder email (see nudgeOverdueSwaps()); existing rows
// get NULL, which correctly means "no nudge sent yet" for a pre-migration
// swap that's already pending. `status` also gains an 'expired' value handled
// entirely in application code (see expireStaleSwaps()), so no schema change
// was needed for that part.
ensureColumn('swap_requests', 'nudge_token', 'TEXT');
ensureColumn('swap_requests', 'nudged_at', 'TEXT');

// original_target snapshots each player's configured target the FIRST time
// they're enrolled in a session (see admin.js's roster-save route) and is
// never touched again, even if target_games is later edited down to "just
// the remaining open weeks" after a mid-season roster change. Kyle,
// 2026-08-13: target_games itself has no history — overwriting it mid-season
// silently loses the original number, which the Stats page inherited too
// since it reads that same column. Existing rows predate this column and
// have no way to know what their true original number was (only today's
// current target_games survives), so treating "whatever's currently there"
// as the best available approximation is the right one-time backfill rather
// than leaving it NULL forever. The WHERE clause makes this safe to run on
// every boot rather than needing a one-time guard: after the first boot every
// row has a value, and every new enrollment sets it at INSERT time (never
// UPDATE), so nothing here ever matches again in practice.
ensureColumn('session_players', 'original_target', 'INTEGER');
raw.exec('UPDATE session_players SET original_target = target_games WHERE original_target IS NULL');

// Explicit "lock this schedule" action (Kyle, 2026-08-13) — distinct from the
// automatic draft -> scheduled status flip that already happens on the FIRST
// "Schedule these players" click. Between that first click and whenever the
// admin is actually confident the schedule is final, blackout dates can still
// change (admin overrides bypass the player-facing lock), the roster can
// still be edited, and another session's roster can shift the double-booking
// picture — so "a schedule technically exists" and "this is the version
// we're standing behind" are genuinely different moments. Nullable TEXT
// timestamp, manually set/cleared via a button (not automatic — matches every
// other judgment call in this app), existing rows all predate this and
// default to NULL (not locked), which is the correct, safe default. Locking
// does not restrict any further edits — it's a marker and, eventually, a gate
// for behavior that should wait for a stable schedule (see the deferred
// sub-needed notification under discussion in CLAUDE.md), not a hard block.
ensureColumn('sessions', 'schedule_locked_at', 'TEXT');

// Admin-flagged sub requests (Kyle, 2026-08-13): an admin can now flag a
// player's slot as needing a sub directly from the Reassign dropdown ("Needs
// a sub"), for a hard conflict discovered before the player's gotten to it
// themselves — deliberately rare/edge-case, per Kyle ("admins should really
// not be touching the player schedule except for edge cases"). Unlike the
// player-initiated flow, this sends no email of any kind at the moment it's
// flagged — not even to the affected player — and the candidate fan-out
// itself waits for that week's normal reminder time rather than firing
// immediately. `initiated_by` records which path created the request (shown
// nowhere player-facing, just for admin/audit clarity); `fanout_sent_at`
// is the actual gate cron.js's processReminders() checks. Existing rows
// predate both columns and were all self-service by definition (this feature
// didn't exist yet), so they backfill to 'player' / fanout already sent at
// creation time — the correct history for a request that, at the time, could
// only have come from a player and could only have emailed immediately.
ensureColumn('sub_requests', 'initiated_by', "TEXT NOT NULL DEFAULT 'player'");
ensureColumn('sub_requests', 'fanout_sent_at', 'TEXT');
raw.exec(`UPDATE sub_requests SET fanout_sent_at = created_at WHERE fanout_sent_at IS NULL AND initiated_by = 'player'`);

// Club name/court info used to be one global value in app_settings; now each
// session has its own (a single install can run sessions for different
// clubs/locations). For an install that already had the old global columns
// set, backfill every session with that value on the boot where the new
// per-session columns first get added, so upgrading doesn't silently blank
// out something that was already configured. Brand new installs never had
// the old app_settings columns in the first place (schema.sql no longer
// creates them), so hasColumn() guards against reading columns that don't
// exist there.
const sessionsGotClubCol = ensureColumn('sessions', 'club_name', "TEXT NOT NULL DEFAULT ''");
const sessionsGotCourtCol = ensureColumn('sessions', 'court_info', "TEXT NOT NULL DEFAULT ''");
if ((sessionsGotClubCol || sessionsGotCourtCol) && hasColumn('app_settings', 'club_name')) {
  const old = raw.prepare('SELECT club_name, court_info FROM app_settings WHERE id = 1').get();
  if (old && (old.club_name || old.court_info)) {
    raw.prepare('UPDATE sessions SET club_name = ?, court_info = ?').run(old.club_name || '', old.court_info || '');
  }
}

ensureColumn('sessions', 'color', 'TEXT');

// Ad-hoc pickup-game sessions (Kyle, 2026-08-12) — a second session shape
// alongside the original fairness-scheduled "regular" one. Every existing
// row predates this, so 'regular' is exactly the right default to preserve
// current behavior; the three lead-hour fields default to the exact routine
// Kyle described (56h initial invite, 30h stragglers-only reminder, 24h
// final roster/"not enough" email) so a freshly-created ad-hoc session works
// out of the box without the admin having to know to configure them. See
// "Ad-hoc sessions" in CLAUDE.md and adhocFlow.js.
ensureColumn('sessions', 'session_type', "TEXT NOT NULL DEFAULT 'regular'");
ensureColumn('sessions', 'adhoc_invite_lead_hours', 'INTEGER NOT NULL DEFAULT 56');
ensureColumn('sessions', 'adhoc_reminder_lead_hours', 'INTEGER NOT NULL DEFAULT 30');
ensureColumn('sessions', 'adhoc_final_lead_hours', 'INTEGER NOT NULL DEFAULT 24');

// One-time seed: before session_sub_list existed, EVERY sub request in the
// app escalated to the ENTIRE broader_sub_list, regardless of session — see
// "Per-session sub list" in CLAUDE.md. Upgrading an install that already
// has real sessions and a real master list, with session_sub_list still
// empty (never touched), assigns every existing master-list person to
// every existing session once, so escalation keeps working exactly as it
// did before this feature existed until the admin deliberately narrows it
// per session. A brand new install has nothing to preserve (no sessions or
// master list yet), so this is a no-op there.
const sessionSubListCount = raw.prepare('SELECT COUNT(*) as n FROM session_sub_list').get().n;
if (sessionSubListCount === 0) {
  const allSessionIds = raw.prepare('SELECT id FROM sessions').all().map((r) => r.id);
  const allSubIds = raw.prepare('SELECT id FROM broader_sub_list').all().map((r) => r.id);
  if (allSessionIds.length > 0 && allSubIds.length > 0) {
    const insertPair = raw.prepare('INSERT OR IGNORE INTO session_sub_list (session_id, broader_list_id) VALUES (?, ?)');
    for (const sessionId of allSessionIds) {
      for (const subId of allSubIds) insertPair.run(sessionId, subId);
    }
  }
}

// One-time seed: the app used to support exactly one admin, via
// ADMIN_PASSWORD_HASH in .env. Now that logins live in the `admins` table
// (so more than one person can have their own password), an upgrade with no
// rows yet gets a single "Admin" row carried over from that env var, so
// nobody's existing password stops working after this update. New admins
// after that are managed entirely from Admin -> Admins, not .env.
const adminCount = raw.prepare('SELECT COUNT(*) as n FROM admins').get().n;
if (adminCount === 0 && process.env.ADMIN_PASSWORD_HASH) {
  raw
    .prepare('INSERT INTO admins (name, password_hash, active) VALUES (?, ?, 1)')
    .run('Admin', process.env.ADMIN_PASSWORD_HASH);
}

// Name-based "My Page" URLs (Kyle, 2026-08-26): players.slug is app-level
// unique (no DB constraint — see playerSlug.js's slugTaken(), which is what
// actually enforces it on create/edit), generated once from the player's
// name and never auto-regenerated afterward so existing /me/<slug> links
// stay valid even if the name is later corrected. Every existing row
// predates this column, so backfill every NULL slug once, in a stable order
// (id ASC) so re-running this is a no-op after the first boot — same
// "unconditional WHERE-guarded backfill" pattern as original_target above.
// Collisions within the backfill itself (two players who'd generate the
// same base slug) are resolved the same way playerSlug.js resolves any
// other collision: -2, -3, ... appended, checked against both already-
// committed rows and slugs assigned earlier in this same loop.
ensureColumn('players', 'slug', 'TEXT');
{
  const { generateUniqueSlug } = require('../services/playerSlug');
  const unslugged = raw.prepare('SELECT id, name FROM players WHERE slug IS NULL ORDER BY id ASC').all();
  if (unslugged.length > 0) {
    const setSlug = raw.prepare('UPDATE players SET slug = ? WHERE id = ?');
    for (const p of unslugged) {
      setSlug.run(generateUniqueSlug(raw, p.name, p.id), p.id);
    }
  }
}

// Thin wrapper giving a better-sqlite3-like ergonomic API (prepare().run/get/all,
// plus a convenience .exec) so the rest of the app reads the same regardless of
// which underlying driver is in use.
function normalizeParams(params) {
  // node:sqlite wants named params without the leading punctuation stripped, and
  // does not accept `undefined` — convert to null.
  if (Array.isArray(params)) {
    return params.map((p) => (p === undefined ? null : p));
  }
  if (params && typeof params === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(params)) {
      out[k] = v === undefined ? null : v;
    }
    return out;
  }
  return params;
}

const db = {
  raw,
  prepare(sql) {
    const stmt = raw.prepare(sql);
    return {
      run: (...args) => stmt.run(...args.map(normalizeParams)),
      get: (...args) => stmt.get(...args.map(normalizeParams)),
      all: (...args) => stmt.all(...args.map(normalizeParams)),
    };
  },
  exec(sql) {
    return raw.exec(sql);
  },
  transaction(fn) {
    return (...args) => {
      raw.exec('BEGIN');
      try {
        const result = fn(...args);
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    };
  },
};

module.exports = db;
