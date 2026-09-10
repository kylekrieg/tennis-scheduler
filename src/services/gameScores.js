'use strict';
const db = require('../db');
const { SESSION_DISPLAY_ORDER } = require('./sessionHelper');

/**
 * Player-entered "games won" (Kyle, 2026-09-09): "a screen where players can
 * enter the # of games won during their weekly match. This will tally
 * together during a session... a running total can be seen with a player
 * leader board." Each player reports their OWN number for their own week —
 * not a single shared team score — so the value lives directly on that
 * player's own week_assignments row (see schema.sql/db/index.js's
 * games_won/games_won_entered_at/games_won_updated_at columns).
 *
 * Entry is only offered once a match has actually happened
 * (weeks.locked = 1 — the same "has this really occurred" flag the rest of
 * the app uses, set by cron.js's processWeekLocking once match_time has
 * passed) and only for the row the player actually played
 * (status IN ('scheduled', 'confirmed') — excludes needs_sub, where nobody
 * ultimately played that slot as this player, and subbed_out, where someone
 * else did).
 *
 * Self-service editing stays open for 24 hours after the score is FIRST
 * entered (games_won_entered_at), not from match time or week-lock time —
 * so a score entered a few days late (someone catching up on a backlog)
 * still gets a full day to fix a typo, rather than being locked the moment
 * it's saved. After that window, only an admin can change it (see the admin
 * session-detail "Games won" field in admin.js/session_detail.ejs, which
 * bypasses this window entirely — same "admin can always override" pattern
 * as everywhere else in this app).
 *
 * Two public entry points share all of the above (isScoreable/canPlayerEdit
 * gating never differs between them): the original per-player page
 * (GET/POST /scores/:idOrSlug, scoreRowsForPlayer below) where a player
 * looks up their own name and can only ever touch their own row, and a
 * group entry grid added 2026-09-10 (GET/POST /scores,
 * scoreEntryWeeksForSession/scoreRowsForWeek below) that lists everybody
 * confirmed for one week at once so a single person can fill in some or all
 * of the group's scores in one sitting — Kyle's explicit call there is that
 * the group page has no "is this your own row" check at all, same "no
 * accounts, just a public page" trust level the rest of the app already
 * runs on (see setGameScore's playerId doc comment for exactly how that's
 * wired).
 *
 * GAMES PLAYED (Kyle, 2026-09-10, revised the same day): every 4 players on
 * one court in one week play the same match, so there is exactly ONE real
 * "games played" total for that week+court — not something each player
 * reports individually (an earlier same-day cut did exactly that, on
 * week_assignments.games_played; see that column's now-vestigial doc
 * comment in schema.sql for why it was replaced). The shared value lives in
 * its own week_court_games table, entered once — by any player, via either
 * entry point, or by an admin — and is what sessionWinPercentLeaderboard()/
 * overallWinPercentLeaderboard() below divide each player's games_won by.
 * See setGamesPlayedForWeekCourt()'s doc comment for the write path and
 * canEditGamesPlayed() for its own independent 24h self-service window,
 * mirroring games_won's but keyed by week+court instead of by player.
 */

const MAX_GAMES = 50; // sane sanity cap, not a real tennis rule — just guards against fat-fingered/garbage input
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** SQLite's `datetime('now')` values are stored as 'YYYY-MM-DD HH:MM:SS' UTC,
 * no 'T'/'Z' — this is the same parse-back trick used elsewhere in this app
 * (e.g. admin.js's subHistory mapping) to turn one back into a real Date. */
function parseDbTimestamp(s) {
  if (!s) return null;
  return new Date(`${s.replace(' ', 'T')}Z`);
}

/** Validates/normalizes a raw form value into an integer games-won count, or
 * null if it isn't one — shared by both the public self-service route and
 * the admin override route so the two can never disagree on what counts as
 * a valid score. */
function parseGamesWon(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_GAMES) return null;
  return n;
}

