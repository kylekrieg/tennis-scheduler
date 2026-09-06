'use strict';
const db = require('../db');
const { zonedTimeToUtc, addDays } = require('./tz');
const { getTimezone } = require('./settings');
const { logSystemActivity } = require('./activityLog');

/**
 * Per-session weather forecast (Kyle, 2026-09-05): "for a session, we need
 * to have some type of weather forecast or widget on the week... turned on
 * for the session the weather forecast should be included in the email
 * confirmation email or the 'who's in' email for ad-hoc sessions... should
 * update hourly between the first email for that week goes out to 1 hour
 * after the playing time." Uses OpenWeatherMap's free "5 day / 3 hour
 * forecast" endpoint (data/2.5/forecast) rather than the newer One Call 3.0
 * API — the free tier here needs no billing setup, and every window this app
 * ever fetches inside (reminder ~2 days out, ad-hoc invite ~56h out) is well
 * within that endpoint's 5-day horizon.
 *
 * This module never gets called directly from a request — it's a cache
 * refreshed on a schedule by cron.js's tick loop (refreshDueWeeks) and read
 * from everywhere else (getCachedWeather). Widgets and emails never call the
 * OpenWeatherMap API themselves; they just render whatever's in week_weather
 * at that moment, which may be null if the window hasn't opened yet or the
 * API hasn't been reached for some reason — every caller treats a missing
 * row as "say nothing" rather than an error, same graceful-degradation
 * philosophy as every other optional feature in this app (e.g. a session
 * with no club_name just omits that part of the email).
 */

// Re-fetch at most once an hour per week, matching Kyle's "update hourly"
// ask — checked as "has it been long enough since the last fetch," not a
// wall-clock alignment, so it stays correct regardless of which minute
// within the hour cron's own 60s tick happens to land on. Slightly under a
// full hour (55 vs 60 min) so a tick that's a few minutes early one cycle
// doesn't push the *next* refresh a full hour later than intended.
const STALE_MS = 55 * 60 * 1000;

function apiKey() {
  return process.env.OPENWEATHER_API_KEY || '';
}

/** Small OpenWeatherMap icon (e.g. "10d" -> a rain-cloud PNG), used by both
 * the site widget and the email block. Returns null if there's no icon code
 * to build a URL from (a week with no cached forecast yet). */
function weatherIconUrl(icon) {
  if (!icon) return null;
  return `https://openweathermap.org/img/wn/${icon}@2x.png`;
}

/** Whatever's currently cached for this week, or null if nothing's been
 * fetched yet (window hasn't opened, session doesn't have weather enabled,
 * or the API hasn't successfully returned anything). Every display surface
 * (widgets, emails) calls this — never fetchForecastForWeek directly. */
function getCachedWeather(weekId) {
  return db.prepare('SELECT * FROM week_weather WHERE week_id = ?').get(weekId) || null;
}

/** SQLite's `datetime('now')`-style strings (and this module's own
 * fetched_at, written the same way) have no timezone marker, but are always
 * UTC — same "explicit UTC parse" pattern already established for
 * email_log.sent_at (see "Email log has a real status" in CLAUDE.md). */
function parseUtc(sqliteDatetime) {
  return new Date(sqliteDatetime.replace(' ', 'T') + 'Z');
}

function isStale(row) {
  if (!row) return true;
  return Date.now() - parseUtc(row.fetched_at).getTime() > STALE_MS;
}

// A session that's persistently broken (bad API key, coordinates OWM
// rejects, etc.) would otherwise fail every single cron tick it's within
// its display window — since a failed fetch never writes a week_weather
// row, isStale(null) is always true, so nothing here naturally backs off
// the retry. Retrying every 60s is fine (OpenWeatherMap's free tier has
// plenty of headroom for one session), but logging every one of those
// retries to admin_activity_log would flood the page Kyle actually looks
// at. Throttle *logging* only (not the retry itself) to once per session
// per this window, by checking the most recent 'weather.refresh_failed'
// row for that session before writing a new one — same "check the log
// itself for a recent row" dedup shape used nowhere else in this app, but
// simple enough not to need a new table just for this.
const ERROR_LOG_THROTTLE_MS = 60 * 60 * 1000;

