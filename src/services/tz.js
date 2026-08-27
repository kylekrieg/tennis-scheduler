'use strict';

// Converts a wall-clock date/time in a named IANA timezone to a UTC Date,
// using only the built-in Intl API (no external tz-database dependency).

function offsetMs(utcDate, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(utcDate).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUTC - utcDate.getTime();
}

/**
 * dateStr: 'YYYY-MM-DD', timeStr: 'HH:MM', both wall-clock in `timeZone`.
 * Throws on anything that doesn't parse to real numbers, rather than
 * quietly producing an Invalid Date — every caller in cron.js compares the
 * result with `<`/`>=` against `now`, and both of those comparisons are
 * `false` against an Invalid Date. Depending which caller, that silently
 * flips a "should this have happened yet?" check to the *wrong* answer
 * (permanently overdue in one place, immediately due in another) instead of
 * erroring loudly — this was a real bug (see admin.js's invalidTimeFields,
 * the form-level guard that should catch bad input before it ever gets
 * here).
 */
function zonedTimeToUtc(dateStr, timeStr, timeZone) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  if (![y, mo, d, h, mi].every(Number.isFinite)) {
    throw new Error(`zonedTimeToUtc: invalid dateStr/timeStr — got dateStr=${JSON.stringify(dateStr)} timeStr=${JSON.stringify(timeStr)}`);
  }
  let utcGuess = Date.UTC(y, mo - 1, d, h, mi);
  let offset = offsetMs(new Date(utcGuess), timeZone);
  let utc = utcGuess - offset;
  // second pass to settle DST-boundary edge cases
  offset = offsetMs(new Date(utc), timeZone);
  utc = utcGuess - offset;
  return new Date(utc);
}

/**
 * The reverse of zonedTimeToUtc: given a real UTC instant, returns the
 * wall-clock date/time it corresponds to in `timeZone`, as the same
 * 'YYYY-MM-DD'/'HH:MM' string shapes used everywhere else in this app (so a
 * caller can hand the result straight to fmtDate/fmtTime). Needed for any
 * lead-hours-style threshold (an arbitrary number of hours before match
 * time, not a clean day boundary — see cron.js's processFollowUps/
 * processAdminReports) where the resulting instant's local date can differ
 * from the match's own date, unlike a whole-day offset like escalation's
 * "24h before" (addDays + same time-of-day).
 */
function utcToZonedParts(utcDate, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = dtf.formatToParts(utcDate).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function addDays(dateStr, days) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  if (![y, mo, d].every(Number.isFinite)) {
    throw new Error(`addDays: invalid dateStr — got ${JSON.stringify(dateStr)}`);
  }
  const date = new Date(Date.UTC(y, mo - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

module.exports = { zonedTimeToUtc, addDays, utcToZonedParts };
