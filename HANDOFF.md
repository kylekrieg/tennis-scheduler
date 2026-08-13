# Handoff: Tennis Doubles Scheduler

This is the "start here" document for whoever picks up this codebase next — written for a developer who'll be working with Claude (or another AI coding assistant) to extend it, not someone starting from zero on Node/Express. Read this first, then follow the pointers below into the deeper docs as needed. Don't try to read `CLAUDE.md` cover to cover before doing anything — it's a reference, not a tutorial.

## What this is

A self-hosted, no-login season scheduler for a recurring doubles tennis group. Plain Node/Express/EJS, SQLite via Node's built-in `node:sqlite` (no native build step, by design — see "Gotchas" below), running on a Raspberry Pi. Two session types: regular (season-long, fairness-optimized scheduling with confirm/sub/swap flows) and ad-hoc (first-come-first-served pickup games). No user accounts for players — everything is single-use emailed links; only admins log in, with a single shared password-only login.

## How the documentation fits together

Four other docs exist in this folder, each answering a different question:

- **`CLAUDE.md`** — the deep one (100+ KB). A decision-by-decision technical history: not just *what* the code does but *why* it's built that way, including options that were tried and reverted. This is written specifically for an AI assistant reading the repo cold — if you're using Claude to make a change, point it at the relevant section of this file before it touches scheduling, email, tokens, or cron logic. Don't read it linearly; use it as a reference for the area you're about to touch.
- **`Full_Scope_Of_Work.md`** — a chronological log of requirements conversations and what got built in response, numbered by section. Useful for "why does this feature exist" or "what was the original ask" context; less useful as a technical reference.
- **`Technical_Architecture.md`** — a short, high-level architecture summary. Good first read if you want the 5-minute version before diving into `CLAUDE.md`.
- **`README.md`** — feature list and setup commands, written for a human running the app, not extending it.
- **In-app docs** — `/help` is the player-facing walkthrough (confirm, blackout dates, sub/swap, calendar, ad-hoc pickup games). `/admin/guide` is the admin-facing walkthrough of the actual day-to-day workflow. Both are useful to skim before changing anything user-facing, since they describe the intended behavior in plain language.

This file is the map; `CLAUDE.md` is the territory.

## Quick start (dev environment)

```
npm install                                    # zero native build deps, see Gotchas
cp .env.example .env                           # fill in ADMIN_PASSWORD_HASH at minimum
node src/scripts/hash-admin-password.js "pw"   # generates the hash for .env
node src/db/seed-example.js                    # optional: loads a 9-player/17-week example roster
npm start                                      # same as npm run dev — no watch mode, no build step
npm run test:scheduler                         # runs src/scheduler/engine.test.js directly
```

No linter, no bundler, no TypeScript — plain CommonJS run directly with `node`. Requires **Node ≥ 22.5** (see below).

## Gotchas — real issues hit this week, in case they recur

**Node version.** The app requires Node ≥ 22.5 because `src/db/index.js` uses the built-in `node:sqlite` module. Raspberry Pi OS's default `apt` Node is usually much older. Symptom if the version is wrong: the app fails immediately on startup with a module-not-found-style error. Check with `node --version` before debugging anything that looks like a database issue.

**Never copy `node_modules` between machines.** Every dependency here was deliberately chosen to need zero native compilation (`bcryptjs` instead of `bcrypt`, `node:sqlite` instead of `better-sqlite3`) specifically so `npm install` is fast and safe to just run directly on the Pi. Copying `node_modules` from a dev machine (especially Windows) to the Pi risks broken symlinks and silent corruption with no clear error. Always `rm -rf node_modules && npm install` on the target machine instead.

**The admin password only seeds once.** `ADMIN_PASSWORD_HASH` in `.env` is read into the `admins` table only when that table is empty (first boot). Changing `.env` and restarting later does nothing if an admin row already exists — a very confusing symptom ("I changed the password but it won't accept it"). To actually reset a password:
- If losing existing data is fine: delete `data/tennis.db*` and restart — it reseeds fresh from `.env`.
- To reset without losing data, update the row directly instead:
  ```
  node -e "
  const bcrypt = require('bcryptjs');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('data/tennis.db');
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = 1').run(bcrypt.hashSync('newpassword', 10));
  "
  ```

**No backups exist until you make one.** There's no `backups/` folder by default — it's only created the first time someone clicks "Create backup" in the admin UI or `npm run backup` runs. If you're setting this up fresh, set up a cron job (`npm run backup`, uses `VACUUM INTO` so it's safe to run while the app is live) sooner rather than later, and decide whether it should also run automatically via `src/scripts/backup-db.js`.

