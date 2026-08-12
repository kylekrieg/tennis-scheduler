'use strict';

/**
 * Pure, DB-free scheduling engine.
 *
 * Given a roster with per-player target game counts, a list of weeks, and a set
 * of hard blackout constraints, produces a full-season assignment:
 *   - which players play each week (normally every player hits their target
 *     exactly — see "Understaffed weeks" below for the one case that's not true)
 *   - how each week's roster is split into doubles teams, spreading partner
 *     pairings as evenly as possible across the season
 *   - who has ball duty each week, proportional to overall playing frequency
 *
 * If the targets + blackout dates can't all be satisfied simultaneously, no
 * approximation is silently produced — a structured list of conflicts is
 * returned instead so the caller (admin dashboard) can show Kyle exactly what
 * to fix.
 *
 * Algorithm:
 *   1. Feasibility + assignment via max-flow (source -> players -> weeks -> sink).
 *      This guarantees an exact solution exists (or proves it doesn't) rather
 *      than a heuristic that might miss a valid arrangement.
 *   2. Local search (simulated annealing over valid swaps) to spread partner
 *      pairings evenly, without ever violating a target count or blackout date.
 *   3. Deficit-based greedy pass to assign ball duty proportional to each
 *      player's share of total games played.
 *
 * Understaffed weeks: if enough players are blacked out on a given week that
 * fewer than `playersPerWeek` are actually available, that week can't be
 * filled to its normal size — and since a doubles court needs exactly 4, it's
 * capped at the largest multiple of 4 the available players can fill (0 if
 * fewer than 4 are available at all). Rather than that one week making the
 * *entire season* infeasible (the old behavior), the week is scheduled with
 * whoever's available, flagged via `understaffedWeeks` in the result, and the
 * rest of the season is scheduled normally. This intentionally does NOT
 * rebalance anyone else's target to compensate — targets stay exactly as
 * configured, so a player who misses games because of an understaffed week
 * simply ends up under their season target; `playerShortfalls` in the result
 * lists exactly who and by how much, and it's on the admin to make it up
 * manually (bump a target on a later re-schedule, pull in a sub, etc.) if
 * they want to. See "Understaffed weeks" in CLAUDE.md.
 */

// ---------------------------------------------------------------------------
// Max-flow (Edmonds-Karp / BFS augmenting path) — small graph, simplicity > speed
// ---------------------------------------------------------------------------

class FlowGraph {
  constructor(numNodes) {
    this.numNodes = numNodes;
    this.adj = Array.from({ length: numNodes }, () => []);
  }

  addEdge(u, v, cap) {
    const edgeUV = { to: v, cap, flow: 0, rev: null };
    const edgeVU = { to: u, cap: 0, flow: 0, rev: null };
    edgeUV.rev = edgeVU;
    edgeVU.rev = edgeUV;
    this.adj[u].push(edgeUV);
    this.adj[v].push(edgeVU);
    return edgeUV;
  }

  maxFlow(source, sink) {
    let total = 0;
    for (;;) {
      // BFS to find an augmenting path
      const prevEdge = new Array(this.numNodes).fill(null);
      const visited = new Array(this.numNodes).fill(false);
      visited[source] = true;
      const queue = [source];
      let qi = 0;
      while (qi < queue.length && !visited[sink]) {
        const u = queue[qi++];
        for (const edge of this.adj[u]) {
          const residual = edge.cap - edge.flow;
          if (residual > 0 && !visited[edge.to]) {
            visited[edge.to] = true;
            prevEdge[edge.to] = edge;
            queue.push(edge.to);
          }
        }
      }
      if (!visited[sink]) break;

      // Find bottleneck along the path
      let aug = Infinity;
      let v = sink;
      while (v !== source) {
        const edge = prevEdge[v];
        aug = Math.min(aug, edge.cap - edge.flow);
        v = edge.rev.to;
      }
      // Apply
      v = sink;
      while (v !== source) {
        const edge = prevEdge[v];
        edge.flow += aug;
        edge.rev.flow -= aug;
        v = edge.rev.to;
      }
      total += aug;
    }
    return total;
  }

