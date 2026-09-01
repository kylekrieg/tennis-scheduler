'use strict';
const crypto = require('crypto');
const db = require('../db');
const email = require('./email');
const subFlow = require('./subFlow');
const adminReport = require('./adminReport');

/**
 * Lets an admin fire any of the app's real email templates at a real roster
 * player, from the "Send Email" page, to confirm the template actually
 * renders and delivers correctly — Kyle, 2026-09-01: "Is there a way to send
 * test messages for all the email templates we've made?... if we wanted to
 * send a test email to confirm an email is working to someone on the
 * roster, we could."
 *
 * Two deliberate safety choices, both load-bearing:
 *
 * 1. Every send here goes through email.js's real template functions with
 *    `test: true`. That flag (see sendMail() in email.js) forces the
 *    category to a single fixed 'test' value and relatedWeekId to null
 *    before the email_log row is written — regardless of which real
 *    template/week/session the content was actually built from. Every
 *    cron dedup check (processReminders/processFollowUps/
 *    escalateOverdueRequests/etc.) keys its "already sent?" lookup on the
 *    *real* category + related_week_id + to_email, so a test send can never
 *    satisfy that lookup and silently suppress a real automatic reminder for
 *    the same player/week. The '[TEST] ' subject prefix + 'test' category
 *    also make it unmistakable on the Email Log page.
 *
 * 2. Every confirm/need-sub/claim/verify/respond/signup link inside a test
 *    email uses a fake, never-persisted token (fakeToken() below) — never a
 *    real one minted via tokenStore.js/adhocFlow.js. Clicking a link in a
 *    test email always lands on "Link not found" rather than actually
 *    confirming a slot, claiming a sub, or accepting a swap. This is what
 *    makes it safe to send a test about a player's real, current upcoming
 *    assignment: the email can accurately preview real content (their real
 *    match date, real teammates) with zero chance of a stray click causing a
 *    real side effect.
 *
 * Real second-party data (a "counterpart" player for swap/sub templates) is
 * drawn from other real active roster players so the preview reads
 * naturally — except sendSwapAcceptedNotice, which structurally emails two
 * different addresses in one call (initiator + target). To guarantee a test
 * send never reaches an uninvolved third party's real inbox without them
 * being the chosen test recipient, both "sides" of that one template use the
 * same real recipient email with a distinct display name for the other
 * party — see sendSwapAcceptedNotice's resolver below.
 */

function fakeToken() {
  return 'TEST-' + crypto.randomBytes(12).toString('hex');
}

/** Wraps a `players` row (id, name, email, slug) into the
 * `{ name, email, slug, player_id, id }` shape footer()/ballDutyNotice()
 * expect for a "player" argument — those helpers read `player.player_id`
 * (present on the real week_assignments-joined rows every real call site
 * passes), not `player.id`, which a plain `players` row uses instead. */
function asAssignmentShapedPlayer(p) {
  if (!p) return p;
  return { ...p, player_id: p.id };
}

/** The real player row a test is being sent to/about. */
function loadPlayer(playerId) {
  return db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
}

/** Up to `count` other real, active players — used for realistic-looking
 * "counterpart" names (a swap partner, a requesting player, a sub) that
 * never actually receive an email themselves in this flow (their name is
 * only ever interpolated as text, never used as a `to` address) except
 * where explicitly noted otherwise. */
function otherActivePlayers(excludePlayerId, count) {
  return db
    .prepare('SELECT * FROM players WHERE active = 1 AND id != ? ORDER BY name LIMIT ?')
    .all(excludePlayerId, count);
}

/** The player's own most relevant session + week, preferring a session
 * they're actually enrolled in (soonest upcoming week, falling back to the
 * most recent past week so a fully-completed season can still be used for a
 * test), and falling back to any session/week in the system at all if the
 * chosen player isn't enrolled anywhere yet — so a test send never simply
 * fails for a brand-new player with no schedule of their own. `sessionType`
 * optionally restricts to 'regular' or 'adhoc' (for templates that only
 * make sense in one or the other); omitted, any session type is fine. */
