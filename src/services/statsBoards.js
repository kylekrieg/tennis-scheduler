'use strict';
const db = require('../db');
const { getTimezone } = require('./settings');
const { utcToZonedParts } = require('./tz');
const { sessionFullTitle } = require('./email');

/**
 * Three-tier stats (Kyle, 2026-09-25): SESSION board, SEASON board, MASTER
 * board. Every board is computed live from the raw scores —
 * week_assignments.games_won (per player) and week_court_games.games_played
 * (shared per court per week) — so nothing here ever stores or deletes a
 * score, and flipping a flag or moving a session between seasons simply
 * changes what gets included the next time a page loads.
 *
 * INCLUSION RULES (one place, so every board and graph agrees):
 *   session — every scored row in that session, minus players in
 *             session_stat_exclusions for that session. Ignores every
 *             other flag.
 *   season  — sessions with season_id = this season AND stats on
 *             (games_won_enabled = 1) AND count_toward_season = 1. Minus
 *             season_stat_exclusions for the season, and minus a player's
 *             scores from any SESSION they're excluded from (their other
 *             sessions in the same season still count).
 *   master  — every session with stats on, any season or none, every
 *             player (no exclusions at all), counting only weeks with
 *             match_date >= the latest non-undone master reset's date (and,
 *             for a past reset period, < the next reset's date).
 * "Stats off means off": a session with games_won_enabled = 0 feeds neither
 * the season nor the master board.
 *
 * "Win %" is games_won / games_played (the shared per-court total) exactly
 * as gameScores.js's existing leaderboards define it: a match only counts
 * toward win % once both the player's games_won and that week+court's
 * games_played are entered, and games_played must be > 0.
 */

const DEFAULT_MIN_MATCHES = 2;
const EPOCH = '0000-01-01';

// ---------------------------------------------------------------------------
// Master reset baseline + settings
// ---------------------------------------------------------------------------

/** All non-undone resets, oldest first. */
function activeResets() {
  return db
    .prepare('SELECT * FROM master_stat_resets WHERE undone_at IS NULL ORDER BY reset_date ASC, id ASC')
    .all();
}

/** The date the CURRENT master period starts (latest non-undone reset), or
 * null when the master has never been reset (counts everything). */
function masterBaseline() {
  const rows = activeResets();
  return rows.length ? rows[rows.length - 1].reset_date : null;
}

function masterSettings() {
  const row = db
    .prepare('SELECT master_stats_visible, master_min_matches_for_win_pct FROM app_settings WHERE id = 1')
    .get();
  return {
    visible: row ? !!row.master_stats_visible : true,
    minMatches: row && row.master_min_matches_for_win_pct != null ? row.master_min_matches_for_win_pct : DEFAULT_MIN_MATCHES,
  };
}

function todayLocalISO() {
  return utcToZonedParts(new Date(), getTimezone()).date;
}

// ---------------------------------------------------------------------------
// Scope -> SQL
// ---------------------------------------------------------------------------

/**
 * scope: { type: 'session', id } | { type: 'season', id } |
 *        { type: 'master', from?: 'YYYY-MM-DD'|null, to?: 'YYYY-MM-DD'|null }
 * For master, `from`/`to` default to the current period (baseline..open).
 * Returns { where, params, playerFilter } fragments for queries that alias
 * week_assignments wa / weeks w / sessions s (playerFilter only matters for
 * queries that have a player row, i.e. the leaderboard/series ones).
 */