  // Set of nodes reachable from `source` in the residual graph (used for min-cut diagnostics)
  reachableFromSource(source) {
    const visited = new Array(this.numNodes).fill(false);
    visited[source] = true;
    const queue = [source];
    let qi = 0;
    while (qi < queue.length) {
      const u = queue[qi++];
      for (const edge of this.adj[u]) {
        if (edge.cap - edge.flow > 0 && !visited[edge.to]) {
          visited[edge.to] = true;
          queue.push(edge.to);
        }
      }
    }
    return visited;
  }
}

// ---------------------------------------------------------------------------
// Feasibility + initial assignment
// ---------------------------------------------------------------------------

/**
 * @param {Array<{id:number, target:number, name?:string}>} players
 * @param {Array<{id:number, date?:string}>} weeks
 * @param {(playerId:number, weekId:number) => boolean} isBlackedOut
 * @param {number} playersPerWeek
 * @returns {{feasible:true, assignment: Map<weekId, number[]>} | {feasible:false, conflicts: object[]}}
 */
function solveAssignment(players, weeks, isBlackedOut, playersPerWeek) {
  const conflicts = [];

  // Every week's roster gets split into courts of exactly 4 (2v2 doubles) by
  // splitIntoCourtTeams below, which chunks the week's assigned players into
  // groups of 4 in order. Anything that doesn't divide evenly into courts of
  // 4 would silently leave players out of a team (or crash) at that step, so
  // this is checked up front as a proper infeasibility rather than trusting
  // the caller (the admin session form restricts this too, but the engine
  // shouldn't rely on that alone).
  if (!Number.isInteger(playersPerWeek) || playersPerWeek < 4 || playersPerWeek % 4 !== 0) {
    conflicts.push({
      type: 'invalid_players_per_week',
      detail: `Players per week must be a positive multiple of 4 (one doubles court = 4 players); got ${playersPerWeek}.`,
    });
    return { feasible: false, conflicts };
  }

  const totalTarget = players.reduce((s, p) => s + p.target, 0);
  const totalSlots = weeks.length * playersPerWeek;

  if (totalTarget !== totalSlots) {
    conflicts.push({
      type: 'totals_mismatch',
      detail: `Player targets sum to ${totalTarget} games, but the season has ${weeks.length} weeks x ${playersPerWeek} players/week = ${totalSlots} slots. These must be equal.`,
      totalTarget,
      totalSlots,
    });
    return { feasible: false, conflicts };
  }

  // Node layout: 0 = source, 1..P = players, P+1..P+W = weeks, P+W+1 = sink
  const P = players.length;
  const W = weeks.length;
  const source = 0;
  const sink = P + W + 1;
  const playerNode = (i) => 1 + i;
  const weekNode = (j) => 1 + P + j;

  // A week's normal capacity is playersPerWeek, but if enough players are
  // blacked out that fewer than that many are actually available, there's no
  // way to fill it to the usual size — and since a doubles court needs
  // exactly 4, a partial court has to be capped at the largest multiple of 4
  // the available players can fill (0 if fewer than 4 are available at all).
  // This is computed up front, deterministically, from blackout data alone —
  // not discovered via max-flow failure — so these weeks can be scheduled
  // with whoever's available instead of blocking the whole season. See the
  // "Understaffed weeks" doc comment at the top of this file.
  const understaffedWeeks = [];
  const weekCapacity = weeks.map((w) => {
    const availableCount = players.filter((p) => !isBlackedOut(p.id, w.id)).length;
    const capacity = Math.min(playersPerWeek, Math.floor(availableCount / 4) * 4);
    if (capacity < playersPerWeek) {
      understaffedWeeks.push({
        weekId: w.id,
        availableCount,
        neededCount: playersPerWeek,
        scheduledCount: capacity,
      });
    }
    return capacity;
  });
  const totalCapacity = weekCapacity.reduce((s, c) => s + c, 0);

  const graph = new FlowGraph(P + W + 2);
  const playerEdges = [];
  for (let i = 0; i < P; i++) {
    playerEdges.push(graph.addEdge(source, playerNode(i), players[i].target));
  }
  const weekEdges = [];
  for (let j = 0; j < W; j++) {
    weekEdges.push(graph.addEdge(weekNode(j), sink, weekCapacity[j]));
  }
  const assignEdges = new Map(); // `${i}-${j}` -> edge
  for (let i = 0; i < P; i++) {
    for (let j = 0; j < W; j++) {
      if (!isBlackedOut(players[i].id, weeks[j].id)) {
        const edge = graph.addEdge(playerNode(i), weekNode(j), 1);
        assignEdges.set(`${i}-${j}`, edge);
      }
    }
  }

  const flow = graph.maxFlow(source, sink);

  // Success means the flow saturates every week's (possibly-reduced)
  // capacity — NOT necessarily every player's target. If an understaffed
  // week reduced total capacity below total target, the shortfall lands on
  // whichever players' games that week would have covered; see
  // playerShortfalls below for exactly who and by how much.
  if (flow === totalCapacity) {
    const assignment = new Map(weeks.map((w) => [w.id, []]));
    for (let i = 0; i < P; i++) {
      for (let j = 0; j < W; j++) {
        const edge = assignEdges.get(`${i}-${j}`);
        if (edge && edge.flow > 0) {
          assignment.get(weeks[j].id).push(players[i].id);
        }
      }
    }
    const playerShortfalls = [];
    for (let i = 0; i < P; i++) {
      const achieved = playerEdges[i].flow;
      if (achieved < players[i].target) {
        playerShortfalls.push({
          playerId: players[i].id,
          target: players[i].target,
          achieved,
          deficit: players[i].target - achieved,
        });
      }
    }
    return { feasible: true, assignment, understaffedWeeks, playerShortfalls };
  }

  // --- Infeasible: something beyond the already-accounted-for understaffed
  // weeks above is also blocking a full schedule. ---

  // 1. Players who structurally can't reach their target given their own
  //    blackout dates (only counting weeks that can actually run a match —
  //    a week already reduced to 0 capacity above can't host anyone either).
  for (let i = 0; i < P; i++) {
    const availableWeeks = weeks.filter((w, j) => !isBlackedOut(players[i].id, w.id) && weekCapacity[j] > 0);
    if (availableWeeks.length < players[i].target) {
      conflicts.push({
        type: 'player_target_unreachable',
        playerId: players[i].id,
        detail: `Target is ${players[i].target} games, but only ${availableWeeks.length} week(s) are available (not blacked out, and have enough players to run a match).`,
        availableWeekIds: availableWeeks.map((w) => w.id),
      });
    }
  }

  // 2. If that simple check doesn't explain the shortfall, it's a deeper
  //    combinatorial conflict (Hall's-theorem-style deficiency across a
  //    subset). Use the min-cut from the residual graph to report exactly
  //    which players/weeks are entangled.
  if (conflicts.length === 0) {
    const reachable = graph.reachableFromSource(source);
    const boundPlayers = [];
    const boundWeeks = [];
    for (let i = 0; i < P; i++) {
      if (reachable[playerNode(i)]) boundPlayers.push(players[i].id);
    }
    for (let j = 0; j < W; j++) {
      if (!reachable[weekNode(j)]) boundWeeks.push(weeks[j].id);
    }
    conflicts.push({
      type: 'combined_conflict',
      detail:
        'The blackout dates and target counts for this group of players/weeks are jointly infeasible, even accounting for any weeks already reduced for having too few available players. Adjust a target or lift a blackout date for one of the listed players/weeks.',
      shortfall: totalCapacity - flow,
      involvedPlayerIds: boundPlayers,
      involvedWeekIds: boundWeeks,
    });
  }

  return { feasible: false, conflicts, understaffedWeeks };
}

