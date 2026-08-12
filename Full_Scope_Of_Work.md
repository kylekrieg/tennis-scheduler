# Tennis Doubles Scheduler — Full Scope of Work

*Reconstructed from the original requirements-gathering chat ("Tennis doubles scheduling website"). This is the functional spec the app was built from — referenced by `README.md` and `CLAUDE.md` but not previously saved into this project folder.*

## 1. Roster & season parameters

Fixed Wednesday 5:30pm slot, one court, 9-player roster, 4 play each week, 17-week season. Two fairness problems, tracked separately:

- **Playing-time fairness** — since only 4 of 9 play each week, over a season everyone should get roughly equal weeks played relative to their tier.
- **Pairing fairness** — among the 4 who play a given week, who partners with whom should even out over time (opponent fairness is not tracked).

**Note: the roster below is a placeholder/starting example, not a fixed spec.** It's the example data used to validate the scheduling engine during the original requirements chat (matches `seed-example.js`), not a permanent roster the app is built around. The number of players, their names, and their per-player targets are all expected to vary session to session — the app's session/roster setup (§9) supports any roster size and any target distribution, as long as targets sum to `weeks × players_per_week`.

Per-player targets for that first example 17-week session (weighted tiers, not equal rotation), summing to exactly 68 = 17 weeks × 4 slots:

| Player | Target games |
|---|---|
| Kyle Krieg | 14 |
| John Gunther | 14 |
| Brian Beracha | 7 |
| Shawn Anderson | 7 |
| Michael Gibbons | 7 |
| Greg Johnson | 7 |
| Doug Geiger | 4 |
| Bart Lautenbach | 4 |
| Brian Potter | 4 |

## 2. Season schedule generator (core engine)

Given the roster with fixed targets and 17 weekly slots of exactly 4 players, computes one full-season schedule in advance. For each week, picks which 4 of 9 play and splits them into two doubles pairs (2v2). Two optimization goals: hit each player's exact target count over the season, and spread partner pairings as evenly as possible so no two players are stuck together (or never together) disproportionately. Blackout dates (players marking themselves unavailable) are constraints fed into the generator before it runs.

## 3. Public schedule view (shared link, no login)

A single page anyone with the link can open, showing the schedule week by week — date, the 4 players, how they're paired, ball duty, and confirmation status per player. Read-only for the 8 non-admin players.

## 4. Player self-serve blackout page

Players can go into the site and choose the dates they can't play; those dates are recorded and the player is excluded from scheduling on those days.

## 5. Weekly confirmation flow

Every Monday, an email goes out to that week's 4 players. The email contains two links — **"Confirm you're playing"** and **"Need a sub? Click here"** — both of which take the player to the site rather than firing instantly on click. On the site, the player sees context, then explicitly clicks a **Confirm** button to either confirm they're playing or (after an "are you sure?" step) indicate they need a sub. Every email includes a link to the main site, and a footer showing the next 3 weeks' pairings.

## 6. Substitution flow

Player clicks "I need a sub" → confirms via the "are you sure?" step → site emails the other 5 non-playing regulars, each with a link to a landing page requiring an explicit confirm click → first to confirm gets the slot → the other 4 requests auto-close → the week's group is notified of the swap. Subs are logged separately and do not count toward the sub's own season fairness target. Subs are never assigned ball duty.

## 7. Escalation tier

If no one from the original 5 confirms within 24 hours of the Wednesday 5:30pm match, an email goes out simultaneously to a broader, admin-maintained list (name + email, managed in the admin panel) — same first-confirm-wins mechanic, same land-on-site-then-confirm pattern. If that also goes unfilled, it's flagged for the admin.

## 8. Ball duty

One of the 4 players scheduled each week brings balls. Ball duty rotates at the same frequency as overall playing time — players with higher targets bring balls more often. Editable in the admin panel. Subs are never assigned ball duty. If the assigned ball-bringer needs a sub, the site auto-suggests the fairest replacement from the remaining 3 scheduled players (excluding the incoming sub) for admin approval. If a ball-duty player drops out via a sub, the admin is alerted that ball duty needs reassigning.

## 9. Admin panel

