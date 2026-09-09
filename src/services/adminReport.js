'use strict';
const db = require('../db');
const email = require('./email');
const subFlow = require('./subFlow');
const { fullName } = require('./playerName');

/**
 * Admin pre-match status report (Kyle, 2026-08-26): "we need to define at
 * least one admin email address... The morning of of the match (let's say 8
 * hours before) the admin gets an email with the status of the players.
 * Who's confirmed, who hasn't confirmed, who asked for a sub and who filled
 * it. Who performed a swap." A per-session, opt-in digest — see
 * `sessions.admin_report_emails`/`admin_report_lead_hours` in schema.sql —
 * gated in cron.js's processAdminReports() on a non-blank recipient list and
 * `session_type = 'regular'` only (ad-hoc sessions have no confirm/sub/swap
 * state machine for this to summarize — see "Ad-hoc sessions" in
 * CLAUDE.md). Regular sessions only ever have one confirm/sub/swap flow per
 * week, so this module's whole job is turning that week's current
 * week_assignments rows into the four buckets Kyle asked for.
 */

/**
 * Maps a `subbed_out` assignment's id -> the full name of whoever ended up
 * in that seat this week. Prefers the real `week_assignments.
 * replaces_assignment_id` link (set at creation time by claimSub() and the
 * admin Reassign route's "one-time sub"/"sub list" branches); falls back to
 * the same same-team/same-court "exactly one unmatched candidate" heuristic
 * sessionHelper.js's orderAssignmentsWithSubGroups() and public.js's My Page
 * query already use for a pair with no real link (an admin placing a sub
 * directly via Reassign outside the request-a-sub flow, a legacy row, etc.
 * — see CLAUDE.md's 2026-09-09 "My Page: sub 'who's subbing for whom'
 * callout missing" entry for the original version of this bug).
 *
 * This used to go through sub_requests/sub_offers instead (looking for a
 * `sub_requests` row with status 'filled' and a claimed `sub_offers` row
 * off of it) — that only ever covers a sub who came through the formal
 * request-a-sub flow. A sub an admin placed directly has no sub_requests
 * row at all, so that lookup silently found nothing and this fell back to
 * a bare "replaced by a sub" even though the exact same pairing was already
 * resolved correctly everywhere else in the app (Kyle, 2026-09-09: reported
 * this exact case — Jon Deuchler's subbed_out row showing "replaced by a
 * sub" instead of "replaced by Ed Bourneuf").
 */
function resolveSubNames(assignments) {
  const byId = new Map(assignments.map((a) => [a.id, a]));
  const subRows = assignments.filter((a) => a.is_sub);
  const claimedChildIds = new Set();
  const subNameByParentId = new Map();

  // Real link first — always correct, no ambiguity possible.
  subRows.forEach((sub) => {
    if (sub.replaces_assignment_id && byId.has(sub.replaces_assignment_id)) {
      subNameByParentId.set(sub.replaces_assignment_id, fullName(sub));
      claimedChildIds.add(sub.id);
    }
  });

  // Heuristic fallback, only for rows the real link didn't already account
  // for: an unmatched `subbed_out` row paired with the one unmatched
  // `is_sub` row sharing its team+court, but only when that pairing is
  // unambiguous (exactly one candidate) — two players on the same team both
  // needing subs the same week is deliberately left unresolved here rather
  // than risk pairing the wrong two people.
  const unmatchedSubbedOut = assignments.filter((a) => a.status === 'subbed_out' && !subNameByParentId.has(a.id));
  const unmatchedSubRows = subRows.filter((a) => !a.replaces_assignment_id && !claimedChildIds.has(a.id));
  unmatchedSubbedOut.forEach((parent) => {
    const candidates = unmatchedSubRows.filter(
      (c) => c.team === parent.team && c.court === parent.court && !claimedChildIds.has(c.id)
    );
    if (candidates.length === 1) {
      subNameByParentId.set(parent.id, fullName(candidates[0]));
      claimedChildIds.add(candidates[0].id);
    }
  });

  return subNameByParentId;
}

/**
 * Maps week_assignments.id -> { otherName, otherDate } for any assignment in
 * this week whose current occupant got there via an accepted direct swap
 * (swapFlow.js's respondToSwap() rewrites player_id on the existing row
 * rather than creating a new one, so there's no is_sub-style flag to check —
 * this has to look the swap up explicitly). `otherName`/`otherDate` describe
 * the *original* owner of this slot and the week they traded it away for,
 * from the current occupant's perspective — e.g. "swapped with Alice, who
 * was playing Sep 9" for the player now sitting in what used to be Alice's
 * seat.
 */