/** Same validation as parseGamesWon, for the shared games-played total (see
 * this file's top doc comment). Kept as its own function rather than an
 * alias so the two can diverge later without surprising the other caller. */
function parseGamesPlayed(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_GAMES) return null;
  return n;
}

/** Whether this assignment's match has actually happened and this row is
 * the one the player actually played (as opposed to a slot they dropped or
 * never filled) — the baseline gate before self-service entry is offered at
 * all. `row` needs `status` and a `week_locked` (or `locked`) flag, e.g.
 * from a `wa.*, w.locked AS week_locked` join. */
function isScoreable(row) {
  const weekLocked = row.week_locked != null ? row.week_locked : row.locked;
  return !!weekLocked && (row.status === 'scheduled' || row.status === 'confirmed');
}

/** When a scoreable row's self-service edit window closes, or null if it's
 * never been entered yet (in which case there's no lock — first entry is
 * always allowed for a scoreable row). */
function lockAt(row) {
  const enteredAt = parseDbTimestamp(row.games_won_entered_at);
  if (!enteredAt) return null;
  return new Date(enteredAt.getTime() + EDIT_WINDOW_MS);
}

/** Full lock status for display — "editable until <lockAt>" vs. "locked,
 * ask an admin to change it". `locked` is only ever true once a score has
 * actually been entered AND the 24h window has passed; a never-entered
 * scoreable row is always open. */
function lockInfo(row, now = new Date()) {
  const enteredAt = parseDbTimestamp(row.games_won_entered_at);
  if (!enteredAt) return { enteredAt: null, lockAt: null, locked: false };
  const at = lockAt(row);
  return { enteredAt, lockAt: at, locked: now >= at };
}

/** Whether a PLAYER (not an admin) may save a value for this row right now.
 * Admins bypass this entirely (see setGameScore's isAdmin flag) — they can
 * always edit a scoreable row, and can also edit one that isn't scoreable
 * yet if they want to get ahead of it, same "admin override" latitude the
 * rest of the app gives (e.g. Mark confirmed, Reassign). */
function canPlayerEdit(row, now = new Date()) {
  if (!isScoreable(row)) return false;
  return !lockInfo(row, now).locked;
}

/** Same "editable until 24h after first entry" shape as lockInfo() above,
 * for the shared games-played total instead of one player's games-won.
 * `gpRow` is a week_court_games row (or null/undefined if nothing's been
 * entered for this week+court yet, in which case there's no lock — first
 * entry is always open once the week itself is locked). */
function lockInfoGamesPlayed(gpRow, now = new Date()) {
  const enteredAt = gpRow ? parseDbTimestamp(gpRow.games_played_entered_at) : null;
  if (!enteredAt) return { enteredAt: null, lockAt: null, locked: false };
  const at = new Date(enteredAt.getTime() + EDIT_WINDOW_MS);
  return { enteredAt, lockAt: at, locked: now >= at };
}

/** Whether a PLAYER (not an admin) may save the shared games-played total
 * for this week+court right now — `weekLocked` gates it the same way
 * isScoreable() gates games_won (no self-service before the match has
 * actually happened), then the same 24h-from-first-entry window as
 * canPlayerEdit(), just keyed by week+court instead of by assignment. No
 * per-player ownership concept here at all — it's one shared number for
 * everyone who played that match, by design (see this file's top doc
 * comment). Admins bypass this entirely, same as canPlayerEdit(). */
function canEditGamesPlayed(weekLocked, gpRow, now = new Date()) {
  if (!weekLocked) return false;
  return !lockInfoGamesPlayed(gpRow, now).locked;
}

/** The shared games-played row for one week+court, or undefined if nothing's
 * been entered yet. */
function gamesPlayedRowForWeekCourt(weekId, court) {
  return db.prepare('SELECT * FROM week_court_games WHERE week_id = ? AND court = ?').get(weekId, court);
}

/** Every week_court_games row for one week (any court), keyed for the group
 * entry grid to look up by court number without a query per court. */