- Freely reassign any player to any week.
- Send free-form custom emails to individual players.
- Resend confirmation links.
- Manually mark someone confirmed for a week.
- Edit ball duty assignments.
- Manage the broader sub list (name + email) used for escalation.
- Full stats: games played vs. target per player, partner matrix, confirmation/sub history.
- Add, remove, or edit players (name/email).
- Add or remove a player's blackout dates directly.
- Session setup: start/end dates for each session (the group runs a first-half and second-half session), plus roster and per-player targets.
- **"Schedule these players"** button to manually kick off the initial scheduling run, taking blackout dates into account. Workflow: admin sets session dates/targets → players submit blackout dates → admin clicks "Schedule these players."
- Unconfirmed players and unfilled sub/ball-duty slots are flagged as deadlines approach.
- Gated by a simple shared password (not a full login system).

### Roster change rules

- **Editing a player's info** (e.g. swapping Kyle for Joe) is a pure identity swap: Joe inherits all of Kyle's already-scheduled weeks, ball duty assignments, and blackout dates exactly as-is. No rescheduling is triggered.
- **Adding or removing a player** is structural: triggers a re-schedule that locks all completed past weeks untouched and regenerates only the remaining future weeks across the updated roster, preserving blackout dates for both continuing and newly added players. The admin manually enters updated target counts for the remaining weeks before that re-schedule runs.

## 10. Security

The core protection is the two-step design already baked into every flow: an email link lands on a page, and no state change fires until an explicit button click (a POST, not a page load) — this alone defeats email-scanner bots that "pre-visit" links. On top of that:

- Each link uses a long, random, unguessable token per player per week — not sequential or predictable.
- Tokens are single-use / expire after the relevant match date so an old email link can't be replayed later.
- The sub-request action (biggest blast radius — emails 5 other people) requires an explicit **"Are you sure?"** confirmation step before it fires.
- Every email includes a link to the main site so players can look before making any change.

## 11. Look-ahead & calendar

- Confirmation emails end with a footer showing the next 3 weeks' pairings.
- The public site has a look-ahead section showing the next 4–5 weeks.
- A full-season overview view shows all 17 dates and everyone's pairings.
- Personalized `.ics` calendar download (works for Apple and Google Calendar), showing only the weeks a given player is scheduled — uses the same name-selection approach as the blackout page since there's no login.

## 12. PDF download

Player-facing, single-page printable document for the whole session showing every week, who's playing, and who's on ball duty — deliberately formatted to fit the entire season on one page rather than one page per week.

## 13. Configuration items (added after initial spec)

- **Match day-of-week and match time** are per-session admin settings, not hardcoded to Wednesday — the app should be flexible enough to run other groups on other days.
- **Reminder email time-of-day** is also a per-session admin setting.
- **Timezone** is a global admin-panel setting.
- **Domain/subdomain and the Gmail app password** are deliberately kept out of the admin panel — set directly in the `.env` file on the server instead.

## 14. Open edge-case questions (never answered in the original chat)

These were raised at the end of the requirements-gathering session and flagged for the next session to pick up. They were never actually answered before that chat stalled out:

1. **A player backs out after already confirming.** Does this go through the same "need a sub" flow as backing out before confirming, or does it need different handling since the rest of the group already believes the roster is set?
2. **Admin overrides a player's blackout date.** If the admin manually schedules a player on a day they marked as blacked out, what should happen — silently allowed, or does the admin need a warning/confirmation step?
3. **Two players in the same week both need a sub simultaneously.** Does each get its own independent sub-request fan-out, or does the second request get queued/blocked/handled differently to avoid confusing overlapping invites for the same week?
4. **Overlapping sessions.** If the first-half and second-half sessions (or two different groups) overlap in time, does a player enrolled in both need to be tracked/scheduled independently per session, and could that create a conflict (e.g. scheduled to play both at the same time)?

**Resolution status, checked directly against the code (2026-08-10):**