function swapsAffectingAssignments(assignmentIds) {
  const map = new Map();
  if (!assignmentIds.length) return map;
  const placeholders = assignmentIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM swap_requests WHERE status = 'accepted' AND (initiator_assignment_id IN (${placeholders}) OR target_assignment_id IN (${placeholders}))`
    )
    .all(...assignmentIds, ...assignmentIds);

  for (const sw of rows) {
    if (assignmentIds.includes(sw.initiator_assignment_id)) {
      // This row was originally the initiator's own slot; whoever's playing
      // it now is the target player, having traded away their own week for it.
      const otherWeek = db
        .prepare(`SELECT w.match_date FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id WHERE wa.id = ?`)
        .get(sw.target_assignment_id);
      const otherPlayer = db.prepare('SELECT name, full_name FROM players WHERE id = ?').get(sw.initiator_player_id);
      map.set(sw.initiator_assignment_id, {
        otherName: otherPlayer ? fullName(otherPlayer) : 'someone',
        otherDate: otherWeek ? otherWeek.match_date : null,
      });
    }
    if (assignmentIds.includes(sw.target_assignment_id)) {
      const otherWeek = db
        .prepare(`SELECT w.match_date FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id WHERE wa.id = ?`)
        .get(sw.initiator_assignment_id);
      const otherPlayer = db.prepare('SELECT name, full_name FROM players WHERE id = ?').get(sw.target_player_id);
      map.set(sw.target_assignment_id, {
        otherName: otherPlayer ? fullName(otherPlayer) : 'someone',
        otherDate: otherWeek ? otherWeek.match_date : null,
      });
    }
  }
  return map;
}

/** Builds the four-bucket breakdown (confirmed / not yet confirmed / needs a
 * sub / subbed out) for one week, plus a headcount and ball duty — everything
 * email.js's sendAdminWeekReport() needs to render, with zero further DB
 * access from that side. Every current week_assignments row is accounted for
 * exactly once, regardless of status. */
function buildWeekReport(weekId) {
  const week = subFlow.getWeekWithSession(weekId);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(week.session_id);

  const assignments = db
    .prepare(`SELECT wa.*, p.name, p.full_name FROM week_assignments wa JOIN players p ON p.id = wa.player_id WHERE wa.week_id = ? ORDER BY p.name`)
    .all(weekId);
  const assignmentIds = assignments.map((a) => a.id);
  const swapMap = swapsAffectingAssignments(assignmentIds);
  const subNameByParentId = resolveSubNames(assignments);

  const confirmed = [];
  const unconfirmed = [];
  const needsSub = [];
  const subbedOut = [];

  for (const a of assignments) {
    const displayName = fullName(a);
    if (a.status === 'confirmed') {
      if (a.is_sub) {
        confirmed.push(`${displayName} (sub)`);
      } else if (swapMap.has(a.id)) {
        const info = swapMap.get(a.id);
        confirmed.push(`${displayName} (via swap with ${info.otherName}${info.otherDate ? `, who was playing ${email.fmtDate(info.otherDate)}` : ''})`);
      } else {
        confirmed.push(displayName);
      }
    } else if (a.status === 'scheduled') {
      unconfirmed.push(displayName);
    } else if (a.status === 'needs_sub') {
      const sr = db
        .prepare(`SELECT * FROM sub_requests WHERE week_assignment_id = ? ORDER BY id DESC LIMIT 1`)
        .get(a.id);
      let label = 'request open';
      if (sr && sr.status === 'escalated') label = 'escalated to the sub list';
      else if (sr && sr.status === 'unfilled') label = 'UNFILLED';
      needsSub.push(`${displayName} (${label})`);
    } else if (a.status === 'subbed_out') {
      const subName = subNameByParentId.get(a.id) || null;
      subbedOut.push(subName ? `${displayName} — replaced by ${subName}` : `${displayName} — replaced by a sub`);
    }
  }

  const ballDuty = week.ball_duty_player_id
    ? db.prepare('SELECT name, full_name FROM players WHERE id = ?').get(week.ball_duty_player_id)
    : null;

  return {
    week,
    session,
    confirmed,
    unconfirmed,
    needsSub,
    subbedOut,
    ballDutyName: ballDuty ? fullName(ballDuty) : null,
    activeCount: assignments.filter((a) => a.status !== 'subbed_out').length,
    playersPerWeek: session.players_per_week,
    needsAttention: !!week.needs_attention,
    notes: week.notes,
  };
}

/** Sends the report for one week to every address configured on its session
 * (comma-separated `admin_report_emails`). By default, skips anyone already
 * sent to for this exact week — same email_log-based dedup as every other
 * reminder-ish email in this app, which is what makes it safe for the
 * automatic cron pass (cron.js's processAdminReports(), which runs every
 * 60s and would otherwise re-send on every tick) to call this repeatedly.
 *
 * `force: true` (Kyle, 2026-09-09: "I want to make sure this fires off a new
 * status report every single time it's pushed... it should fire to the
 * admin status report email and report on what the latest status is in
 * that moment in time") bypasses that dedup check entirely — used only by
 * the admin's own manual "Send status report now" button, which should
 * always send a fresh snapshot on every click, not just the first click
 * after the automatic threshold passes. buildWeekReport() above already
 * recomputes live from the current week_assignments/sub_requests/
 * swap_requests rows on every call regardless of `force` — the dedup check
 * being bypassed is what was actually stopping a re-send from reaching the
 * admin's inbox, not stale data.
 *
 * A forced send is logged under a distinct 'admin_report_manual' category
 * (same trick as email.js's 'test' category for a template test send) — NOT
 * 'admin_report' — precisely so it can never satisfy the dedup check above.
 * Originally a manual send logged under the same 'admin_report' category as
 * the automatic one, which meant clicking "Send status report now" wrote a
 * row that then made the *automatic* pass at T-minus-admin_report_lead_hours
 * think it had already sent for that week/recipient and silently skip it —
 * a manual send would end up suppressing the real scheduled report instead
 * of just supplementing it (Kyle, 2026-09-09: reported the automated report
 * not firing after using the manual button).
 *
 * Returns how many were actually sent. */
async function sendReportForWeek(weekId, { force = false } = {}) {
  const report = buildWeekReport(weekId);
  const { session, week } = report;
  const recipients = (session.admin_report_emails || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let sentCount = 0;
  for (const to of recipients) {
    if (!force) {
      const already = db
        .prepare(`SELECT id FROM email_log WHERE category = 'admin_report' AND related_week_id = ? AND to_email = ?`)
        .get(week.id, to);
      if (already) continue;
    }
    await email.sendAdminWeekReport({ to, week, session, report, manual: force });
    sentCount++;
  }
  return sentCount;
}

module.exports = { buildWeekReport, sendReportForWeek };