function gamesPlayedRowsForWeek(weekId) {
  const rows = db.prepare('SELECT * FROM week_court_games WHERE week_id = ?').all(weekId);
  const byCourt = new Map();
  for (const r of rows) byCourt.set(r.court, r);
  return byCourt;
}

/** Every one of this player's assignment rows across every session that are
 * either already scoreable or already scored, most recent match first —
 * this is what the /scores/:idOrSlug page lists. Deliberately NOT scoped to
 * "upcoming" (unlike sessionHelper.js's sessionsForPlayer, which is built
 * for My Page's forward-looking view) — scoring only ever applies to a
 * match that's already happened, so this looks backward instead. */
function scoreRowsForPlayer(playerId) {
  return db
    .prepare(
      `SELECT wa.*, w.match_date, w.locked AS week_locked, w.session_id
       FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       WHERE wa.player_id = ? AND w.locked = 1 AND wa.status IN ('scheduled', 'confirmed') AND s.games_won_enabled = 1
       ORDER BY w.match_date DESC`
    )
    .all(playerId);
}

/** Sessions to show on this player's Scores page: any non-archived session
 * where they have at least one scoreable (locked, actually-played) row —
 * covers both their own roster sessions and a sub's one-off appearance,
 * same inclusive spirit as sessionHelper.js's sessionsForPlayer but scoped
 * to past/locked weeks instead of upcoming ones. */
function sessionsWithScoresForPlayer(playerId) {
  return db
    .prepare(
      `SELECT DISTINCT s.* FROM sessions s
       JOIN weeks w ON w.session_id = s.id
       JOIN week_assignments wa ON wa.week_id = w.id
       WHERE wa.player_id = ? AND w.locked = 1 AND wa.status IN ('scheduled', 'confirmed')
         AND s.archived_at IS NULL AND s.games_won_enabled = 1
       ${SESSION_DISPLAY_ORDER}`
    )
    .all(playerId);
}

/**
 * Group entry (Kyle, 2026-09-10): "instead of a dropdown and everybody
 * entering their own score, show everybody confirmed for that week with
 * input boxes, so one person can fill in the whole group's scores." This is
 * the week-picking half of that: every locked week in a session that has at
 * least one actually-played (scoreable) row, most recent first, each
 * flagged with how many of those rows are still missing a score. The public
 * /scores page defaults to the newest one (`weeks[0]`) and offers any other
 * week with `missing_count > 0` as a "still needs scores" pick-list, so a
 * week nobody got to right after it happened doesn't just fall off the page
 * once a newer week locks.
 */
function scoreEntryWeeksForSession(sessionId) {
  return db
    .prepare(
      `SELECT w.*,
              SUM(CASE WHEN wa.status IN ('scheduled','confirmed') THEN 1 ELSE 0 END) AS scoreable_count,
              SUM(CASE WHEN wa.status IN ('scheduled','confirmed') AND wa.games_won IS NULL THEN 1 ELSE 0 END) AS missing_count
       FROM weeks w
       JOIN week_assignments wa ON wa.week_id = w.id
       WHERE w.session_id = ? AND w.locked = 1
       GROUP BY w.id
       HAVING scoreable_count > 0
       ORDER BY w.match_date DESC`
    )
    .all(sessionId);
}

/** Every actually-played (scoreable) assignment row for ONE week, in name
 * order — the group entry grid's data source. Deliberately not scoped to a
 * player, unlike scoreRowsForPlayer above: this is "who actually played
 * this week," full stop, since anyone landing on the group page may fill in
 * any or all of the boxes. Includes `court` (via wa.*), which the route
 * groups rows by so the shared games-played field can be shown once per
 * court rather than once per player. */
function scoreRowsForWeek(weekId) {
  return db
    .prepare(
      `SELECT wa.*, w.match_date, w.locked AS week_locked, w.session_id, p.name, p.slug
       FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = wa.player_id
       WHERE wa.week_id = ? AND wa.status IN ('scheduled', 'confirmed')
       ORDER BY wa.court, p.name`
    )
    .all(weekId);
}