1. **Backing out after confirming — handled, no special-casing needed.** `POST /confirm/:token` never invalidates a player's own tokens on confirm (`src/routes/public.js`), and `subFlow.createSubRequest()` doesn't check the assignment's prior status before proceeding. So a player who already confirmed can still use the same "Need a sub" link from their original email, and it fires the identical fan-out-to-5 flow as if they'd never confirmed. The only case `POST /need-sub/:token` blocks is `subbed_out` or an already-open `needs_sub` request — `confirmed` is not one of the blocked states.
2. **Admin overriding a blackout date — resolved.** The admin blackout page and the Reassign route allow scheduling a player on a date they blacked out, with a flash warning rather than a hard block (`CLAUDE.md`, "Blackout visibility" section).
3. **Two simultaneous sub requests in one week — resolved.** `hasActiveConcurrentSubRequest()` in `subFlow.js` blocks a second automated request for the same week and routes the player to "contact the admin" instead (`src/routes/public.js` `POST /need-sub/:token`).
4. **Overlapping sessions — resolved 2026-08-10 (warning), extended 2026-08-11 (actual prevention).** `sessionHelper.js`'s `findOverlappingSessionEnrollments()` detects when a player is enrolled in two non-archived sessions that share a `match_day_of_week` and have overlapping date ranges, and surfaces it as a warning in three places — the flash message right after saving a roster, a persistent card on the session detail page, and the dashboard/Status page flags. That part alone never stopped the *scheduler* from actually double-booking the player, since `runScheduler()` still operated entirely within one `session_id`. Kyle flagged this as a real gap on 2026-08-11 once he actually had two overlapping sessions sharing a roster, and asked for a "priority session" concept to resolve it. `session_players.priority` (set on the roster table, lower number wins) plus `scheduleRun.js`'s `crossSessionPriorityExclusions()` now actually prevents it: when a player's priority is set and distinct between two colliding sessions, the losing session excludes them on every date the two share, feeding into the exact same blackout-date mechanism the scheduler already had — so it inherits the existing understaffed-week and target-auto-absorb graceful degradation for free, no new conflict type needed. Left unresolved (priority not set, or tied) it's exactly today's original behavior: a warning, nothing blocked. See `CLAUDE.md`'s "Cross-session double-booking guard" section for the implementation, and §16 below.

## 15. Player-target-unreachable: resolved 2026-08-10 (real production report)

Not one of the original §14 open questions — this surfaced from actual use. Kyle entered new blackout dates for several players and hit `player_target_unreachable: Target is 14 games, but only 13 week(s) are available...`, which hard-failed the entire scheduling run (nothing got written for any open week) rather than degrading gracefully the way the understaffed-weeks fix (§2) does. The two failure modes look similar but have different root causes: understaffed weeks are a *week* not having enough total available players; this is a *specific player's own* blackout dates capping how many weeks they personally could ever play, which the understaffed-weeks fix doesn't cover.

Presented as a genuine design choice, same shape as the original understaffed-weeks decision: (a) auto-absorb the exact shortfall onto another player with room, (b) never touch any target automatically and instead drop a whole court (4 games) to absorb even a 1-game deficit, or (c) keep the hard fail, just improve the message. **Kyle chose (a), auto-absorb**, specifically because a 1-2 game shortfall costing 3+ unrelated players a game each (option b) was worse than the narrower, fully-transparent fix. See `CLAUDE.md`'s "Player-target-unreachable: auto-absorbed onto another player, not a hard fail" section for the implementation (`engine.js`'s `attemptAutoAbsorb()`) — it never touches `session_players.target_games` in the DB, only reports what happened for that run via `targetAdjustments`, and still hard-fails (as before) if there's genuinely no slack anywhere else to absorb the deficit, or if the underlying conflict is a deeper `combined_conflict` rather than a single player's own limit.

Fixed alongside this: neither this conflict type's message nor `combined_conflict`'s ever actually named the affected player(s) anywhere in the UI (just "Target is 14 games..." with no indication of who) — now enriched with resolved names before being stored/displayed.

## 16. Cross-session double-booking guard: resolved 2026-08-11 (real production report)

Follow-up to §14 question 4. Kyle: "If 2 sessions are scheduled for the same day and the same player is assigned to that session, we need to make sure the same player doesn't get scheduled for the same week on both sessions. We need to come up with a 'priority session' for each player if they are playing two or more sessions on the same day."