function findSessionAndWeek(playerId, sessionType) {
  const typeFilter = sessionType ? 'AND s.session_type = ?' : '';
  const args = sessionType ? [playerId, sessionType] : [playerId];

  const ownUpcoming = db
    .prepare(
      `SELECT w.*, s.* , w.id as week_id, s.id as session_id, w.match_date as week_match_date
       FROM session_players sp
       JOIN sessions s ON s.id = sp.session_id AND s.archived_at IS NULL ${typeFilter}
       JOIN weeks w ON w.session_id = s.id
       WHERE sp.player_id = ? AND w.match_date >= date('now')
       ORDER BY w.match_date LIMIT 1`
    )
    .get(...args);
  const row =
    ownUpcoming ||
    db
      .prepare(
        `SELECT w.*, s.*, w.id as week_id, s.id as session_id, w.match_date as week_match_date
         FROM session_players sp
         JOIN sessions s ON s.id = sp.session_id AND s.archived_at IS NULL ${typeFilter}
         JOIN weeks w ON w.session_id = s.id
         WHERE sp.player_id = ?
         ORDER BY w.match_date DESC LIMIT 1`
      )
      .get(...args) ||
    db
      .prepare(
        `SELECT w.*, s.*, w.id as week_id, s.id as session_id, w.match_date as week_match_date
         FROM weeks w JOIN sessions s ON s.id = w.session_id AND s.archived_at IS NULL ${typeFilter}
         ORDER BY w.match_date >= date('now') DESC, w.match_date LIMIT 1`
      )
      .get(...(sessionType ? [sessionType] : []));
  if (!row) return null;
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(row.week_id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(row.session_id);
  return { week, session };
}

/** A second, distinct week in the same session (for the two-date swap
 * templates) — the next upcoming week after `week`, or `week` itself again
 * if the session only has the one (still renders fine, just the same date
 * on both sides, which is an acceptable test-only artifact). */
function findSecondWeek(sessionId, excludeWeekId) {
  return (
    db
      .prepare('SELECT * FROM weeks WHERE session_id = ? AND id != ? ORDER BY match_date LIMIT 1')
      .get(sessionId, excludeWeekId) || db.prepare('SELECT * FROM weeks WHERE id = ?').get(excludeWeekId)
  );
}

const NEEDS_SESSION_WEEK = new Set([
  'sendConfirmationReminder',
  'sendFollowUpReminder',
  'sendSubRequestVerification',
  'sendSubRequestOwnConfirmation',
  'sendSubFilledOriginalNotice',
  'sendBlackoutNotice',
  'sendSubRequestFanout',
  'sendEscalationEmail',
  'sendSubFilledNotice',
  'sendSwapGroupNotice',
  'sendAdminWeekReport',
]);

/**
 * One entry per testable template: a short admin-facing label and a
 * `build(ctx)` function that returns the exact options object the matching
 * email.js function expects (plus `test: true`), given `ctx = { player,
 * session, week, others }` — `player` is the chosen roster row (the real
 * test recipient throughout), `others` is up to 3 other real active
 * players, `session`/`week` are the player's own real, most-relevant
 * schedule context (null if none could be found at all — see
 * findSessionAndWeek).
 */
const TEMPLATES = {
  reminder: {
    label: 'Confirmation reminder',
    fn: 'sendConfirmationReminder',
    build: (ctx) => ({
      player: asAssignmentShapedPlayer(ctx.player),
      week: ctx.week,
      session: ctx.session,
      confirmToken: fakeToken(),
      needSubToken: fakeToken(),
      upcomingWeeks: subFlow.upcomingWeeksPreview(ctx.session.id, ctx.week.match_date, 3),
      test: true,
    }),
  },
  follow_up: {
    label: 'Follow-up reminder',
    fn: 'sendFollowUpReminder',
    build: (ctx) => ({
      player: asAssignmentShapedPlayer(ctx.player),
      week: ctx.week,
      session: ctx.session,
      confirmToken: fakeToken(),
      needSubToken: fakeToken(),
      test: true,
    }),
  },
  sub_request_verification: {
    label: 'Sub request — "confirm it\'s you" gate',
    fn: 'sendSubRequestVerification',
    build: (ctx) => ({ player: ctx.player, week: ctx.week, session: ctx.session, needSubToken: fakeToken(), test: true }),
  },
  sub_request_self_notice: {
    label: 'Sub request — your own confirmation',
    fn: 'sendSubRequestOwnConfirmation',
    build: (ctx) => ({
      player: ctx.player,
      week: ctx.week,
      session: ctx.session,
      candidates: ctx.others,
      sessionSubs: subFlow.sessionSubList(ctx.session.id),
      test: true,
    }),
  },
  sub_filled_original: {
    label: 'Sub request — your spot got filled',
    fn: 'sendSubFilledOriginalNotice',
    build: (ctx) => ({
      recipient: ctx.player,
      week: ctx.week,
      session: ctx.session,
      subName: (ctx.others[0] && ctx.others[0].name) || 'Test Sub',
      test: true,
    }),
  },
  blackout_notice: {
    label: 'Blackout dates open — notify roster',
    fn: 'sendBlackoutNotice',
    build: (ctx) => ({ recipient: ctx.player, session: ctx.session, test: true }),
  },
  sub_request: {
    label: 'Sub needed — fan-out to candidates',
    fn: 'sendSubRequestFanout',
    build: (ctx) => ({
      recipient: ctx.player,
      week: ctx.week,
      session: ctx.session,
      claimToken: fakeToken(),
      requestingPlayerName: (ctx.others[0] && ctx.others[0].name) || 'Test Player',
      test: true,
    }),
  },
  escalation: {
    label: 'Sub still needed — escalation to sub list',
    fn: 'sendEscalationEmail',
    build: (ctx) => ({ recipient: ctx.player, week: ctx.week, session: ctx.session, claimToken: fakeToken(), test: true }),
  },
  sub_filled: {
    label: 'Sub confirmed — group notice',
    fn: 'sendSubFilledNotice',
    build: (ctx) => ({
      recipient: ctx.player,
      week: ctx.week,
      session: ctx.session,
      subName: (ctx.others[0] && ctx.others[0].name) || 'Test Sub',
      test: true,
    }),
  },
  swap_proposal_verification: {
    label: 'Swap — "confirm it\'s you" gate',
    fn: 'sendSwapProposalVerification',
    build: (ctx) => ({
      player: ctx.player,
      targetPlayer: ctx.others[0] || { name: 'Test Partner' },
      initiatorWeek: ctx.week,
      targetWeek: ctx.week2,
      session: ctx.session,
      verifyToken: fakeToken(),
      test: true,
    }),
  },
  swap_request: {
    label: 'Swap proposed — respond',
    fn: 'sendSwapRequestEmail',
    build: (ctx) => ({
      recipient: ctx.player,
      initiatorPlayer: ctx.others[0] || { name: 'Test Player' },
      initiatorWeek: ctx.week,
      targetWeek: ctx.week2,
      session: ctx.session,
      claimToken: fakeToken(),
      test: true,
    }),
  },
  swap_nudge: {
    label: 'Swap proposed — overdue nudge',
    fn: 'sendSwapNudge',
    build: (ctx) => ({
      recipient: ctx.player,
      initiatorPlayer: ctx.others[0] || { name: 'Test Player' },
      initiatorWeek: ctx.week,
      targetWeek: ctx.week2,
      session: ctx.session,
      claimToken: fakeToken(),
      test: true,
    }),
  },
  swap_proposed_self_notice: {
    label: 'Swap — your own proposal confirmation',
    fn: 'sendSwapProposedConfirmation',
    build: (ctx) => ({
      player: ctx.player,
      targetPlayer: ctx.others[0] || { name: 'Test Partner' },
      initiatorWeek: ctx.week,
      targetWeek: ctx.week2,
      session: ctx.session,
      test: true,
    }),
  },
  swap_declined: {
    label: 'Swap declined',
    fn: 'sendSwapDeclinedNotice',
    build: (ctx) => ({
      player: ctx.player,
      targetPlayer: ctx.others[0] || { name: 'Test Partner' },
      initiatorWeek: ctx.week,
      session: ctx.session,
      test: true,
    }),
  },
  swap_accepted: {
    label: 'Swap accepted',
    fn: 'sendSwapAcceptedNotice',
    build: (ctx) => ({
      // Both "sides" of this template use the same real recipient email —
      // see this file's own doc comment above for why: unlike every other
      // template here, sendSwapAcceptedNotice emails two different
      // addresses in one call, and a "test" must never reach a third party
      // who wasn't the one chosen on the Send Email page.
      initiatorPlayer: ctx.player,
      targetPlayer: { ...ctx.player, name: 'Test Partner' },
      initiatorWeek: ctx.week,
      targetWeek: ctx.week2,
      session: ctx.session,
      test: true,
    }),
  },
  swap_group_notice: {
    label: 'Swap — roster update for the group',
    fn: 'sendSwapGroupNotice',
    build: (ctx) => ({ recipient: ctx.player, week: ctx.week, session: ctx.session, test: true }),
  },
  adhoc_invite: {
    label: 'Ad-hoc — opening invite',
    fn: 'sendAdhocInvite',
    build: (ctx) => ({ recipient: ctx.player, week: ctx.week, session: ctx.session, signupToken: fakeToken(), test: true }),
  },
  adhoc_reminder: {
    label: 'Ad-hoc — still need players',
    fn: 'sendAdhocReminder',
    build: (ctx) => ({
      recipient: ctx.player,
      week: ctx.week,
      session: ctx.session,
      signupToken: fakeToken(),
      stillNeeded: 2,
      test: true,
    }),
  },
  adhoc_final: {
    label: "Ad-hoc — you're in (final roster)",
    fn: 'sendAdhocFinalRoster',
    build: (ctx) => ({
      recipient: ctx.player,
      week: ctx.week,
      session: ctx.session,
      teammates: ctx.others.length ? ctx.others : [{ name: 'Test Player' }],
      court: 1,
      test: true,
    }),
  },
  adhoc_not_enough: {
    label: 'Ad-hoc — not enough signed up',
    fn: 'sendAdhocNotEnough',
    build: (ctx) => ({ recipient: ctx.player, week: ctx.week, session: ctx.session, test: true }),
  },
  admin_report: {
    label: 'Admin pre-match status report',
    fn: 'sendAdminWeekReport',
    build: (ctx) => ({
      to: ctx.player.email,
      week: ctx.week,
      session: ctx.session,
      report: adminReport.buildWeekReport(ctx.week.id),
      test: true,
    }),
  },
};

function listTemplates() {
  return Object.keys(TEMPLATES).map((key) => ({ key, label: TEMPLATES[key].label }));
}

/** Sends a real template, in test mode, to a real roster player. Returns
 * `{ ok: true }` on success or `{ ok: false, error }` on a recognizable
 * failure (unknown template, unknown player, or no session/week data at all
 * to build the preview from — e.g. a brand-new install with nothing
 * scheduled yet). Never throws for those expected cases; a genuine bug in a
 * template's own render code still propagates like any other exception, the
 * same as a real send would. */
async function sendTestEmail(templateKey, playerId) {
  const tpl = TEMPLATES[templateKey];
  if (!tpl) return { ok: false, error: 'Unknown template.' };
  const player = loadPlayer(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };

  let ctx = { player, others: otherActivePlayers(player.id, 3) };

  if (NEEDS_SESSION_WEEK.has(tpl.fn) || tpl.fn.startsWith('sendSwap') || tpl.fn.startsWith('sendAdhoc')) {
    const sessionType = tpl.fn.startsWith('sendAdhoc') ? 'adhoc' : null;
    const found = findSessionAndWeek(player.id, sessionType) || findSessionAndWeek(player.id, null);
    if (!found) {
      return {
        ok: false,
        error:
          sessionType === 'adhoc'
            ? 'No ad-hoc session with any scheduled week exists yet — nothing to build a preview from.'
            : 'No session with any scheduled week exists yet — nothing to build a preview from.',
      };
    }
    ctx.session = found.session;
    ctx.week = found.week;
    if (tpl.fn.startsWith('sendSwap')) {
      ctx.week2 = findSecondWeek(found.session.id, found.week.id);
    }
  }

  const args = tpl.build(ctx);
  const result = await email[tpl.fn](args);
  return { ok: !!result, error: result ? null : 'Send failed — see the Email Log for details.' };
}

module.exports = { listTemplates, sendTestEmail, TEMPLATES };
