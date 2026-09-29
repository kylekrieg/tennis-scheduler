// Detail log (Kyle, 2026-09-29) — the extra, lower-level trail shown only on
// the admin Super Log (/admin/super-log), so the Email Log and Activity Log
// stay as they are. Records:
//   - 'open'    someone opened an emailed link's landing page (confirm,
//               need a sub, I'll play, swap, I found a sub, pickup invite)
//   - 'click'   someone pressed that page's button
//   - 'admin'   admin buttons the Activity Log doesn't cover (Resend link,
//               Send status report now, Notify roster, log out)
//   - 'refused' a link/button that didn't go through (expired or used link,
//               spot already filled, rate limit, bot trap, failed admin login)
// Every row carries the IP, raw user agent and a short device label, so
// "who actually pressed that button, and from what" can be answered later.
// Logging must never break the request it's describing, so everything here
// swallows its own errors.
const db = require('../db');
const { hashToken } = require('./tokens');
const { fullName } = require('./playerName');

const RETENTION_DAYS = 365;
let lastPrune = 0;

function clientIp(req) {
  if (!req) return null;
  return (req.headers && req.headers['cf-connecting-ip']) || req.ip || (req.socket && req.socket.remoteAddress) || null;
}

// Short, human label for a user agent. Also flags the usual link scanners
// and preview fetchers (Outlook/Office safe-links, Gmail image proxy, Slack
// previews, curl, …) so an automated open isn't mistaken for a person.
function deviceLabel(ua) {
  if (!ua) return 'unknown device';
  const u = String(ua);
  if (/bot|crawl|spider|preview|scanner|curl|wget|python|headless|googleimageproxy|safelinks|proofpoint|mimecast|barracuda|ms-office|microsoft office|slackbot|facebookexternalhit|whatsapp|skypeuripreview/i.test(u)) {
    return 'link scanner / bot';
  }
  let os = 'other';
  if (/iPhone/.test(u)) os = 'iPhone';
  else if (/iPad/.test(u)) os = 'iPad';
  else if (/Android/.test(u)) os = 'Android';
  else if (/Windows/.test(u)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(u)) os = 'Mac';
  else if (/CrOS/.test(u)) os = 'Chromebook';
  else if (/Linux/.test(u)) os = 'Linux';
  let browser = 'browser';
  if (/Edg\//.test(u)) browser = 'Edge';
  else if (/SamsungBrowser/.test(u)) browser = 'Samsung Internet';
  else if (/OPR\/|Opera/.test(u)) browser = 'Opera';
  else if (/Firefox\/|FxiOS/.test(u)) browser = 'Firefox';
  else if (/CriOS|Chrome\//.test(u)) browser = 'Chrome';
  else if (/Safari\//.test(u)) browser = 'Safari';
  else if (/Mobile\//.test(u) && /iPhone|iPad/.test(u)) browser = 'in-app browser';
  return `${os} · ${browser}`;
}

// Never store a raw emailed token: long path segments are masked.
function safePath(req) {
  return String((req && (req.originalUrl || req.url)) || '')
    .split('?')[0]
    .replace(/\/[A-Za-z0-9_\-]{20,}/g, '/…');
}

function prune() {
  const now = Date.now();
  if (now - lastPrune < 24 * 60 * 60 * 1000) return;
  lastPrune = now;
  db.prepare(`DELETE FROM detail_log WHERE created_at < datetime('now', ?)`).run(`-${RETENTION_DAYS} days`);
}

function record(req, { kind, event, actor = null, playerId = null, sessionId = null, weekId = null, description }) {
  try {
    const ua = req && req.headers ? req.headers['user-agent'] || null : null;
    db.prepare(
      `INSERT INTO detail_log (kind, event, actor, player_id, session_id, week_id, description, ip, user_agent, device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(kind, event, actor, playerId, sessionId, weekId, description, clientIp(req), ua, req ? deviceLabel(ua) : null);
    prune();
  } catch (e) {
    console.error('[detailLog] failed to record:', e.message);
  }
}

// --- Emailed-link pages -----------------------------------------------------
// Who a token belongs to, looked up BEFORE the route runs (several routes
// delete their token as part of acting on it). Deliberately ignores "locked"
// / "used" so a refused attempt can still be attributed.
function weekSession(weekId) {
  return db.prepare('SELECT w.id, w.match_date, w.session_id FROM weeks w WHERE w.id = ?').get(weekId) || {};
}
const RESOLVERS = {
  assignment(raw) {
    const r = db.prepare(
      `SELECT p.id pid, p.name, p.full_name, wa.week_id FROM week_assignment_tokens t
       JOIN week_assignments wa ON wa.id = t.week_assignment_id JOIN players p ON p.id = wa.player_id
       WHERE t.token = ?`
    ).get(hashToken(raw));
    return r ? { actor: fullName(r), playerId: r.pid, week: weekSession(r.week_id) } : null;
  },
  offer(raw) {
    const r = db.prepare(
      `SELECT o.candidate_player_id, o.broader_list_id, wa.week_id, sr.requesting_player_id
       FROM sub_offers o JOIN sub_requests sr ON sr.id = o.sub_request_id
       JOIN week_assignments wa ON wa.id = sr.week_assignment_id WHERE o.token = ?`
    ).get(hashToken(raw));
    if (!r) return null;
    let actor = 'unknown';
    let playerId = null;
    if (r.candidate_player_id) {
      const p = db.prepare('SELECT id, name, full_name FROM players WHERE id = ?').get(r.candidate_player_id);
      if (p) { actor = fullName(p); playerId = p.id; }
    } else if (r.broader_list_id) {
      const b = db.prepare('SELECT name FROM broader_sub_list WHERE id = ?').get(r.broader_list_id);
      if (b) actor = `${b.name} (sub list)`;
    }
    const req = db.prepare('SELECT name, full_name FROM players WHERE id = ?').get(r.requesting_player_id);
    return { actor, playerId, week: weekSession(r.week_id), extra: req ? ` (sub request from ${fullName(req)})` : '' };
  },
  swapVerify(raw) {
    const r = db.prepare(
      `SELECT p.id pid, p.name, p.full_name, wa.week_id FROM swap_proposal_verifications v
       JOIN week_assignments wa ON wa.id = v.initiator_assignment_id JOIN players p ON p.id = wa.player_id WHERE v.token = ?`
    ).get(hashToken(raw));
    return r ? { actor: fullName(r), playerId: r.pid, week: weekSession(r.week_id) } : null;
  },
  swapRespond(raw) {
    const h = hashToken(raw);
    const r = db.prepare(
      `SELECT p.id pid, p.name, p.full_name, wa.week_id FROM swap_requests s
       JOIN players p ON p.id = s.target_player_id JOIN week_assignments wa ON wa.id = s.target_assignment_id
       WHERE s.token = ? OR s.nudge_token = ?`
    ).get(h, h);
    return r ? { actor: fullName(r), playerId: r.pid, week: weekSession(r.week_id) } : null;
  },
  adhoc(raw) {
    const h = hashToken(raw);
    const r = db.prepare(
      `SELECT p.id pid, p.name, p.full_name, a.week_id FROM adhoc_signups a JOIN players p ON p.id = a.player_id
       WHERE a.token = ? OR a.reminder_token = ?`
    ).get(h, h);
    return r ? { actor: fullName(r), playerId: r.pid, week: weekSession(r.week_id) } : null;
  },
};

const PAGES = {
  confirm: { resolver: 'assignment', open: 'opened the Confirm link', click: 'clicked Confirm (I\'m playing)' },
  need_sub: { resolver: 'assignment', open: 'opened the Need a sub link', click: 'clicked Need a sub' },
  found_sub: { resolver: 'assignment', open: 'opened the I found a sub page', click: 'submitted I found a sub' },
  claim_sub: { resolver: 'offer', open: 'opened the sub request page (I\'ll play)', click: 'clicked I\'ll play' },
  swap_verify: { resolver: 'swapVerify', open: 'opened the swap confirmation link', click: 'confirmed sending the swap proposal' },
  swap_respond: { resolver: 'swapRespond', open: 'opened the swap proposal', click: 'responded to the swap proposal' },
  adhoc_signup: { resolver: 'adhoc', open: 'opened the pickup-game invite', click: 'clicked I\'m in' },
};

// Middleware for an emailed-link route (GET = open, POST = click). Records
// one row when the response finishes, with the outcome taken from what the
// route rendered: an error-toned message page or a 4xx/5xx is 'refused'.
function linkPage(page) {
  const def = PAGES[page];
  return function (req, res, next) {
    let who = null;
    try { who = RESOLVERS[def.resolver](req.params.token); } catch (e) { who = null; }
    let rendered = null;
    const origRender = res.render.bind(res);
    res.render = function (view, locals, cb) {
      rendered = { view, heading: locals && locals.heading, body: locals && locals.body, tone: locals && locals.tone };
      return origRender(view, locals, cb);
    };
    res.on('finish', () => {
      const isClick = req.method === 'POST';
      const refused = res.statusCode >= 400 || (rendered && rendered.tone === 'error');
      const actor = who ? who.actor : 'Unknown (link not recognized)';
      const week = (who && who.week) || {};
      let verb = isClick ? def.click : def.open;
      if (isClick && page === 'swap_respond' && req.body && req.body.action) verb += ` (${req.body.action})`;
      let description = `${actor} ${verb}${week.match_date ? ` for ${week.match_date}` : ''}${(who && who.extra) || ''}`;
      if (refused) {
        const why = rendered ? [rendered.heading, rendered.body].filter(Boolean).join(': ') : `HTTP ${res.statusCode}`;
        description += ` — refused: ${String(why).slice(0, 200)}`;
      } else if (isClick) {
        description += ' — went through';
      }
      record(req, {
        kind: refused ? 'refused' : isClick ? 'click' : 'open',
        event: `${page}.${isClick ? 'click' : 'open'}`,
        actor,
        playerId: who && who.playerId,
        sessionId: week.session_id || null,
        weekId: week.id || null,
        description,
      });
    });
    next();
  };
}

module.exports = { record, linkPage, deviceLabel, safePath, RETENTION_DAYS };