// ---------------------------------------------------------------------------
// Auto-absorb: when a player's own blackout dates alone make their target
// unreachable, hand the exact shortfall to another player instead of failing
// the whole run.
// ---------------------------------------------------------------------------

/**
 * Recomputes each week's blackout-driven capacity exactly like solveAssignment
 * does, standalone, so this can be called after solveAssignment has already
 * failed without needing solveAssignment to expose its internal state.
 */
function computeWeekCapacity(players, weeks, isBlackedOut, playersPerWeek) {
  return weeks.map((w) => {
    const availableCount = players.filter((p) => !isBlackedOut(p.id, w.id)).length;
    return Math.min(playersPerWeek, Math.floor(availableCount / 4) * 4);
  });
}

/**
 * When solveAssignment fails and the *only* reason is one or more players
 * structurally unable to reach their own target (never a deeper
 * combined_conflict — see below for why that case is deliberately excluded),
 * this hands the exact shortfall to other players with room instead of
 * failing the entire run.
 *
 * This is a narrower, more targeted version of the "auto-rebalance" option
 * Kyle explicitly rejected for understaffed weeks (see "Understaffed weeks"
 * doc comment above and CLAUDE.md) — that option would have nudged *every*
 * player's target down slightly, opaquely, to keep the season's math
 * balanced. This instead touches only the specific player(s) who structurally
 * can't hit their own number, hands the *exact* deficit (usually 1-2 games)
 * to whichever other player(s) have room, and reports every adjustment made
 * (`targetAdjustments`) so it's never a silent change — session_players.
 * target_games in the DB is never touched, only this run's actual game
 * counts. Kyle chose this over both "always hard-fail" and "always drop a
 * whole court to avoid touching any target" on 2026-08-10 (see
 * Full_Scope_Of_Work.md §14) specifically because a 1-game shortfall costing
 * 3 unrelated players a game each (dropping a whole court to stay under the
 * old target-immutability rule) was worse than the narrower fix.
 *
 * Deliberately does NOT attempt this for a `combined_conflict` (the
 * Hall's-theorem-style deficiency across an entangled subset of players/weeks
 * solveAssignment falls back to when no single player's own blackout dates
 * explain the shortfall) — that failure mode is a genuinely tangled
 * combination the admin needs to look at directly, not something safe to
 * paper over with a generic "give it to whoever has room" rule.
 *
 * Returns `null` if this isn't a case it should touch (a combined_conflict is
 * present) or if there isn't enough aggregate slack among other players to
 * absorb the full deficit — in both cases the caller should report the
 * original conflict as before.
 */
