# CLAUDE.md

Guidance for Claude working in this repo. Keep this file **short**; it's loaded at the start of every session.

- **Background on any feature** (why it exists, what was tried, how it was verified) lives in `docs/HISTORY.md`, the full dated change log. Don't read it top to bottom. `grep -n` it for the feature, route, table or column you're touching and read only that section.
- **When you make a real change:** append a short dated entry to the end of `docs/HISTORY.md` (heading `### <change> (Kyle, YYYY-MM-DD)`, 3–10 lines: the ask, root cause, what changed, how verified). Only edit this file if a rule or convention below changed.
- Other docs: `HANDOFF.md` (start-here map), `README.md` (features/setup), `RASPBERRY_PI_SETUP.md`, `EMAIL_MAP.md` (every email and its timing; generated), `Technical_Architecture.md`. In-app: `/help` (players), `/admin/guide` (admins).

## Working rules

- **Never run anything against the connected project's `data/tennis.db`.** Requiring `src/db` opens the DB and runs every pending migration, even from a one-off `node -e`. Copy the project/DB to a scratch dir and set `SQLITE_PATH` for any test, including read-only diagnostics.
- Kyle deploys by copying files to the Pi (WinSCP) and running `pm2 restart`. The local `data/tennis.db` is a separate copy of production; a data fix made here must be re-run on the Pi by Kyle. No network path to the Pi exists.
- Push finished files back into the connected folder; give a plain summary of which files changed. Don't commit unless asked.
- Ask before building when a design choice is genuinely Kyle's (scope, wording, who sees what). Don't guess.
- Keep line endings LF.

## Commands

```
npm install                                    # no native build deps
cp .env.example .env                           # set SESSION_SECRET + ADMIN_PASSWORD_HASH
node src/scripts/hash-admin-password.js "pw"
node src/db/seed-example.js                    # example 9-player/17-week roster
npm start                                      # = npm run dev; no watch/build step
npm run test:scheduler                         # plain node + assert, add cases in engine.test.js
npm run email-map                              # regenerate EMAIL_MAP.md from services/emailMap.js
npm run backup | backup:offsite | reset-data -- --confirm
```

Node >= 22.5 (uses built-in `node:sqlite`). Plain CommonJS, no bundler/linter.

## Architecture

