'use strict';
const assert = require('assert');
const { generateSeasonSchedule, attemptAutoAbsorb } = require('./engine');

function makeWeeks(n) {
  const weeks = [];
  const start = new Date('2026-01-07'); // a Wednesday
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i * 7);
    weeks.push({ id: i + 1, date: d.toISOString().slice(0, 10) });
  }
  return weeks;
}

// --- Test 1: example roster from Full_Scope_Of_Work.md, no blackout dates ---
console.log('Test 1: example roster (9 players, 17 weeks, no blackouts)');
{
  const players = [
    { id: 1, name: 'Kyle Krieg', target: 14 },
    { id: 2, name: 'John Gunther', target: 14 },
    { id: 3, name: 'Brian Beracha', target: 7 },
    { id: 4, name: 'Shawn Anderson', target: 7 },
    { id: 5, name: 'Michael Gibbons', target: 7 },
    { id: 6, name: 'Greg Johnson', target: 7 },
    { id: 7, name: 'Doug Geiger', target: 4 },
    { id: 8, name: 'Bart Lautenbach', target: 4 },
    { id: 9, name: 'Brian Potter', target: 4 },
  ];
  const weeks = makeWeeks(17);
  const isBlackedOut = () => false;

  const result = generateSeasonSchedule({ players, weeks, isBlackedOut, playersPerWeek: 4, iterations: 6000 });
  assert.strictEqual(result.feasible, true, 'should be feasible');

  // Each week has exactly 4 distinct players, on exactly 1 court
  for (const w of result.weeks) {
    assert.strictEqual(w.players.length, 4, `week ${w.weekId} should have 4 players`);
    assert.strictEqual(new Set(w.players).size, 4, `week ${w.weekId} players should be distinct`);
    assert.strictEqual(w.courts.length, 1, 'single-court session should produce exactly 1 court per week');
    assert.strictEqual(w.courts[0].teamA.length, 2);
    assert.strictEqual(w.courts[0].teamB.length, 2);
    const teamPlayers = new Set([...w.courts[0].teamA, ...w.courts[0].teamB]);
    assert.strictEqual(teamPlayers.size, 4, 'teams should cover all 4 players with no overlap');
    assert.ok(w.ballDutyPlayerId, 'ball duty should be assigned');
    assert.ok(w.players.includes(w.ballDutyPlayerId), 'ball duty player must be one of the 4 scheduled');
  }

  // Each player hits their target exactly
  const gamesPlayed = new Map(players.map((p) => [p.id, 0]));
  for (const w of result.weeks) {
    for (const pid of w.players) gamesPlayed.set(pid, gamesPlayed.get(pid) + 1);
  }
  for (const p of players) {
    assert.strictEqual(gamesPlayed.get(p.id), p.target, `player ${p.name} should hit target ${p.target}`);
  }

  // Ball duty distribution roughly proportional to target share
  const ballDutyCount = new Map(players.map((p) => [p.id, 0]));
  for (const w of result.weeks) {
    ballDutyCount.set(w.ballDutyPlayerId, ballDutyCount.get(w.ballDutyPlayerId) + 1);
  }
  console.log('  Ball duty counts:', Object.fromEntries(
    players.map((p) => [p.name, `${ballDutyCount.get(p.id)} (target share ${(p.target / 68 * 17).toFixed(1)})`])
  ));

  // Partner spread stats
  const counts = Object.values(result.partnerCounts);
  console.log('  Partner-pairing counts (min/max/avg):',
    Math.min(...counts), Math.max(...counts), (counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2));

  console.log('  PASS');
}

// --- Test 2: infeasible due to totals mismatch ---
console.log('Test 2: totals mismatch is caught');
{
  const players = [
    { id: 1, target: 5 },
    { id: 2, target: 5 },
  ];
  const weeks = makeWeeks(3); // 3 weeks * 4 = 12 slots, targets sum to 10
  const result = generateSeasonSchedule({ players, weeks, isBlackedOut: () => false, playersPerWeek: 4 });
  assert.strictEqual(result.feasible, false);
  assert.strictEqual(result.conflicts[0].type, 'totals_mismatch');
  console.log('  PASS:', result.conflicts[0].detail);
}