/** Result codes setGameScore()/setGamesPlayedForWeekCourt() can throw as
 * `err.code`, for the routes to turn into a plain-language message rather
 * than a raw 500. */
const ScoreError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};

/**
 * Validates and saves one player's games-won value for one assignment.
 * `isAdmin: true` skips both the scoreable gate and the 24h self-service
 * window (an admin can set/fix a score on any row, any time — same
 * unrestricted override latitude the rest of the admin panel has).
 *
 * `playerId` is optional and only ever used as an ownership check: the
 * per-player page (POST /scores/:idOrSlug) passes the resolved player so a
 * guessable assignment id can't be used to write onto someone else's row
 * from that page. The group entry page (POST /scores) calls this with
 * `playerId` left null on purpose — Kyle's explicit call (2026-09-10) is
 * that anyone on the group page can fill in anyone's box, same "no
 * accounts, just a public page" trust level the rest of this app already
 * runs on — so when it's omitted the ownership check is simply skipped
 * rather than failing closed. Either caller still goes through the
 * scoreable gate and the 24h self-service edit window below; only the
 * "is this actually your row" check is conditional on `playerId`.
 *
 * `games_won_entered_at` is only ever set the FIRST time (COALESCE keeps it
 * fixed after that — see schema.sql's doc comment); `games_won_updated_at`
 * is stamped on every save. Returns `{ row, wasFirstEntry }` so the caller
 * can log/word the activity entry as "entered" vs. "updated".
 *
 * Cross-checked against the shared games-played total for this row's
 * week+court (see this file's top doc comment), if one has been entered yet
 * — a games_won that exceeds it is definitely a typo (either the win or the
 * shared total), so it's refused as invalid_value rather than silently
 * accepted. Applied unconditionally, even for isAdmin: true — unlike the
 * eligibility/lock gates above (which are pure workflow rules an admin can
 * always bypass), this is a data-integrity check, same class as the
 * MAX_GAMES cap itself. If no shared total has been entered yet for this
 * week+court, there's nothing to check against, so any valid games_won is
 * accepted — the shared total can be entered before or after any
 * individual player's games_won with no ordering requirement.
 */
function setGameScore({ assignmentId, gamesWon, isAdmin = false, playerId = null }) {
  const parsed = parseGamesWon(gamesWon);
  if (parsed === null) {
    throw new ScoreError('invalid_value', `Enter a whole number of games from 0 to ${MAX_GAMES}.`);
  }

  const row = db
    .prepare(
      `SELECT wa.*, w.match_date, w.locked AS week_locked, w.session_id, s.games_won_enabled AS session_games_won_enabled,
              wcg.games_played AS shared_games_played
       FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       LEFT JOIN week_court_games wcg ON wcg.week_id = wa.week_id AND wcg.court = wa.court
       WHERE wa.id = ?`
    )
    .get(assignmentId);
  if (!row) throw new ScoreError('not_found', 'That match assignment could not be found.');

  if (row.shared_games_played != null && parsed > row.shared_games_played) {
    throw new ScoreError(
      'invalid_value',
      `Games won can't be more than the ${row.shared_games_played} total games played already entered for this match.`
    );
  }

  if (!isAdmin) {
    if (playerId != null && row.player_id !== Number(playerId)) {
      throw new ScoreError('not_yours', "That match isn't on your own page.");
    }
    // Per-session opt-out (Kyle, 2026-09-10) — checked ahead of isScoreable
    // below so the error is specific ("not tracked here") rather than the
    // generic "hasn't happened yet" text. This is a backstop, not the normal
    // path: scoreRowsForPlayer()/sessionsWithScoresForPlayer() already
    // exclude a disabled session's rows from ever showing up on a player's
    // Scores page, and the group-entry route only ever resolves an enabled
    // session via resolveSession({gamesWonOnly: true}) — so this only
    // actually fires against a stale bookmark or a direct/crafted POST, not
    // normal navigation. Admins bypass this like every other gate here.
    if (!row.session_games_won_enabled) {
      throw new ScoreError('session_disabled', "Games-won tracking isn't turned on for this session.");
    }
    if (!isScoreable(row)) {
      throw new ScoreError('not_scoreable', "Scores can only be entered once a match has happened, for a week that was actually played.");
    }
    if (!canPlayerEdit(row)) {
      throw new ScoreError('locked', 'The 24-hour window to enter or fix this score has closed — ask an admin to change it.');
    }
  }

  const wasFirstEntry = row.games_won === null;
  db.prepare(
    `UPDATE week_assignments
     SET games_won = ?,
         games_won_entered_at = COALESCE(games_won_entered_at, datetime('now')),
         games_won_updated_at = datetime('now')
     WHERE id = ?`
  ).run(parsed, assignmentId);

  const updated = db.prepare('SELECT wa.*, w.match_date, w.locked AS week_locked, w.session_id FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id WHERE wa.id = ?').get(assignmentId);
  return { row: updated, wasFirstEntry };
}