function attemptAutoAbsorb(players, weeks, isBlackedOut, playersPerWeek, originalConflicts) {
  if (originalConflicts.length === 0 || !originalConflicts.every((c) => c.type === 'player_target_unreachable')) {
    return null;
  }

  const weekCapacity = computeWeekCapacity(players, weeks, isBlackedOut, playersPerWeek);
  const availableWeeksFor = (playerId) =>
    weeks.filter((w, j) => !isBlackedOut(playerId, w.id) && weekCapacity[j] > 0);

  const unreachableIds = new Set(originalConflicts.map((c) => c.playerId));
  const adjusted = players.map((p) => ({ ...p }));
  const byId = new Map(adjusted.map((p) => [p.id, p]));

  const capped = [];
  let totalDeficit = 0;
  for (const c of originalConflicts) {
    const p = byId.get(c.playerId);
    const achievable = availableWeeksFor(p.id).length;
    const deficit = p.target - achievable;
    if (deficit <= 0) continue; // shouldn't happen (solveAssignment already found this deficit), defensive only
    capped.push({ id: p.id, from: p.target, to: achievable });
    p.target = achievable;
    totalDeficit += deficit;
  }
  if (totalDeficit <= 0) return null;

  // Candidates to absorb the shortfall: any other player with at least one
  // available week beyond their own current target. Sorted by target
  // ascending (lowest-target players first) so the extra game or two is
  // proportionally the smallest bump for whoever gets it, rather than piling
  // onto whoever's already playing the most.
  const candidates = adjusted
    .filter((p) => !unreachableIds.has(p.id))
    .map((p) => ({ player: p, slack: availableWeeksFor(p.id).length - p.target }))
    .filter((c) => c.slack > 0)
    .sort((a, b) => a.player.target - b.player.target || a.player.id - b.player.id);

  const boostById = new Map();
  let remaining = totalDeficit;
  // Round-robin one game at a time (rather than dumping the whole deficit on
  // the single lowest-target candidate) so a deficit bigger than 1 spreads
  // across more than one person where possible.
  while (remaining > 0 && candidates.some((c) => c.slack > 0)) {
    let progressed = false;
    for (const c of candidates) {
      if (remaining <= 0) break;
      if (c.slack <= 0) continue;
      c.player.target += 1;
      c.slack -= 1;
      remaining -= 1;
      progressed = true;
      boostById.set(c.player.id, (boostById.get(c.player.id) || 0) + 1);
    }
    if (!progressed) break;
  }
  if (remaining > 0) return null; // not enough aggregate slack among everyone else to absorb it

  const retry = solveAssignment(adjusted, weeks, isBlackedOut, playersPerWeek);
  if (!retry.feasible) return null; // the adjusted numbers still don't produce a valid routing — give up, report the original conflict

  const targetAdjustments = [
    ...capped.map((c) => ({
      playerId: c.id,
      configuredTarget: c.from,
      effectiveTarget: c.to,
      reason: 'own_blackout_limit',
    })),
    ...[...boostById.entries()].map(([playerId, extra]) => ({
      playerId,
      configuredTarget: byId.get(playerId).target - extra,
      effectiveTarget: byId.get(playerId).target,
      reason: 'absorbed_shortfall',
    })),
  ];

  return { ...retry, targetAdjustments };
}

