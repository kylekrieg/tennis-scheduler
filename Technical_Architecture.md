# Tennis Doubles Scheduler — Technical Architecture

*Reconstructed from the original requirements-gathering chat. Captures the infrastructure and configuration decisions made before the app was built — referenced by `README.md` but not previously saved into this project folder. For the as-built data model, routes, and implementation details as the app evolved, `CLAUDE.md` is the authoritative, up-to-date source; this doc reflects the original decisions rather than everything added since.*

## Stack

- **Runtime:** Node.js + Express.
- **Database:** SQLite (chosen for a single-file, zero-admin database appropriate for a small self-hosted deployment).
- **Process manager:** pm2, to keep the app running on the host and restart it automatically.

## Hosting

- **Self-hosted on a Raspberry Pi.** Claude does not have network access to the physical Pi — deployment (copying files over, running install/start commands) is done by the admin following provided setup instructions.
- **Exposed to the internet via Cloudflare Tunnel**, since the Pi needs to be reachable for players to click email links and view the schedule without exposing the home network directly via port forwarding. Requires a domain added to a free Cloudflare account.

## Email

- **Sent via Gmail SMTP**, using a Gmail account app password.
- Domain/subdomain and the Gmail app password are configured directly in the `.env` file on the Pi — deliberately not exposed anywhere in the admin panel.

## Scheduled jobs

The Monday reminder email send and the 24-hour sub-request escalation check both require a server process that can run on a recurring schedule, not just a static site — this was the deciding factor against a purely static/serverless hosting approach.

- The job logic is written to check "should this have already happened and hasn't?" rather than firing only at an exact instant, so a missed run (e.g. the Pi losing power over a weekend) still catches up correctly once the process is back up, instead of silently skipping that cycle.

## Handling infeasible schedules

If blackout dates make it mathematically impossible to hit every player's exact target for a given week or across the season (e.g. too many people out the same week), the scheduler does not guess or silently produce a bad schedule — it flags the conflict for the admin, who resolves it manually via the admin panel's reassignment tools.

## Configuration decisions

- **Match day-of-week and match time** are per-session settings entered in the admin panel, not hardcoded to Wednesday — the app is meant to generalize to other groups/days, not stay a single-purpose Wednesday-night tool.
- **Reminder email time-of-day** is likewise a per-session admin setting.
- **Timezone** is a single global admin-panel setting used for all time math.
- **Domain/subdomain and Gmail app password** are `.env`-only, filled in directly by the admin on the server — never entered through the admin panel UI.

## Security baseline

- Tokens: long, random, unguessable, single-use per player per week — no sequential or predictable IDs.
- No state change ever happens on a page load (GET) — only on an explicit button click (POST). This is the primary defense against email-scanner bots that pre-visit links.
- Token reuse (e.g. double-clicking Confirm, or opening the same link in two tabs) is checked server-side, so it can't cause a double state change.
- Gmail SMTP doesn't surface bounces in a way the app can act on directly — a bad player email address fails silently and would only show up indirectly via the admin dashboard's "unconfirmed" flag, not as a labeled bounce.

## Known gap at the time of the original spec

Gmail SMTP bounce handling was explicitly identified as a soft spot: there's no dedicated "this email address is bad" signal, only the indirect symptom of a player never confirming.
