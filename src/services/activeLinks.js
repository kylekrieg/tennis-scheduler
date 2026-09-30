'use strict';
/**
 * Active Links (Kyle, 2026-09-30): "an admin should have the ability to
 * null and void any links that go out via email just to make sure a player
 * doesn't fill a sub list that shouldn't."
 *
 * Lists every emailed link that would still do something if clicked, and
 * cancels any of them. Only hashes are stored, so the links themselves
 * can't be shown — just who has one and what it does. Scoped to
 * non-archived sessions and weeks that haven't locked yet (a locked week's
 * links already stop working — see tokenStore.findAssignmentByToken and
 * cron's processWeekLocking).
 *
 * Kinds (what cancelLink() takes):
 *   sub_offer   one sub_offers row -> status 'closed' (claimSub only accepts
 *               'pending'). Closed offers still count as "already offered",
 *               so a later escalation won't re-invite that person.
 *   sub_request every pending offer on one request, same as above. The
 *               request itself stays open — use "Clear sub request" on the
 *               session page to call the whole thing off.
 *   assignment  every confirm / need-a-sub / "I found a sub" link for one
 *               player's spot (week_assignment_tokens). "Resend link" issues
 *               a fresh one if needed.
 *   swap        a pending swap request -> 'cancelled'.
 *   swap_verify an unclicked "confirm it's you" swap proposal link.
 *   adhoc       a pickup-game "I'm in" link; also marks the straggler
 *               reminder as sent so the cron doesn't issue a new link.
 *   other_dates a My Page "My Other Dates" edit link.
 */
const db = require('../db');
const { generateRawToken, hashToken } = require('./tokens');
const { utcToZonedParts } = require('./tz');
const { getTimezone } = require('./settings');
const { fullName } = require('./playerName');
const email = require('./email');

