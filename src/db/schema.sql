-- Tennis Doubles Scheduler — SQLite schema
-- Matches the data model in Technical_Architecture.md

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  active        INTEGER NOT NULL DEFAULT 1,
  slug          TEXT  -- URL-safe name-based id for "My Page" (/me/<slug>) links, e.g. 'brian-b'. App-level uniqueness only (see playerSlug.js) — generated once at creation and never auto-regenerated on rename, so existing bookmarks/emails/calendar links keep working. NULL only briefly for a pre-migration row before db/index.js's one-time backfill runs.
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
  follow_up_lead_hours INTEGER NOT NULL DEFAULT 27, -- hours before match_time the one automatic follow-up nudge fires for anyone still 'scheduled' (replaced a fixed 9am-morning-of time — Kyle, 2026-08-27: wanted this reachable during work hours the day before, not the morning of, since 9am-morning-of can already be mid-workday for an evening match)
  reminders_enabled  INTEGER NOT NULL DEFAULT 1, -- 0 pauses the automatic reminder + follow-up cron pass for this session only; manual Resend/Send reminders now are unaffected either way
  courts              INTEGER NOT NULL DEFAULT 1,
  players_per_week    INTEGER NOT NULL DEFAULT 4,
  club_name           TEXT NOT NULL DEFAULT '',   -- per-session: shown in this session's outbound emails, since different sessions can be different clubs/locations
  court_info          TEXT NOT NULL DEFAULT '',   -- per-session: e.g. "Court 3" or "North courts 1-2"
  color               TEXT,    -- optional hex color (e.g. '#0969da') the admin can set to visually tell same-club/same-time sessions apart; NULL falls back to a deterministic palette pick keyed by session id (see email.js's sessionColor())
  schedule_conflicts  TEXT,    -- JSON array of conflict objects from the last "Schedule these players" run, if infeasible
  archived_at         TEXT,    -- NULL = active/visible; set = hidden from the dashboard and public session picker, but not deleted (see "Archiving" in CLAUDE.md)
  session_type        TEXT NOT NULL DEFAULT 'regular', -- 'regular' | 'adhoc' — see "Ad-hoc sessions" in CLAUDE.md. Fixed for the life of a session; everything downstream (session detail page, dashboard section, cron behavior, which emails fire) branches on this.
  adhoc_invite_lead_hours   INTEGER NOT NULL DEFAULT 56, -- adhoc only: hours before match_time the first sign-up invite goes out to the whole roster
  adhoc_reminder_lead_hours INTEGER NOT NULL DEFAULT 30, -- adhoc only: hours before match_time a reminder goes to whoever on the roster hasn't signed up yet, but only if there's currently an incomplete trailing group (not a multiple of 4)
  adhoc_final_lead_hours    INTEGER NOT NULL DEFAULT 24, -- adhoc only: hours before match_time full courts get a "here's your court" email and any leftover incomplete group gets a "not enough signed up" email
  schedule_locked_at  TEXT,    -- NULL = not yet finalized; set manually via "Lock this schedule" once the admin is confident the schedule is done shifting — distinct from `status` leaving 'draft', which happens automatically on the first "Schedule these players" click. Doesn't restrict further edits; a marker/gate for behavior that should wait for a stable schedule. See "Lock this schedule" in CLAUDE.md.
  admin_report_emails      TEXT,    -- regular sessions only: comma-separated admin address(es) that get a pre-match status report for each week (who's confirmed/unconfirmed/needs a sub/subbed out/swapped). NULL/blank = feature off for this session. See "Admin pre-match status report" in CLAUDE.md.
  admin_report_lead_hours  INTEGER NOT NULL DEFAULT 8, -- hours before match_time the status report above goes out
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_players (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id         INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target_games      INTEGER NOT NULL,
  original_target   INTEGER, -- snapshot of target_games the first time this player was enrolled; never touched again, even if target_games is later edited down to "remaining open weeks" mid-season — see db/index.js
  role              TEXT NOT NULL DEFAULT 'regular',
  priority          INTEGER,  -- cross-session double-booking guard: lower = higher priority when this player's sessions collide on the same day; NULL = not yet decided (see scheduleRun.js)
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

-- Which master-list subs apply to which session (Kyle, 2026-08-13): the
-- broader_sub_list above is the whole pool of people willing to sub at all;
-- this join table is each session's own subset of that pool — only these
-- people get escalation emails when one of *this* session's sub requests
-- goes unanswered, not the entire master list. See subFlow.js's
-- escalateOverdueRequests() and "Per-session sub list" in CLAUDE.md.
CREATE TABLE IF NOT EXISTS session_sub_list (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  broader_list_id   INTEGER NOT NULL REFERENCES broader_sub_list(id) ON DELETE CASCADE,
  UNIQUE(session_id, broader_list_id)
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
  escalated_at          TEXT,
  initiated_by          TEXT NOT NULL DEFAULT 'player', -- 'player' | 'admin' — see subFlow.js's adminFlagNeedsSub()
  fanout_sent_at        TEXT -- NULL until the candidate roster has actually been emailed. Self-service requests set this immediately (see fanOutSubRequest()); an admin-flagged request leaves it NULL until cron.js's processReminders() reaches that week's normal reminder time, so the flag itself never emails anyone by surprise.
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
  category        TEXT NOT NULL, -- reminder | followup_reminder | sub_request | escalation | sub_filled | custom | confirmation | adhoc_invite | adhoc_reminder | adhoc_final | adhoc_not_enough
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

-- Ad-hoc pickup-game sign-ups (session_type = 'adhoc' — see CLAUDE.md). One
-- row per (week, roster player), created up front when the T-56h invite goes
-- out so the invite list and the sign-up state live in the same place.
-- `signed_up_at` is NULL until the player clicks their "I'm in" link — the
-- timestamp IS the first-come-first-served order, so court assignment is
-- always `ORDER BY signed_up_at` chunked into groups of 4, computed live
-- (see adhocFlow.js's courtGroupsForWeek()) rather than stored anywhere.
-- Reuses the same hashed-token pattern as every other emailed link in this
-- app (see tokens.js) — only the SHA-256 hash is stored, the raw value only
-- ever exists in the outbound email.
CREATE TABLE IF NOT EXISTS adhoc_signups (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id             INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  player_id           INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  token               TEXT UNIQUE NOT NULL,
  reminder_token      TEXT UNIQUE, -- a second, additionally-valid token minted only if/when the T-30h stragglers reminder fires (see adhocFlow.js's mintReminderToken()) — the original invite's raw token can't be reused since only its hash is ever stored, same "don't kill a link that's already out" reasoning as swap_requests.nudge_token. NULL until a reminder is actually sent.
  invited_at          TEXT NOT NULL DEFAULT (datetime('now')),
  signed_up_at        TEXT,   -- NULL = hasn't clicked "I'm in" yet
  reminded_at         TEXT,   -- set once the T-30h stragglers-only reminder has gone out to this player for this week
  result_notified_at  TEXT,   -- set once the T-24h final email (their court, or "not enough signed up") has gone out
  UNIQUE(week_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_adhoc_signups_week ON adhoc_signups(week_id);

CREATE INDEX IF NOT EXISTS idx_weeks_session ON weeks(session_id);
CREATE INDEX IF NOT EXISTS idx_assignments_week ON week_assignments(week_id);
CREATE INDEX IF NOT EXISTS idx_assignments_player ON week_assignments(player_id);
CREATE INDEX IF NOT EXISTS idx_blackout_session_player ON blackout_dates(session_id, player_id);
CREATE INDEX IF NOT EXISTS idx_assignment_tokens_assignment ON week_assignment_tokens(week_assignment_id);