// --- Test 3: an understaffed week (everyone blacked out) is scheduled with
// whoever's available instead of failing the whole season. This is the fix
// for a real reported issue: a single fully-blacked-out week used to make
// every other week fail too, with no way to schedule anything until the
// blackout was resolved. Targets are deliberately NOT rebalanced to
// compensate — see engine.js's "Understaffed weeks" doc comment — so the
// affected players simply end up short of their season target this run. ---
console.log('Test 3: understaffed week is auto-handled instead of failing the whole season');
{
  const players = [
    { id: 1, target: 3 },
    { id: 2, target: 3 },
    { id: 3, target: 3 },
    { id: 4, target: 3 },
  ];
  const weeks = makeWeeks(3); // 3 weeks * 4 = 12 slots, targets sum to 12
  // Everyone is blacked out on the middle week only
  const isBlackedOut = (playerId, weekId) => weekId === weeks[1].id;
  const result = generateSeasonSchedule({ players, weeks, isBlackedOut, playersPerWeek: 4 });
  assert.strictEqual(result.feasible, true, 'should still succeed for the rest of the season');

  assert.strictEqual(result.understaffedWeeks.length, 1, 'exactly the middle week should be flagged');
  const uw = result.understaffedWeeks[0];
  assert.strictEqual(uw.weekId, weeks[1].id);
  assert.strictEqual(uw.availableCount, 0);
  assert.strictEqual(uw.neededCount, 4);
  assert.strictEqual(uw.scheduledCount, 0);

  const [w1, w2, w3] = result.weeks;
  assert.strictEqual(w1.players.length, 4, 'week 1 should still be fully scheduled');
  assert.strictEqual(w2.players.length, 0, 'the understaffed week should have nobody scheduled');
  assert.strictEqual(w2.courts.length, 0);
  assert.strictEqual(w2.ballDutyPlayerId, null, 'no ball duty for a week nobody plays');
  assert.strictEqual(w3.players.length, 4, 'week 3 should still be fully scheduled');

  // Every player was capped at 2 games (only 2 of the 3 weeks were ever
  // available to them), so every one of them is short of their target-3 by 1.
  assert.strictEqual(result.playerShortfalls.length, 4);
  for (const s of result.playerShortfalls) {
    assert.strictEqual(s.target, 3);
    assert.strictEqual(s.achieved, 2);
    assert.strictEqual(s.deficit, 1);
  }
  console.log('  PASS: middle week scheduled with 0 players and flagged; weeks 1 and 3 scheduled normally; all 4 players short by 1 game');
}

// --- Test 3b: a *partially* understaffed week (some, but not enough,
// players available) is capped at the largest multiple of 4 the available
// players can actually fill — never a partial court of 1-3 people. ---
console.log('Test 3b: partially understaffed multi-court week is capped to the nearest full court');
{
  const players = [];
  for (let i = 1; i <= 8; i++) players.push({ id: i, target: 2 });
  const weeks = makeWeeks(2); // 2 weeks * 8 = 16 slots, targets sum to 16
  // Players 7 and 8 are blacked out on week 2 only, leaving 6 of 8 available
  // there — enough for 1 court (4) but not 2 (8), so it should run reduced
  // to exactly 1 court rather than trying to squeeze in a partial second one.
  const isBlackedOut = (playerId, weekId) => (playerId === 7 || playerId === 8) && weekId === weeks[1].id;
  const result = generateSeasonSchedule({ players, weeks, isBlackedOut, playersPerWeek: 8 });
  assert.strictEqual(result.feasible, true);

  assert.strictEqual(result.understaffedWeeks.length, 1);
  const uw = result.understaffedWeeks[0];
  assert.strictEqual(uw.weekId, weeks[1].id);
  assert.strictEqual(uw.availableCount, 6);
  assert.strictEqual(uw.neededCount, 8);
  assert.strictEqual(uw.scheduledCount, 4, 'should round down to the nearest full court, not 6');

  const [w1, w2] = result.weeks;
  assert.strictEqual(w1.players.length, 8, 'week 1 has no blackouts, should be fully scheduled');
  assert.strictEqual(w1.courts.length, 2);
  assert.strictEqual(w2.players.length, 4, 'week 2 should only run 1 court worth');
  assert.strictEqual(w2.courts.length, 1);

  // Total shortfall = 16 target - (8 + 4) achievable = 4 games, spread across
  // 4 players. Players 7 and 8 are guaranteed to be among them — each only
  // had 1 available week (week 1) against a target of 2, regardless of how
  // the other 6 players' games got distributed.
  assert.strictEqual(result.playerShortfalls.length, 4);
  const shortfallIds = result.playerShortfalls.map((s) => s.playerId);
  assert.ok(shortfallIds.includes(7) && shortfallIds.includes(8), 'players 7 and 8 must be short — they only had 1 available week');
  const totalDeficit = result.playerShortfalls.reduce((s, x) => s + x.deficit, 0);
  assert.strictEqual(totalDeficit, 4);
  console.log('  PASS:', uw.scheduledCount, 'of', uw.neededCount, 'players scheduled for the reduced week; total shortfall', totalDeficit, 'games');
}