function scopeSql(scope) {
  if (scope.type === 'session') {
    return {
      where: 'w.session_id = ?',
      params: [scope.id],
      playerFilter:
        'AND NOT EXISTS (SELECT 1 FROM session_stat_exclusions x WHERE x.session_id = w.session_id AND x.player_id = wa.player_id)',
    };
  }
  if (scope.type === 'season') {
    return {
      where: 's.season_id = ? AND s.games_won_enabled = 1 AND s.count_toward_season = 1',
      params: [scope.id],
      playerFilter:
        `AND NOT EXISTS (SELECT 1 FROM session_stat_exclusions x WHERE x.session_id = w.session_id AND x.player_id = wa.player_id)
         AND NOT EXISTS (SELECT 1 FROM season_stat_exclusions y WHERE y.season_id = s.season_id AND y.player_id = wa.player_id)`,
    };
  }
  if (scope.type === 'master') {
    const from = scope.from !== undefined ? scope.from : masterBaseline();
    const to = scope.to !== undefined ? scope.to : null;
    const params = [from || EPOCH];
    let where = 's.games_won_enabled = 1 AND w.match_date >= ?';
    if (to) {
      where += ' AND w.match_date < ?';
      params.push(to);
    }
    return { where, params, playerFilter: '' };
  }
  throw new Error(`Unknown stats scope: ${JSON.stringify(scope)}`);
}

/**
 * Every scored assignment row in scope (games_won entered), with the shared
 * games_played for its court/week attached (null if not entered yet).
 */
function fetchScoredRows(scope) {
  const sc = scopeSql(scope);
  return db
    .prepare(
      `SELECT wa.player_id, p.name, p.full_name, p.slug,
              w.session_id, w.id AS week_id, w.week_number, w.match_date, wa.court,
              wa.games_won, wcg.games_played
       FROM week_assignments wa
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       JOIN players p ON p.id = wa.player_id
       LEFT JOIN week_court_games wcg ON wcg.week_id = wa.week_id AND wcg.court = wa.court
       WHERE wa.games_won IS NOT NULL AND ${sc.where} ${sc.playerFilter}`
    )
    .all(...sc.params);
}

/** Every week (week_number + match_date) in scope, scored or not. Used so the
 * win % graph can show weeks nobody entered scores for as flat carry-forward
 * points instead of silently skipping them. */
function fetchScopeWeeks(scope) {
  const sc = scopeSql(scope);
  return db
    .prepare(
      `SELECT w.week_number, w.match_date FROM weeks w JOIN sessions s ON s.id = w.session_id WHERE ${sc.where}`
    )
    .all(...sc.params);
}

function playerObj(r) {
  return { id: r.player_id, name: r.name, full_name: r.full_name, slug: r.slug };
}

// ---------------------------------------------------------------------------
// Boards (same shapes the existing leaderboard views already render)
// ---------------------------------------------------------------------------

/** Total games won, ranked — same shape/tie-break as gameScores.sessionLeaderboard(). */
function totalsBoard(rows) {
  const by = new Map();
  for (const r of rows) {
    let e = by.get(r.player_id);
    if (!e) {
      e = { player: playerObj(r), totalGames: 0, matchesScored: 0 };
      by.set(r.player_id, e);
    }
    e.totalGames += r.games_won;
    e.matchesScored += 1;
  }
  return [...by.values()]
    .map((e) => ({ ...e, avgPerMatch: e.matchesScored ? e.totalGames / e.matchesScored : 0 }))
    .sort(
      (a, b) =>
        b.totalGames - a.totalGames ||
        b.avgPerMatch - a.avgPerMatch ||
        a.player.name.localeCompare(b.player.name)
    );
}

/** Win % board — same shape/tie-break as gameScores.overallWinPercentLeaderboard(),
 * with the `qualified` flag driven by `minMatches`. */
function winPctBoard(rows, minMatches = DEFAULT_MIN_MATCHES) {
  const by = new Map();
  for (const r of rows) {
    if (!(r.games_played > 0)) continue;
    let e = by.get(r.player_id);
    if (!e) {
      e = { player: playerObj(r), gamesWon: 0, gamesPlayed: 0, matchesScored: 0 };
      by.set(r.player_id, e);
    }
    e.gamesWon += r.games_won;
    e.gamesPlayed += r.games_played;
    e.matchesScored += 1;
  }
  return [...by.values()]
    .map((e) => ({
      ...e,
      winPct: e.gamesPlayed ? e.gamesWon / e.gamesPlayed : 0,
      qualified: e.matchesScored >= minMatches,
    }))
    .sort(
      (a, b) =>
        b.winPct - a.winPct || b.matchesScored - a.matchesScored || a.player.name.localeCompare(b.player.name)
    );
}

