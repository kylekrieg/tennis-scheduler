// Diagnostic only — read-only, changes nothing. Runs the exact same
// "who filled this slot" resolution logic the new Sub History column uses,
// directly against your database, independent of whether the app code
// itself has actually been redeployed. If this script shows the right
// names but the website still shows blank, the fix hasn't reached the Pi
// yet (re-copy admin.js + stats.ejs and pm2 restart). If this script ALSO
// shows blank, something about the live data differs from what was tested.
//
// Usage: node diag-filled-by.js --db /home/aa0z/tennis-scheduler/data/tennis.db

const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx !== -1 ? args[dbIdx + 1] : './data/tennis.db';
const MATCH_DATE = '2026-09-09';

const db = new DatabaseSync(dbPath, { readOnly: true });

const weeks = db.prepare(`SELECT id, session_id FROM weeks WHERE match_date = ?`).all(MATCH_DATE);
console.log(`Weeks with match_date = ${MATCH_DATE}:`, weeks);

for (const week of weeks) {
  console.log(`\n=== Session ${week.session_id}, week_id ${week.id} ===`);

  const rawSubHistory = db
    .prepare(
      `SELECT sr.id, sr.status, sr.created_at, sr.escalated_at, w.match_date,
              wa.id AS assignment_id, wa.week_id, wa.team, wa.court, wa.player_id AS current_player_id,
              p.id AS original_player_id, p.name, p.full_name
       FROM sub_requests sr JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = COALESCE(sr.requesting_player_id, wa.player_id)
       WHERE w.session_id = ? AND sr.status != 'resolved_double_booking' ORDER BY w.match_date DESC`
    )
    .all(week.session_id);

  console.log(`sub_requests rows found for this session: ${rawSubHistory.length}`);

  const findFiller = db.prepare(
    `SELECT player_id FROM week_assignments WHERE replaces_assignment_id = ? ORDER BY id DESC LIMIT 1`
  );
  const findPlayer = db.prepare('SELECT id, name, full_name FROM players WHERE id = ?');
  const weekAssignmentsCache = new Map();
  function getWeekAssignmentsForFillerLookup(weekId) {
    if (!weekAssignmentsCache.has(weekId)) {
      weekAssignmentsCache.set(
        weekId,
        db
          .prepare('SELECT id, player_id, team, court, is_sub, replaces_assignment_id FROM week_assignments WHERE week_id = ?')
          .all(weekId)
      );
    }
    return weekAssignmentsCache.get(weekId);
  }
  const heuristicallyClaimedFillerIds = new Set();

  for (const r of rawSubHistory) {
    let fillerId = null;
    let method = 'none';
    const linked = findFiller.get(r.assignment_id);
    if (linked) {
      fillerId = linked.player_id;
      method = 'real link (replaces_assignment_id)';
    } else if (r.current_player_id !== r.original_player_id) {
      fillerId = r.current_player_id;
      method = 'in-place reassign (current player_id differs from original)';
    } else {
      const weekRows = getWeekAssignmentsForFillerLookup(r.week_id);
      const candidates = weekRows.filter(
        (x) =>
          x.is_sub &&
          !x.replaces_assignment_id &&
          x.team === r.team &&
          x.court === r.court &&
          !heuristicallyClaimedFillerIds.has(x.id)
      );
      method = `heuristic fallback (${candidates.length} candidate(s) found)`;
      if (candidates.length === 1) {
        fillerId = candidates[0].player_id;
        heuristicallyClaimedFillerIds.add(candidates[0].id);
      }
    }
    const fillerPlayer = fillerId != null ? findPlayer.get(fillerId) : null;
    console.log({
      sub_request_id: r.id,
      status: r.status,
      original_assignment_id: r.assignment_id,
      original_player: r.full_name || r.name,
      current_player_id_on_that_row: r.current_player_id,
      resolved_filled_by: fillerPlayer ? fillerPlayer.full_name || fillerPlayer.name : null,
      method,
    });
  }
}

db.close();
