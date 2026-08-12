'use strict';
const nodemailer = require('nodemailer');
const db = require('../db');

let transport = null;
function getTransport() {
  if (transport) return transport;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.warn(
      '[email] GMAIL_USER / GMAIL_APP_PASSWORD not set — emails will be logged to the console instead of sent.'
    );
    transport = null;
    return null;
  }
  transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  return transport;
}

function siteUrl() {
  return (process.env.PUBLIC_SITE_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * Wraps every outgoing email's body in a single consistent container with an
 * explicit font-size/line-height/family, applied centrally here rather than
 * repeated in each template. Before this, no template set a font-size on its
 * `<p>` content at all — every email relied on the recipient's mail client's
 * own default for an unstyled `<p>`, which reads noticeably small in several
 * common clients (particularly Gmail's mobile app). Inline styles are the
 * only thing reliably honored across mail clients (many strip `<style>`
 * blocks entirely), so this has to be an inline style on a wrapping element,
 * not a stylesheet. `footer()`'s deliberately smaller 12px club/court and
 * "Full schedule" lines still render smaller than this, since an inline
 * style on a child element always wins over the inherited size from this
 * wrapper. Kyle, 2026-08-12: "I feel like the font is too small in the body
 * of the email when sending out reminders and confirmation emails."
 */
function wrapEmailHtml(innerHtml) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:17px;line-height:1.6;color:#1a1a1a;max-width:600px;">${innerHtml}</div>`;
}

/**
 * Sends an email and always writes an email_log row, regardless of whether
 * SMTP is configured (so the admin dashboard's activity log works in dev too).
 * Gmail SMTP does not reliably surface bounces — see Technical_Architecture.md
 * §10 — so this function's success/failure only reflects submission to Gmail,
 * not final delivery. The admin "unconfirmed" dashboard flag is the intended
 * indirect signal for a bad address.
 */
async function sendMail({ to, subject, html, text, category, relatedWeekId = null, session = null }) {
  // Club name is per-session (a single install can run sessions for
  // different clubs/locations) — every template passes its `session` through
  // here so the subject prefix is correct without each one repeating this
  // logic. `session` is null for emails with no session context (e.g. the
  // admin's freeform custom email), which just means no prefix.
  const club = session && session.club_name;
  const finalSubject = club ? `${club} — ${subject}` : subject;

  const t = getTransport();
  let status = 'sent';
  try {
    if (t) {
      await t.sendMail({
        from: process.env.GMAIL_USER,
        to,
        subject: finalSubject,
        html: wrapEmailHtml(html),
        text: text || html.replace(/<[^>]+>/g, ' '),
      });
      status = 'sent';
    } else {
      console.log(`\n[email:${category}] (not sent — no SMTP configured) to=${to} subject="${finalSubject}"\n${text || ''}\n`);
      status = 'logged_dev_mode';
    }
    db.prepare(
      'INSERT INTO email_log (to_email, subject, category, status, related_week_id) VALUES (?, ?, ?, ?, ?)'
    ).run(to, finalSubject, category, status, relatedWeekId);
    return true;
  } catch (err) {
    console.error(`[email] failed to send to ${to}:`, err.message);
    db.prepare(
      'INSERT INTO email_log (to_email, subject, category, status, related_week_id) VALUES (?, ?, ?, ?, ?)'
    ).run(to, finalSubject, category, 'failed', relatedWeekId);
    return false;
  }
}

function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Converts a stored 'HH:MM' 24h wall-clock string (match_time, reminder_time)
 * into a friendly 12-hour display string, e.g. '19:15' -> '7:15 PM'. Used
 * everywhere a time is shown to a player or admin so nobody has to do the
 * 24-hour math themselves. */
function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/** "6:00 PM, Court 3" (or just "6:00 PM" if the session has no court/location
 * text set) — the match time + place, for dropping into the subject line of
 * match-day emails (reminder, follow-up, sub request/escalation/filled) so a
 * player can tell when and where without opening the email. Deliberately
 * separate from footer()'s club/court line below, which is body content, not
 * subject content. Only used where a specific match (a `week`) is actually
 * being talked about — blackout-date and freeform admin emails aren't about
 * one match, so they don't call this. */
function timeAndPlace(session) {
  const bits = [fmtTime(session.match_time)];
  if (session.court_info) bits.push(session.court_info);
  return bits.join(', ');
}

/**
 * "Session name — Club, Court" for every player-facing surface where a
 * player needs to tell two same-day, same-club sessions apart at a glance —
 * the session picker dropdown, page headers, the PDF, calendar (ICS) event
 * titles. Kyle's call (2026-08-11): rather than adding a separate
 * player-facing "display name" field to maintain, derive this directly from
 * the Club/Court fields every session already has, so it can never drift out
 * of sync with the real court. Falls back to the bare name if neither is
 * set. Deliberately NOT used on admin-facing pages (dashboard, session
 * detail/edit, stats, activity/email log, status page) — those keep showing
 * the admin's own internal session name unchanged, since that's the
 * organizational label that makes sense in that context.
 */
function sessionPublicLabel(session) {
  if (!session) return '';
  const bits = [session.club_name, session.court_info].filter(Boolean);
  return bits.length ? `${session.name} — ${bits.join(', ')}` : session.name;
}

// A fixed, hand-picked palette rather than generating arbitrary colors —
// every entry is distinct enough at a glance and reads fine as both a small
// dot and a colored left-border/banner, in both light and dark mode (all
// mid-saturation, avoids anything too close to the app's own green/red
// accent colors used for confirmed/needs_sub badges elsewhere, so a session
// color is never mistaken for a status indicator).
const SESSION_COLOR_PALETTE = ['#0969da', '#b42318', '#8250df', '#0891b2', '#bf6a02', '#c2255c', '#1a7f37', '#4d5bce'];

/**
 * A consistent color for a session, used everywhere a player needs to tell
 * two sessions apart at a glance rather than by reading text — the session
 * switcher banner, page headers, and match-day email banners. Kyle,
 * 2026-08-12: two sessions at the same club, same day, same time (e.g. Court
 * 2 vs. Court 4) are easy to mix up from text alone ("it's very easy for
 * someone to get confused and ask for a sub for court 2 when they really
 * meant court 4"); colors are recognized faster than reading, so this is
 * meant to become a reliable shortcut ("the blue one") once a player learns
 * it, on top of the existing sessionPublicLabel() text.
 *
 * Returns `session.color` (a hex string) if the admin explicitly set one on
 * the session's Edit page; otherwise falls back to a deterministic pick from
 * `SESSION_COLOR_PALETTE` keyed by session id, so every session always has
 * *some* stable color — including every session that existed before this
 * field was added — without the admin having to configure anything.
 * Deterministic (not random) so the same session always renders the same
 * color across every page load and every email, with nothing to invalidate.
 */
function sessionColor(session) {
  if (!session) return SESSION_COLOR_PALETTE[0];
  if (session.color) return session.color;
  const id = Number(session.id) || 0;
  return SESSION_COLOR_PALETTE[id % SESSION_COLOR_PALETTE.length];
}

/**
 * A colored banner dropped at the very top of every match-specific email
 * body — before the "Hi <name>," greeting, so it's the first thing seen —
 * showing the session's color (see sessionColor()), full disambiguated name,
 * and the specific date/time/court in bold. Court/time already appeared in
 * the subject line via timeAndPlace() (see "Match-day email subjects include
 * time + court" in CLAUDE.md), but a subject line is easy to skim past once
 * an email is open; Kyle asked (2026-08-12) for the body itself to make it
 * unmissable which of two same-club, same-time sessions (e.g. Court 2 vs.
 * Court 4) a given email is actually about, on top of the color-coding used
 * on the site's own session switcher. Every color/style is inline, same
 * reasoning as wrapEmailHtml() — mail clients don't reliably honor
 * stylesheets.
 */
function matchBanner(session, week) {
  const color = sessionColor(session);
  const dateLine = week ? `${fmtDate(week.match_date)} · ${timeAndPlace(session)}` : timeAndPlace(session);
  return `<div style="background:${color}1a;border-left:5px solid ${color};border-radius:6px;padding:10px 14px;margin-bottom:16px;">
    <div style="font-weight:700;font-size:18px;color:#1a1a1a;">${sessionPublicLabel(session)}</div>
    <div style="font-size:15px;color:#444;margin-top:2px;">${dateLine}</div>
  </div>`;
}

function footer(session) {
  const club = session && session.club_name;
  const court = session && session.court_info;
  const clubLine =
    club || court
      ? `<p style="color:#888;font-size:12px;margin:0 0 4px;">${[club, court].filter(Boolean).join(' — ')}</p>`
      : '';
  return `${clubLine}<p style="color:#888;font-size:12px;margin-top:24px;">Full schedule: <a href="${siteUrl()}/schedule">${siteUrl()}/schedule</a></p>`;
}

/** A direct callout for the recipient when *they* are the one on ball duty
 * for the match this email is about — distinct from nextWeeksPreviewHtml's
 * list, which only shows ball duty for *other*, later weeks. Compares
 * player_id (present on both the week_assignments-joined recipient rows and
 * the admin resend route's `assignment` row) against week.ball_duty_player_id. */
function ballDutyNotice(player, week) {
  if (!player || !week || player.player_id !== week.ball_duty_player_id) return '';
  return `<p class="flag" style="border:1px solid #ffd77a;background:#fff8e6;border-radius:8px;padding:10px 14px;margin:12px 0;"><strong>You're on ball duty this week</strong> — please bring the balls.</p>`;
}

/** Who's actually playing this specific week (current roster) plus who has
 * ball duty, formatted for sub-related emails so a potential sub — or the
 * group once a sub is confirmed — has some context on who else will be
 * there. Queries fresh at send time rather than trusting the caller's
 * `week` object, which can be stale: e.g. createSubRequest() fetches `week`
 * before nulling out ball_duty_player_id when the player needing a sub was
 * themselves on ball duty, so re-querying here avoids showing a ball-duty
 * person who's actually the one being subbed out. Filters to
 * scheduled/confirmed only, so it naturally excludes whoever currently
 * needs a sub (status 'needs_sub') and, for the sub-filled notice sent
 * right after claimSub() commits, correctly shows the new sub in and the
 * original player out. */
function currentWeekRosterHtml(week) {
  const players = db
    .prepare(
      `SELECT p.name, wa.is_sub FROM week_assignments wa JOIN players p ON p.id = wa.player_id
       WHERE wa.week_id = ? AND wa.status IN ('scheduled', 'confirmed') ORDER BY p.name`
    )
    .all(week.id);
  if (!players.length) return '';
  const names = players.map((p) => p.name + (p.is_sub ? ' (sub)' : '')).join(', ');
  const freshWeek = db.prepare('SELECT ball_duty_player_id FROM weeks WHERE id = ?').get(week.id);
  const ballDuty =
    freshWeek && freshWeek.ball_duty_player_id
      ? db.prepare('SELECT name FROM players WHERE id = ?').get(freshWeek.ball_duty_player_id)
      : null;
  return `<p style="margin:12px 0;"><strong>Playing that week:</strong> ${names}${ballDuty ? `<br><strong>Bringing balls:</strong> ${ballDuty.name}` : ''}</p>`;
}

function nextWeeksPreviewHtml(weeks) {
  if (!weeks.length) return '';
  const rows = weeks
    .map((w) => `<li>${fmtDate(w.match_date)} — ${w.players.map((p) => p.name).join(', ')}${w.ballDutyName ? ` (ball duty: ${w.ballDutyName})` : ''}</li>`)
    .join('');
  return `<p><strong>Next few weeks:</strong></p><ul>${rows}</ul>`;
}

async function sendConfirmationReminder({ player, week, session, confirmToken, needSubToken, upcomingWeeks }) {
  const confirmUrl = `${siteUrl()}/confirm/${confirmToken}`;
  const needSubUrl = `${siteUrl()}/need-sub/${needSubToken}`;
  const subject = `Tennis ${fmtDate(week.match_date)}, ${timeAndPlace(session)} — please confirm`;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${player.name},</p>
    <p>You're scheduled to play doubles on <strong>${fmtDate(week.match_date)}</strong> at ${fmtTime(session.match_time)}.</p>
    <p>
      <a href="${confirmUrl}" style="display:inline-block;background:#1a7f37;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;margin-right:8px;">Confirm you're playing</a>
      <a href="${needSubUrl}" style="display:inline-block;background:#b42318;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Need a sub? Click here</a>
    </p>
    ${ballDutyNotice(player, week)}
    ${nextWeeksPreviewHtml(upcomingWeeks)}
    ${footer(session)}
  `;
  return sendMail({ to: player.email, subject, html, category: 'reminder', relatedWeekId: week.id, session });
}

async function sendFollowUpReminder({ player, week, session, confirmToken, needSubToken }) {
  const confirmUrl = `${siteUrl()}/confirm/${confirmToken}`;
  const needSubUrl = `${siteUrl()}/need-sub/${needSubToken}`;
  const subject = `Playing today? ${fmtDate(week.match_date)}, ${timeAndPlace(session)} doubles — please confirm`;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${player.name},</p>
    <p>Quick nudge — you haven't confirmed for today's doubles match at ${fmtTime(session.match_time)}, and it's coming up. Please let us know either way:</p>
    <p>
      <a href="${confirmUrl}" style="display:inline-block;background:#1a7f37;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;margin-right:8px;">Confirm you're playing</a>
      <a href="${needSubUrl}" style="display:inline-block;background:#b42318;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Need a sub? Click here</a>
    </p>
    ${ballDutyNotice(player, week)}
    ${footer(session)}
  `;
  return sendMail({ to: player.email, subject, html, category: 'followup_reminder', relatedWeekId: week.id, session });
}

/**
 * Sent to the player themselves the moment their own sub request goes out —
 * whether they triggered it from an emailed link or the self-service
 * "Request a Sub" page. This is the safety net for a wrong-name mix-up on
 * the self-service page: if this lands in an inbox that didn't expect it,
 * the actual player finds out immediately, before someone else claims the
 * slot, rather than discovering it after the fact.
 */
async function sendSubRequestOwnConfirmation({ player, week, session }) {
  const subject = `Sub requested for you — ${fmtDate(week.match_date)}, ${timeAndPlace(session)} doubles`;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${player.name},</p>
    <p>This confirms a sub was just requested for your spot on <strong>${fmtDate(week.match_date)}</strong> at ${fmtTime(session.match_time)}. The other players not already scheduled that week have been emailed — first to confirm takes the spot.</p>
    <p><strong>Didn't request this yourself?</strong> Reach out right away so it can be sorted out before someone else claims the slot.</p>
    ${footer(session)}
  `;
  return sendMail({ to: player.email, subject, html, category: 'sub_request_self_notice', relatedWeekId: week.id, session });
}

/**
 * Sent when the admin clicks "Notify roster" on a session's blackout-dates
 * admin page, so players actually know the page exists and where to go —
 * without this, nothing in the app tells a player blackout dates are open
 * for entry; they'd only get there if told outside the app. Sent to everyone
 * currently enrolled, before anyone's necessarily submitted anything. Only
 * meaningful while the session is still `draft` (see the route in admin.js),
 * since that's the only time the player-facing page accepts changes.
 *
 * The link includes `&player=<id>` so `/blackout` pre-selects the
 * recipient's own name instead of landing on the bare dropdown — just a
 * convenience (`?player=` is a plain query param `GET /blackout` already
 * reads to pre-fill the select, not a token), one less step and one less
 * chance to pick the wrong name from the list. There's no confirmation step
 * after submitting — `POST /blackout` saves directly — so whichever name is
 * selected when the form is submitted is the one whose dates change; this
 * pre-fill is the only guard against that being the wrong person.
 */
async function sendBlackoutNotice({ recipient, session }) {
  const blackoutUrl = `${siteUrl()}/blackout?session=${session.id}&player=${recipient.id}`;
  // Includes time/court, same reasoning as timeAndPlace() on every
  // match-specific subject below — a player enrolled in two same-day,
  // same-club sessions needs to tell which one this is about from the
  // subject line alone, not just the club prefix + session name.
  const subject = `Enter your blackout dates — ${session.name}, ${timeAndPlace(session)}`;
  const html = `
    ${matchBanner(session, null)}
    <p>Hi ${recipient.name},</p>
    <p><strong>${session.name}</strong> is being scheduled. If there are any dates you already know you can't play, let us know before the schedule is generated:</p>
    <p><a href="${blackoutUrl}" style="display:inline-block;background:#1a7f37;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Enter your blackout dates</a></p>
    <p>That link will already have your name selected — just check off any dates you can't make. Nothing else to do if you don't have any — you'll be assumed available every week.</p>
    <p>This only works until the schedule is generated — after that, use Request a Sub instead for any date you end up needing to miss.</p>
    ${footer(session)}
  `;
  return sendMail({ to: recipient.email, subject, html, category: 'blackout_notice', session });
}

async function sendSubRequestFanout({ recipient, week, session, claimToken, requestingPlayerName }) {
  const claimUrl = `${siteUrl()}/claim-sub/${claimToken}`;
  const subject = `Sub needed — ${fmtDate(week.match_date)}, ${timeAndPlace(session)} doubles`;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${recipient.name},</p>
    <p>${requestingPlayerName} needs a sub for <strong>${fmtDate(week.match_date)}</strong> at ${fmtTime(session.match_time)}. First to confirm gets the spot.</p>
    <p><a href="${claimUrl}" style="display:inline-block;background:#1a7f37;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">I'll play</a></p>
    ${currentWeekRosterHtml(week)}
    ${footer(session)}
  `;
  return sendMail({ to: recipient.email, subject, html, category: 'sub_request', relatedWeekId: week.id, session });
}

async function sendEscalationEmail({ recipient, week, session, claimToken }) {
  const claimUrl = `${siteUrl()}/claim-sub/${claimToken}`;
  const subject = `[Sub still needed] ${fmtDate(week.match_date)}, ${timeAndPlace(session)} doubles`;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${recipient.name},</p>
    <p>A doubles slot for <strong>${fmtDate(week.match_date)}</strong> at ${fmtTime(session.match_time)} still needs a sub — the regular group hasn't filled it yet.</p>
    <p><a href="${claimUrl}" style="display:inline-block;background:#1a7f37;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">I'll play</a></p>
    ${currentWeekRosterHtml(week)}
    ${footer(session)}
  `;
  return sendMail({ to: recipient.email, subject, html, category: 'escalation', relatedWeekId: week.id, session });
}

async function sendSubFilledNotice({ recipient, week, session, subName }) {
  const subject = `Sub confirmed — ${fmtDate(week.match_date)}, ${timeAndPlace(session)} doubles`;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${recipient.name},</p>
    <p>${subName} will be subbing in for ${fmtDate(week.match_date)}. See you on the court!</p>
    ${currentWeekRosterHtml(week)}
    ${footer(session)}
  `;
  return sendMail({ to: recipient.email, subject, html, category: 'sub_filled', relatedWeekId: week.id, session });
}

// --- Direct player-to-player swaps (swapFlow.js) ---------------------------

/** Sent to the target player with a single link to the accept/decline
 * landing page (GET /swap/respond/:token) — mirrors the confirm/need-sub
 * emails' one-link-to-a-landing-page pattern rather than separate
 * accept/decline URLs, so there's one clear place to see the full trade
 * before deciding. */
async function sendSwapRequestEmail({ recipient, initiatorPlayer, initiatorWeek, targetWeek, session, claimToken }) {
  const respondUrl = `${siteUrl()}/swap/respond/${claimToken}`;
  // Includes time/court (see timeAndPlace()'s doc comment) — a player
  // enrolled in two same-day sessions at the same club needs to tell which
  // one a swap invite is for from the subject alone, not just the club
  // prefix + session name, which could be similar or generic across
  // sessions. match_time/court_info are session-level, not per-week, so this
  // is valid regardless of which of the two traded dates the player looks at.
  const subject = `${initiatorPlayer.name} wants to swap weeks with you — ${session.name}, ${timeAndPlace(session)}`;
  const html = `
    ${matchBanner(session, null)}
    <p>Hi ${recipient.name},</p>
    <p>${initiatorPlayer.name} would like to swap with you in <strong>${session.name}</strong>:</p>
    <ul>
      <li>You'd give up <strong>${fmtDate(targetWeek.match_date)}</strong></li>
      <li>You'd take over <strong>${fmtDate(initiatorWeek.match_date)}</strong> (currently ${initiatorPlayer.name}'s)</li>
    </ul>
    <p>You're still playing the same number of games either way — just trading which week.</p>
    <p><a href="${respondUrl}" style="display:inline-block;background:#1a7f37;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Review and respond</a></p>
    ${footer(session)}
  `;
  return sendMail({ to: recipient.email, subject, html, category: 'swap_request', relatedWeekId: targetWeek.id, session });
}

/** One-time overdue nudge (swapFlow.js's nudgeOverdueSwaps()) — sent only if
 * the target player hasn't responded within 48h of whichever of the two
 * involved weeks' matches comes first. Reuses the same respond link pattern
 * as sendSwapRequestEmail, just with a fresh (additionally-valid, not a
 * replacement) token and more urgent framing. */
async function sendSwapNudge({ recipient, initiatorPlayer, initiatorWeek, targetWeek, session, claimToken }) {
  const respondUrl = `${siteUrl()}/swap/respond/${claimToken}`;
  const subject = `Still waiting on you — ${initiatorPlayer.name}'s swap request, ${session.name}, ${timeAndPlace(session)}`;
  const html = `
    ${matchBanner(session, null)}
    <p>Hi ${recipient.name},</p>
    <p>Just a nudge — ${initiatorPlayer.name} proposed a swap with you in <strong>${session.name}</strong> a little while ago and it's still waiting on your answer:</p>
    <ul>
      <li>You'd give up <strong>${fmtDate(targetWeek.match_date)}</strong></li>
      <li>You'd take over <strong>${fmtDate(initiatorWeek.match_date)}</strong> (currently ${initiatorPlayer.name}'s)</li>
    </ul>
    <p>One of these dates is coming up soon, so it'd help to decide either way.</p>
    <p><a href="${respondUrl}" style="display:inline-block;background:#1a7f37;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Review and respond</a></p>
    ${footer(session)}
  `;
  return sendMail({ to: recipient.email, subject, html, category: 'swap_nudge', relatedWeekId: targetWeek.id, session });
}

/** Safety net for a wrong-person mix-up, same reasoning as
 * sendSubRequestOwnConfirmation — the initiator finds out immediately if
 * this wasn't what they meant to send. */
async function sendSwapProposedConfirmation({ player, targetPlayer, initiatorWeek, targetWeek, session }) {
  const subject = `Swap request sent to ${targetPlayer.name} — ${session.name}, ${timeAndPlace(session)}`;
  const html = `
    ${matchBanner(session, null)}
    <p>Hi ${player.name},</p>
    <p>This confirms you proposed a swap with ${targetPlayer.name} in <strong>${session.name}</strong>: you'd give up ${fmtDate(initiatorWeek.match_date)} and take over their ${fmtDate(targetWeek.match_date)}. Nothing changes yet — waiting on ${targetPlayer.name} to accept.</p>
    <p><strong>Didn't request this yourself?</strong> Reach out right away so it can be sorted out before it's accepted.</p>
    ${footer(session)}
  `;
  return sendMail({ to: player.email, subject, html, category: 'swap_proposed_self_notice', relatedWeekId: initiatorWeek.id, session });
}

async function sendSwapDeclinedNotice({ player, targetPlayer, initiatorWeek, session }) {
  const subject = `${targetPlayer.name} declined your swap request — ${session.name}, ${timeAndPlace(session)}`;
  const html = `
    ${matchBanner(session, null)}
    <p>Hi ${player.name},</p>
    <p>${targetPlayer.name} declined your swap proposal for <strong>${fmtDate(initiatorWeek.match_date)}</strong>. You're still scheduled for that date as before — nothing changed.</p>
    ${footer(session)}
  `;
  return sendMail({ to: player.email, subject, html, category: 'swap_declined', relatedWeekId: initiatorWeek.id, session });
}

/** Sends each swapping player their own personalized confirmation — they
 * each gave up a different date and took over a different one, so this
 * fires two separate emails rather than one shared one. */
async function sendSwapAcceptedNotice({ initiatorPlayer, targetPlayer, initiatorWeek, targetWeek, session }) {
  const subjectFor = (newDate) => `Swap confirmed — you're now playing ${fmtDate(newDate)}, ${timeAndPlace(session)} (${session.name})`;
  const bodyFor = (recipient, other, gaveUpDate, tookOverDate) => `
    ${matchBanner(session, null)}
    <p>Hi ${recipient.name},</p>
    <p>Your swap with ${other.name} is confirmed. You gave up <strong>${fmtDate(gaveUpDate)}</strong> and are now playing <strong>${fmtDate(tookOverDate)}</strong> instead.</p>
    ${footer(session)}
  `;
  const r1 = await sendMail({
    to: initiatorPlayer.email,
    subject: subjectFor(targetWeek.match_date),
    html: bodyFor(initiatorPlayer, targetPlayer, initiatorWeek.match_date, targetWeek.match_date),
    category: 'swap_accepted',
    relatedWeekId: targetWeek.id,
    session,
  });
  const r2 = await sendMail({
    to: targetPlayer.email,
    subject: subjectFor(initiatorWeek.match_date),
    html: bodyFor(targetPlayer, initiatorPlayer, targetWeek.match_date, initiatorWeek.match_date),
    category: 'swap_accepted',
    relatedWeekId: initiatorWeek.id,
    session,
  });
  return r1 && r2;
}

/** Lets the rest of an affected week's group know their roster shifted —
 * mirrors sendSubFilledNotice, minus a specific "subName" since this is a
 * trade, not a sub. */
async function sendSwapGroupNotice({ recipient, week, session }) {
  const subject = `Roster update — ${fmtDate(week.match_date)}, ${timeAndPlace(session)} doubles`;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${recipient.name},</p>
    <p>Two players swapped weeks, so your ${fmtDate(week.match_date)} match now has a different lineup:</p>
    ${currentWeekRosterHtml(week)}
    ${footer(session)}
  `;
  return sendMail({ to: recipient.email, subject, html, category: 'swap_group_notice', relatedWeekId: week.id, session });
}

// No session context — this is the admin's freeform email tool, not tied to
// any particular session/week, so there's no club/court to show here.
async function sendCustomEmail({ to, subject, body }) {
  const html = `<p>${body.replace(/\n/g, '<br>')}</p>${footer(null)}`;
  return sendMail({ to, subject, html, category: 'custom' });
}

module.exports = {
  sendMail,
  wrapEmailHtml,
  sendConfirmationReminder,
  sendFollowUpReminder,
  sendSubRequestOwnConfirmation,
  sendBlackoutNotice,
  sendSubRequestFanout,
  sendEscalationEmail,
  sendSubFilledNotice,
  sendSwapRequestEmail,
  sendSwapNudge,
  sendSwapProposedConfirmation,
  sendSwapDeclinedNotice,
  sendSwapAcceptedNotice,
  sendSwapGroupNotice,
  sendCustomEmail,
  siteUrl,
  fmtDate,
  fmtTime,
  timeAndPlace,
  sessionPublicLabel,
  sessionColor,
  matchBanner,
};
