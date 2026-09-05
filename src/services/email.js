'use strict';
const nodemailer = require('nodemailer');
const db = require('../db');
const { getTimezone } = require('./settings');
const { utcToZonedParts } = require('./tz');

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
// Domain used for the placeholder email address a one-time sub gets when
// the admin adds them via the "One-time sub (not on roster)" option on
// Reassign without an email on file (see admin.js's reassign route). Not a
// real, resolvable domain — RFC 2606 reserves .invalid specifically for
// addresses that are guaranteed never to be a real destination, which is
// exactly what's needed here: players.email is NOT NULL UNIQUE, so a real
// (if fake) value has to go there, but sendMail() below skips ever actually
// trying to send to it rather than attempting a doomed SMTP send.
const NO_EMAIL_DOMAIN = 'no-email.invalid';

async function sendMail({ to, subject, html, text, category, relatedWeekId = null, session = null, test = false }) {
  // Club name is per-session (a single install can run sessions for
  // different clubs/locations) — every template passes its `session` through
  // here so the subject prefix is correct without each one repeating this
  // logic. `session` is null for emails with no session context (e.g. the
  // admin's freeform custom email), which just means no prefix.
  const club = session && session.club_name;
  let finalSubject = club ? `${club} — ${subject}` : subject;

  // Admin "Send test email" (admin/custom_email.ejs) can trigger any real
  // template function with `test: true`, threaded down from that function's
  // own options object. This is the one thing that makes a test send safe to
  // fire against a real player's real upcoming assignment: forcing the
  // category to a single fixed 'test' value and relatedWeekId to null means
  // the resulting email_log row can never satisfy any cron dedup check
  // (processReminders/processFollowUps/escalateOverdueRequests/etc. all key
  // their "already sent?" lookup on the *real* category + related_week_id +
  // to_email) — so a test send can never accidentally suppress a real
  // automatic reminder, follow-up, or escalation for that same player/week.
  // The '[TEST] ' subject prefix and distinct category also make a test send
  // unmistakable on the Email Log page rather than looking like the real
  // thing. See admin.js's POST /email 'template_test' branch and
  // testEmail.js for where this is set.
  if (test) {
    finalSubject = `[TEST] ${finalSubject}`;
    category = 'test';
    relatedWeekId = null;
  }

  // One-time subs added without a real email on file get a placeholder
  // @no-email.invalid address so players.email's NOT NULL UNIQUE constraint
  // is satisfied — never actually attempt to send there (would just fail,
  // or worse, get "accepted" by the SMTP relay only to bounce later and dent
  // Gmail's sending reputation for nothing). Logged distinctly so this is
  // visibly different from a real failed send on the Email Log page.
  if (!to || (typeof to === 'string' && to.endsWith(`@${NO_EMAIL_DOMAIN}`))) {
    db.prepare(
      'INSERT INTO email_log (to_email, subject, category, status, related_week_id) VALUES (?, ?, ?, ?, ?)'
    ).run(to || '(no email on file)', finalSubject, category, 'skipped_no_email', relatedWeekId);
    return true;
  }

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

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * "today"/"tomorrow"/"Wednesday" (and the matching possessive form) for the
 * follow-up reminder's subject and body — computed against the real gap
 * between the moment the email is actually being sent and the match date,
 * not assumed. Kyle, 2026-09-01: noticed a test follow-up email always said
 * "today's doubles match" and asked whether that changes based on when it's
 * actually sent. It didn't — the wording was hardcoded. That's a real
 * mismatch given how `follow_up_lead_hours` is designed: its default (27h)
 * is deliberately set to land the afternoon *before* a typical evening
 * match (see "Follow-up timing became a per-session configurable lead time"
 * in CLAUDE.md), so in the common case this email fires the day before and
 * "today's" was simply wrong. An admin can still configure a short lead
 * time that fires same-day, or an unusually long one that fires more than a
 * day out, so this checks the actual gap rather than assuming either.
 *
 * `matchDateStr` and "today" are both compared as plain 'YYYY-MM-DD'
 * strings in the app's configured timezone (utcToZonedParts), not the
 * server's own local time — same reasoning as every other lead-hours
 * display conversion in this app (see tz.js's utcToZonedParts doc comment).
 */
function relativeDayPhrase(matchDateStr) {
  const tz = getTimezone();
  const todayStr = utcToZonedParts(new Date(), tz).date;
  const diffDays = Math.round((Date.parse(matchDateStr + 'T00:00:00Z') - Date.parse(todayStr + 'T00:00:00Z')) / 86400000);
  if (diffDays === 0) return { subject: 'today', possessive: "today's" };
  if (diffDays === 1) return { subject: 'tomorrow', possessive: "tomorrow's" };
  if (diffDays > 1) {
    const dow = DOW_NAMES[new Date(matchDateStr + 'T00:00:00Z').getUTCDay()];
    return { subject: dow, possessive: `${dow}'s` };
  }
  // The match date has already passed — shouldn't normally happen, since a
  // follow-up only ever fires before match time (see cron.js's
  // processFollowUps), but fail toward something that still reads sensibly
  // rather than a flatly wrong "today's" for a match that's already over.
  return { subject: 'that match', possessive: 'that' };
}

/**
 * "Session name · Day of week · Match Time · Court/location · Club/group
 * name" — the full composed title Kyle asked for (2026-08-29), first built
 * for the admin dashboard's session headings and then extended to the
 * handful of public-facing "this is the page/banner you're looking at"
 * spots he asked to match it: the /schedule and /lookahead page titles and
 * the "You're viewing" session-picker banner. Each trailing piece is only
 * included if actually set, so a session with no club/court configured yet
 * still renders cleanly. Deliberately a single shared function (not
 * duplicated per-view) so the admin and public formats can never drift out
 * of sync with each other.
 *
 * This is intentionally NOT used everywhere sessionPublicLabel() is (match
 * emails, the PDF, calendar/.ics event titles, the "also in X" double-
 * booking mentions, My Page) — Kyle's own call: those surfaces already show
 * date/time/court nearby in their own layout, so repeating it in the name
 * itself would just be redundant there. sessionPublicLabel() stays exactly
 * as it was for all of those.
 */
function sessionFullTitle(session) {
  if (!session) return '';
  const parts = [session.name];
  if (session.match_day_of_week !== null && session.match_day_of_week !== undefined) parts.push(DOW_NAMES[session.match_day_of_week]);
  if (session.match_time) parts.push(fmtTime(session.match_time));
  if (session.court_info) parts.push(session.court_info);
  if (session.club_name) parts.push(session.club_name);
  return parts.join(' · ');
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

/**
 * `player` is optional (most callers only ever passed `session`, and still
 * can — omitting it just skips the My Page link below). When present, its
 * `slug` (preferred, see playerSlug.js) or `player_id` (the row shape every
 * caller here actually has — these are all `week_assignments`-joined rows,
 * so the player's own id comes through as `wa.player_id`, not `p.id`/`id`,
 * which `wa.*` already claims for the assignment's own row id) builds a
 * link to that player's own My Page. Added 2026-09-01 for the reminder and
 * follow-up emails specifically (Kyle: players clicking Confirm every week
 * from the reminder email never see the My Page button that only exists on
 * the confirm *result* page) — see "My Page link in reminder/follow-up
 * email footers" in CLAUDE.md for the full story and why this was left out
 * of the original My Page build.
 */
function footer(session, player) {
  const club = session && session.club_name;
  const court = session && session.court_info;
  const clubLine =
    club || court
      ? `<p style="color:#888;font-size:12px;margin:0 0 4px;">${[club, court].filter(Boolean).join(' — ')}</p>`
      : '';
  const myPageId = player && (player.slug || player.player_id);
  const myPageLink = myPageId ? ` &nbsp;|&nbsp; <a href="${siteUrl()}/me/${myPageId}">My Page</a>` : '';
  return `${clubLine}<p style="color:#888;font-size:12px;margin-top:24px;">Full schedule: <a href="${siteUrl()}/schedule">${siteUrl()}/schedule</a>${myPageLink}</p>`;
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

async function sendConfirmationReminder({ player, week, session, confirmToken, needSubToken, upcomingWeeks, test = false }) {
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
    ${footer(session, player)}
  `;
  return sendMail({ to: player.email, subject, html, category: 'reminder', relatedWeekId: week.id, session, test });
}

async function sendFollowUpReminder({ player, week, session, confirmToken, needSubToken, test = false }) {
  const confirmUrl = `${siteUrl()}/confirm/${confirmToken}`;
  const needSubUrl = `${siteUrl()}/need-sub/${needSubToken}`;
  const dayPhrase = relativeDayPhrase(week.match_date);
  const subject = `Playing ${dayPhrase.subject}? ${fmtDate(week.match_date)}, ${timeAndPlace(session)} doubles — please confirm`;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${player.name},</p>
    <p>Quick nudge — you haven't confirmed for ${dayPhrase.possessive} doubles match at ${fmtTime(session.match_time)}, and it's coming up. Please let us know either way:</p>
    <p>
      <a href="${confirmUrl}" style="display:inline-block;background:#1a7f37;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;margin-right:8px;">Confirm you're playing</a>
      <a href="${needSubUrl}" style="display:inline-block;background:#b42318;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Need a sub? Click here</a>
    </p>
    ${ballDutyNotice(player, week)}
    ${footer(session, player)}
  `;
  return sendMail({ to: player.email, subject, html, category: 'followup_reminder', relatedWeekId: week.id, session, test });
}

/**
 * Sent the moment someone clicks "Need a sub for this week" on the public,
 * unauthenticated self-service /request-sub page — before anything in the
 * DB changes. /request-sub has no login, just a name picked from a
 * dropdown, so nothing stops a script from hitting that button for every
 * name in the list; this is the gate that makes that harmless. The single
 * link here goes to the exact same /need-sub/:token GET/POST landing page
 * already used by the reminder email's "need a sub" link — same "Are you
 * sure?" confirmation, same POST-mutates convention — so a bot (or a
 * mis-click on the wrong name) never gets past this without whoever
 * actually owns that inbox choosing to click through. Kyle, 2026-08-18:
 * "I feel like bots could easily send out many emails by pressing that sub
 * button. I want there to be some validation by the player." Distinct from
 * sendSubRequestOwnConfirmation() below, which fires *after* the fanout has
 * already gone out, as an audit trail/mistake-catcher; this one fires
 * *before*, as the actual consent gate — nothing is emailed to the rest of
 * the roster until the recipient of *this* email clicks through.
 */
async function sendSubRequestVerification({ player, week, session, needSubToken, test = false }) {
  const needSubUrl = `${siteUrl()}/need-sub/${needSubToken}`;
  const subject = `Confirm your sub request — ${fmtDate(week.match_date)}, ${timeAndPlace(session)} doubles`;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${player.name},</p>
    <p>Someone just clicked "Need a sub for this week" for your spot on <strong>${fmtDate(week.match_date)}</strong> at ${fmtTime(session.match_time)} on the Request a Sub page. To keep this from happening by mistake (or automatically), nothing has been sent to anyone else yet — click below to confirm it's really you and finish requesting a sub:</p>
    <p><a href="${needSubUrl}" style="display:inline-block;background:#b42318;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Confirm — I need a sub</a></p>
    <p class="muted" style="color:#888;">Didn't request this? No action needed — nothing changes and no one else is notified unless you click the button above.</p>
    ${footer(session)}
  `;
  return sendMail({ to: player.email, subject, html, category: 'sub_request_verification', relatedWeekId: week.id, session, test });
}

/**
 * Sent to the player themselves the moment their own sub request goes out —
 * whether they triggered it from an emailed link or the self-service
 * "Request a Sub" page. This is the safety net for a wrong-name mix-up on
 * the self-service page: if this lands in an inbox that didn't expect it,
 * the actual player finds out immediately, before someone else claims the
 * slot, rather than discovering it after the fact.
 *
 * Kyle, 2026-08-27: originally this didn't say *who* got emailed, or what
 * happens if nobody responds — a player who wanted to personally nudge a
 * couple people had no way to know who'd already been asked, and had no
 * sense of the timeline (does anything happen automatically, or is it on
 * them to chase it down). Now takes `candidates` (exactly who fanOutSubRequest
 * just emailed) and `sessionSubs` (this session's own escalation list, see
 * sessionSubList()) so the email can spell out the whole plan up front —
 * right now, in 24h if nobody's responded, and what to do if nobody ever
 * does. The escalation window is a plain 24h constant, same as
 * escalateOverdueRequests() below — not currently a per-session configurable
 * field the way follow_up_lead_hours/admin_report_lead_hours are, so this
 * copy is written to match that fixed number; if that ever becomes
 * configurable, this text needs to read it the same way.
 */
async function sendSubRequestOwnConfirmation({ player, week, session, candidates, sessionSubs, test = false }) {
  const subject = `Sub requested for you — ${fmtDate(week.match_date)}, ${timeAndPlace(session)} doubles`;
  const candidateNames = candidates && candidates.length ? candidates.map((c) => c.name).join(', ') : null;
  const subListNames = sessionSubs && sessionSubs.length ? sessionSubs.map((s) => s.name).join(', ') : null;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${player.name},</p>
    <p>This confirms a sub was just requested for your spot on <strong>${fmtDate(week.match_date)}</strong> at ${fmtTime(session.match_time)}. Here's exactly what happens from here:</p>
    <ul>
      <li><strong>Right now:</strong> ${candidateNames ? `an email just went out to ${candidateNames} — first to confirm takes the spot.` : `no one else on the roster was free to ask for this date — see the next step below.`}</li>
      <li><strong>If no one responds within 24 hours of the match:</strong> ${subListNames ? `it automatically goes out to this session's sub list: ${subListNames}.` : `there's currently no one on this session's sub list to escalate to — worth flagging to your admin ahead of time.`}</li>
      <li><strong>If no one has confirmed by match time:</strong> please contact your admin for help finding a replacement.</li>
    </ul>
    <p>You'll get a separate email the moment someone actually confirms — no need to keep checking.</p>
    <p><strong>Didn't request this yourself?</strong> Reach out right away so it can be sorted out before someone else claims the slot.</p>
    ${footer(session)}
  `;
  return sendMail({ to: player.email, subject, html, category: 'sub_request_self_notice', relatedWeekId: week.id, session, test });
}

/**
 * Sent to the ORIGINAL player once their sub request is actually filled —
 * distinct from sendSubFilledNotice below, which notifies the rest of that
 * week's group (who'd otherwise have no way to know the slot is now
 * covered). This is a real gap Kyle flagged, 2026-08-27: the original
 * requester's own week_assignments row flips to 'subbed_out' as part of the
 * same claimSub() transaction, which is exactly why they were previously
 * excluded from the group notice (it queries status != 'subbed_out') and so
 * never heard anything back at all — they'd only find out by checking the
 * site themselves. claimSub() now sends this to them directly, once, right
 * after the group notice.
 */
async function sendSubFilledOriginalNotice({ recipient, week, session, subName, test = false }) {
  const subject = `Your sub is confirmed — ${fmtDate(week.match_date)}, ${timeAndPlace(session)} doubles`;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${recipient.name},</p>
    <p>Good news — <strong>${subName}</strong> will be covering your spot on <strong>${fmtDate(week.match_date)}</strong> at ${fmtTime(session.match_time)}. You're all set, no further action needed.</p>
    ${footer(session)}
  `;
  return sendMail({ to: recipient.email, subject, html, category: 'sub_filled_original', relatedWeekId: week.id, session, test });
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
async function sendBlackoutNotice({ recipient, session, test = false }) {
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
  return sendMail({ to: recipient.email, subject, html, category: 'blackout_notice', session, test });
}

async function sendSubRequestFanout({ recipient, week, session, claimToken, requestingPlayerName, test = false }) {
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
  return sendMail({ to: recipient.email, subject, html, category: 'sub_request', relatedWeekId: week.id, session, test });
}

async function sendEscalationEmail({ recipient, week, session, claimToken, test = false }) {
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
  return sendMail({ to: recipient.email, subject, html, category: 'escalation', relatedWeekId: week.id, session, test });
}

async function sendSubFilledNotice({ recipient, week, session, subName, test = false }) {
  const subject = `Sub confirmed — ${fmtDate(week.match_date)}, ${timeAndPlace(session)} doubles`;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${recipient.name},</p>
    <p>${subName} will be subbing in for ${fmtDate(week.match_date)}. See you on the court!</p>
    ${currentWeekRosterHtml(week)}
    ${footer(session)}
  `;
  return sendMail({ to: recipient.email, subject, html, category: 'sub_filled', relatedWeekId: week.id, session, test });
}

// --- Direct player-to-player swaps (swapFlow.js) ---------------------------

/** Sent to the target player with a single link to the accept/decline
 * landing page (GET /swap/respond/:token) — mirrors the confirm/need-sub
 * emails' one-link-to-a-landing-page pattern rather than separate
 * accept/decline URLs, so there's one clear place to see the full trade
 * before deciding. */
/** Bot-protection gate in front of the real swap proposal — sent to the
 * *initiator* only, before proposeSwap() runs or the target player hears
 * anything. Mirrors sendSubRequestVerification's role for Request a Sub:
 * /swap/start is an unauthenticated public form (pick any two players from
 * a dropdown), so nothing has actually been sent to the target player yet
 * when this lands — clicking through is what proves it's really the
 * initiator, not a script picking names at random. */
async function sendSwapProposalVerification({ player, targetPlayer, initiatorWeek, targetWeek, session, verifyToken, test = false }) {
  const verifyUrl = `${siteUrl()}/swap/verify/${verifyToken}`;
  const subject = `Confirm your swap proposal — ${session.name}, ${timeAndPlace(session)}`;
  const html = `
    ${matchBanner(session, null)}
    <p>Hi ${player.name},</p>
    <p>Someone just proposed swapping weeks with ${targetPlayer.name} on the Swap a Week page: you'd give up <strong>${fmtDate(initiatorWeek.match_date)}</strong> and take over their <strong>${fmtDate(targetWeek.match_date)}</strong>. To keep this from happening by mistake (or automatically), nothing has been sent to ${targetPlayer.name} yet — click below to confirm it's really you and send the proposal:</p>
    <p><a href="${verifyUrl}" style="display:inline-block;background:#1a7f37;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Confirm and send proposal</a></p>
    <p class="muted" style="color:#888;">Didn't request this? No action needed — nothing changes and ${targetPlayer.name} is never notified unless you click the button above.</p>
    ${footer(session)}
  `;
  return sendMail({ to: player.email, subject, html, category: 'swap_proposal_verification', relatedWeekId: initiatorWeek.id, session, test });
}

async function sendSwapRequestEmail({ recipient, initiatorPlayer, initiatorWeek, targetWeek, session, claimToken, test = false }) {
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
  return sendMail({ to: recipient.email, subject, html, category: 'swap_request', relatedWeekId: targetWeek.id, session, test });
}

/** One-time overdue nudge (swapFlow.js's nudgeOverdueSwaps()) — sent only if
 * the target player hasn't responded within 48h of whichever of the two
 * involved weeks' matches comes first. Reuses the same respond link pattern
 * as sendSwapRequestEmail, just with a fresh (additionally-valid, not a
 * replacement) token and more urgent framing. */
async function sendSwapNudge({ recipient, initiatorPlayer, initiatorWeek, targetWeek, session, claimToken, test = false }) {
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
  return sendMail({ to: recipient.email, subject, html, category: 'swap_nudge', relatedWeekId: targetWeek.id, session, test });
}

/** Safety net for a wrong-person mix-up, same reasoning as
 * sendSubRequestOwnConfirmation — the initiator finds out immediately if
 * this wasn't what they meant to send. */
async function sendSwapProposedConfirmation({ player, targetPlayer, initiatorWeek, targetWeek, session, test = false }) {
  const subject = `Swap request sent to ${targetPlayer.name} — ${session.name}, ${timeAndPlace(session)}`;
  const html = `
    ${matchBanner(session, null)}
    <p>Hi ${player.name},</p>
    <p>This confirms you proposed a swap with ${targetPlayer.name} in <strong>${session.name}</strong>: you'd give up ${fmtDate(initiatorWeek.match_date)} and take over their ${fmtDate(targetWeek.match_date)}. Nothing changes yet — waiting on ${targetPlayer.name} to accept.</p>
    <p><strong>Didn't request this yourself?</strong> Reach out right away so it can be sorted out before it's accepted.</p>
    ${footer(session)}
  `;
  return sendMail({ to: player.email, subject, html, category: 'swap_proposed_self_notice', relatedWeekId: initiatorWeek.id, session, test });
}

async function sendSwapDeclinedNotice({ player, targetPlayer, initiatorWeek, session, test = false }) {
  const subject = `${targetPlayer.name} declined your swap request — ${session.name}, ${timeAndPlace(session)}`;
  const html = `
    ${matchBanner(session, null)}
    <p>Hi ${player.name},</p>
    <p>${targetPlayer.name} declined your swap proposal for <strong>${fmtDate(initiatorWeek.match_date)}</strong>. You're still scheduled for that date as before — nothing changed.</p>
    ${footer(session)}
  `;
  return sendMail({ to: player.email, subject, html, category: 'swap_declined', relatedWeekId: initiatorWeek.id, session, test });
}

/** Sends each swapping player their own personalized confirmation — they
 * each gave up a different date and took over a different one, so this
 * fires two separate emails rather than one shared one. */
async function sendSwapAcceptedNotice({ initiatorPlayer, targetPlayer, initiatorWeek, targetWeek, session, test = false }) {
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
    test,
  });
  const r2 = await sendMail({
    to: targetPlayer.email,
    subject: subjectFor(initiatorWeek.match_date),
    html: bodyFor(targetPlayer, initiatorPlayer, targetWeek.match_date, initiatorWeek.match_date),
    category: 'swap_accepted',
    relatedWeekId: initiatorWeek.id,
    session,
    test,
  });
  return r1 && r2;
}

/** Lets the rest of an affected week's group know their roster shifted —
 * mirrors sendSubFilledNotice, minus a specific "subName" since this is a
 * trade, not a sub. */
async function sendSwapGroupNotice({ recipient, week, session, test = false }) {
  const subject = `Roster update — ${fmtDate(week.match_date)}, ${timeAndPlace(session)} doubles`;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${recipient.name},</p>
    <p>Two players swapped weeks, so your ${fmtDate(week.match_date)} match now has a different lineup:</p>
    ${currentWeekRosterHtml(week)}
    ${footer(session)}
  `;
  return sendMail({ to: recipient.email, subject, html, category: 'swap_group_notice', relatedWeekId: week.id, session, test });
}

// --- Ad-hoc pickup-game sign-ups (adhocFlow.js) -----------------------------

/**
 * The T-minus-(adhoc_invite_lead_hours) opening invite — sent to every
 * currently-enrolled roster player at once, each with their own single-use
 * "I'm in" link. First-come-first-served: the first 4 clicks form a court
 * immediately, no waiting for any deadline (see adhocFlow.js's doc comment).
 */
async function sendAdhocInvite({ recipient, week, session, signupToken, test = false }) {
  const signupUrl = `${siteUrl()}/adhoc-signup/${signupToken}`;
  const subject = `Pickup game ${fmtDate(week.match_date)}, ${timeAndPlace(session)} — want in?`;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${recipient.name},</p>
    <p>Looking for players for <strong>${fmtDate(week.match_date)}</strong> at ${fmtTime(session.match_time)}. First come, first served — the first 4 to sign up get the first court, the next 4 get a second court, and so on.</p>
    <p><a href="${signupUrl}" style="display:inline-block;background:#1a7f37;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">I'm in</a></p>
    <p>If you're not free this time, no need to do anything — you'll get invited again for the next one.</p>
    ${footer(session)}
  `;
  return sendMail({ to: recipient.email, subject, html, category: 'adhoc_invite', relatedWeekId: week.id, session, test });
}

/**
 * The T-minus-(adhoc_reminder_lead_hours) nudge — only sent when there's
 * currently an incomplete trailing group (sign-ups not a clean multiple of
 * 4), and only to roster players who haven't signed up yet (adhocFlow.js's
 * courtGroupsForWeek().notSignedUp). Reuses the same token minted for the
 * original invite rather than issuing a new one — that link was never used
 * (they haven't signed up), so it's still perfectly valid.
 */
async function sendAdhocReminder({ recipient, week, session, signupToken, stillNeeded, test = false }) {
  const signupUrl = `${siteUrl()}/adhoc-signup/${signupToken}`;
  const subject = `Still need players — ${fmtDate(week.match_date)}, ${timeAndPlace(session)}`;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${recipient.name},</p>
    <p>We're ${stillNeeded} player${stillNeeded === 1 ? '' : 's'} short of a full court for <strong>${fmtDate(week.match_date)}</strong> at ${fmtTime(session.match_time)}. Still want in?</p>
    <p><a href="${signupUrl}" style="display:inline-block;background:#1a7f37;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">I'm in</a></p>
    ${footer(session)}
  `;
  return sendMail({ to: recipient.email, subject, html, category: 'adhoc_reminder', relatedWeekId: week.id, session, test });
}

/**
 * The T-minus-(adhoc_final_lead_hours) wrap-up for anyone who landed in a
 * completed court — tells them who else is on their court. Sent once a
 * court has actually been materialized into real week_assignments rows (see
 * adhocFlow.js's finalizeWeek()), so this doubles as their only confirmation
 * — there's no separate confirm step for ad-hoc sign-ups.
 */
async function sendAdhocFinalRoster({ recipient, week, session, teammates, court, test = false }) {
  const subject = `You're in — ${fmtDate(week.match_date)}, ${timeAndPlace(session)}`;
  const names = teammates.map((p) => p.name).join(', ');
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${recipient.name},</p>
    <p>You're set for <strong>${fmtDate(week.match_date)}</strong> at ${fmtTime(session.match_time)}${court ? `, Court ${court}` : ''}.</p>
    <p><strong>Playing with:</strong> ${names}</p>
    ${footer(session)}
  `;
  return sendMail({ to: recipient.email, subject, html, category: 'adhoc_final', relatedWeekId: week.id, session, test });
}

/**
 * Sent instead of sendAdhocFinalRoster to anyone left in an incomplete
 * trailing group once the T-minus-(adhoc_final_lead_hours) cutoff arrives —
 * they don't play this time. No further action needed from them; they'll be
 * invited again for the next week same as everyone else on the roster.
 */
async function sendAdhocNotEnough({ recipient, week, session, test = false }) {
  const subject = `Not enough signed up — ${fmtDate(week.match_date)}, ${timeAndPlace(session)}`;
  const html = `
    ${matchBanner(session, week)}
    <p>Hi ${recipient.name},</p>
    <p>Thanks for signing up for <strong>${fmtDate(week.match_date)}</strong> — we didn't get enough players to fill a full court this time, so this one's not happening. Hope to see you at the next one.</p>
    ${footer(session)}
  `;
  return sendMail({ to: recipient.email, subject, html, category: 'adhoc_not_enough', relatedWeekId: week.id, session, test });
}

/** Escapes the five HTML-significant characters. Every other email template
 * in this file interpolates server-known values (player/session names typed
 * by an admin through a constrained form, dates/times this app computed
 * itself) — sendCustomEmail() below is the one place a genuinely free-text
 * admin-typed paragraph reaches an outbound email with no EJS auto-escaping
 * in between (this file builds raw HTML strings, not EJS templates). Pulled
 * out as its own helper so it's a one-line call at the interpolation site
 * rather than a wall of .replace() chains inline. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// `session` is optional — the original one-off "email a single player"
// flow has no session in scope, so this stays plain (no club/court prefix,
// no banner) for that path, same as before. The "email a whole session's
// roster" flow (admin.js's POST /email, added 2026-08-13) passes the
// chosen session through so the bulk send looks consistent with every
// other session-tied email in this app rather than being the one
// exception — same matchBanner(session, null) treatment as the swap
// templates use when there's no single date to show (a session-wide
// message isn't about one specific match either).
//
// Pre-launch security review (Kyle, 2026-08-29): `body` is free text an
// admin types into a textarea (admin/custom_email.ejs) with no format
// restriction at all — unlike every other admin-controlled string in this
// app's email templates (names, session titles), which are short values
// from constrained form fields. Escaped here before interpolation so a
// compromised or careless admin account can't inject arbitrary HTML/links
// into a message sent to the whole roster's inboxes. escapeHtml() runs
// before the \n-to-<br> conversion so a literal "<br>" typed by the admin
// reads as text, not markup, and the real line-break conversion still works
// on the now-escaped text.
// `week` is optional (default null, same matchBanner(session, null) banner as
// before) — added 2026-09-02 for the "email this week's scheduled/subbed-in
// players" recipient mode (admin.js's POST /email, 'week' branch): once the
// caller has resolved a specific week, showing its real date in the banner
// (matchBanner(session, week), same treatment sendAdminWeekReport() already
// gives a week-specific email) is strictly more useful than the session-only
// banner every other custom-email path still uses, and costs nothing extra.
async function sendCustomEmail({ to, subject, body, session = null, week = null, test = false }) {
  const banner = session ? matchBanner(session, week) : '';
  const html = `${banner}<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>${footer(session)}`;
  return sendMail({ to, subject, html, category: 'custom', session, test });
}

/**
 * Pre-match status digest for the admin (Kyle, 2026-08-26): "we need to
 * define at least one admin email address... the morning of the match...
 * the admin gets an email with the status of the players. Who's confirmed,
 * who hasn't confirmed, who asked for a sub and who filled it. Who
 * performed a swap." One email per configured address (see adminReport.js,
 * which builds `report` and handles per-recipient dedup via email_log the
 * same way every other reminder-ish email in this app does), listing every
 * player currently on this week's roster bucketed by what's actually
 * happened to their slot. Pure template — all the DB work (which bucket
 * each player falls into, matching swaps back to who traded with whom) is
 * done by the caller so this stays consistent with every other function in
 * this file only ever rendering, never querying.
 */
async function sendAdminWeekReport({ to, week, session, report, test = false }) {
  const subject = `Status report — ${fmtDate(week.match_date)}, ${timeAndPlace(session)}`;
  const listOrNone = (arr) =>
    arr.length ? `<ul style="margin:4px 0 12px;">${arr.map((n) => `<li>${n}</li>`).join('')}</ul>` : `<p style="margin:2px 0 12px;color:#888;">— none —</p>`;
  const fillLine = `${report.activeCount} of ${report.playersPerWeek} slots currently filled for this match.`;
  const attentionLine = report.needsAttention
    ? `<p style="color:#b42318;font-weight:600;">&#9888; ${report.notes || 'This week is flagged for attention.'}</p>`
    : '';
  const html = `
    ${matchBanner(session, week)}
    <p>${fillLine}</p>
    ${attentionLine}
    <p style="margin-bottom:2px;"><strong>Confirmed (${report.confirmed.length})</strong></p>
    ${listOrNone(report.confirmed)}
    <p style="margin-bottom:2px;"><strong>Not yet confirmed (${report.unconfirmed.length})</strong></p>
    ${listOrNone(report.unconfirmed)}
    <p style="margin-bottom:2px;"><strong>Needs a sub — not yet filled (${report.needsSub.length})</strong></p>
    ${listOrNone(report.needsSub)}
    <p style="margin-bottom:2px;"><strong>Subbed out, spot filled (${report.subbedOut.length})</strong></p>
    ${listOrNone(report.subbedOut)}
    ${report.ballDutyName ? `<p><strong>Ball duty:</strong> ${report.ballDutyName}</p>` : ''}
    ${footer(session)}
  `;
  return sendMail({ to, subject, html, category: 'admin_report', relatedWeekId: week.id, session, test });
}

module.exports = {
  NO_EMAIL_DOMAIN,
  sendMail,
  wrapEmailHtml,
  sendConfirmationReminder,
  sendFollowUpReminder,
  sendSubRequestVerification,
  sendSubRequestOwnConfirmation,
  sendBlackoutNotice,
  sendSubRequestFanout,
  sendEscalationEmail,
  sendSubFilledNotice,
  sendSubFilledOriginalNotice,
  sendSwapProposalVerification,
  sendSwapRequestEmail,
  sendSwapNudge,
  sendSwapProposedConfirmation,
  sendSwapDeclinedNotice,
  sendSwapAcceptedNotice,
  sendSwapGroupNotice,
  sendAdhocInvite,
  sendAdhocReminder,
  sendAdhocFinalRoster,
  sendAdhocNotEnough,
  sendCustomEmail,
  sendAdminWeekReport,
  siteUrl,
  fmtDate,
  fmtTime,
  timeAndPlace,
  sessionPublicLabel,
  sessionFullTitle,
  sessionColor,
  matchBanner,
  DOW_NAMES,
};