Two design questions were resolved with Kyle before implementing (via structured options, both recommended choices taken): (a) priority is a numeric field set per player per session on the roster table — lower number wins — rather than a pairwise chooser on the conflict card, since it scales cleanly to a player being in 3+ colliding sessions; (b) an unresolved priority (not set, or tied) stays a warning, not a hard block on "Schedule these players" — consistent with every other soft-conflict pattern in this app.

Implementation: `session_players.priority` (nullable, `NULL` = not yet decided) plus `scheduleRun.js`'s `crossSessionPriorityExclusions()`, which — for a player whose priority is set and distinct between two colliding sessions — treats the shared calendar dates as a blackout for them in the losing session. Deliberately stateless (compares only priority numbers and date ranges, never what the other session has actually assigned) so the result doesn't depend on scheduling order. Verified end-to-end with a live test script before considering this done (per the standing "verify before deploy" requirement): confirmed unresolved pairs still double-book exactly as before (no regression), confirmed a resolved pair excludes the loser on every shared date, and confirmed that exclusion correctly triggers both existing degradation paths — an understaffed week when the loss drops available players below a full court, and target auto-absorb (§15) when only the excluded player's own target becomes unreachable. See `CLAUDE.md`'s "Cross-session double-booking guard" section for full implementation detail.

