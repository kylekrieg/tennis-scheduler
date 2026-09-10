// Diagnostic only — read-only, changes nothing. Dumps every week_assignments
// row for the week we're investigating so we can see what's actually there.
//
// Usage: node diag-week-assignments.js --db /home/aa0z/tennis-scheduler/data/tennis.db

const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx !== -1 ? args[dbIdx + 1] : './data/tennis.db';
const MATCH_DATE = '2026-09-09';

const db = new DatabaseSync(dbPath, { readOnly: true });

const weeks = db.prepare(`SELECT * FROM weeks WHERE match_date = ?`).all(MATCH_DATE);
console.log(`Weeks with match_date = ${MATCH_DATE}:`);
console.log(weeks);

for (const week of weeks) {
  console.log(`\n--- week_assignments for week_id=${week.id} (session_id=${week.session_id}) ---`);
  const rows = db.prepare(
    `SELECT wa.*, p.name, p.full_name
     FROM week_assignments wa
     LEFT JOIN players p ON p.id = wa.player_id
     WHERE wa.week_id = ?
     ORDER BY wa.team, wa.court, wa.id`
  ).all(week.id);
  console.log(rows);
}

db.close();