// ---------------------------------------------------------------------------
// Graph 1: win % over time, one line per player
// ---------------------------------------------------------------------------

/**
 * Cumulative (season-to-date) and per-week win % for every player, on a
 * shared X axis. axis 'week' (session scope): X = week number of that
 * session. axis 'date' (season/master): X = each distinct match date.
 * A player's cumulative value is null until they have a qualifying match;
 * it then carries flat through weeks they miss. `qualifiedAt` is the first
 * X index at which they reach `minMatches`, so the chart can draw the
 * "still building a sample" stretch dashed.
 */
function winPctSeries(rows, { axis, minMatches = DEFAULT_MIN_MATCHES, weeks = [] }) {
  const qual = rows.filter((r) => r.games_played > 0);
  const keyOf = (r) => (axis === 'week' ? r.week_number : r.match_date);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const scoredXs = [...new Set(qual.map(keyOf))].sort(cmp);
  // Weeks with no scores entered that fall between the first and last scored
  // week stay on the axis: everyone's cumulative line runs flat through them
  // (no new data), then keeps calculating from the next scored week.
  // Unscored weeks before the first / after the last scored week are left off.
  const xSet = new Set(scoredXs);
  if (scoredXs.length) {
    const lo = scoredXs[0];
    const hi = scoredXs[scoredXs.length - 1];
    for (const w of weeks) {
      const k = axis === 'week' ? w.week_number : w.match_date;
      if (k > lo && k < hi) xSet.add(k);
    }
  }
  const xs = [...xSet].sort(cmp);
  const xIndex = new Map(xs.map((x, i) => [x, i]));
  const labels = xs.map((x) => (axis === 'week' ? `Week ${x}` : x));

  const byPlayer = new Map();
  for (const r of qual) {
    let e = byPlayer.get(r.player_id);
    if (!e) {
      e = { player: playerObj(r), perX: new Map() };
      byPlayer.set(r.player_id, e);
    }
    const i = xIndex.get(keyOf(r));
    const cell = e.perX.get(i) || { gw: 0, gp: 0, n: 0 };
    cell.gw += r.games_won;
    cell.gp += r.games_played;
    cell.n += 1;
    e.perX.set(i, cell);
  }

  const players = [];
  for (const e of byPlayer.values()) {
    let cgw = 0;
    let cgp = 0;
    let cn = 0;
    let qualifiedAt = null;
    const cumulative = [];
    const weekly = [];
    for (let i = 0; i < xs.length; i++) {
      const cell = e.perX.get(i);
      if (cell) {
        cgw += cell.gw;
        cgp += cell.gp;
        cn += cell.n;
        weekly.push(cell.gp ? round4(cell.gw / cell.gp) : null);
      } else {
        weekly.push(null);
      }
      cumulative.push(cn > 0 && cgp > 0 ? round4(cgw / cgp) : null);
      if (qualifiedAt === null && cn >= minMatches) qualifiedAt = i;
    }
    const final = cgp ? cgw / cgp : 0;
    players.push({
      id: e.player.id,
      name: e.player.name,
      matches: cn,
      finalWinPct: round4(final),
      qualifiedAt,
      cumulative,
      weekly,
    });
  }
  players.sort((a, b) => b.finalWinPct - a.finalWinPct || b.matches - a.matches || a.name.localeCompare(b.name));
  return { axis, labels, players, minMatches };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Graph 2: average games played per match
// ---------------------------------------------------------------------------

/**
 * "Match" = one court's match in one week (one week_court_games row with a
 * games_played entered). Session scope: average per week (across that
 * week's courts) plus the session-wide average. Season/master scope: one
 * bar per session. Player exclusions don't apply — a match is a match.
 */
function avgGamesPerMatch(scope) {
  let where;
  let params;
  if (scope.type === 'session') {
    where = 'w.session_id = ?';
    params = [scope.id];
  } else if (scope.type === 'season') {
    where = 's.season_id = ? AND s.games_won_enabled = 1 AND s.count_toward_season = 1';
    params = [scope.id];
  } else {
    const sc = scopeSql(scope);
    where = sc.where;
    params = sc.params;
  }
  const rows = db
    .prepare(
      `SELECT wcg.week_id, wcg.court, wcg.games_played, w.week_number, w.match_date, w.session_id,
              s.name AS session_name, s.court_info, s.start_date
       FROM week_court_games wcg
       JOIN weeks w ON w.id = wcg.week_id
       JOIN sessions s ON s.id = w.session_id
       WHERE wcg.games_played IS NOT NULL AND wcg.games_played > 0 AND ${where}
       ORDER BY w.match_date, w.week_number, wcg.court`
    )
    .all(...params);

  const total = rows.reduce((a, r) => a + r.games_played, 0);
  const average = rows.length ? total / rows.length : null;

  if (scope.type === 'session') {
    const byWeek = new Map();
    for (const r of rows) {
      const e = byWeek.get(r.week_number) || { week: r.week_number, date: r.match_date, sum: 0, matches: 0 };
      e.sum += r.games_played;
      e.matches += 1;
      byWeek.set(r.week_number, e);
    }
    const points = [...byWeek.values()]
      .sort((a, b) => a.week - b.week)
      .map((e) => ({ label: `Week ${e.week}`, date: e.date, average: round2(e.sum / e.matches), matches: e.matches }));
    return { mode: 'weeks', points, average: average === null ? null : round2(average), matches: rows.length };
  }

  const bySession = new Map();
  for (const r of rows) {
    const e =
      bySession.get(r.session_id) ||
      {
        sessionId: r.session_id,
        label: r.court_info ? `${r.session_name} · ${r.court_info}` : r.session_name,
        date: r.start_date,
        sum: 0,
        matches: 0,
      };
    e.sum += r.games_played;
    e.matches += 1;
    bySession.set(r.session_id, e);
  }
  const points = [...bySession.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sessionId - b.sessionId))
    .map((e) => ({ label: e.label, date: e.date, average: round2(e.sum / e.matches), matches: e.matches }));
  return { mode: 'sessions', points, average: average === null ? null : round2(average), matches: rows.length };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// One call that gives the public/admin page everything for a scope
// ---------------------------------------------------------------------------

function boardsForScope(scope, minMatches) {
  const rows = fetchScoredRows(scope);
  const axis = scope.type === 'session' ? 'week' : 'date';
  return {
    totals: totalsBoard(rows),
    winPct: winPctBoard(rows, minMatches),
    winSeries: winPctSeries(rows, { axis, minMatches, weeks: fetchScopeWeeks(scope) }),
    avgGames: avgGamesPerMatch(scope),
    scoredRows: rows.length,
  };
}

// ---------------------------------------------------------------------------
// Master resets
// ---------------------------------------------------------------------------

/**
 * Freezes the current master board into master_stat_resets and starts a new
 * master period today. Never deletes or edits a score. Returns the new
 * reset row. `resetDate` defaults to today in the app's timezone.
 */
function resetMaster({ createdBy = null, resetDate = null } = {}) {
  const date = resetDate || todayLocalISO();
  const since = masterBaseline();
  const { minMatches } = masterSettings();
  const rows = fetchScoredRows({ type: 'master' });
  const snapshot = {
    since,
    minMatches,
    totals: totalsBoard(rows),
    winPct: winPctBoard(rows, minMatches),
  };
  const label = `Master board before the ${date} reset`;
  const info = db
    .prepare('INSERT INTO master_stat_resets (reset_date, label, snapshot_json, created_by) VALUES (?, ?, ?, ?)')
    .run(date, label, JSON.stringify(snapshot), createdBy);
  return db.prepare('SELECT * FROM master_stat_resets WHERE id = ?').get(Number(info.lastInsertRowid));
}

/** Rolls back the most recent non-undone reset. Returns it, or null if none. */
function undoLastReset() {
  const rows = activeResets();
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  db.prepare("UPDATE master_stat_resets SET undone_at = datetime('now') WHERE id = ?").run(last.id);
  return last;
}

/** Past master periods, newest first: [{ reset, from, to }] where the period
 * ran [from, to) — `from` is the previous reset's date (or null = the start
 * of the database) and `to` is this reset's date. */
function pastMasterPeriods() {
  const rows = activeResets();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    out.push({ reset: rows[i], from: i === 0 ? null : rows[i - 1].reset_date, to: rows[i].reset_date });
  }
  return out.reverse();
}

