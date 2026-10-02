'use strict';
// Email Log grouping (Kyle, 2026-09-27): "when a player says they need a
// sub, the emails get sent initially to the roster... If nobody picks up
// that sub request, emails get sent to the broader sub list. I wonder if
// there is a way to group those emails together." Every email in one sub
// request's trail carries email_log.thread_key = 'sub:<sub_requests.id>'
// (see subFlow.js's subThreadKey()). This module turns a set of tagged rows
// into one displayable group: a header describing the request, and the
// emails split into steps in the order they happen — so the trail reads
// correctly even when steps went out in the same minute (a request made
// inside the escalation window emails the roster and the sub list together).
const db = require('../db');
const { fullName } = require('./playerName');
const subFlow = require('./subFlow');

const SUB_STAGES = [
  { key: 'request', label: 'Request', categories: ['sub_request_verification', 'found_sub_verification', 'sub_request_self_notice', 'self_arranged_sub_self_notice'] },
  { key: 'roster', label: 'Sent to the roster', categories: ['sub_request'] },
  { key: 'invite', label: 'Invite to the sub they named', categories: ['self_arranged_sub_invite'] },
  { key: 'followup', label: 'Reminders & warning', categories: ['self_arranged_sub_reminder', 'self_arranged_requester_reminder', 'self_arranged_warning'] },
  { key: 'sublist', label: 'Escalated to the sub list', categories: ['escalation', 'self_arranged_escalated'] },
  { key: 'admin', label: 'Admin alert', categories: ['new_sub_list_entry_alert', 'self_arranged_late_alert'] },
  { key: 'stillopen', label: 'Still open', categories: ['sub_still_open', 'sub_still_open_admin'] },
  { key: 'confirmed', label: 'Sub confirmed', categories: ['sub_filled', 'sub_filled_original'] },
];
const STAGE_BY_CATEGORY = new Map();
SUB_STAGES.forEach((st, i) => st.categories.forEach((c) => STAGE_BY_CATEGORY.set(c, i)));

const STATUS_LABELS = {
  open: 'open',
  escalated: 'escalated',
  unfilled: 'unfilled',
  filled: 'filled',
  resolved_manually: 'resolved by admin',
  resolved_double_booking: 'closed (double booking)',
  resolved_injury_return: 'closed (back from injury)',
};

function parseUtc(s) {
  return new Date(`${s.replace(' ', 'T')}Z`);
}

/** Header info for 'sub:<id>' — who asked, which match, current status, and
 * who ended up filling it (same resolver the Stats page's Sub History uses). */
function describeSubThread(subRequestId) {
  const r = db
    .prepare(
      `SELECT sr.id, sr.status, sr.self_arranged, sr.initiated_by,
              wa.id AS assignment_id, wa.week_id, wa.team, wa.court, wa.player_id AS current_player_id,
              w.match_date, w.session_id,
              p.id AS original_player_id, p.name AS p_name, p.full_name AS p_full_name
       FROM sub_requests sr
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id
       JOIN weeks w ON w.id = wa.week_id
       JOIN players p ON p.id = COALESCE(sr.requesting_player_id, wa.player_id)
       WHERE sr.id = ?`
    )
    .get(subRequestId);
  if (!r) return null;
  // Session fetched separately: joining s.* above would overwrite the
  // request's own id/status columns with the session's.
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(r.session_id);
  const weekAssignments = db
    .prepare('SELECT id, player_id, team, court, is_sub, replaces_assignment_id FROM week_assignments WHERE week_id = ?')
    .all(r.week_id);
  const fillerId = subFlow.resolveSubRequestFiller({
    assignmentId: r.assignment_id,
    team: r.team,
    court: r.court,
    currentPlayerId: r.current_player_id,
    originalPlayerId: r.original_player_id,
    weekAssignments,
    claimedFillerIds: new Set(),
  });
  const filler = fillerId != null && (r.status === 'filled' || r.status === 'resolved_manually')
    ? db.prepare('SELECT name, full_name FROM players WHERE id = ?').get(fillerId)
    : null;
  return {
    subRequestId: r.id,
    requester: fullName({ name: r.p_name, full_name: r.p_full_name }),
    matchDate: r.match_date,
    session,
    selfArranged: !!r.self_arranged,
    status: r.status,
    statusLabel: STATUS_LABELS[r.status] || r.status,
    filledBy: filler ? fullName(filler) : null,
  };
}

