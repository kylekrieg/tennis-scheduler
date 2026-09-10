// One-off fix: backfill a missing sub_requests row for a substitution that
// happened via the admin Reassign "Sub list" dropdown before that path logged
// to Sub History. Looks everything up by name/date instead of hardcoded IDs,
// and checks every week sharing that match_date (since more than one session
// can play on the same date) rather than assuming there's only one.
// Safe to re-run — it always checks for an existing row first and does
// nothing if one's already there.
//
// Usage (run from anywhere, pointing at your real database):
//   node fix-sub-history.js --db /home/aa0z/tennis-scheduler/data/tennis.db
//        -> dry run, shows what it found
//   node fix-sub-history.js --db /home/aa0z/tennis-scheduler/data/tennis.db --apply
//        -> actually inserts the row

const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx !== -1 ? args[dbIdx + 1] : './data/tennis.db';

// Edit these three lines if you're reusing this script for a different
// missing substitution later.
const ORIGINAL_PLAYER_NAME = 'Jon Deuchler'; // who the slot originally belonged to
const SUB_PLAYER_NAME = 'Ed Bourneuf';       // who actually played instead
const MATCH_DATE = '2026-09-09';             // the week's match_date, YYYY-MM-DD

const db = new DatabaseSync(dbPath, { readOnly: !apply });

function findPlayerId(name) {
  const row = db.prepare(
    `SELECT id, name, full_name FROM players
     WHERE name = ? OR full_name = ? OR name LIKE ? OR full_name LIKE ?`
  ).get(name, name, `%${name}%`, `%${name}%`);
  return row || null;
}

const original = findPlayerId(ORIGINAL_PLAYER_NAME);
const sub = findPlayerId(SUB_PLAYER_NAME);

console.log('Original player lookup:', original);
console.log('Sub player lookup:', sub);

if (!original || !sub) {
  console.error('Could not find one or both players by name. Check spelling above, or edit the names at the top of this script to match exactly what\'s in your Players list.');
  db.close();
  process.exit(1);
}

// There can be more than one session playing on the same date, so check
// every week with this match_date rather than assuming there's just one.
const weeks = db.prepare(`SELECT id, session_id, match_date FROM weeks WHERE match_date = ?`).all(MATCH_DATE);
console.log(`Weeks with match_date = ${MATCH_DATE}:`, weeks);

if (weeks.length === 0) {
  console.error(`No week found with match_date = ${MATCH_DATE}`);
  db.close();
  process.exit(1);
}

let week = null;
let originalAssignment = null;
let subAssignment = null;

for (const w of weeks) {
  const orig = db.prepare(
    `SELECT * FROM week_assignments WHERE week_id = ? AND player_id = ? AND status = 'subbed_out'`
  ).get(w.id, original.id);
  const subA = db.prepare(
    `SELECT * FROM week_assignments WHERE week_id = ? AND player_id = ? AND is_sub = 1`
  ).get(w.id, sub.id);
  if (orig && subA) {
    week = w;
    originalAssignment = orig;
    subAssignment = subA;
    break;
  }
}

console.log('Matching week:', week);
console.log('Original (subbed_out) assignment:', originalAssignment);
console.log('Sub (is_sub=1) assignment:', subAssignment);

if (!originalAssignment || !subAssignment) {
  console.error('Could not find a matching subbed_out/is_sub=1 pair on any week with that match_date. Nothing to fix, or the names/date above need adjusting.');
  db.close();
  process.exit(1);
}

const existing = db.prepare(
  `SELECT * FROM sub_requests WHERE week_assignment_id = ?`
).get(originalAssignment.id);

if (existing) {
  console.log('A sub_requests row already exists for this assignment — nothing to do:', existing);
  db.close();
  process.exit(0);
}

// Try to find the real timestamp from the activity log, so the backfilled
// row shows the actual date this happened rather than "now".
const activityRow = db.prepare(
  `SELECT created_at, description FROM admin_activity_log
   WHERE action IN ('week.reassign_from_sub_list', 'week.reassign')
     AND description LIKE ? AND description LIKE ?
   ORDER BY created_at DESC LIMIT 1`
).get(`%${SUB_PLAYER_NAME}%`, `%${ORIGINAL_PLAYER_NAME}%`);

const timestamp = activityRow ? activityRow.created_at : new Date().toISOString().replace('T', ' ').slice(0, 19);
console.log('Timestamp to use (from activity log if found):', timestamp, activityRow ? '' : '(activity log entry not found — using current time instead)');

console.log('\nWould insert into sub_requests:');
console.log({
  week_assignment_id: originalAssignment.id,
  status: 'resolved_manually',
  created_at: timestamp,
  initiated_by: 'admin',
  requesting_player_id: original.id,
});

if (!apply) {
  console.log('\nDry run only — nothing was written. Re-run with --apply to actually insert this row.');
  db.close();
  process.exit(0);
}

db.prepare(
  `INSERT INTO sub_requests (week_assignment_id, status, created_at, initiated_by, requesting_player_id)
   VALUES (?, 'resolved_manually', ?, 'admin', ?)`
).run(originalAssignment.id, timestamp, original.id);

const check = db.prepare('PRAGMA integrity_check').get();
console.log('\nInsert done. Integrity check:', check);

const inserted = db.prepare(`SELECT * FROM sub_requests WHERE week_assignment_id = ?`).get(originalAssignment.id);
console.log('Row now on file:', inserted);

db.close();