// ---------------------------------------------------------------------------
// Selector + scope resolution (public stats page)
// ---------------------------------------------------------------------------

/**
 * Parses a `view` query value: 'master', 'master:<resetId>', 'season:<id>',
 * 'session:<id>'. Returns { scope, label, minMatches, key } or null when the
 * value is missing/invalid OR the target isn't visible to this viewer.
 * Visibility: master/past-master need app_settings.master_stats_visible;
 * a season needs seasons.stats_visible; a session needs
 * sessions.games_won_enabled. `isAdmin` bypasses all three (admins always
 * see everything). Archived seasons/sessions stay viewable — archiving is
 * only about clutter, never about hiding stats.
 */
function resolveView(value, { isAdmin = false } = {}) {
  if (!value || typeof value !== 'string') return null;
  const [kind, rawId] = value.split(':');
  const id = Number(rawId);
  if (kind === 'master') {
    const ms = masterSettings();
    if (!ms.visible && !isAdmin) return null;
    if (!rawId) {
      const from = masterBaseline();
      return {
        key: 'master',
        kind: 'master',
        scope: { type: 'master', from, to: null },
        label: 'Master leaderboard',
        detail: from ? `since ${from}` : 'all time',
        minMatches: ms.minMatches,
      };
    }
    const period = pastMasterPeriods().find((p) => p.reset.id === id);
    if (!period) return null;
    return {
      key: `master:${id}`,
      kind: 'master',
      scope: { type: 'master', from: period.from, to: period.to },
      label: 'Master leaderboard (past period)',
      detail: `${period.from || 'the beginning'} to ${period.to}`,
      minMatches: ms.minMatches,
    };
  }
  if (kind === 'season' && Number.isInteger(id)) {
    const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(id);
    if (!season || (!season.stats_visible && !isAdmin)) return null;
    return {
      key: `season:${id}`,
      kind: 'season',
      season,
      scope: { type: 'season', id },
      label: season.name,
      detail: season.archived_at ? 'archived season' : 'season',
      minMatches: season.min_matches_for_win_pct,
    };
  }
  if (kind === 'session' && Number.isInteger(id)) {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!session || (!session.games_won_enabled && !isAdmin)) return null;
    return {
      key: `session:${id}`,
      kind: 'session',
      session,
      scope: { type: 'session', id },
      label: session.name,
      detail: session.archived_at ? 'archived session' : 'session',
      minMatches: session.min_matches_for_win_pct != null ? session.min_matches_for_win_pct : DEFAULT_MIN_MATCHES,
    };
  }
  return null;
}