/** rows: already display-ready email_log rows (sent_at etc.) sharing one
 * thread_key. Returns the group object the view renders. */
function buildGroup(threadKey, rows) {
  const m = /^sub:(\d+)$/.exec(threadKey);
  const info = m ? describeSubThread(Number(m[1])) : null;
  const stages = SUB_STAGES.map((st) => ({ key: st.key, label: st.label, rows: [] }));
  const other = { key: 'other', label: 'Other', rows: [] };
  rows
    .slice()
    .sort((a, b) => (a.sent_at < b.sent_at ? -1 : a.sent_at > b.sent_at ? 1 : a.id - b.id))
    .forEach((r) => {
      const idx = STAGE_BY_CATEGORY.get(r.category);
      (idx != null ? stages[idx] : other).rows.push(r);
    });
  const usedStages = stages.concat([other]).filter((st) => st.rows.length);

  // Roster and sub list emailed within minutes of each other = the request
  // came in inside the escalation window, so the next cron tick escalated it
  // right away. Called out so the admin isn't left wondering why.
  let note = null;
  const roster = stages.find((st) => st.key === 'roster').rows;
  const sublist = stages.find((st) => st.key === 'sublist').rows;
  if (roster.length && sublist.length) {
    const gapMs = Math.abs(parseUtc(sublist[0].sent_at) - parseUtc(roster[0].sent_at));
    if (gapMs <= 10 * 60 * 1000) {
      note = 'The roster and the sub list were emailed within minutes of each other because the request came in inside the escalation window before the match.';
    }
  }
  const latest = rows.reduce((a, b) => (a.sent_at >= b.sent_at ? a : b));
  return {
    type: 'group',
    threadKey,
    domId: threadKey.replace(/[^a-z0-9]/gi, '-'),
    info,
    stages: usedStages,
    count: rows.length,
    latest,
    note,
  };
}

/** Turns a newest-first list of rows into display items: ungrouped rows stay
 * as-is, and each thread becomes one group placed where its newest email
 * falls in the list. */
function groupRows(rows) {
  const byKey = new Map();
  rows.forEach((r) => {
    if (!r.thread_key || !r.thread_key.startsWith('sub:')) return;
    if (!byKey.has(r.thread_key)) byKey.set(r.thread_key, []);
    byKey.get(r.thread_key).push(r);
  });
  const emitted = new Set();
  const items = [];
  rows.forEach((r) => {
    if (r.thread_key && byKey.has(r.thread_key)) {
      if (emitted.has(r.thread_key)) return;
      emitted.add(r.thread_key);
      items.push(buildGroup(r.thread_key, byKey.get(r.thread_key)));
    } else {
      items.push({ type: 'row', row: r });
    }
  });
  return items;
}

// Batch grouping (Kyle, 2026-09-29): consecutive plain rows (not part of a
// sub-request trail) with the same category and week, sent within 5 minutes
// of each other — a reminder batch, a "sub found" group notice, or a sub
// request from before trails were tagged — collapse into one 'batch' item.
// Same rule the Super Log uses. A lone email stays a plain row.
const BATCH_GAP_MS = 5 * 60 * 1000;
function collapseBatches(items) {
  const out = [];
  const ms = (r) => Date.parse(`${String(r.sent_at).replace(' ', 'T')}Z`);
  items.forEach((it) => {
    const last = out[out.length - 1];
    if (it.type === 'row' && last && (last.type === 'row' || last.type === 'batch')) {
      const lastRows = last.type === 'batch' ? last.rows : [last.row];
      const prev = lastRows[lastRows.length - 1];
      const r = it.row;
      if (prev.category === r.category && (prev.related_week_id || null) === (r.related_week_id || null)
          && Math.abs(ms(prev) - ms(r)) <= BATCH_GAP_MS) {
        if (last.type === 'row') {
          out[out.length - 1] = { type: 'batch', rows: [prev, r] };
        } else {
          last.rows.push(r);
        }
        return;
      }
    }
    out.push(it);
  });
  out.forEach((it, i) => {
    if (it.type !== 'batch') return;
    it.domId = `batch-${i}-${it.rows[0].id}`;
    it.latest = it.rows[0];
    it.category = it.rows[0].category;
    it.failed = it.rows.filter((r) => r.status === 'failed').length;
  });
  return out;
}

module.exports = { groupRows, collapseBatches, buildGroup, describeSubThread, SUB_STAGES };