function when(utcStr) {
  if (!utcStr) return '';
  const d = new Date(String(utcStr).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  const p = utcToZonedParts(d, getTimezone());
  return `${email.fmtDate(p.date)}, ${email.fmtTime(p.time)}`;
}

const SOURCE_LABEL = {
  roster: 'Sub request (roster)',
  self_arranged: '"I found a sub" invite',
  escalation: 'Sub request (sub list)',
};

function listActiveLinks(sessionId = null) {
  const sessFilter = sessionId ? 'AND s.id = ?' : '';
  const sessArgs = sessionId ? [Number(sessionId)] : [];
  const sessions = new Map(db.prepare('SELECT * FROM sessions').all().map((s) => [s.id, s]));

  const subRows = db
    .prepare(
      `SELECT o.id, o.source, o.candidate_player_id, o.broader_list_id, o.nudge_token,
              sr.id AS request_id, sr.status AS request_status, sr.created_at, sr.escalated_at, sr.self_arranged,
              w.id AS week_id, w.match_date, s.id AS session_id,
              op.name AS orig_name, op.full_name AS orig_full_name,
              cp.name AS cand_name, cp.full_name AS cand_full_name, bl.name AS bl_name,
              (SELECT MIN(id) FROM sub_offers o2 WHERE o2.sub_request_id = sr.id) AS first_offer_id
       FROM sub_offers o
       JOIN sub_requests sr ON sr.id = o.sub_request_id
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       JOIN players op ON op.id = wa.player_id
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       LEFT JOIN players cp ON cp.id = o.candidate_player_id
       LEFT JOIN broader_sub_list bl ON bl.id = o.broader_list_id
       WHERE o.status = 'pending' AND sr.status IN ('open', 'escalated', 'unfilled')
         AND w.locked = 0 AND s.archived_at IS NULL ${sessFilter}
       ORDER BY w.match_date, sr.id, o.id`
    )
    .all(...sessArgs);
  const requests = new Map();
  for (const r of subRows) {
    if (!requests.has(r.request_id)) {
      requests.set(r.request_id, {
        id: r.request_id,
        status: r.request_status,
        matchDate: r.match_date,
        session: sessions.get(r.session_id),
        forName: fullName({ name: r.orig_name, full_name: r.orig_full_name }),
        offers: [],
      });
    }
    let source = r.source;
    if (!source) source = r.self_arranged && r.id === r.first_offer_id ? 'self_arranged' : r.broader_list_id ? 'escalation' : 'roster';
    requests.get(r.request_id).offers.push({
      id: r.id,
      kind: SOURCE_LABEL[source] || 'Sub request',
      name: r.candidate_player_id ? fullName({ name: r.cand_name, full_name: r.cand_full_name }) : r.bl_name || '(unknown)',
      sent: when(source === 'escalation' ? r.escalated_at || r.created_at : r.created_at),
      twoLinks: !!r.nudge_token,
    });
  }

  const assignmentLinks = db
    .prepare(
      `SELECT wa.id, wa.status, w.match_date, s.id AS session_id, p.name, p.full_name,
              COUNT(t.id) AS n, MAX(t.created_at) AS last_created
       FROM week_assignment_tokens t
       JOIN week_assignments wa ON wa.id = t.week_assignment_id
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       JOIN players p ON p.id = wa.player_id
       WHERE w.locked = 0 AND s.archived_at IS NULL ${sessFilter}
       GROUP BY wa.id
       ORDER BY w.match_date, p.name`
    )
    .all(...sessArgs)
    .map((r) => ({ id: r.id, status: r.status, matchDate: r.match_date, session: sessions.get(r.session_id), name: fullName(r), count: r.n, last: when(r.last_created) }));

  const swaps = db
    .prepare(
      `SELECT sw.id, sw.created_at, sw.nudged_at, ip.name AS i_name, ip.full_name AS i_full, tp.name AS t_name, tp.full_name AS t_full,
              iw.match_date AS i_date, tw.match_date AS t_date, s.id AS session_id
       FROM swap_requests sw
       JOIN week_assignments ia ON ia.id = sw.initiator_assignment_id
       JOIN week_assignments ta ON ta.id = sw.target_assignment_id
       JOIN weeks iw ON iw.id = ia.week_id
       JOIN weeks tw ON tw.id = ta.week_id
       JOIN sessions s ON s.id = iw.session_id
       LEFT JOIN players ip ON ip.id = sw.initiator_player_id
       JOIN players tp ON tp.id = sw.target_player_id
       WHERE sw.status = 'pending' AND s.archived_at IS NULL ${sessFilter}
       ORDER BY sw.created_at`
    )
    .all(...sessArgs)
    .map((r) => ({
      id: r.id,
      session: sessions.get(r.session_id),
      from: r.i_name ? fullName({ name: r.i_name, full_name: r.i_full }) : '(unknown)',
      to: fullName({ name: r.t_name, full_name: r.t_full }),
      giveDate: r.i_date,
      takeDate: r.t_date,
      sent: when(r.created_at),
      nudged: !!r.nudged_at,
    }));

  const swapVerifications = db
    .prepare(
      `SELECT v.id, v.created_at, p.name, p.full_name, w.match_date, s.id AS session_id
       FROM swap_proposal_verifications v
       JOIN week_assignments wa ON wa.id = v.initiator_assignment_id
       JOIN players p ON p.id = wa.player_id
       JOIN weeks w ON w.id = wa.week_id
       JOIN sessions s ON s.id = w.session_id
       WHERE w.locked = 0 AND s.archived_at IS NULL ${sessFilter}
       ORDER BY v.created_at`
    )
    .all(...sessArgs)
    .map((r) => ({ id: r.id, name: fullName(r), matchDate: r.match_date, session: sessions.get(r.session_id), sent: when(r.created_at) }));

  const adhoc = db
    .prepare(
      `SELECT a.id, a.invited_at, a.reminder_token, p.name, p.full_name, w.match_date, s.id AS session_id
       FROM adhoc_signups a
       JOIN players p ON p.id = a.player_id
       JOIN weeks w ON w.id = a.week_id
       JOIN sessions s ON s.id = w.session_id
       WHERE a.signed_up_at IS NULL AND a.token NOT LIKE 'void:%' AND w.locked = 0 AND s.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM week_assignments x WHERE x.week_id = w.id) ${sessFilter}
       ORDER BY w.match_date, p.name`
    )
    .all(...sessArgs)
    .map((r) => ({ id: r.id, name: fullName(r), matchDate: r.match_date, session: sessions.get(r.session_id), sent: when(r.invited_at), twoLinks: !!r.reminder_token }));

  // Not tied to a session, so only shown when no session filter is set.
  const otherDates = sessionId
    ? []
    : db
        .prepare(
          `SELECT t.id, t.created_at, t.expires_at, p.name, p.full_name FROM personal_event_tokens t
           JOIN players p ON p.id = t.player_id
           WHERE t.expires_at > ? ORDER BY t.created_at`
        )
        .all(new Date().toISOString())
        .map((r) => ({ id: r.id, name: fullName(r), sent: when(r.created_at), expires: when(r.expires_at.replace('T', ' ').slice(0, 19)) }));

  const subRequests = [...requests.values()];
  return {
    subRequests,
    assignmentLinks,
    swaps,
    swapVerifications,
    adhoc,
    otherDates,
    total:
      subRequests.reduce((n, r) => n + r.offers.length, 0) +
      assignmentLinks.length + swaps.length + swapVerifications.length + adhoc.length + otherDates.length,
  };
}

/** Cancel one link (or group). Returns { ok, description, sessionId } for
 * the activity log, or { ok: false } if it was already gone. */
function cancelLink(kind, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id)) return { ok: false };
  const sessionOfWeek = (weekId) => (db.prepare('SELECT session_id FROM weeks WHERE id = ?').get(weekId) || {}).session_id || null;

  if (kind === 'sub_offer' || kind === 'sub_request') {
    const offers = db
      .prepare(
        `SELECT o.*, wa.week_id, w.match_date, op.name AS orig_name, op.full_name AS orig_full,
                cp.name AS cand_name, cp.full_name AS cand_full, bl.name AS bl_name
         FROM sub_offers o JOIN sub_requests sr ON sr.id = o.sub_request_id
         JOIN week_assignments wa ON wa.id = sr.week_assignment_id
         JOIN weeks w ON w.id = wa.week_id
         JOIN players op ON op.id = wa.player_id
         LEFT JOIN players cp ON cp.id = o.candidate_player_id
         LEFT JOIN broader_sub_list bl ON bl.id = o.broader_list_id
         WHERE o.status = 'pending' AND ${kind === 'sub_offer' ? 'o.id = ?' : 'o.sub_request_id = ?'}`
      )
      .all(id);
    if (!offers.length) return { ok: false };
    const stmt = db.prepare("UPDATE sub_offers SET status = 'closed', responded_at = datetime('now') WHERE id = ? AND status = 'pending'");
    db.transaction(() => offers.forEach((o) => stmt.run(o.id)))();
    const o = offers[0];
    const forName = fullName({ name: o.orig_name, full_name: o.orig_full });
    const names = offers.map((x) => (x.candidate_player_id ? fullName({ name: x.cand_name, full_name: x.cand_full }) : x.bl_name)).join(', ');
    return {
      ok: true,
      sessionId: sessionOfWeek(o.week_id),
      description: `Cancelled ${offers.length} sub link(s) for ${forName}'s ${email.fmtDate(o.match_date)} spot (sent to ${names})`,
    };
  }

  if (kind === 'assignment') {
    const a = db
      .prepare(
        `SELECT wa.week_id, w.match_date, p.name, p.full_name, (SELECT COUNT(*) FROM week_assignment_tokens t WHERE t.week_assignment_id = wa.id) AS n
         FROM week_assignments wa JOIN weeks w ON w.id = wa.week_id JOIN players p ON p.id = wa.player_id WHERE wa.id = ?`
      )
      .get(id);
    if (!a || !a.n) return { ok: false };
    db.prepare('DELETE FROM week_assignment_tokens WHERE week_assignment_id = ?').run(id);
    return {
      ok: true,
      sessionId: sessionOfWeek(a.week_id),
      description: `Cancelled ${a.n} confirm / need-a-sub link(s) for ${fullName(a)}'s ${email.fmtDate(a.match_date)} spot`,
    };
  }

  if (kind === 'swap') {
    const sw = db
      .prepare(
        `SELECT sw.*, ia.week_id, ip.name AS i_name, ip.full_name AS i_full, tp.name AS t_name, tp.full_name AS t_full
         FROM swap_requests sw JOIN week_assignments ia ON ia.id = sw.initiator_assignment_id
         LEFT JOIN players ip ON ip.id = sw.initiator_player_id JOIN players tp ON tp.id = sw.target_player_id
         WHERE sw.id = ? AND sw.status = 'pending'`
      )
      .get(id);
    if (!sw) return { ok: false };
    db.prepare("UPDATE swap_requests SET status = 'cancelled', responded_at = datetime('now') WHERE id = ?").run(id);
    return {
      ok: true,
      sessionId: sessionOfWeek(sw.week_id),
      description: `Cancelled the pending swap from ${fullName({ name: sw.i_name || '(unknown)', full_name: sw.i_full })} to ${fullName({ name: sw.t_name, full_name: sw.t_full })}`,
    };
  }

  if (kind === 'swap_verify') {
    const v = db
      .prepare(
        `SELECT v.*, wa.week_id, p.name, p.full_name FROM swap_proposal_verifications v
         JOIN week_assignments wa ON wa.id = v.initiator_assignment_id JOIN players p ON p.id = wa.player_id WHERE v.id = ?`
      )
      .get(id);
    if (!v) return { ok: false };
    db.prepare('DELETE FROM swap_proposal_verifications WHERE id = ?').run(id);
    return { ok: true, sessionId: sessionOfWeek(v.week_id), description: `Cancelled ${fullName(v)}'s unconfirmed swap-proposal link` };
  }

  if (kind === 'adhoc') {
    const a = db
      .prepare(`SELECT a.*, w.match_date, w.session_id, p.name, p.full_name FROM adhoc_signups a JOIN weeks w ON w.id = a.week_id JOIN players p ON p.id = a.player_id WHERE a.id = ? AND a.signed_up_at IS NULL`)
      .get(id);
    if (!a || String(a.token).startsWith('void:')) return { ok: false };
    // token is NOT NULL UNIQUE, so replace it with an unguessable value no
    // link hashes to; reminded_at stops the cron minting a new reminder link.
    db.prepare(
      "UPDATE adhoc_signups SET token = ?, reminder_token = NULL, reminded_at = COALESCE(reminded_at, datetime('now')) WHERE id = ?"
    ).run('void:' + hashToken(generateRawToken()), id);
    return { ok: true, sessionId: a.session_id, description: `Cancelled ${fullName(a)}'s pickup-game sign-up link for ${email.fmtDate(a.match_date)}` };
  }

  if (kind === 'other_dates') {
    const t = db.prepare('SELECT t.*, p.name, p.full_name FROM personal_event_tokens t JOIN players p ON p.id = t.player_id WHERE t.id = ?').get(id);
    if (!t) return { ok: false };
    db.prepare('DELETE FROM personal_event_tokens WHERE id = ?').run(id);
    return { ok: true, sessionId: null, description: `Cancelled ${fullName(t)}'s "My Other Dates" edit link` };
  }

  return { ok: false };
}

module.exports = { listActiveLinks, cancelLink };