- **Express + EJS + `node:sqlite`.** `src/app.js` wires middleware; `routes/public.js` (no login) and `routes/admin.js` (everything after `requireAdmin`). Services in `src/services/`, one concern each.
- **DB (`src/db/index.js`)**: `DatabaseSync` behind a small better-sqlite3-style shim (`prepare().run/get/all`, `transaction()`). BLOBs: use `db.raw.prepare` (the shim mangles Buffers).
- **Migrations**: `schema.sql` runs every boot (`CREATE TABLE IF NOT EXISTS`). For a new column on an existing table add it to `schema.sql` *and* call `ensureColumn(table, col, def)` in `db/index.js`. **`ensureColumn` defaults must be literals** (`0`, `'x'`, `NULL`); never `DEFAULT (datetime('now'))`, which crashes existing installs. Add bare and backfill with an `UPDATE`. Also never reference a new column in `schema.sql`'s seed `INSERT`s. Additive only: never drop columns/tables (vestigial ones are noted in schema comments).
- **Scheduler (`src/scheduler/engine.js`)** is pure (no DB/Express): max-flow assignment → simulated-annealing partner variety (+ player-pair constraints) → ball duty. `services/scheduleRun.js` is the DB glue. **Locked weeks (`weeks.locked=1`) are never regenerated.** Understaffed weeks are reduced and flagged, not fatal; unreachable targets are auto-absorbed and reported, never written back to `target_games`.
- **Cron (`services/cron.js`)**: 60s `setInterval`, every check is "should this have already happened?" so missed ticks catch up. Automatic passes dedup via `email_log` (category + week + address); manual admin buttons (`Send reminders now`, `Send status report now`) pass `{force:true}`. Per-line Suspend checkboxes (`services/automationSuspend.js`) gate reminder/follow-up/escalation. `processWeekLocking` locks weeks at match time and kills their tokens.
- **Time**: `match_time`/`reminder_time` are naive `HH:MM` in the single `app_settings.timezone`. Always go through `services/tz.js` (`zonedTimeToUtc`, `utcToZonedParts`, `addDays`); never SQLite date math. Stored timestamps are UTC; convert for display.
- **Tokens**: `crypto.randomBytes(32)`, only SHA-256 hashes stored. Confirm/need-sub links go through `services/tokenStore.js` (`week_assignment_tokens`, multiple live tokens per assignment; issue never revokes older ones). GET renders, POST mutates. Public self-service starts (`/request-sub/start`, `/swap/start`, `/found-sub/start`) email a verification link first, plus honeypot (`services/honeypot.js`) + per-IP rate limit (`middleware/rateLimiter.js`, keyed on `CF-Connecting-IP`).
- **Sub flow (`services/subFlow.js`)**: the only place sub requests are created/claimed. One active request per week. Email sends for a request run inside `withSubRequestLock()` so they go out in order. Self-arranged subs ("I found a sub") have their own timeline (`selfArrangedTimeline`), no escalation until the deadline. Escalation hours are per session. Every sub email carries `threadKey` (`sub:<id>`) for Email Log grouping.
- **Sessions**: `session_type` `regular` | `adhoc` (pickup, first-come courts, `services/adhocFlow.js`). Multiple concurrent sessions are normal; never assume one. `resolveSession()` picks the current one for public pages. Archiving hides and silences; it doesn't delete. Sessions belong to a **season** (`seasons`); stats boards: session → season → master (`services/statsBoards.js`).
- **Email (`services/email.js`)**: every send goes through `sendMail()`, which writes `email_log` (with `body_html`, `thread_key`) in dev mode too. `test:true` forces category `test` so tests never satisfy cron dedup. Add every new template to `services/testEmail.js` and every new/retimed email to `services/emailMap.js`.
- **Logging**: `activityLog.js` (`logActivity` admin, `logPlayerActivity`, `logSystemActivity` for cron) → Activity Log. `detailLog.js` → link opens/clicks, refused attempts, un-logged admin buttons → only shown on Super Log (`/admin/super-log`, merges all three).
- **Async routes** must be wrapped in `asyncHandler()`.
- **PDF (`services/pdf.js`)**: PDFKit standard fonts, ASCII markers only (`*`, `[!]`, `[DB]`).

## Conventions

- **Names**: `players.name` = short public name ("Kyle K"), `players.full_name` = full name. Public pages use `.name`; admin pages, Activity Log text and **all emails** use `fullName(p)` (`services/playerName.js`). Slugs never change on rename.
- **Session titles**: anywhere a session is named on a page/log, use `sessionFullTitle(s)` (name · day · time · court · club). `sessionPublicLabel(s)` only for inline mentions on player pages, emails, PDF, calendar. Flash messages may use the bare name.
- **Escaping**: EJS `<%= %>` everywhere; `<%-` only for includes or pre-escaped HTML. In `email.js`, wrap any user-entered text (names, notes, subjects) in `escapeHtml()`.
- **Warn, don't block**: judgment-call conflicts (overlaps, double-bookings, capacity) are flagged for the admin, not refused.
- **Admin UI**: `flash(req,msg,type)` + redirect; `popFlash(req)` in GET. Wide tables: pass `wideMain: true`. Static asset URLs get `?v=<%= assetVersion %>`.
- **Colors**: CSS custom properties only, defined for light and `[data-theme="dark"]`; font sizes as `calc(Npx * var(--text-scale, 1))`.
- **Activity Log** descriptions name the acting admin and use full titles/names. Don't double-log sends already in `email_log`.

## Backlog (deferred; see HISTORY.md for design notes)

- Reply-to-email confirmation (`confirm+<token>@stl-tennis.com` Reply-To + inbound adapter); self-hosted SMTP tradeoffs.
- SMS "running late" button (Twilio vs carrier gateways; needs `players.phone`).
- Cloudflare Turnstile on public forms, if bots get past honeypot + rate limit.
- Reassign-equivalent UI for finalized ad-hoc weeks.
- "All 4 confirmed" group email (design settled: fire each time a week re-completes; whole roster; parked until Kyle revisits).
- Two players requesting a sub for the same week (design discussion needed).
- Scheduled cleanup of stale tokens, orphaned news images.
- Player-pair constraints aren't enforced on manual Reassign/sub/swap.
- Mid-season player replacement stays manual (decided twice).
- Persistent session store so deploys don't log admins out.
- Full Content-Security-Policy (blocked by inline scripts in views).