// --- Test 4: a single player's own blackout dates make their target
// unreachable, but there's slack elsewhere on the roster to absorb the exact
// shortfall — the scheduler auto-absorbs rather than failing the whole run.
// See engine.js's attemptAutoAbsorb() doc comment; Kyle chose this over
// always-hard-fail and over-always-drop-a-whole-court on 2026-08-10 (real
// production report — see Full_Scope_Of_Work.md §14). This replaces the old
// Test 4, which asserted infeasible for this exact scenario before
// auto-absorb existed. ---
console.log('Test 4: player target unreachable due to own blackout dates is auto-absorbed by another player');
{
  const players = [
    { id: 1, target: 3 }, // wants 3 games
    { id: 2, target: 2 },
    { id: 3, target: 2 },
    { id: 4, target: 2 },
    { id: 5, target: 3 },
  ];
  const weeks = makeWeeks(3); // 3 weeks * 4 = 12 slots, targets sum to 12
  // player 1 blacks out 2 of the 3 weeks, leaving only 1 available -- can't reach target of 3
  const isBlackedOut = (playerId, weekId) => playerId === 1 && weekId !== weeks[0].id;
  const result = generateSeasonSchedule({ players, weeks, isBlackedOut, playersPerWeek: 4 });
  assert.strictEqual(result.feasible, true, 'should auto-absorb rather than fail — players 2-5 have room to cover the 2-game deficit');

  assert.strictEqual(result.targetAdjustments.length, 3, 'one capped player + however many it took to absorb 2 games one at a time');
  const capEntry = result.targetAdjustments.find((a) => a.reason === 'own_blackout_limit');
  assert.ok(capEntry, 'player 1 should be recorded as capped');
  assert.strictEqual(capEntry.playerId, 1);
  assert.strictEqual(capEntry.configuredTarget, 3);
  assert.strictEqual(capEntry.effectiveTarget, 1, 'only 1 week was ever available to player 1');
  const absorbedEntries = result.targetAdjustments.filter((a) => a.reason === 'absorbed_shortfall');
  assert.strictEqual(absorbedEntries.length, 2, 'the 2-game deficit should spread across 2 players, not pile onto 1');
  const totalAbsorbedExtra = absorbedEntries.reduce((s, a) => s + (a.effectiveTarget - a.configuredTarget), 0);
  assert.strictEqual(totalAbsorbedExtra, 2, 'the extra games absorbed must exactly equal player 1\'s deficit');
  // Lowest-target players (2 and 3, both target 2) should be preferred over
  // player 5 (target 3) — spreads the bump onto whoever's playing least.
  assert.ok(
    absorbedEntries.every((a) => [2, 3].includes(a.playerId)),
    'should prefer the lowest-target players (2, 3) to absorb, not player 5'
  );

  // Actual games played match the adjusted (not configured) targets exactly.
  const gamesPlayed = new Map(players.map((p) => [p.id, 0]));
  for (const w of result.weeks) for (const pid of w.players) gamesPlayed.set(pid, gamesPlayed.get(pid) + 1);
  assert.strictEqual(gamesPlayed.get(1), 1, 'player 1 capped to 1 game');
  assert.strictEqual(gamesPlayed.get(2) + gamesPlayed.get(3), 6, 'players 2+3 together should have absorbed exactly 2 extra games (2+2 base +2 extra)');
  assert.strictEqual(gamesPlayed.get(4), 2, 'player 4 untouched — no slack was needed from them');
  assert.strictEqual(gamesPlayed.get(5), 3, 'player 5 untouched — lower-target players were preferred');
  assert.strictEqual(result.playerShortfalls.length, 0, 'nobody should be short relative to their (possibly adjusted) effective target');
  console.log('  PASS:', result.targetAdjustments.map((a) => `player ${a.playerId} ${a.configuredTarget}->${a.effectiveTarget} (${a.reason})`).join('; '));
}

// --- Test 4b: same shape of problem, but with zero slack anywhere else on
// the roster to absorb the shortfall — auto-absorb must decline, not
// silently produce a broken or partial schedule. Unit-tests
// attemptAutoAbsorb directly (fabricated conflicts, same approach as Test
// 4c) rather than via generateSeasonSchedule: constructing an integration
// scenario that reaches the player_target_unreachable diagnostic at all
// *and* leaves every other player at exactly zero slack turns out to be
// mutually exclusive with small rosters — the moment blacking out one player
// drops a week's available count below playersPerWeek, the pre-existing
// understaffed-week handling (see solveAssignment) takes over first and the
// run never reaches this function in the first place. Directly fabricating
// the conflicts avoids that confound and tests the actual "no slack" branch
// in isolation. ---
console.log('Test 4b: no slack anywhere else means auto-absorb declines instead of producing a broken schedule');
{
  const players = [
    { id: 1, target: 3 }, // flagged as unreachable; achievable only 1 of the 1 week below
    { id: 2, target: 1 }, // already at their own max (1 available week) — zero slack
    { id: 3, target: 1 },
    { id: 4, target: 1 },
    { id: 5, target: 1 },
  ];
  const weeks = makeWeeks(1);
  const isBlackedOut = () => false; // nobody's actually blacked out — the point here is testing the slack computation, not blackout mechanics
  const fakeConflicts = [{ type: 'player_target_unreachable', playerId: 1, detail: 'x' }];
  const result = attemptAutoAbsorb(players, weeks, isBlackedOut, 4, fakeConflicts);
  assert.strictEqual(result, null, 'players 2-5 are each already at their own max — no room to absorb player 1\'s deficit');
  console.log('  PASS');
}