**No process manager is configured yet.** There's no `pm2`/`systemd` unit/`Procfile` in this repo — if the Pi reboots or the process dies, nothing restarts it automatically. Worth setting up (`pm2 start src/server.js` + `pm2 startup`, or a systemd unit) if this hasn't been done already on the live Pi.

## Where everything lives

```
src/server.js              entry point — loads .env, starts Express, starts the cron loop
src/app.js                 Express app setup, mounts routes, sets app.locals helpers (fmtDate, sessionColor, etc.)
src/db/
  schema.sql                CREATE TABLE IF NOT EXISTS for every table
  index.js                  DatabaseSync wrapper + ensureColumn() migration guard (the only migration mechanism)
  seed-example.js            loads example roster
src/scheduler/
  engine.js                  pure scheduling logic (max-flow assignment, partner variety, ball duty) — no DB/Express deps
  engine.test.js              plain assert-based test file, run directly with node
src/services/               business logic — one file per concern (see filenames, mostly self-descriptive):
  scheduleRun.js              glue between engine.js and the DB
  email.js                    every email template + the single sendMail() choke point
  tokenStore.js / tokens.js   hashed single-use token issuing/lookup for confirm/sub links
  subFlow.js / swapFlow.js    sub-request and direct-swap state machines
  adhocFlow.js                first-come-first-served pickup-game logic
  cron.js                     in-process setInterval loop (not node-cron) — reminders, escalations, week locking
  sessionHelper.js            resolveSession(), overlap/double-booking detection
  statusPage.js               aggregates "needs attention" across all sessions
  activityLog.js              admin audit trail
  tz.js                        the only place wall-clock times get converted to UTC — always route through here
src/routes/
  public.js                   no-auth player-facing routes
  admin.js                    everything behind requireAdmin
src/views/                  EJS templates, no shared layout — each page does its own header/footer include
```

## Routine operations (day to day)

The short version — `/admin/guide` has the full walkthrough: create a session → build the roster and set target games (or, for ad-hoc, just an invite list) → collect blackout dates (regular sessions only — "Notify roster" sends the email) → click "Schedule these players" → monitor via the dashboard and `/admin/status` for anything flagged (understaffed weeks, unfilled subs, stale swaps, double-bookings) → the Activity Log and Email Log for after-the-fact "what happened" questions.

## Emergency / recovery playbook

**Site won't start:** check `node --version` (≥22.5), check `.env` exists and has `ADMIN_PASSWORD_HASH`/`SESSION_SECRET`, check the configured `PORT` isn't already in use, read the terminal output — startup errors print before the "listening on..." line.

**Can't log in / lost admin password:** see the "admin password only seeds once" gotcha above — use the direct `UPDATE admins` approach to avoid wiping data.

**Database seems corrupted or lost:** restore the most recent file from `backups/` (or `data/tennis.db.backup-*` depending on naming) by copying it over `data/tennis.db` while the app is stopped. If there is no backup, there's nothing to recover — see the backups gotcha above for why this matters going forward.

**Something is silently not sending emails:** check `/admin/email-log` for `status = 'failed'` rows first — every send attempt is logged regardless of outcome, so this is always the first place to look, not the server console.

**Pi rebooted and the site didn't come back:** there's currently no process manager configured (see gotcha above) — this is the most likely explanation, not an app bug.

## Working with Claude on this codebase

A few conventions worth telling a fresh Claude session about explicitly, since they're easy to violate accidentally and hard to catch in review:

- **Additive-only migrations.** New columns go in via `ensureColumn()` in `src/db/index.js` *and* `schema.sql` — never `ALTER`/drop an existing column. Several vestigial columns exist on purpose.
- **GET renders, POST mutates.** Every token-driven public route (confirm, need-sub, claim-sub, swap respond, ad-hoc sign-up) follows this — the GET only displays state, the POST from that same page does the actual mutation.
- **Every async route handler must be wrapped in `asyncHandler()`** (`src/middleware/asyncHandler.js`) — Express 4 doesn't auto-catch rejected promises, and an unwrapped throw can crash the whole process.
- **"Warn, don't block."** This app's general philosophy for judgment-call conflicts (double-booking, understaffed weeks, priority conflicts) is to flag them for the admin rather than silently refusing an action. Don't add a hard block without checking whether a softer warning fits the existing pattern better.
- **Test against a copy, not the live folder.** If you're running the dev server to verify a change, copy the project elsewhere first rather than running it against whatever folder is actually deployed — resetting the database or `.env` for a test can wipe real data.

When in doubt about *why* something works a certain way, search `CLAUDE.md` for the feature name before changing it — there's usually a paragraph explaining a rejected alternative and the actual reason behind the current design.
