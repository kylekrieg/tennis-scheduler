'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const { fmtDate, fmtTime, sessionPublicLabel, sessionFullTitle, sessionColor } = require('./services/email');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Available in every EJS template without importing anything — fmtTime in
// particular turns the stored 24h 'HH:MM' values (match_time, reminder_time)
// into friendly 12-hour times (e.g. '19:15' -> '7:15 PM') everywhere they're
// shown, so nobody has to do the mental math.
app.locals.fmtDate = fmtDate;
app.locals.fmtTime = fmtTime;
// "Session name — Club, Court" for player-facing pages that need to
// disambiguate two same-day sessions at the same club — see
// sessionPublicLabel()'s doc comment in email.js. Deliberately not used on
// admin-facing pages, which keep showing the bare internal session name.
app.locals.sessionPublicLabel = sessionPublicLabel;
// "Session name · Day · Time · Court · Club" — the fuller composed title
// Kyle asked for (2026-08-29), used on both the admin dashboard and the
// small set of public pages/banner he asked to match it (see
// sessionFullTitle()'s doc comment in email.js for exactly which ones and
// why it's not used everywhere sessionPublicLabel() is).
app.locals.sessionFullTitle = sessionFullTitle;
// Same reasoning, but a color instead of text — see sessionColor()'s doc
// comment in email.js. Used on both player-facing and admin pages (the
// admin's own session-color picker on session_form.ejs needs it too), unlike
// sessionPublicLabel which is deliberately player-facing only.
app.locals.sessionColor = sessionColor;
// A cache-busting query param appended to every static CSS/JS <link>/<script>
// tag (see header.ejs, admin_header.ejs, admin/login.ejs, preferences.ejs).
// Set once per process, so it changes on every `pm2 restart` after a deploy —
// added 2026-08-29 after a real incident where an updated style.css/navmenu.js
// pair was deployed (via WinSCP + pm2 restart, same as always) but browsers/
// the Cloudflare tunnel in front of this app kept serving an old cached copy
// of style.css with no visible way for Kyle to tell that was the problem: the
// server-rendered HTML (never cached) picked up the new #nav-toggle markup
// immediately, so the button appeared everywhere, but the CSS rules that
// hide it on desktop and collapse <nav> on mobile were still the stale
// pre-hamburger-menu version — explaining exactly what he saw (the toggle
// visible on desktop, and the full nav still overflowing on mobile). Express's
// static() sets no explicit Cache-Control by default, which still leaves
// long-lived heuristic caching (and Cloudflare's own edge cache for static
// extensions) free to hang onto an old copy indefinitely. A version query
// string is a new, previously-never-seen URL on every restart, so neither
// layer has anything stale to serve.
app.locals.assetVersion = Date.now();

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Pre-launch security review (Kyle, 2026-08-29): trust the first hop so
// Express can see the real scheme (http vs. https) a request actually
// arrived as. This app is always reached through a local `cloudflared`
// process (Cloudflare Tunnel) proxying to this same machine — a single,
// known hop — so trusting it is safe and doesn't affect req.ip (this app
// already reads the real client IP straight off the CF-Connecting-IP header
// itself, in rateLimiter.js, rather than relying on Express's trust-proxy
// machinery for that).
app.set('trust proxy', 1);

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12, // 12h admin session
      sameSite: 'lax', // was previously left unset, relying on the same
      // browser default — made explicit so it's a deliberate, documented
      // choice rather than an implicit one, and blocks the classic CSRF
      // shape (a hidden auto-submitting cross-site form) without breaking
      // normal same-site navigation or an emailed link a player clicks.
      secure: 'auto', // fails safe: only adds the Secure flag when Express
      // sees the request as HTTPS (via the trust proxy setting above and
      // Cloudflare's X-Forwarded-Proto). If that header setup ever changes
      // or is missing, this quietly falls back to no Secure flag rather
      // than refusing to set the cookie at all (which a hardcoded `true`
      // would do) — so a proxy misconfiguration can't lock an admin out of
      // their own login.
    },
  })
);

app.use('/admin', adminRoutes);
app.use('/', publicRoutes);

app.use((req, res) => {
  res.status(404).render('message', { title: 'Not found', heading: 'Page not found', body: 'That page does not exist.', tone: 'error' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('message', { title: 'Error', heading: 'Something went wrong', body: err.message, tone: 'error' });
});

module.exports = app;
