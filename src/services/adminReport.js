'use strict';
const db = require('../db');
const email = require('./email');
const subFlow = require('./subFlow');

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

/** For a claimed sub_offers row, resolves the actual player who ended up in
 * the seat — either an existing roster player (candidate_player_id) or
 * someone claimed from the broader sub list, who claimSub() creates/reuses
 * a real players row for by email but never writes back onto the offer row
 * itself, so this has to redo that same email lookup rather than trusting
 * candidate_player_id to always be set. */
function resolveOfferPlayerName(offer) {
  if (!offer) return null;
  if (offer.candidate_player_id) {
    const p = db.prepare('SELECT name FROM players WHERE id = ?').get(offer.candidate_player_id);
    return p ? p.name : null;
  }
  if (offer.broader_list_id) {
    const bl = db.prepare('SELECT * FROM broader_sub_list WHERE id = ?').get(offer.broader_list_id);
    if (!bl) return null;
    const p = db.prepare('SELECT name FROM players WHERE email = ?').get(bl.email);
    return p ? p.name : bl.name;
  }
  return null;
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
      const otherPlayer = db.prepare('SELECT name FROM players WHERE id = ?').get(sw.initiator_player_id);
      map.set(sw.initiator_assignment_id, {
        otherName: otherPlayer ? otherPlayer.name : 'someone',
        otherDate: otherWeek ? otherWeek.match_date : null,
      });
    }
    if (assignmentIds.includes(sw.target_assignment_id)) {
      const otherWeek = db
        .prepare(`SELECT w.match_date FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id WHERE wa.id = ?`)
        .get(sw.initiator_assignment_id);
      const otherPlayer = db.prepare('SELECT name FROM players WHERE id = ?').get(sw.target_player_id);
      map.set(sw.target_assignment_id, {
        otherName: otherPlayer ? otherPlayer.name : 'someone',
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
    .prepare(`SELECT wa.*, p.name FROM week_assignments wa JOIN players p ON p.id = wa.player_id WHERE wa.week_id = ? ORDER BY p.name`)
    .all(weekId);
  const assignmentIds = assignments.map((a) => a.id);
  const swapMap = swapsAffectingAssignments(assignmentIds);

  const confirmed = [];
  const unconfirmed = [];
  const needsSub = [];
  const subbedOut = [];

  for (const a of assignments) {
    if (a.status === 'confirmed') {
      if (a.is_sub) {
        confirmed.push(`${a.name} (sub)`);
      } else if (swapMap.has(a.id)) {
        const info = swapMap.get(a.id);
        confirmed.push(`${a.name} (via swap with ${info.otherName}${info.otherDate ? `, who was playing ${email.fmtDate(info.otherDate)}` : ''})`);
      } else {
        confirmed.push(a.name);
      }
    } else if (a.status === 'scheduled') {
      unconfirmed.push(a.name);
    } else if (a.status === 'needs_sub') {
      const sr = db
        .prepare(`SELECT * FROM sub_requests WHERE week_assignment_id = ? ORDER BY id DESC LIMIT 1`)
        .get(a.id);
      let label = 'request open';
      if (sr && sr.status === 'escalated') label = 'escalated to the sub list';
      else if (sr && sr.status === 'unfilled') label = 'UNFILLED';
      needsSub.push(`${a.name} (${label})`);
    } else if (a.status === 'subbed_out') {
      const sr = db
        .prepare(`SELECT * FROM sub_requests WHERE week_assignment_id = ? ORDER BY id DESC LIMIT 1`)
        .get(a.id);
      let subName = null;
      if (sr && sr.status === 'filled') {
        const offer = db.prepare(`SELECT * FROM sub_offers WHERE sub_request_id = ? AND status = 'claimed'`).get(sr.id);
        subName = resolveOfferPlayerName(offer);
      }
      subbedOut.push(subName ? `${a.name} — replaced by ${subName}` : `${a.name} — replaced by a sub`);
    }
  }

  const ballDuty = week.ball_duty_player_id
    ? db.prepare('SELECT name FROM players WHERE id = ?').get(week.ball_duty_player_id)
    : null;

  return {
    week,
    session,
    confirmed,
    unconfirmed,
    needsSub,
    subbedOut,
    ballDutyName: ballDuty ? ballDuty.name : null,
    activeCount: assignments.filter((a) => a.status !== 'subbed_out').length,
    playersPerWeek: session.players_per_week,
    needsAttention: !!week.needs_attention,
    notes: week.notes,
  };
}

/** Sends the report for one week to every address configured on its session
 * (comma-separated `admin_report_emails`), skipping anyone already sent to
 * for this exact week — same email_log-based dedup as every other
 * reminder-ish email in this app, which is what makes this safe to call
 * more than once (the automatic cron pass and the admin's own manual
 * "Send status report now" button share this one function, same pattern as
 * cron.js's sendRemindersNowForWeek). Returns how many were actually sent. */
async function sendReportForWeek(weekId) {
  const report = buildWeekReport(weekId);
  const { session, week } = report;
  const recipients = (session.admin_report_emails || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let sentCount = 0;
  for (const to of recipients) {
    const already = db
      .prepare(`SELECT id FROM email_log WHERE category = 'admin_report' AND related_week_id = ? AND to_email = ?`)
      .get(week.id, to);
    if (already) continue;
    await email.sendAdminWeekReport({ to, week, session, report });
    sentCount++;
  }
  return sentCount;
}

module.exports = { buildWeekReport, sendReportForWeek };
