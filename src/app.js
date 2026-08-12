'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const { fmtDate, fmtTime, sessionPublicLabel, sessionColor } = require('./services/email');

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
// Same reasoning, but a color instead of text — see sessionColor()'s doc
// comment in email.js. Used on both player-facing and admin pages (the
// admin's own session-color picker on session_form.ejs needs it too), unlike
// sessionPublicLabel which is deliberately player-facing only.
app.locals.sessionColor = sessionColor;

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12 }, // 12h admin session
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