/**
 * Validates and saves the shared "games played" total for one week+court
 * (see this file's top doc comment for why it's shared rather than
 * per-player). `isAdmin: true` skips the "week must be locked" gate and the
 * 24h self-service window, same unrestricted latitude as setGameScore()'s
 * own isAdmin flag. No ownership concept to check — anyone who can reach
 * either public entry point for this week+court may set or, within the
 * window, correct this value, same "no accounts, just a public page" trust
 * level as the group entry grid's per-player boxes.
 *
 * Cross-checked the same way setGameScore() checks the other direction: if
 * any player has already recorded a games_won higher than the total being
 * saved here, that's refused as invalid_value — applied unconditionally,
 * same data-integrity reasoning as setGameScore()'s own cross-check.
 *
 * `games_played_entered_at` is set only the first time (an INSERT ... ON
 * CONFLICT DO UPDATE that never touches it on the conflict path — same
 * COALESCE-once spirit as games_won_entered_at, just expressed as "don't
 * list it in the UPDATE SET clause" since this is an upsert rather than a
 * plain UPDATE); `games_played_updated_at` is stamped on every save.
 * Returns `{ weekId, court, gamesPlayed, wasFirstEntry }`.
 */
function setGamesPlayedForWeekCourt({ weekId, court, gamesPlayed, isAdmin = false }) {
  const parsed = parseGamesPlayed(gamesPlayed);
  if (parsed === null) {
    throw new ScoreError('invalid_value', `Enter a whole number of games played from 0 to ${MAX_GAMES}.`);
  }

  const week = db
    .prepare(
      `SELECT w.*, s.games_won_enabled AS session_games_won_enabled
       FROM weeks w JOIN sessions s ON s.id = w.session_id WHERE w.id = ?`
    )
    .get(weekId);
  if (!week) throw new ScoreError('not_found', 'That week could not be found.');

  // A real match actually has to exist on this court this week — guards
  // against a crafted POST naming a court nobody was ever assigned to.
  const hasCourt = db.prepare('SELECT 1 FROM week_assignments WHERE week_id = ? AND court = ? LIMIT 1').get(weekId, court);
  if (!hasCourt) throw new ScoreError('not_found', 'No match was found on that court for that week.');

  const maxAlreadyWon = db
    .prepare("SELECT MAX(games_won) as m FROM week_assignments WHERE week_id = ? AND court = ? AND games_won IS NOT NULL")
    .get(weekId, court).m;
  if (maxAlreadyWon !== null && maxAlreadyWon > parsed) {
    throw new ScoreError(
      'invalid_value',
      `Games played can't be less than the ${maxAlreadyWon} games won already entered for this match.`
    );
  }

  const gpRow = gamesPlayedRowForWeekCourt(weekId, court);

  if (!isAdmin) {
    if (!week.session_games_won_enabled) {
      throw new ScoreError('session_disabled', "Games-won tracking isn't turned on for this session.");
    }
    if (!week.locked) {
      throw new ScoreError('not_scoreable', "Games played can only be entered once a match has happened, for a week that was actually played.");
    }
    if (!canEditGamesPlayed(week.locked, gpRow)) {
      throw new ScoreError('locked', 'The 24-hour window to enter or fix games played has closed — ask an admin to change it.');
    }
  }

  const wasFirstEntry = !gpRow || gpRow.games_played === null;
  db.prepare(
    `INSERT INTO week_court_games (week_id, court, games_played, games_played_entered_at, games_played_updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(week_id, court) DO UPDATE SET
       games_played = excluded.games_played,
       games_played_updated_at = datetime('now')`
  ).run(weekId, court, parsed);

  return { weekId, court, gamesPlayed: parsed, wasFirstEntry };
}