**Reverted the same day, after a real case.** The exclusion above reserved *every* shared calendar date for the winning session, not just the ones it turned out to actually need — so a player with enough other blackout dates could be excluded from so many dates in the losing session that their target became unreachable there too, and when that deficit was too large for §15's auto-absorb to redistribute, the *entire losing session's* scheduling run aborted and wrote nothing, for every player in that session, not just the one actually in conflict. Kyle hit this directly and, given the choice between patching the exclusion to be less aggressive (e.g. only reserving dates the winning session actually ends up using — rejected as sequencing-dependent, contradicting the "deliberately stateless" design above) or reverting to warn-only, chose the revert: priority is kept as an advisory field (still shown on the roster table, still referenced by `findOverlappingSessionEnrollments()`'s `resolution`), but nothing in `scheduleRun.js` reads it anymore — see §18 below for how a real double-booking is now made visible instead of prevented. `crossSessionPriorityExclusions()` itself was deleted from `scheduleRun.js` (not just disabled) — see `CLAUDE.md`'s "`session_players.priority`: advisory only, deliberately not enforced by the scheduler" section for the full writeup and the exact failure scenario that triggered the revert.

## 17. Direct player-to-player swaps: resolved 2026-08-11

Feature request, discussed as a design conversation before any code was written (per Kyle's explicit ask: "let's talk about how that would look before coding anything"). Three design questions were resolved up front via structured options, all recommended choices taken: (a) a two-way trade of two specific players' own weeks, not a one-way targeted sub; (b) requires the other player's confirmation via an emailed link, not instant; (c) self-service, players initiate it themselves rather than routing through the admin.

Once the shape was agreed, Kyle added three more requirements before implementation started: a swap that happens to create an actual cross-session double-booking should not be blocked — flag it for the admin to fix manually; every player-initiated swap needs to show up in the Activity Log like everything else; and the emails a swap sends need to be logged too.

All three were built in: `sessionHelper.js`'s new `findActualDoubleBookings()` catches a player genuinely double-booked (not just at-risk) across sessions and surfaces it on the session detail page, dashboard, and Status page — general-purpose, not swap-specific, so it'd catch the same problem caused any other way too. `activityLog.js`'s new `logPlayerActivity()` writes to the same `admin_activity_log` table as every admin action, tagged `"<player> (player self-service)"` so it's clear at a glance which rows are a player's own action. Every swap email routes through the app's existing shared `sendMail()`, so `email_log` captured them automatically with no extra work needed for that part.

Implementation lives in `src/services/swapFlow.js` (new `swap_requests` table, distinct from `sub_requests`/`sub_offers` since a swap is addressed to one specific person, not fanned out). Verified end-to-end via live test scripts before considering this done: propose → accept (assignments correctly swap player_id, tokens invalidated, both confirmed), propose → decline (nothing changes), admin cancel of a stuck pending request, and the cross-session double-booking flag actually appearing after an accepted swap creates one — plus the full picker-to-response flow through real HTTP requests against a running server, not just direct service calls. One real bug was caught during this verification (not by inspection): the accept-time eligibility re-check was rejecting every swap's own acceptance, because it saw the swap's own still-`pending` row as a blocking "already in flight" conflict on both assignments. Fixed by having `respondToSwap()` exclude its own request id from that check — see `CLAUDE.md`'s "Direct player-to-player swaps" section for the full writeup.

**Follow-up: a comprehensive eligibility test suite, an identity-drift bug it caught, and overdue-swap handling (2026-08-11).** Kyle asked for every eligibility scenario to be tested, including races against admin actions — not just the happy path already covered above. That turned up a real bug: `respondToSwap()`'s re-validation checked whether an assignment *row* was still swappable, but never whether it still belonged to the *player* the swap actually named — so if an admin reassigned either side of a pending swap for an unrelated reason before it was accepted (same row id, so every other check still passed), the original recipient's still-live accept link would silently execute a trade with whoever now occupied that seat, who never saw the proposal or agreed to anything. Verified live (propose Alice-for-Carol → admin reassigns Carol's slot to Bob → Carol accepts her original email → trade wrongly executes as Alice-for-Bob), then fixed by snapshotting `initiator_player_id`/`target_player_id` at proposal time and having `respondToSwap()` compare both against the *current* occupants before doing anything — a mismatch fails closed with the same `no_longer_available` reason used for every other accept-time rejection. Reassigning a slot with a pending swap on it now also cancels that swap outright (rather than leaving a dead-but-`pending` row for the other, uninvolved player to eventually hit this same check and fail with no explanation).

Separately, Kyle asked what happens if the target player simply never responds — nothing did at the time. Two new cron passes close that gap: a one-time nudge email once within 48 hours of whichever of the two weeks' matches comes first (double the sub-request lead time, since this is a one-to-one negotiation with no fan-out to fall back on), and an automatic expiry once that same deadline actually passes with no response, so a stale swap can't permanently block either assignment from being part of some other trade later. A nudged-but-still-unanswered swap surfaces on the dashboard and Status page. See `CLAUDE.md`'s "Direct player-to-player swaps" section (the identity-drift guard and overdue-swap nudge/expiry paragraphs) for full implementation detail.

## 18. Player-facing double-booking visibility: resolved 2026-08-11

Direct follow-up to §16's revert: once priority stopped preventing a double-booking, Kyle wanted the same real, confirmed conflict (`sessionHelper.js`'s pre-existing `findActualDoubleBookings()`) visible to the *player themselves*, weeks in advance, on the pages they'd already normally check — not just to the admin on the session detail page, dashboard, and Status page, which was the only place it showed up before this.

A new shared helper, `doubleBookingMapForSession(sessionId)`, wraps `findActualDoubleBookings()` into a `${playerId}|${matchDate}` → other-session lookup that every consumer below uses, computed live at render time rather than stored, so nothing needs to be invalidated when a schedule changes. Wired into: the full season schedule and 4-week look-ahead (a red "double booked" badge on the affected row), My Page (the single bookmark that already aggregates a player's whole schedule — arguably the most important surface), the printable PDF (a `[DB]` marker, since PDFKit's standard fonts can't render the badge styling used elsewhere), and both calendar outputs — the one-time `.ics` download and the subscribable feed — via a `DOUBLE BOOKED —` prefix on the event title itself plus a warning line in the description. Verified end-to-end against a live two-session scenario producing 8 real double-booked dates for a shared player, confirming all four surfaces flagged exactly those dates and named the correct conflicting session.

**Two follow-up refinements the same day, both from direct user feedback rather than something anticipated up front:**
1. The admin session detail page had an aggregate "Double-booked" summary card at the top already, but nothing at the actual week/player row an admin would act on. Kyle: "can we flag the individual players in each week... from 'scheduled' to 'double booked' in red so I can see it on a weekly basis?" — the per-assignment badge on that page now flips to "double booked" (red) in place of the normal status badge whenever it applies, verified against the same scenario with no false positives.
2. Once the badges were live on the public schedule pages, the table felt cramped: the date column was wrapping to two lines inside the default 900px page width, and a double-booked player showed two stacked badges ("scheduled" plus "double booked"). Fixed by widening `/schedule` and `/lookahead` to the same 1400px container the admin pages already use (reusing the existing `main.wide` CSS class via a new `wideMain` header option), forcing the date column to `white-space: nowrap`, and — since "double booked" already supersedes whatever the normal status was going to be — showing only the double-booked badge instead of both.
3. Found by Kyle actually using the Request a Sub page: a double-booked week still showed a plain "scheduled" badge there, since that page (and Swap a Week) had never been wired into `doubleBookingMapForSession()` when the surfaces above were built. Both self-service pickers — Request a Sub's list of upcoming weeks, and Swap a Week's "which week do you want to give up?" table (which previously had no status column at all) — now show the same "double booked" badge, since these are exactly the pages where a player decides which week to act on.

Also discussed, not built: filling a double-booked slot directly with a broader-list sub, either as an instant admin-side reassign or a triggered sub request. Kyle's call: leave it to the existing self-service "Request a sub" flow the player already has — a double-booked player resolves it themselves the same way they'd handle any other conflict, rather than adding a second, parallel admin-initiated path. (This surfaced a good factual question worth recording here: the broader/external sub list only gets emailed automatically 24 hours before match time, and only if nobody from the regular roster claimed the open slot first — see `subFlow.js`'s `escalateOverdueRequests()`.)

## 19. Player orientation page: resolved 2026-08-11

Kyle: "I want to build some type of 'getting started' or 'how to' page so someone can sit down and within a few mins understand the process and where to go to request blackout dates, request a sub, swap a week, direct player to player swaps, and all the features we've built. I know there is a lot there so maybe we break it down into smaller pieces." By this point the player-facing surface had grown large enough (confirm/sub emails, blackout dates, Request a Sub, Swap a Week, My Page, two schedule views, two calendar options, PDF, double-booking, five status badges) that there was no single place explaining any of it — a new player had to be told, or figure it out by clicking around.

One structural question was resolved before building: a single scannable page with a jump-link table of contents, or a hub page linking out to a separate page per topic. Kyle picked the single-page option — one URL, one nav link, still broken into short digestible sections.

`GET /help` renders `help.ejs`: pure static content (no DB query, no session context) with one section per topic, each linking to the real page it describes rather than duplicating instructions that could drift out of sync with the actual UI, plus a closing glossary table of what each status badge (`scheduled`, `confirmed`, `needs_sub`, `subbed_out`, `double_booked`) actually means. Added as the first link in the public nav, ahead of My Page, since it's meant to be where someone starts if they don't know where anything else is yet. See `CLAUDE.md`'s "Player orientation page" section for implementation detail.

**Follow-up, same conversation (2026-08-12): real screenshots turned out not to be possible.** Kyle's original ask for the help page included "good pictures of examples" of the real UI (choosing a blackout date, confirming, the reminder email, requesting a sub both from the email and the site, a player-to-player swap) rather than just prose. Attempted via a headless Chromium (Puppeteer) in the sandbox so screenshots would be pixel-accurate against the real production HTML/CSS, not a mockup — blocked by the sandbox's network allowlist (`storage.googleapis.com`, where Chromium's binary is hosted, returns `403 blocked-by-allowlist`), no system Chromium/Chrome available via `apt` either (no `sudo`, no cached package index), and no browser-automation tool (Claude in Chrome, computer-use) connected in this session. Left as an open item — either Kyle sends real screenshots from the live Pi-hosted site for proper placement/captioning, or a future session with a connected browser tool revisits it. Not asked to build a substitute (hand-drawn mockups) since that wasn't what was requested.

## 20. Admin process guide: resolved 2026-08-12

Companion ask in the same message as the player orientation page above: "Somewhere in the help page (admin items hidden from the players help) I'd like to display the whole process this scheduler takes from the admin perspective. I'd like to show the process of creating a new session (by the admin), creating your roster, sending out requests for blackout dates & scheduling the session."

Rather than gating a single shared page on session/auth state, `GET /admin/guide` lives under the already-authenticated `/admin` section as its own route — `requireAdmin` already blocks it from anyone not logged in, same as every other admin page, so there's no conditional-rendering logic that could leak admin content to a player if it were ever wrong. Content follows the actual chronological workflow (create a session → build the roster and set targets → collect blackout dates → "Schedule these players" → running it week to week → where to check things are working → the multi-session judgment call → archiving/deleting when done) rather than a topic list, since that's what someone walking through this for the first time actually needs. Added to the admin nav as "Guide," right after Dashboard. See `CLAUDE.md`'s "Admin process guide" section for implementation detail.

## 21. Email body font size and match-day visual banner: resolved 2026-08-12

Two related email-formatting asks from the same conversation. First: "I feel like the font is too small in the body of the email when sending out reminders and confirmation emails." Root cause: no template had ever set a `font-size` on its body content — every `<p>` relied on the recipient's mail client's own default for unstyled text, which reads small in several common clients (particularly Gmail's mobile app). Fixed once, centrally, in `email.js`'s `sendMail()` via a new `wrapEmailHtml()` that wraps the finished HTML in a single inline-styled `<div>` (17px, comfortable line-height) right before the actual send — every template still builds plain unstyled fragments same as before, so nothing can drift out of sync template-by-template, and any future template inherits the fix automatically just by going through `sendMail()`.

Second, folded into the same pass since it touches the same templates: see §22 below — Kyle's separate multi-session disambiguation ask specifically included "strengthen the email itself," which became `matchBanner()`, threaded into all 13 session-scoped email templates.

## 22. Multi-session visual disambiguation: resolved 2026-08-12

Kyle: "There are many sessions all at the same club. I'd like to brainstorm how to make it easy for players to know they are looking at one schedule vs another. For example, we have two courts on the same day, same club, same time. Court 2 and Court 4. It's very easy for someone to get confused and ask for a sub for court 2 when they really meant court 4." Explicitly framed as a brainstorm rather than a build request — four options were presented before writing any code: a confirmation step before Request a Sub/Swap naming the exact session, color-coded badges everywhere, a bigger "you are here" banner on every page, and a stronger email. Kyle picked three of the four and explicitly declined the fourth: "I like the color-coded session badges, 'you are here' banner and also to strengthen the email. I don't want to add another confirmation step in this process right now." No new checkpoint or blocking behavior was added anywhere — this is purely about making the existing `sessionPublicLabel()` text easier to notice, not adding friction to any flow.

New optional `sessions.color` field (admin-set via a native color-picker input on the Edit page) plus `email.js`'s `sessionColor(session)`, which falls back to a deterministic pick from a fixed palette keyed by session id when no color is set — so every session, including every one that predates this field, always has a stable, distinct color with zero admin configuration required. `partials/session_picker.ejs` (included at the top of every player-facing page that operates on "the current session") was redesigned from a plain `<select>` into a bordered "You're viewing" banner — colored dot, full session label, match day/time, in bold — which covers the banner ask on its own since it already sat at the top of every relevant page; a row of colored pill buttons underneath handles switching when more than one session is viewable, doubling as the color-coded badge set. `email.js`'s new `matchBanner(session, week)` drops the same colored, bordered treatment at the very top of the email body — before the greeting — threaded into all 13 session-scoped templates.

Verified end-to-end in the sandbox: confirmed the migration adds the column without data loss, confirmed `sessionColor()` returns an explicit color when set and a stable fallback otherwise, confirmed two sessions in the same scenario get visibly different colors, confirmed the real `/schedule` route renders the banner and switcher correctly, and confirmed a generated email banner contains the right color, label, and date/time. See `CLAUDE.md`'s "Session color" section for full implementation detail.

**Follow-up, 2026-08-12: My Page was missed.** Kyle noticed color showed up on "most of the pages" but not his bookmarked My Page. Root cause: that page builds its own per-session cards directly rather than including the shared session-picker partial (it spans every session a player's in, not one selected session), so it had already missed the earlier `sessionPublicLabel()` rollout too — the card header was still the bare internal session name with no color anywhere. Fixed directly in `me.ejs`: same colored left-border and dot treatment as everywhere else, `sessionPublicLabel()` in place of the bare name, and a day/time line that hadn't existed on this page before at all. Verified against a real two-session render (one draft, one scheduled) that both the draft-session notice and the scheduled session's card show their correct distinct colors and full labels.