// --- Test 4c: attemptAutoAbsorb declines outright when a deeper
// combined_conflict is present, even alongside a player_target_unreachable
// conflict — see its doc comment for why a tangled multi-player/multi-week
// deficiency isn't safe to paper over with the same simple rule. Unit-tests
// the guard clause directly rather than trying to construct a real
// Hall's-theorem-deficiency scenario. ---
console.log('Test 4c: attemptAutoAbsorb declines when a combined_conflict is present');
{
  const players = [{ id: 1, target: 2 }, { id: 2, target: 2 }];
  const weeks = makeWeeks(1);
  const fakeConflicts = [
    { type: 'player_target_unreachable', playerId: 1, detail: 'x' },
    { type: 'combined_conflict', detail: 'y', involvedPlayerIds: [1, 2], involvedWeekIds: [weeks[0].id] },
  ];
  const result = attemptAutoAbsorb(players, weeks, () => false, 4, fakeConflicts);
  assert.strictEqual(result, null, 'should decline to auto-absorb when a combined_conflict is present');
  console.log('  PASS');
}

// --- Test 5: multi-court (2 courts, 8 players/week) — regression test for a
// real shipped bug where only the first 4 players of a larger week roster
// ever made it onto a team; the other 4 silently vanished from
// week_assignments despite having consumed a target-game slot. ---
console.log('Test 5: multi-court session assigns every player to a team, on the right number of courts');
{
  const players = [];
  for (let i = 1; i <= 8; i++) players.push({ id: i, name: `P${i}`, target: 6 });
  const weeks = makeWeeks(6);
  const result = generateSeasonSchedule({
    players,
    weeks,
    isBlackedOut: () => false,
    playersPerWeek: 8,
    iterations: 2000,
  });
  assert.strictEqual(result.feasible, true, 'should be feasible');

  for (const w of result.weeks) {
    assert.strictEqual(w.players.length, 8, `week ${w.weekId} should have 8 players`);
    assert.strictEqual(w.courts.length, 2, `week ${w.weekId} should have 2 courts (8 players / 4)`);

    // The actual regression check: every player in w.players must appear on
    // some court's team. Before the fix, courts (then just a single
    // teamA/teamB pair) only ever covered the first 4 of the 8 players.
    const coveredPlayers = new Set();
    for (const c of w.courts) {
      assert.strictEqual(c.teamA.length, 2, `court ${c.court} teamA should have 2 players`);
      assert.strictEqual(c.teamB.length, 2, `court ${c.court} teamB should have 2 players`);
      for (const pid of [...c.teamA, ...c.teamB]) coveredPlayers.add(pid);
    }
    assert.strictEqual(coveredPlayers.size, 8, `all 8 players in week ${w.weekId} should be covered by a team`);
    for (const pid of w.players) {
      assert.ok(coveredPlayers.has(pid), `player ${pid} in week ${w.weekId} should be on a team, not dropped`);
    }
  }

  // Each player still hits their target exactly, same invariant as single-court
  const gamesPlayed = new Map(players.map((p) => [p.id, 0]));
  for (const w of result.weeks) {
    for (const pid of w.players) gamesPlayed.set(pid, gamesPlayed.get(pid) + 1);
  }
  for (const p of players) {
    assert.strictEqual(gamesPlayed.get(p.id), p.target, `player ${p.name} should hit target ${p.target}`);
  }

  console.log('  PASS');
}

// --- Test 6: players_per_week not a multiple of 4 is rejected up front,
// rather than silently truncating a court's worth of players. ---
console.log('Test 6: players_per_week that is not a positive multiple of 4 is rejected');
{
  const players = [{ id: 1, target: 3 }, { id: 2, target: 3 }, { id: 3, target: 3 }];
  const weeks = makeWeeks(3);
  const result = generateSeasonSchedule({ players, weeks, isBlackedOut: () => false, playersPerWeek: 3 });
  assert.strictEqual(result.feasible, false);
  assert.strictEqual(result.conflicts[0].type, 'invalid_players_per_week');
  console.log('  PASS:', result.conflicts[0].detail);
}

console.log('\nAll scheduling engine tests passed.');