/**
 * "Who's on top" for one session: every player (roster regular or a sub who
 * picked up a real game) with at least one scored assignment in this
 * session, ranked by total games won. Ties break by average games per
 * match scored, then by name — total alone would let someone who's only
 * scored one great match outrank a fuller season, but total (not average)
 * is still the primary sort since Kyle's ask was specifically "who's on top
 * for # of games", a season-total leaderboard, not a per-match average one.
 *
 * Deliberately not restricted to session_players roster membership (unlike
 * sessionRosterStats' `roster` bucket) — a sub who logged a score should
 * show up on the leaderboard too, same inclusive spirit as that function's
 * own `subs` bucket, just merged into one ranked list here rather than two
 * separate tables, since "who's on top" is naturally one list.
 */
function sessionLeaderboard(sessionId) {
  const rows = db
    .prepare(
      `SELECT wa.player_id, p.name, p.full_name, p.slug,
              SUM(wa.games_won) as total, COUNT(*) as matches
       FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = wa.player_id
       WHERE w.session_id = ? AND wa.games_won IS NOT NULL
       GROUP BY wa.player_id
       ORDER BY total DESC, (total * 1.0 / matches) DESC, p.name ASC`
    )
    .all(sessionId);

  return rows.map((r) => ({
    player: { id: r.player_id, name: r.name, full_name: r.full_name, slug: r.slug },
    totalGames: r.total,
    matchesScored: r.matches,
    avgPerMatch: r.matches ? r.total / r.matches : 0,
  }));
}

/**
 * Win %-based leaderboard (Kyle, 2026-09-10) — a second ranking alongside
 * sessionLeaderboard() above, meant to fix that one's known bias toward
 * attendance: someone who's played every week of the season will always
 * out-total someone who's missed half of it, even if the second player wins
 * a much higher share of the games they actually play. This ranks by
 * win % = total games won / total games played instead, so attendance no
 * longer matters except as a tiebreaker (more weeks scored, then name).
 *
 * Joins each player's own games_won against the SHARED games-played total
 * for that same week+court (week_court_games — see this file's top doc
 * comment), not a per-player value. Only counts a week toward a player's
 * percentage once both their own games_won AND that week+court's shared
 * total have been entered — a week with just games_won (nobody's gotten
 * around to entering the shared total yet) can't contribute a denominator,
 * so it's left out of this leaderboard entirely rather than guessed at.
 * That's a real gap for a still-in-progress week: a player's win % here can
 * quietly be based on fewer weeks than their total-games number on the
 * other leaderboard. games_played > 0 additionally guards the division
 * itself (a stray 0 would otherwise produce a divide-by-zero player at the
 * top of the board).
 *
 * No minimum-attendance qualification floor (Kyle, 2026-09-10: "no minimum
 * for now") — every player with at least one qualifying week appears, so a
 * single great week can currently outrank a fuller season on win % alone.
 * Add a HAVING weeks >= n clause here (and surface the threshold in the
 * view) if that turns out to matter in practice.
 */
