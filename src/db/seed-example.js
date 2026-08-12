'use strict';
// Seeds the example roster from Full_Scope_Of_Work.md §2 for local testing/demo.
// Usage: node src/db/seed-example.js
require('dotenv').config();
const db = require('./index');
const { runScheduler } = require('../services/scheduleRun');

const roster = [
  { name: 'Kyle Krieg', email: 'kyle@example.com', target: 14 },
  { name: 'John Gunther', email: 'john@example.com', target: 14 },
  { name: 'Brian Beracha', email: 'brian.b@example.com', target: 7 },
  { name: 'Shawn Anderson', email: 'shawn@example.com', target: 7 },
  { name: 'Michael Gibbons', email: 'michael@example.com', target: 7 },
  { name: 'Greg Johnson', email: 'greg@example.com', target: 7 },
  { name: 'Doug Geiger', email: 'doug@example.com', target: 4 },
  { name: 'Bart Lautenbach', email: 'bart@example.com', target: 4 },
  { name: 'Brian Potter', email: 'brian.p@example.com', target: 4 },
];

function todayPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function nextWednesday() {
  const d = new Date();
  const diff = (3 - d.getDay() + 7) % 7 || 7; // next Wednesday, not today
  d.setDate(d.getDate() + diff);
  return d;
}

const start = nextWednesday();
const end = new Date(start);
end.setDate(end.getDate() + 16 * 7); // 17 weeks total

const startDate = start.toISOString().slice(0, 10);
const endDate = end.toISOString().slice(0, 10);

const playerIds = roster.map((p) => {
  let row = db.prepare('SELECT id FROM players WHERE email = ?').get(p.email);
  if (!row) {
    const info = db.prepare('INSERT INTO players (name, email) VALUES (?, ?)').run(p.name, p.email);
    row = { id: info.lastInsertRowid };
  }
  return { id: row.id, target: p.target };
});

const sessionInfo = db
  .prepare(
    `INSERT INTO sessions (name, start_date, end_date, match_day_of_week, match_time, reminder_time, reminder_days_before, players_per_week)
     VALUES (?, ?, ?, 3, '17:30', '09:00', 2, 4)`
  )
  .run('First Half — Example', startDate, endDate);
const sessionId = sessionInfo.lastInsertRowid;

for (const p of playerIds) {
  db.prepare('INSERT INTO session_players (session_id, player_id, target_games) VALUES (?, ?, ?)').run(
    sessionId,
    p.id,
    p.target
  );
}

const result = runScheduler(sessionId);
console.log('Seeded example session id', sessionId, 'result:', result);