/**
 * Option groups for the public selector: Master (current + past periods),
 * then each season with its sessions underneath (open seasons first, then
 * archived ones), then any sessions with no season. Only entries this
 * viewer may see.
 */
function selectorGroups({ isAdmin = false } = {}) {
  const groups = [];
  const ms = masterSettings();
  if (ms.visible || isAdmin) {
    const opts = [{ value: 'master', label: 'Master leaderboard (current)' }];
    for (const p of pastMasterPeriods()) {
      opts.push({ value: `master:${p.reset.id}`, label: `Master — ${p.from || 'start'} to ${p.to}` });
    }
    groups.push({ label: 'Master', options: opts });
  }
  const seasons = db
    .prepare('SELECT * FROM seasons ORDER BY (archived_at IS NOT NULL), created_at DESC, id DESC')
    .all();
  const sessions = db
    .prepare('SELECT * FROM sessions ORDER BY start_date DESC, id DESC')
    .all();
  for (const season of seasons) {
    const seasonVisible = season.stats_visible || isAdmin;
    const sess = sessions.filter((s) => s.season_id === season.id && (s.games_won_enabled || isAdmin));
    const opts = [];
    if (seasonVisible) opts.push({ value: `season:${season.id}`, label: `All of ${season.name}` });
    for (const s of sess) opts.push({ value: `session:${s.id}`, label: `— ${sessionFullTitle(s)}` });
    if (opts.length) {
      groups.push({ label: season.archived_at ? `${season.name} (archived)` : season.name, options: opts });
    }
  }
  const loose = sessions.filter((s) => !s.season_id && (s.games_won_enabled || isAdmin));
  if (loose.length) {
    groups.push({
      label: 'Sessions without a season',
      options: loose.map((s) => ({ value: `session:${s.id}`, label: sessionFullTitle(s) })),
    });
  }
  return groups;
}

