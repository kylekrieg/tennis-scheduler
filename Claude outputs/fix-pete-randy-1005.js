// One-off fix (Kyle, 2026-09-30): Pete D requested a sub for 10/5, Randy J
// said yes on the group email, and the admin put Randy in with a plain
// Reassign. That overwrote Pete's slot in place, so Pete vanished from 10/5
// and Randy looks like a regular scheduled player instead of Pete's sub.
//
// This puts it back the way the new "as sub" Reassign checkbox records it:
//   - Pete's original slot row goes back to Pete, status 'subbed_out'
//   - a new row for Randy is added under it (is_sub=1, 'scheduled',
//     manually_placed=1, replaces_assignment_id -> Pete's row)
//   - any live links on the old row are removed (they'd now point at Pete's
//     subbed-out row); Randy gets a fresh link from the normal reminder
//   - the existing sub request (already 'resolved_manually') is left alone;
//     Sub History will now show Randy as "filled by" via the new link
//
// Looks everything up by name/date, no hardcoded IDs. Safe to re-run: if
// Randy's sub row already exists it does nothing.
//
// Usage (on the Pi):
//   node fix-pete-randy-1005.js --db /home/aa0z/tennis-scheduler/data/tennis.db
//        -> dry run, shows what it found and what it would change
//   node fix-pete-randy-1005.js --db /home/aa0z/tennis-scheduler/data/tennis.db --apply
//        -> actually makes the change

const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx !== -1 ? args[dbIdx + 1] : './data/tennis.db';

const ORIGINAL_PLAYER_NAME = 'Peter DiGasbarro'; // who asked for the sub
const SUB_PLAYER_NAME = 'Randy Jacobsmeyer';     // who's subbing
const MATCH_DATE = '2026-10-05';

const db = new DatabaseSync(dbPath, { readOnly: !apply });

function fail(msg) {
  console.error(msg);
  db.close();
  process.exit(1);
}

function findPlayer(name) {
  const rows = db
    .prepare(`SELECT id, name, full_name FROM players WHERE full_name = ? OR name = ?`)
    .all(name, name);
  if (rows.length !== 1) fail(`Expected exactly one player named "${name}", found ${rows.length}.`);
  return rows[0];
}

const original = findPlayer(ORIGINAL_PLAYER_NAME);
const sub = findPlayer(SUB_PLAYER_NAME);
console.log('Original player:', original);
console.log('Sub player:', sub);

// The overwritten slot: a row now held by Randy whose sub request was opened
// by Pete. Checked across every week on that date (more than one session can
// play the same day).
const slots = db
  .prepare(
    `SELECT wa.*, w.session_id, w.locked, sr.id AS sub_request_id, sr.status AS sub_request_status
     FROM week_assignments wa
     JOIN weeks w ON w.id = wa.week_id
     JOIN sub_requests sr ON sr.week_assignment_id = wa.id
     WHERE w.match_date = ? AND sr.requesting_player_id = ?`
  )
  .all(MATCH_DATE, original.id);
console.log(`Slots on ${MATCH_DATE} with a sub request from ${ORIGINAL_PLAYER_NAME}:`, slots);
if (slots.length !== 1) fail(`Expected exactly one such slot, found ${slots.length}. Nothing changed.`);
const slot = slots[0];

const existingSubRow = db
  .prepare(`SELECT id, player_id, is_sub, status FROM week_assignments WHERE replaces_assignment_id = ?`)
  .get(slot.id);
if (existingSubRow) {
  console.log('Already fixed — a sub row already points at this slot:', existingSubRow);
  db.close();
  process.exit(0);
}

if (slot.locked) fail('That week is already locked (played). Use "Wrong person listed?" in the admin instead. Nothing changed.');
if (slot.player_id !== sub.id) {
  fail(`That slot is held by player #${slot.player_id}, not ${SUB_PLAYER_NAME} (#${sub.id}). Nothing changed.`);
}

console.log('\nPlanned changes:');
console.log(`  week_assignments #${slot.id}: player ${sub.id} -> ${original.id}, status '${slot.status}' -> 'subbed_out', manually_placed -> 0`);
console.log(`  new week_assignments row: player ${sub.id}, week ${slot.week_id}, court ${slot.court}, team ${slot.team}, is_sub=1, status '${slot.status === 'confirmed' ? 'confirmed' : 'scheduled'}', manually_placed=1, replaces #${slot.id}`);
console.log(`  delete any live links (week_assignment_tokens) on #${slot.id}`);

if (!apply) {
  console.log('\nDry run only. Re-run with --apply to make these changes.');
  db.close();
  process.exit(0);
}

db.exec('BEGIN');
try {
  db.prepare(`UPDATE week_assignments SET player_id = ?, status = 'subbed_out', manually_placed = 0 WHERE id = ?`).run(
    original.id,
    slot.id
  );
  db.prepare('DELETE FROM week_assignment_tokens WHERE week_assignment_id = ?').run(slot.id);
  const newStatus = slot.status === 'confirmed' ? 'confirmed' : 'scheduled';
  const info = db
    .prepare(
      `INSERT INTO week_assignments (week_id, player_id, team, court, is_sub, status, confirmed_at, manually_placed, replaces_assignment_id)
       VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?)`
    )
    .run(slot.week_id, sub.id, slot.team, slot.court, newStatus, newStatus === 'confirmed' ? slot.confirmed_at : null, slot.id);
  db.exec('COMMIT');
  console.log(`\nDone. New sub row #${info.lastInsertRowid}.`);
} catch (err) {
  db.exec('ROLLBACK');
  fail(`Failed, rolled back — nothing changed: ${err.message}`);
}
db.close();