function recentlyLoggedError(sessionId) {
  const row = db
    .prepare(
      `SELECT created_at FROM admin_activity_log WHERE session_id = ? AND action = 'weather.refresh_failed' ORDER BY created_at DESC LIMIT 1`
    )
    .get(sessionId);
  if (!row) return false;
  return Date.now() - parseUtc(row.created_at).getTime() < ERROR_LOG_THROTTLE_MS;
}

/** Always console.error's (so a live server's logs still show every single
 * attempt, for anyone actually tailing them), but only writes to the admin
 * activity log — the thing Kyle can actually see in the app — once per hour
 * per session, so a stuck session doesn't bury everything else on that
 * page. Uses logSystemActivity() rather than logActivity() because this
 * runs from cron.js's tick loop, which has no req/req.session to attribute
 * the action to (see activityLog.js's own doc comment on this exact split). */
function logRefreshFailure(session, message) {
  console.error(`[weather] refreshDueWeeks failed for session ${session.id} (${session.name}):`, message);
  if (recentlyLoggedError(session.id)) return;
  try {
    logSystemActivity({
      action: 'weather.refresh_failed',
      description: `Weather forecast refresh failed for "${session.name}": ${message}`,
      sessionId: session.id,
    });
  } catch (logErr) {
    // Logging the failure should never itself be able to take down the
    // refresh loop for other sessions — console.error and move on.
    console.error('[weather] failed to write activity log entry:', logErr.message);
  }
}

function nowAsSqliteUtc() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** Picks the forecast list entry whose timestamp is closest to targetMs —
 * OpenWeatherMap's free forecast endpoint returns fixed 3-hour slots, not an
 * arbitrary time, so this is how "the forecast for kickoff" is derived from
 * "the forecast for 6pm" vs "the forecast for 9pm" etc. */
function pickClosestEntry(list, targetMs) {
  let best = null;
  let bestDiff = Infinity;
  for (const entry of list || []) {
    const diff = Math.abs(entry.dt * 1000 - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = entry;
    }
  }
  return best;
}

function upsertWeekWeather(row) {
  db.prepare(
    `INSERT INTO week_weather (week_id, fetched_at, forecast_time, temp_f, feels_like_f, condition, icon, precip_chance, wind_mph, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(week_id) DO UPDATE SET
       fetched_at = excluded.fetched_at, forecast_time = excluded.forecast_time, temp_f = excluded.temp_f,
       feels_like_f = excluded.feels_like_f, condition = excluded.condition, icon = excluded.icon,
       precip_chance = excluded.precip_chance, wind_mph = excluded.wind_mph, raw_json = excluded.raw_json`
  ).run(
    row.week_id,
    row.fetched_at,
    row.forecast_time,
    row.temp_f,
    row.feels_like_f,
    row.condition,
    row.icon,
    row.precip_chance,
    row.wind_mph,
    row.raw_json
  );
}

/**
 * Fetches the current forecast for one week and upserts it into
 * week_weather. Returns the cached row shape on success, or null if weather
 * isn't actually configured (no API key, or the session has no lat/lon set
 * yet) — that's a normal, silent "not ready" state, not an error. A real API
 * failure (bad key, network issue, OWM outage) throws, same as any other
 * external call in this app — refreshDueWeeks below is the one place that
 * catches it, per-session, so one bad session/key doesn't stop every other
 * session's forecast from refreshing.
 */
async function fetchForecastForWeek(week, session) {
  const key = apiKey();
  if (!key || session.weather_lat == null || session.weather_lon == null) return null;

  const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${session.weather_lat}&lon=${session.weather_lon}&appid=${key}&units=imperial`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OpenWeatherMap request failed (${res.status})`);
  }
  const data = await res.json();

  const tz = getTimezone();
  const matchAt = zonedTimeToUtc(week.match_date, session.match_time, tz);
  const entry = pickClosestEntry(data.list, matchAt.getTime());
  if (!entry) return null;

  const weatherInfo = (entry.weather && entry.weather[0]) || {};
  const row = {
    week_id: week.id,
    fetched_at: nowAsSqliteUtc(),
    forecast_time: new Date(entry.dt * 1000).toISOString().slice(0, 19).replace('T', ' '),
    temp_f: entry.main ? entry.main.temp : null,
    feels_like_f: entry.main ? entry.main.feels_like : null,
    condition: weatherInfo.description || null,
    icon: weatherInfo.icon || null,
    precip_chance: entry.pop != null ? entry.pop : null,
    wind_mph: entry.wind ? entry.wind.speed : null,
    raw_json: JSON.stringify(entry),
  };
  upsertWeekWeather(row);
  return row;
}

