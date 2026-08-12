'use strict';
const db = require('../db');
const { generateSeasonSchedule } = require('../scheduler/engine');

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

/** All dates in [startDate, endDate] (inclusive, ISO strings) matching dayOfWeek (0=Sun..6=Sat). */
function datesForDayOfWeek(startDate, endDate, dayOfWeek) {
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  const dates = [];
  const cur = new Date(start);
  // advance to the first matching day-of-week
  const diff = (dayOfWeek - cur.getUTCDay() + 7) % 7;
  cur.setUTCDate(cur.getUTCDate() + diff);
  while (cur <= end) {
    dates.push(toISODate(cur));
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return dates;
}

/**
 * Idempotently creates `weeks` rows for every match date in the session's
 * date range. Never touches a week row that already exists (preserves
 * locked/completed weeks and any admin edits).
 */
function ensureWeeksExist(sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('Session not found');

  const dates = datesForDayOfWeek(session.start_date, session.end_date, session.match_day_of_week);
  const existing = db.prepare('SELECT match_date FROM weeks WHERE session_id = ?').all(sessionId);
  const existingDates = new Set(existing.map((w) => w.match_date));

  const insert = db.prepare(
    'INSERT INTO weeks (session_id, week_number, match_date) VALUES (?, ?, ?)'
  );
  dates.forEach((date, idx) => {
    if (!existingDates.has(date)) {
      insert.run(sessionId, idx + 1, date);
    }
  });

  return db.prepare('SELECT * FROM weeks WHERE session_id = ? ORDER BY match_date').all(sessionId);
}

/**
 * Cross-session double-booking: DELIBERATELY NOT ENFORCED HERE. Two sessions
 * that share a match_day_of_week with overlapping date ranges can both try to
 * schedule the same player on the same calendar date — this is left as a
 * warn-only situation, surfaced via findOverlappingSessionEnrollments()
 * (enrollment-level risk) and findActualDoubleBookings() (a confirmed
 * conflict once both sessions are actually scheduled), both in
 * sessionHelper.js. Neither one changes what the scheduler does.
 *
 * This app briefly had a `session_players.priority`-driven auto-exclusion
 * here (added 2026-08-11, removed the same day): whichever of a player's two
 * colliding sessions had the lower priority number would exclude that player
 * from *every* calendar date the two sessions shared, treating it exactly
 * like a self-imposed blackout. It was reverted after a real case (Kyle,
 * 2026-08-11): reserving every shared date — not just the ones a session
 * would actually use — could leave a player with zero available dates in the
 * losing session even when the real conflict was much smaller, and when the
 * resulting deficit was too large for the auto-absorb mechanism to
 * redistribute, the *entire* losing session's scheduling run aborted and
 * wrote nothing, for every player, not just the one in question. Fixing that
 * properly would have meant either (a) only reserving as many dates as the
 * winning session's own target actually needs — which reopens the exact
 * "shouldn't depend on scheduling order/go stale on re-schedule" problem this
 * was originally built to avoid — or (b) teaching solveAssignment to treat an
 * unrecoverable target deficit as understaffed weeks rather than a hard
 * failure, a real engine change. Kyle's call: skip both and go back to
 * warn-only — the scheduler never blocks or excludes anyone on its own, and
 * an actual double-booking is caught and flagged (including to the affected
 * player directly — see ics.js/pdf.js/schedule.ejs/lookahead.ejs/me.ejs)
 * instead of prevented.
 *
 * `session_players.priority` is kept (not dropped, per this app's
 * additive-only migration philosophy) purely as advisory context: it still
 * shows up in the overlap-warning text ("priority set here") so whoever
 * resolves an actual conflict by hand has a documented steer on who should
 * probably yield — it just doesn't drive any automatic behavior anymore.
 */

/**
 * Runs (or re-runs) the scheduling engine for a session.
 *
 * Locked weeks (already played / manually locked by the admin) are always
 * left untouched. Every other week is treated as open and fully recomputed
 * from the current roster/targets/blackout dates — this is correct both for
 * the very first "Schedule these players" run (no locked weeks yet) and for
 * a structural re-schedule after a roster add/remove (locked weeks skipped,
 * remaining weeks regenerated per Full_Scope_Of_Work.md §7).
 */
function runScheduler(sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('Session not found');

  const allWeeks = ensureWeeksExist(sessionId);
  const openWeeks = allWeeks.filter((w) => !w.locked);

  const roster = db
    .prepare(
      `SELECT sp.player_id as id, sp.target_games as target, p.name as name, p.email as email
       FROM session_players sp JOIN players p ON p.id = sp.player_id
       WHERE sp.session_id = ? AND p.active = 1`
    )
    .all(sessionId);

  const blackoutRows = db
    .prepare('SELECT player_id, date FROM blackout_dates WHERE session_id = ?')
    .all(sessionId);
  const blackoutSet = new Set(blackoutRows.map((b) => `${b.player_id}|${b.date}`));

  // Cross-session priority is deliberately NOT consulted here — see the doc
  // comment above (removed 2026-08-11 after it took down a whole session's
  // scheduling run over one player's conflict). Only a player's own real
  // blackout dates affect scheduling.
  const weekDateById = new Map(openWeeks.map((w) => [w.id, w.match_date]));
  const isBlackedOut = (playerId, weekId) => {
    const key = `${playerId}|${weekDateById.get(weekId)}`;
    return blackoutSet.has(key);
  };

  const engineWeeks = openWeeks.map((w) => ({ id: w.id, date: w.match_date }));

  const result = generateSeasonSchedule({
    players: roster,
    weeks: engineWeeks,
    isBlackedOut,
    playersPerWeek: session.players_per_week,
    iterations: Math.min(8000, Math.max(2000, engineWeeks.length * roster.length * 15)),
  });

  const applyResult = db.transaction(() => {
    if (!result.feasible) {
      // Neither `player_target_unreachable`'s detail string nor
      // `combined_conflict`'s ever actually named the affected player(s) —
      // engine.js only has playerId/involvedPlayerIds to work with (it's a
      // pure, DB-free module with no access to names), so without this the
      // admin sees "Target is 14 games..." with no way to tell who from the
      // UI alone (session_detail.ejs and status.ejs just render `c.detail`
      // verbatim). This is the one place with both the raw conflicts and the
      // roster's names in scope together, so it's enriched here before
      // storing, not left to every downstream view to resolve separately.
      const nameById = new Map(roster.map((p) => [p.id, p.name]));
      const enrichedConflicts = result.conflicts.map((c) => {
        if (c.type === 'player_target_unreachable' && c.playerId != null) {
          const name = nameById.get(c.playerId) || `player #${c.playerId}`;
          return { ...c, playerName: name, detail: `${name}: ${c.detail}` };
        }
        if (c.type === 'combined_conflict' && c.involvedPlayerIds) {
          const names = c.involvedPlayerIds.map((id) => nameById.get(id) || `player #${id}`);
          return { ...c, involvedPlayerNames: names, detail: `${c.detail} Involved player(s): ${names.join(', ')}.` };
        }
        return c;
      });

      db.prepare('UPDATE sessions SET schedule_conflicts = ? WHERE id = ?').run(
        JSON.stringify(enrichedConflicts),
        sessionId
      );
      // Flag any weeks explicitly named in the conflicts
      for (const c of enrichedConflicts) {
        if (c.weekId) {
          db.prepare('UPDATE weeks SET needs_attention = 1, notes = ? WHERE id = ?').run(c.detail, c.weekId);
        }
        if (c.involvedWeekIds) {
          for (const wid of c.involvedWeekIds) {
            db.prepare('UPDATE weeks SET needs_attention = 1, notes = ? WHERE id = ?').run(c.detail, wid);
          }
        }
      }
      return { feasible: false, conflicts: enrichedConflicts };
    }

    // Clear any prior conflict flags/assignments on the open weeks we're about to (re)write
    for (const w of openWeeks) {
      db.prepare('DELETE FROM week_assignments WHERE week_id = ?').run(w.id);
      db.prepare('UPDATE weeks SET needs_attention = 0, notes = NULL, ball_duty_player_id = NULL WHERE id = ?').run(
        w.id
      );
    }
    db.prepare('UPDATE sessions SET schedule_conflicts = NULL WHERE id = ?').run(sessionId);

    const insertAssignment = db.prepare(
      'INSERT INTO week_assignments (week_id, player_id, team, court, is_sub, status) VALUES (?, ?, ?, ?, 0, ?)'
    );
    const updateBallDuty = db.prepare('UPDATE weeks SET ball_duty_player_id = ? WHERE id = ?');

    for (const wr of result.weeks) {
      for (const c of wr.courts) {
        for (const pid of c.teamA) insertAssignment.run(wr.weekId, pid, 'A', c.court, 'scheduled');
        for (const pid of c.teamB) insertAssignment.run(wr.weekId, pid, 'B', c.court, 'scheduled');
      }
      updateBallDuty.run(wr.ballDutyPlayerId, wr.weekId);
    }

    // Understaffed weeks (too few available, non-blacked-out players to fill
    // normally) were still scheduled above with whoever was available,
    // instead of blocking the whole run — this flags them on the session
    // detail page instead of letting them silently look like any other
    // normal week. Deliberately does NOT touch anyone's target_games to
    // compensate for the missed games — see engine.js's "Understaffed weeks"
    // doc comment and CLAUDE.md.
    for (const uw of result.understaffedWeeks) {
      const note =
        uw.scheduledCount === 0
          ? `No match scheduled — only ${uw.availableCount} player(s) were available (not blacked out), fewer than the 4 needed for a court.`
          : `Short-staffed — only ${uw.scheduledCount} of ${uw.neededCount} needed players were available (not blacked out) and got scheduled.`;
      db.prepare('UPDATE weeks SET needs_attention = 1, notes = ? WHERE id = ?').run(note, uw.weekId);
    }

    const newStatus = session.status === 'draft' ? 'scheduled' : session.status;
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(newStatus, sessionId);

    // Human-readable shortfall summary for the admin flash message — built
    // here (not in the route) since this is the one place with both the
    // player-shortfall numbers and the player names in scope together.
    const nameById = new Map(roster.map((p) => [p.id, p.name]));
    const shortfallSummary = result.playerShortfalls.map(
      (s) => `${nameById.get(s.playerId) || `player #${s.playerId}`} (${s.achieved} of ${s.target})`
    );

    // Same treatment for engine.js's attemptAutoAbsorb() adjustments (see its
    // doc comment): when a player's own blackout dates made their target
    // unreachable, this names exactly who got capped and who picked up the
    // slack, split into the two reasons so the flash message reads clearly
    // rather than as one undifferentiated list of target changes.
    const cappedSummary = result.targetAdjustments
      .filter((a) => a.reason === 'own_blackout_limit')
      .map((a) => `${nameById.get(a.playerId) || `player #${a.playerId}`} (${a.configuredTarget} → ${a.effectiveTarget}, own blackout dates)`);
    const absorbedSummary = result.targetAdjustments
      .filter((a) => a.reason === 'absorbed_shortfall')
      .map((a) => `${nameById.get(a.playerId) || `player #${a.playerId}`} (${a.configuredTarget} → ${a.effectiveTarget})`);

    return {
      feasible: true,
      weeksScheduled: result.weeks.length,
      understaffedWeeksCount: result.understaffedWeeks.length,
      shortfallSummary,
      targetAdjustments: result.targetAdjustments,
      cappedSummary,
      absorbedSummary,
    };
  });

  return applyResult();
}

module.exports = { ensureWeeksExist, runScheduler, datesForDayOfWeek };
