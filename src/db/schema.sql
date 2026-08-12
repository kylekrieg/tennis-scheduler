-- Tennis Doubles Scheduler — SQLite schema
-- Matches the data model in Technical_Architecture.md

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  active        INTEGER NOT NULL DEFAULT 1
);

-- Single-row global settings table
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  timezone      TEXT NOT NULL DEFAULT 'America/Chicago'
);
INSERT OR IGNORE INTO app_settings (id, timezone) VALUES (1, 'America/Chicago');

CREATE TABLE IF NOT EXISTS sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  start_date          TEXT NOT NULL,          -- ISO date
  end_date            TEXT NOT NULL,          -- ISO date
  status              TEXT NOT NULL DEFAULT 'draft', -- draft | scheduled | active | completed
  lookahead_weeks     INTEGER NOT NULL DEFAULT 4,
  match_day_of_week   INTEGER NOT NULL,       -- 0=Sun .. 6=Sat
  match_time          TEXT NOT NULL,          -- 'HH:MM' 24h, local to app_settings.timezone
  reminder_time       TEXT NOT NULL,          -- 'HH:MM' 24h
  reminder_days_before INTEGER NOT NULL DEFAULT 2,
  reminders_enabled  INTEGER NOT NULL DEFAULT 1, -- 0 pauses the automatic reminder + follow-up cron pass for this session only; manual Resend/Send reminders now are unaffected either way
  courts              INTEGER NOT NULL DEFAULT 1,
  players_per_week    INTEGER NOT NULL DEFAULT 4,
  club_name           TEXT NOT NULL DEFAULT '',   -- per-session: shown in this session's outbound emails, since different sessions can be different clubs/locations
  court_info          TEXT NOT NULL DEFAULT '',   -- per-session: e.g. "Court 3" or "North courts 1-2"
  color               TEXT,    -- optional hex color (e.g. '#0969da') the admin can set to visually tell same-club/same-time sessions apart; NULL falls back to a deterministic palette pick keyed by session id (see email.js's sessionColor())
  schedule_conflicts  TEXT,    -- JSON array of conflict objects from the last "Schedule these players" run, if infeasible
  archived_at         TEXT,    -- NULL = active/visible; set = hidden from the dashboard and public session picker, but not deleted (see "Archiving" in CLAUDE.md)
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_players (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target_games  INTEGER NOT NULL,
  role          TEXT NOT NULL DEFAULT 'regular',
  priority      INTEGER,  -- cross-session double-booking guard: lower = higher priority when this player's sessions collide on the same day; NULL = not yet decided (see scheduleRun.js)
  UNIQUE(session_id, player_id)
);

CREATE TABLE IF NOT EXISTS blackout_dates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,   -- ISO date
  source        TEXT NOT NULL DEFAULT 'self', -- self | admin
  UNIQUE(session_id, player_id, date)
);

-- VESTIGIAL as of the removal of the blackout-date email-confirmation step
-- (POST /blackout now writes straight to blackout_dates) — left in place,
-- never dropped, per this app's additive-only migration philosophy. Nothing
-- reads or writes this table anymore; kept only so an existing install that
-- happens to have a stale row here doesn't hit a missing-table error.
CREATE TABLE IF NOT EXISTS blackout_pending (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  dates_json    TEXT NOT NULL,   -- JSON array of ISO dates selected, awaiting confirmation
  token         TEXT UNIQUE NOT NULL, -- SHA-256 hash of the raw token; raw value only ever exists in the emailed link
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, player_id) -- a new submission replaces any not-yet-confirmed one for that player
);

CREATE TABLE IF NOT EXISTS broader_sub_list (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS weeks (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  week_number           INTEGER NOT NULL,
  match_date            TEXT NOT NULL,  -- ISO date
  locked                INTEGER NOT NULL DEFAULT 0,
  ball_duty_player_id   INTEGER REFERENCES players(id),
  needs_attention        INTEGER NOT NULL DEFAULT 0, -- flagged infeasible by scheduler
  notes                 TEXT,
  UNIQUE(session_id, week_number)
);

CREATE TABLE IF NOT EXISTS week_assignments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id         INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  player_id       INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team            TEXT NOT NULL,  -- 'A' | 'B'
  court           INTEGER NOT NULL DEFAULT 1, -- which physical court this team pair is on, for multi-court sessions
  is_sub          INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | confirmed | needs_sub | subbed_out
  token           TEXT UNIQUE, -- vestigial as of the multi-token redesign — see week_assignment_tokens. Left in place (never dropped) per this app's additive-only migration philosophy; no longer read.
  token_used_at   TEXT, -- last time ANY token for this assignment was used (any row in week_assignment_tokens)
  confirmed_at    TEXT,
  UNIQUE(week_id, player_id)
);