/** When this week's forecast should start being fetched — mirrors
 * cron.js's own threshold math exactly (rather than reusing it directly,
 * since neither processReminders nor processAdhocInvites expose their
 * per-week threshold as a standalone value): the reminder threshold for a
 * regular session, the invite threshold for ad-hoc. This is deliberately
 * "the first email for the week," not "5 days before match" or some other
 * fixed horizon — Kyle's own framing ("between the first email... and 1
 * hour after the playing time") ties the display window to the same
 * moment a player first hears about the match, not an arbitrary lead time. */
function windowStart(session, week, tz) {
  if (session.session_type === 'adhoc') {
    const matchAt = zonedTimeToUtc(week.match_date, session.match_time, tz);
    return new Date(matchAt.getTime() - session.adhoc_invite_lead_hours * 60 * 60 * 1000);
  }
  const reminderDate = addDays(week.match_date, -session.reminder_days_before);
  return zonedTimeToUtc(reminderDate, session.reminder_time, tz);
}

/**
 * Cron entry point (called from cron.js's tick loop, alongside every other
 * per-tick pass) — refreshes any week whose display window is currently
 * open (see windowStart above) and whose cached forecast is missing or more
 * than an hour old. Scoped to weather_enabled sessions with both
 * coordinates set; a session that's enabled the checkbox but hasn't entered
 * lat/lon yet is silently skipped rather than erroring, same as a session
 * with reminders_enabled off just not firing reminders.
 */
async function refreshDueWeeks() {
  const tz = getTimezone();
  const now = new Date();
  const sessions = db
    .prepare(
      `SELECT * FROM sessions
       WHERE archived_at IS NULL AND status IN ('scheduled', 'active')
         AND weather_enabled = 1 AND weather_lat IS NOT NULL AND weather_lon IS NOT NULL`
    )
    .all();

  for (const session of sessions) {
    try {
      const weeks = db.prepare(`SELECT * FROM weeks WHERE session_id = ? AND locked = 0 ORDER BY match_date`).all(session.id);
      for (const week of weeks) {
        let matchAt;
        let start;
        try {
          matchAt = zonedTimeToUtc(week.match_date, session.match_time, tz);
          start = windowStart(session, week, tz);
        } catch (e) {
          continue; // malformed time/date on a legacy row — skip this week, not the whole session
        }
        const end = new Date(matchAt.getTime() + 60 * 60 * 1000); // "1 hour after the playing time"
        if (now < start || now > end) continue;

        if (!isStale(getCachedWeather(week.id))) continue;
        await fetchForecastForWeek(week, session);
      }
    } catch (err) {
      logRefreshFailure(session, err.message);
    }
  }
}

/** "72°F, light rain (20% chance of rain)" — the same plain-text summary
 * used by both the site widget (schedule/lookahead/session detail pages, via
 * app.locals — see app.js) and could be reused anywhere else a one-line
 * forecast is wanted. Returns '' for a null/empty row so a view can safely
 * do `<%= weatherSummaryText(r.weather) %>` without an extra null check. */
function weatherSummaryText(row) {
  if (!row) return '';
  const parts = [];
  if (row.temp_f != null) parts.push(`${Math.round(row.temp_f)}°F`);
  if (row.condition) parts.push(row.condition);
  if (!parts.length) return '';
  const precip = row.precip_chance != null ? ` (${Math.round(row.precip_chance * 100)}% chance of rain)` : '';
  return `${parts.join(', ')}${precip}`;
}

module.exports = {
  getCachedWeather,
  fetchForecastForWeek,
  refreshDueWeeks,
  weatherIconUrl,
  weatherSummaryText,
};