function sessionWinPercentLeaderboard(sessionId) {
  const rows = db
    .prepare(
      `SELECT wa.player_id, p.name, p.full_name, p.slug,
              SUM(wa.games_won) as gw, SUM(wcg.games_played) as gp, COUNT(*) as weeks
       FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = wa.player_id
       JOIN week_court_games wcg ON wcg.week_id = wa.week_id AND wcg.court = wa.court
       WHERE w.session_id = ? AND wa.games_won IS NOT NULL AND wcg.games_played IS NOT NULL AND wcg.games_played > 0
       GROUP BY wa.player_id
       ORDER BY (gw * 1.0 / gp) DESC, weeks DESC, p.name ASC`
    )
    .all(sessionId);

  return rows.map((r) => ({
    player: { id: r.player_id, name: r.name, full_name: r.full_name, slug: r.slug },
    gamesWon: r.gw,
    gamesPlayed: r.gp,
    weeksScored: r.weeks,
    winPct: r.gp ? r.gw / r.gp : 0,
  }));
}

/**
 * All-time, all-sessions version of sessionLeaderboard() (Kyle, 2026-09-10:
 * "we should have a total leaderboard for all of the players entered into
 * the system... broken out into each session, but also have a total
 * players leaderboard"). Identical shape and tie-break rule, just without
 * the `WHERE w.session_id = ?` scoping — sums every scored week across
 * every session a player has ever played in, archived sessions included
 * (an all-time board that quietly dropped a player's history the moment a
 * session got archived would be a strange "all-time" board).
 */
function overallLeaderboard() {
  const rows = db
    .prepare(
      `SELECT wa.player_id, p.name, p.full_name, p.slug,
              SUM(wa.games_won) as total, COUNT(*) as matches
       FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = wa.player_id
       WHERE wa.games_won IS NOT NULL
       GROUP BY wa.player_id
       ORDER BY total DESC, (total * 1.0 / matches) DESC, p.name ASC`
    )
    .all();

  return rows.map((r) => ({
    player: { id: r.player_id, name: r.name, full_name: r.full_name, slug: r.slug },
    totalGames: r.total,
    matchesScored: r.matches,
    avgPerMatch: r.matches ? r.total / r.matches : 0,
  }));
}

/** All-time, all-sessions version of sessionWinPercentLeaderboard() — same
 * relationship to overallLeaderboard() above as the per-session win% board
 * has to the per-session total-games board. See overallLeaderboard()'s doc
 * comment for why archived sessions are included. */
function overallWinPercentLeaderboard() {
  const rows = db
    .prepare(
      `SELECT wa.player_id, p.name, p.full_name, p.slug,
              SUM(wa.games_won) as gw, SUM(wcg.games_played) as gp, COUNT(*) as weeks
       FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = wa.player_id
       JOIN week_court_games wcg ON wcg.week_id = wa.week_id AND wcg.court = wa.court
       WHERE wa.games_won IS NOT NULL AND wcg.games_played IS NOT NULL AND wcg.games_played > 0
       GROUP BY wa.player_id
       ORDER BY (gw * 1.0 / gp) DESC, weeks DESC, p.name ASC`
    )
    .all();

  return rows.map((r) => ({
    player: { id: r.player_id, name: r.name, full_name: r.full_name, slug: r.slug },
    gamesWon: r.gw,
    gamesPlayed: r.gp,
    weeksScored: r.weeks,
    winPct: r.gp ? r.gw / r.gp : 0,
  }));
}

module.exports = {
  MAX_GAMES,
  ScoreError,
  parseGamesWon,
  parseGamesPlayed,
  isScoreable,
  lockInfo,
  canPlayerEdit,
  lockInfoGamesPlayed,
  canEditGamesPlayed,
  gamesPlayedRowForWeekCourt,
  gamesPlayedRowsForWeek,
  scoreRowsForPlayer,
  sessionsWithScoresForPlayer,
  scoreEntryWeeksForSession,
  scoreRowsForWeek,
  setGameScore,
  setGamesPlayedForWeekCourt,
  sessionLeaderboard,
  sessionWinPercentLeaderboard,
  overallLeaderboard,
  overallWinPercentLeaderboard,
};
