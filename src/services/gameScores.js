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
 * any or all of the boxes. */
function scoreRowsForWeek(weekId) {
  return db
    .prepare(
      `SELECT wa.*, w.match_date, w.locked AS week_locked, w.session_id, p.name, p.slug
       FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = wa.player_id
       WHERE wa.week_id = ? AND wa.status IN ('scheduled', 'confirmed')
       ORDER BY p.name`
    )
    .all(weekId);
}

/** Result codes setGameScore() can throw as `err.code`, for the routes to
 * turn into a plain-language message rather than a raw 500. */
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
 */
function setGameScore({ assignmentId, gamesWon, isAdmin = false, playerId = null }) {
  const parsed = parseGamesWon(gamesWon);
  if (parsed === null) {
    throw new ScoreError('invalid_value', `Enter a whole number of games from 0 to ${MAX_GAMES}.`);
  }

  const row = db
    .prepare(
      `SELECT wa.*, w.match_date, w.locked AS week_locked, w.session_id, s.games_won_enabled AS session_games_won_enabled
       FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       WHERE wa.id = ?`
    )
    .get(assignmentId);
  if (!row) throw new ScoreError('not_found', 'That match assignment could not be found.');

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

module.exports = {
  MAX_GAMES,
  ScoreError,
  parseGamesWon,
  isScoreable,
  lockInfo,
  canPlayerEdit,
  scoreRowsForPlayer,
  sessionsWithScoresForPlayer,
  scoreEntryWeeksForSession,
  scoreRowsForWeek,
  setGameScore,
  sessionLeaderboard,
};