-- Replaces the single week_assignments.token column. Multiple tokens can be
-- valid for the same assignment at once (e.g. the original reminder link and
-- a later follow-up nudge's link both work), so a player who goes back to an
-- older-but-still-recent email doesn't hit a dead "Link not found" page. Rows
-- are deleted (not just marked used) when they should stop working: when the
-- assignment's status leaves scheduled/confirmed (see tokenStore.js), or when
-- the whole week locks because match time has passed (cron.processWeekLocking).
CREATE TABLE IF NOT EXISTS week_assignment_tokens (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  week_assignment_id    INTEGER NOT NULL REFERENCES week_assignments(id) ON DELETE CASCADE,
  token                 TEXT UNIQUE NOT NULL, -- SHA-256 hash of the raw token; raw value only ever exists in the emailed link
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sub_requests (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  week_assignment_id    INTEGER NOT NULL REFERENCES week_assignments(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'open', -- open | filled | escalated | unfilled
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  escalated_at          TEXT
);

CREATE TABLE IF NOT EXISTS sub_offers (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_request_id        INTEGER NOT NULL REFERENCES sub_requests(id) ON DELETE CASCADE,
  candidate_player_id   INTEGER REFERENCES players(id),
  broader_list_id       INTEGER REFERENCES broader_sub_list(id),
  token                 TEXT UNIQUE NOT NULL, -- SHA-256 hash of the raw token
  status                TEXT NOT NULL DEFAULT 'pending', -- pending | claimed | closed
  responded_at          TEXT
);

-- Direct player-to-player swap proposals: a two-way trade between two
-- specific players' own upcoming slots (initiator gives up their own
-- assignment, takes over the target's), distinct from sub_requests/sub_offers
-- above (a one-to-many fan-out where someone drops out and anyone can claim
-- it). One row per proposal, single token since it's addressed to exactly
-- one specific player rather than fanned out. See swapFlow.js.
CREATE TABLE IF NOT EXISTS swap_requests (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  initiator_assignment_id INTEGER NOT NULL REFERENCES week_assignments(id) ON DELETE CASCADE,
  target_assignment_id    INTEGER NOT NULL REFERENCES week_assignments(id) ON DELETE CASCADE,
  initiator_player_id     INTEGER REFERENCES players(id), -- snapshot of who proposed it, taken at proposeSwap() time; see identity-drift check in respondToSwap()
  target_player_id        INTEGER NOT NULL REFERENCES players(id),
  token                   TEXT UNIQUE NOT NULL, -- SHA-256 hash of the raw token; raw value only ever exists in the emailed link
  nudge_token             TEXT UNIQUE, -- SHA-256 hash of a second, additionally-valid token minted for the one-time nudge email (see nudgeOverdueSwaps() in swapFlow.js) — does not invalidate `token`, same "multiple valid tokens" reasoning as week_assignment_tokens
  nudged_at               TEXT, -- set once the overdue nudge has gone out; NULL until then, so the cron pass never nudges twice
  status                  TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined | cancelled | expired (expired = still pending once the earlier of the two involved weeks' match times arrived — see expireStaleSwaps())
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_swap_requests_initiator ON swap_requests(initiator_assignment_id);
CREATE INDEX IF NOT EXISTS idx_swap_requests_target ON swap_requests(target_assignment_id);

CREATE TABLE IF NOT EXISTS email_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email        TEXT NOT NULL,
  subject         TEXT NOT NULL,
  category        TEXT NOT NULL, -- reminder | followup_reminder | sub_request | escalation | sub_filled | custom | confirmation
  status          TEXT NOT NULL DEFAULT 'sent', -- sent | failed | logged_dev_mode (no SMTP configured, console-only)
  sent_at         TEXT NOT NULL DEFAULT (datetime('now')),
  related_week_id INTEGER REFERENCES weeks(id)
);

-- Audit trail of admin-triggered changes, added 2026-08-10 for accountability
-- now that multiple admins share full, untiered access (see "Admin accounts"
-- in CLAUDE.md — any admin can do anything, so knowing *who* made a given
-- change is otherwise unrecoverable). Deliberately a plain, human-readable
-- log (one row per action with a prose `description`), matching this app's
-- existing email_log pattern (simple, queryable, no structured diff system)
-- rather than a heavier audit framework for a small, low-volume admin panel.
CREATE TABLE IF NOT EXISTS admin_activity_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id      INTEGER REFERENCES admins(id), -- nullable defensively; admins are never hard-deleted today (only deactivated — see admin.js), but not relied on
  admin_name    TEXT NOT NULL, -- denormalized snapshot at the time of the action, so the log reads correctly with one query, no JOIN required
  action        TEXT NOT NULL, -- short machine-readable tag, e.g. 'session.schedule', 'week.reassign' — see activityLog.js for the full list
  description   TEXT NOT NULL, -- human-readable summary, e.g. "Reassigned Wed 9/9 slot from Kyle Krieg to John Gunther"
  session_id    INTEGER REFERENCES sessions(id), -- nullable (not every action is session-scoped, e.g. admin account management). Deliberately NOT cascaded on session delete, same reasoning as email_log.related_week_id — a change record should outlive a deleted session for support/history purposes. POST /admin/sessions/:id/delete nulls this out first, same pattern it already uses for email_log.related_week_id.
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_log_session ON admin_activity_log(session_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON admin_activity_log(created_at);

CREATE INDEX IF NOT EXISTS idx_weeks_session ON weeks(session_id);
CREATE INDEX IF NOT EXISTS idx_assignments_week ON week_assignments(week_id);
CREATE INDEX IF NOT EXISTS idx_assignments_player ON week_assignments(player_id);
CREATE INDEX IF NOT EXISTS idx_blackout_session_player ON blackout_dates(session_id, player_id);
CREATE INDEX IF NOT EXISTS idx_assignment_tokens_assignment ON week_assignment_tokens(week_assignment_id);