/** A sensible default view when none is asked for: the active session's
 * board (matches how /leaderboard behaved before seasons), else the
 * newest visible season, else the master. */
function defaultView({ isAdmin = false } = {}) {
  const active = db
    .prepare(
      `SELECT id FROM sessions WHERE games_won_enabled = 1 AND archived_at IS NULL AND status IN ('scheduled','active')
       ORDER BY (status = 'active') DESC, start_date DESC, id DESC LIMIT 1`
    )
    .get();
  if (active) return `session:${active.id}`;
  const season = db
    .prepare(
      `SELECT id FROM seasons WHERE (stats_visible = 1 OR ?) ORDER BY (archived_at IS NOT NULL), created_at DESC, id DESC LIMIT 1`
    )
    .get(isAdmin ? 1 : 0);
  if (season) return `season:${season.id}`;
  return 'master';
}

// ---------------------------------------------------------------------------
// Exclusion pickers (admin)
// ---------------------------------------------------------------------------

/** Everyone who's enrolled in or has played in a session (roster + subs). */
function sessionPlayerList(sessionId) {
  return db
    .prepare(
      `SELECT p.id, p.name, p.full_name FROM players p
       WHERE p.id IN (SELECT player_id FROM session_players WHERE session_id = ?)
          OR p.id IN (SELECT wa.player_id FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id WHERE w.session_id = ?)
       ORDER BY p.name`
    )
    .all(sessionId, sessionId);
}

/** Everyone in any of a season's sessions. */
function seasonPlayerList(seasonId) {
  return db
    .prepare(
      `SELECT p.id, p.name, p.full_name FROM players p
       WHERE p.id IN (SELECT sp.player_id FROM session_players sp JOIN sessions s ON s.id = sp.session_id WHERE s.season_id = ?)
          OR p.id IN (SELECT wa.player_id FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id JOIN sessions s ON s.id = w.session_id WHERE s.season_id = ?)
       ORDER BY p.name`
    )
    .all(seasonId, seasonId);
}

module.exports = {
  DEFAULT_MIN_MATCHES,
  masterBaseline,
  masterSettings,
  activeResets,
  pastMasterPeriods,
  resetMaster,
  undoLastReset,
  fetchScoredRows,
  totalsBoard,
  winPctBoard,
  winPctSeries,
  avgGamesPerMatch,
  boardsForScope,
  resolveView,
  selectorGroups,
  defaultView,
  sessionPlayerList,
  seasonPlayerList,
  todayLocalISO,
};
