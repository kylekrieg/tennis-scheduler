'use strict';
const { createEvents } = require('ics');
const db = require('../db');
const { sessionPublicLabel } = require('./email');
const { doubleBookingMapForSession } = require('./sessionHelper');

const DEFAULT_DURATION_MINUTES = 90; // not specified in the spec; adjust here if match length differs

function buildPlayerICS(playerId, sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!session || !player) return { error: 'Session or player not found' };

  const rows = db
    .prepare(
      `SELECT w.match_date, wa.status, wa.is_sub
       FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id
       WHERE wa.player_id = ? AND w.session_id = ? AND wa.status != 'subbed_out'
       ORDER BY w.match_date`
    )
    .all(playerId, sessionId);

  const [hh, mm] = session.match_time.split(':').map(Number);
  if (![hh, mm].every(Number.isFinite)) {
    return { error: `Session has an invalid match_time (${JSON.stringify(session.match_time)}) — can't build a calendar file.` };
  }

  // Same double-booking detection used everywhere else a player sees their
  // own schedule (see sessionHelper.js's doubleBookingMapForSession) — a
  // downloaded/subscribed calendar invite is exactly the kind of "weeks in
  // advance" surface Kyle asked for, so a conflict shouldn't only show up on
  // the website.
  const dbMap = doubleBookingMapForSession(sessionId);

  const events = rows.map((r) => {
    const [y, mo, d] = r.match_date.split('-').map(Number);
    if (![y, mo, d].every(Number.isFinite)) {
      // Legacy/bad row — skip it rather than feeding NaN into the ics
      // library, which would silently produce a broken .ics file (or throw
      // deep inside a third-party dependency) instead of a clear error.
      return null;
    }
    const doubleBooked = dbMap.get(`${playerId}|${r.match_date}`);
    return {
      title: `${doubleBooked ? 'DOUBLE BOOKED — ' : ''}Tennis doubles${r.is_sub ? ' (sub)' : ''} — ${sessionPublicLabel(session)}`,
      start: [y, mo, d, hh, mm],
      duration: { minutes: DEFAULT_DURATION_MINUTES },
      description: `Doubles match for ${player.name}. Full schedule: ${(process.env.PUBLIC_SITE_URL || '')}/schedule`
        + (doubleBooked ? ` WARNING: you're also scheduled to play in ${sessionPublicLabel(doubleBooked)} on this same date — sort this out before match day.` : ''),
      status: 'CONFIRMED',
    };
  }).filter(Boolean);

  const { error, value } = createEvents(events);
  if (error) return { error: error.message || String(error) };
  return { value };
}

/**
 * Builds a *subscribable* feed (as opposed to buildPlayerICS's one-time
 * download): every scheduled/active, non-archived session this player is
 * currently enrolled in, not just one. A calendar app re-fetches this same
 * URL periodically (interval is the app's own choice — X-PUBLISHED-TTL below
 * is only a hint, and some clients, notably Google Calendar, ignore it and
 * poll on their own schedule, often much less than hourly), so unlike a
 * downloaded file it stays in sync automatically as re-scheduling happens —
 * no re-download needed after every "Schedule these players" run.
 *
 * The stable, deterministic `uid` per event is the part that makes
 * "subscribe" actually work correctly rather than just "re-download
 * repeatedly": the `ics` library defaults to a random uid per build when one
 * isn't supplied, which would make every single refresh look like a calendar
 * full of brand-new events to the subscribing app instead of updates to the
 * same ones — Apple/Google Calendar would accumulate duplicates forever
 * instead of updating in place. Built from session id + match date + player
 * id, so the same real-world match always maps to the same UID across every
 * fetch, and (RFC 5545's own recommendation) suffixed with a domain-like tag
 * for global uniqueness.
 */
function buildPlayerFeedICS(playerId) {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) return { error: 'Player not found' };

  // Mirrors sessionHelper.js's getViewableSessions() scope: archived
  // sessions are meant to go fully quiet (nothing new to show), and a draft
  // session has no schedule yet — only scoped to sessions this player is
  // actually enrolled in, via session_players.
  const sessions = db
    .prepare(
      `SELECT s.* FROM sessions s
       JOIN session_players sp ON sp.session_id = s.id
       WHERE sp.player_id = ? AND s.status IN ('scheduled', 'active') AND s.archived_at IS NULL
       ORDER BY s.start_date`
    )
    .all(playerId);

  const events = [];
  for (const session of sessions) {
    const [hh, mm] = session.match_time.split(':').map(Number);
    if (![hh, mm].every(Number.isFinite)) continue; // bad row on this one session — skip it, don't break the whole feed

    const rows = db
      .prepare(
        `SELECT w.match_date, wa.status, wa.is_sub
         FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id
         WHERE wa.player_id = ? AND w.session_id = ? AND wa.status != 'subbed_out'
         ORDER BY w.match_date`
      )
      .all(playerId, session.id);

    // Same double-booking detection as buildPlayerICS above — see that
    // function's comment. Computed once per session, not per event.
    const dbMap = doubleBookingMapForSession(session.id);

    for (const r of rows) {
      const [y, mo, d] = r.match_date.split('-').map(Number);
      if (![y, mo, d].every(Number.isFinite)) continue;
      const doubleBooked = dbMap.get(`${playerId}|${r.match_date}`);
      events.push({
        uid: `assignment-${session.id}-${r.match_date}-${playerId}@tennis-scheduler.local`,
        title: `${doubleBooked ? 'DOUBLE BOOKED — ' : ''}Tennis doubles${r.is_sub ? ' (sub)' : ''} — ${sessionPublicLabel(session)}`,
        start: [y, mo, d, hh, mm],
        duration: { minutes: DEFAULT_DURATION_MINUTES },
        // Key omitted entirely (not set to undefined) when there's no court
        // info — safer than relying on the ics library treating an explicit
        // `undefined` value the same as an absent key.
        ...(session.court_info ? { location: session.court_info } : {}),
        description: `Doubles match for ${player.name}. Full schedule: ${(process.env.PUBLIC_SITE_URL || '')}/schedule?session=${session.id}`
          + (doubleBooked ? ` WARNING: you're also scheduled to play in ${sessionPublicLabel(doubleBooked)} on this same date — sort this out before match day.` : ''),
        status: 'CONFIRMED',
      });
    }
  }

  const { error, value } = createEvents(events, { calName: `Tennis — ${player.name}` });
  if (error) return { error: error.message || String(error) };
  return { value };
}

module.exports = { buildPlayerICS, buildPlayerFeedICS };