// ---------------------------------------------------------------------------
// Team pairing + partner-variety local search
// ---------------------------------------------------------------------------

function pairKey(a, b) {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function bestSplitFor4(four, partnerCounts) {
  const [a, b, c, d] = four;
  const options = [
    [[a, b], [c, d]],
    [[a, c], [b, d]],
    [[a, d], [b, c]],
  ];
  let best = null;
  let bestScore = Infinity;
  for (const [teamA, teamB] of options) {
    const cA = partnerCounts.get(pairKey(...teamA)) || 0;
    const cB = partnerCounts.get(pairKey(...teamB)) || 0;
    // Minimize the resulting max, then the resulting sum of (choose 2) — spreads evenly.
    const score = Math.max(cA, cB) * 1000 + (cA + cB);
    if (score < bestScore) {
      bestScore = score;
      best = [teamA, teamB];
    }
  }
  return best;
}

/**
 * Splits a week's full roster (any positive multiple of 4) into courts of 4,
 * each split into two teams of 2. Courts are independent — every player
 * appears on exactly one court, so there's no cross-court interaction to
 * account for; each quad is just handed to bestSplitFor4 against the same
 * partnerCounts snapshot. This is the fix for a real bug: the previous
 * version (`bestSplitFor4` called directly on the full roster) silently
 * destructured only the first 4 players of a larger roster, so any session
 * with more than one court dropped every player past the first 4 from
 * week_assignments entirely — they still consumed a target-game slot in the
 * max-flow solution, but never got a team, a confirmation email, or a
 * calendar entry for that week.
 */
function splitIntoCourtTeams(players, partnerCounts) {
  const courts = [];
  for (let i = 0; i < players.length; i += 4) {
    const quad = players.slice(i, i + 4);
    const [teamA, teamB] = bestSplitFor4(quad, partnerCounts);
    courts.push({ court: Math.floor(i / 4) + 1, teamA, teamB });
  }
  return courts;
}

function computeObjective(weekTeams, partnerCounts) {
  // sum of c*(c-1)/2 over all pairs — minimizing this spreads pairings evenly
  // for a fixed total number of teammate-pair-slots.
  let total = 0;
  for (const c of partnerCounts.values()) {
    total += (c * (c - 1)) / 2;
  }
  return total;
}

function rebuildPartnerCounts(weekOrder, weekTeams) {
  const counts = new Map();
  for (const weekId of weekOrder) {
    const teams = weekTeams.get(weekId);
    if (!teams) continue;
    for (const team of teams) {
      const key = pairKey(team[0], team[1]);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Splits each week's group of 4 into two teams, then runs a bounded simulated
 * annealing pass that swaps *which players* are assigned to which week
 * (only among valid, blackout-respecting, target-preserving swaps) to spread
 * partner pairings evenly across the whole season.
 */
function optimizePartnerVariety(assignment, weeks, isBlackedOut, options = {}) {
  const { iterations = 4000, seed = 42 } = options;
  // A week reduced to 0 capacity (understaffed — see solveAssignment) has an
  // empty roster and nothing to optimize. It also has to be excluded from
  // swap candidates entirely, not just skipped when picked as the *source* of
  // a swap: picking a real player from another week and "swapping" them with
  // the nonexistent player at index 0 of an empty array (`undefined`) would
  // otherwise silently splice `undefined` into that other week's roster in
  // place of a real player.
  const weekIds = weeks.map((w) => w.id).filter((id) => assignment.get(id).length > 0);

  // deterministic PRNG so results are reproducible for a given roster/blackouts
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };

  const roster = new Map(); // weekId -> [4 player ids]
  for (const w of weeks) roster.set(w.id, [...assignment.get(w.id)]);

  const weekTeams = new Map(); // weekId -> [{court, teamA, teamB}, ...] — one entry per court
  let partnerCounts = new Map();
  for (const w of weeks) {
    const courts = splitIntoCourtTeams(roster.get(w.id), partnerCounts);
    weekTeams.set(w.id, courts);
    for (const c of courts) {
      const keyA = pairKey(c.teamA[0], c.teamA[1]);
      const keyB = pairKey(c.teamB[0], c.teamB[1]);
      partnerCounts.set(keyA, (partnerCounts.get(keyA) || 0) + 1);
      partnerCounts.set(keyB, (partnerCounts.get(keyB) || 0) + 1);
    }
  }

  let currentObjective = computeObjective(weekTeams, partnerCounts);

  for (let iter = 0; iter < iterations; iter++) {
    const temperature = 1 - iter / iterations; // linear cooling, 1 -> 0

    // Pick two distinct random weeks
    const wi1 = Math.floor(rand() * weekIds.length);
    let wi2 = Math.floor(rand() * weekIds.length);
    if (wi1 === wi2) continue;
    const w1 = weekIds[wi1];
    const w2 = weekIds[wi2];

    const roster1 = roster.get(w1);
    const roster2 = roster.get(w2);
    const p1 = roster1[Math.floor(rand() * roster1.length)];
    const p2 = roster2[Math.floor(rand() * roster2.length)];
    if (p1 === p2) continue;
    if (roster1.includes(p2) || roster2.includes(p1)) continue; // would create duplicate in a week
    if (isBlackedOut(p1, w2) || isBlackedOut(p2, w1)) continue; // hard constraint

    // Tentatively swap
    const newRoster1 = roster1.map((p) => (p === p1 ? p2 : p));
    const newRoster2 = roster2.map((p) => (p === p2 ? p1 : p));

    // Remove old contributions for w1/w2 (all their courts), compute new
    // best court splits for the swapped rosters, compare objective.
    const trial = new Map(partnerCounts);
    const removeCourts = (courts) => {
      for (const c of courts) {
        const keyA = pairKey(c.teamA[0], c.teamA[1]);
        const keyB = pairKey(c.teamB[0], c.teamB[1]);
        trial.set(keyA, trial.get(keyA) - 1);
        trial.set(keyB, trial.get(keyB) - 1);
      }
    };
    const addCourts = (courts) => {
      for (const c of courts) {
        const keyA = pairKey(c.teamA[0], c.teamA[1]);
        const keyB = pairKey(c.teamB[0], c.teamB[1]);
        trial.set(keyA, (trial.get(keyA) || 0) + 1);
        trial.set(keyB, (trial.get(keyB) || 0) + 1);
      }
    };
    removeCourts(weekTeams.get(w1));
    removeCourts(weekTeams.get(w2));
    const courts1 = splitIntoCourtTeams(newRoster1, trial);
    addCourts(courts1);
    const courts2 = splitIntoCourtTeams(newRoster2, trial);
    addCourts(courts2);

    const trialObjective = computeObjective(null, trial);
    const delta = trialObjective - currentObjective;

    const accept = delta <= 0 || rand() < Math.exp(-delta / Math.max(temperature, 0.001) / 5);
    if (accept) {
      roster.set(w1, newRoster1);
      roster.set(w2, newRoster2);
      weekTeams.set(w1, courts1);
      weekTeams.set(w2, courts2);
      partnerCounts = trial;
      currentObjective = trialObjective;
    }
  }

  return { roster, weekTeams, partnerCounts };
}

// ---------------------------------------------------------------------------
// Ball duty — proportional to each player's share of total games, deficit-based
// ---------------------------------------------------------------------------

function assignBallDuty(weeks, roster, players) {
  const totalGames = players.reduce((s, p) => s + p.target, 0);
  // Only count weeks that actually have a match — an understaffed week
  // reduced to 0 players (see solveAssignment) has nobody to assign ball
  // duty to, and including it here would inflate everyone's "fair share"
  // relative to the weeks that actually get played, throwing off deficit
  // ordering for the weeks that do.
  const totalWeeks = weeks.filter((w) => roster.get(w.id).length > 0).length;
  const fairShare = new Map(players.map((p) => [p.id, (p.target / totalGames) * totalWeeks]));
  const assignedSoFar = new Map(players.map((p) => [p.id, 0]));

  const ballDuty = new Map(); // weekId -> playerId, or null for an unplayed week

  for (const w of weeks) {
    const four = roster.get(w.id);
    if (four.length === 0) {
      ballDuty.set(w.id, null);
      continue;
    }
    let chosen = null;
    let bestDeficit = -Infinity;
    for (const pid of four) {
      const deficit = fairShare.get(pid) - assignedSoFar.get(pid);
      if (
        deficit > bestDeficit ||
        (deficit === bestDeficit && chosen !== null && assignedSoFar.get(pid) < assignedSoFar.get(chosen))
      ) {
        bestDeficit = deficit;
        chosen = pid;
      }
    }
    ballDuty.set(w.id, chosen);
    assignedSoFar.set(chosen, assignedSoFar.get(chosen) + 1);
  }

  return ballDuty;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {Array<{id:number, target:number, name?:string}>} input.players
 * @param {Array<{id:number, date?:string}>} input.weeks - in chronological order
 * @param {(playerId:number, weekId:number) => boolean} input.isBlackedOut
 * @param {number} [input.playersPerWeek]
 * @param {number} [input.iterations] - local search iterations for partner variety
 */
function generateSeasonSchedule(input) {
  const { players, weeks, isBlackedOut, playersPerWeek = 4, iterations = 4000 } = input;

  let solved = solveAssignment(players, weeks, isBlackedOut, playersPerWeek);
  let targetAdjustments = [];
  if (!solved.feasible) {
    // See attemptAutoAbsorb's doc comment: only kicks in for the narrow case
    // of one or more players structurally unable to reach their own target,
    // never for a deeper combined_conflict. Returns null (leaving `solved`
    // as the original infeasible result) if it can't find a way to absorb
    // the shortfall either.
    const absorbed = attemptAutoAbsorb(players, weeks, isBlackedOut, playersPerWeek, solved.conflicts);
    if (absorbed) {
      solved = absorbed;
      targetAdjustments = absorbed.targetAdjustments;
    }
  }
  if (!solved.feasible) {
    return { feasible: false, conflicts: solved.conflicts, understaffedWeeks: solved.understaffedWeeks || [] };
  }

  const { roster, weekTeams, partnerCounts } = optimizePartnerVariety(
    solved.assignment,
    weeks,
    isBlackedOut,
    { iterations }
  );

  const ballDuty = assignBallDuty(weeks, roster, players);

  const weekResults = weeks.map((w) => ({
    weekId: w.id,
    players: roster.get(w.id),
    // One entry per court: { court: 1, teamA: [p,p], teamB: [p,p] }. Every
    // player in `players` above appears in exactly one court's teamA/teamB —
    // see splitIntoCourtTeams for why that invariant matters.
    courts: weekTeams.get(w.id),
    ballDutyPlayerId: ballDuty.get(w.id),
  }));

  return {
    feasible: true,
    weeks: weekResults,
    partnerCounts: Object.fromEntries(partnerCounts),
    // Weeks that had too few available (non-blacked-out) players to fill
    // normally, and were scheduled with a reduced (possibly 0) roster
    // instead of blocking the whole run — see the "Understaffed weeks" doc
    // comment at the top of this file. Empty array in the normal case.
    understaffedWeeks: solved.understaffedWeeks,
    // Players whose achieved games this run fell short of their configured
    // target as a direct result of an understaffed week above — targets are
    // never auto-adjusted to compensate, so this is purely informational.
    // Empty array in the normal case.
    playerShortfalls: solved.playerShortfalls,
    // Present only when attemptAutoAbsorb kicked in: one or more players
    // whose own blackout dates made their configured target unreachable had
    // it capped down (reason: 'own_blackout_limit'), and the exact deficit
    // was handed to one or more other players with room (reason:
    // 'absorbed_shortfall') so every court still stays full. Never touches
    // session_players.target_games in the DB — this is purely this run's
    // actual game counts, reported so the admin sees exactly what happened
    // and can override manually if they'd rather split it differently. Empty
    // array in the normal case. See attemptAutoAbsorb's doc comment.
    targetAdjustments,
  };
}

module.exports = {
  generateSeasonSchedule,
  // exported for testing / admin diagnostics reuse
  solveAssignment,
  attemptAutoAbsorb,
  optimizePartnerVariety,
  assignBallDuty,
  splitIntoCourtTeams,
  FlowGraph,
};
