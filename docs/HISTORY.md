# Change history (moved out of CLAUDE.md on 2026-09-30)

Dated log of every real change, from 2026-09-15 on. Not loaded automatically: `grep -n` it for the feature you are touching and read only that section. New entries go at the end.

Older history (the original CLAUDE.md architecture notes, design decisions and dated entries before 2026-09-15) is in `docs/HISTORY_ARCHIVE.md`. Search there when this file has nothing on the feature, or when a code comment points at a section that isn't here.

### Player Behavior stats: a collapsible section on Activity Log (Kyle, 2026-09-15)

Kyle: "I'd like to build some player operating stats, not tennis stats. I'd like to keep track of how many times a player clicks on 'confirmed' after a 2nd reminder email. I'd like to know how many times a player needs a sub, or how many times we find a sub within the player roster vs the boarder sub list vs an unknown player. I'd like to know how many times a player never confirms their status for the week. Any other player behavior stats would be nice to know too." This is the fuller build-out of the "Player activity logging / breadcrumb" backlog item above (which the 2026-09-09 `admin_activity_log` action-tag work already partly addressed) — these are aggregate counts computed from the underlying tables directly, not a re-read of the log's own prose descriptions.

Asked (`AskUserQuestion`) where this should live, how the roster/broader-list/unknown-player split should be scoped, and which extra stats were worth adding. Kyle: put it at the top of Activity Log, collapsible so it doesn't take up room, pushing the real log table down; show the sub-source split both as a league-wide total and broken out per player ("Both"); and add self-arranged subs found, subs claimed for others, swap activity, and blackout self-reports while in there.

New module `services/playerBehaviorStats.js` — `playerBehaviorSummary(sessionId)` is the one entry point `GET /admin/activity-log` calls; `sessionId` is optional and reuses that page's own existing Session filter dropdown (blank = every session, all time) rather than adding a second filter control. Rendered as a collapsed `<details>` block in `views/admin/activity_log.ejs`, above the existing filter form/table, with a league-wide sub-source summary plus two per-player tables (confirmation & subs; other activity).

"Confirmed after 2nd reminder" is computed by joining a confirmed `week_assignments` row to `email_log` for a `category = 'followup_reminder'` row on that same week/player sent at or before `confirmed_at` — no new column needed, that data was already there. "Never confirmed" is a locked week where the assignment is still sitting at `status = 'scheduled'`.

The roster/broader-list/unknown-player split needed two small new columns, since neither fact was reliably re-derivable after the fact: `sub_requests.self_arranged` (`INTEGER NOT NULL DEFAULT 0`, additive migration via `ensureColumn` — every existing row defaults to 0, correctly, since the code that sets it didn't exist before this change) is stamped 1 only by `subFlow.js`'s `arrangeSelfSub()` ("I found a sub"), never by the normal fan-out or an admin flag — needed because a self-arranged request can still escalate and gain more offers later, so counting offer rows after the fact stops being reliable. `sub_offers.was_new_person` (same migration pattern) is stamped 1 only on the single offer `arrangeSelfSub()` creates for a genuinely-new person (not matched against `players` or `broader_sub_list` by email) — everything else (roster fan-out, escalation, a self-arranged pick of someone already known) leaves it 0. A filled request's winning (`status = 'claimed'`) offer is then bucketed: `was_new_person` → unknown player; else `candidate_player_id` set → roster; else → broader sub list. "Subs claimed for others" resolves the filling player directly via `week_assignments.replaces_assignment_id`, not by re-deriving it from the offer, so it works identically for every fill path.

Deliberately excluded from the source-bucket totals and from "subs claimed for others": an admin's own direct placement (Reassign/one-time-sub/Correct-player, all going through `recordAdminReassignAsSub()`, `status = 'resolved_manually'`) — that's an admin decision, not player behavior — though it still counts toward that player's "subs needed." `resolved_double_booking` requests are excluded entirely, matching the existing Sub History table's own convention.

**Known edge case, explicitly accepted by Kyle rather than fixed:** if a self-arranged invite to a brand-new person times out and the request escalates (that person is already added to the session's sub list by then), they could theoretically get re-offered via the escalation and claim through *that* link instead of their original invite — the escalation-created offer doesn't carry `was_new_person`, so it would bucket as "broader" instead of "unknown." Kyle: "We are going to count the brand-new sub as a one off. We are going to assume if there was coordination with that brand new sub then they probably have confirmed with the player they are subbing for." Not worth engineering around.

**Verified via a synthetic in-memory `node:sqlite` database** (hand-built fixture data exercising every bucket — roster, broader list, unknown, admin-placed, double-booking-excluded — with asserted expected counts) rather than the connected folder's own `data/tennis.db`: `device_bash`'s mount was down this session (same issue noted in the "Sub History" fix above), so no scratch-sandbox live-server run was possible either. Also rendered the actual `activity_log.ejs` via the `ejs` package with both populated and empty-state data to confirm it compiles and the conditionals render correctly. `node --check` passed on every edited/new `.js` file. Touched/added files: `db/schema.sql`, `db/index.js`, `services/subFlow.js`, `services/playerBehaviorStats.js` (new), `routes/admin.js`, `views/admin/activity_log.ejs`.

No data backfill needed — both new columns default to 0 and the facts they capture (self-arranged, was-new-person) genuinely didn't exist before this code did. The schema migration runs automatically on next boot via the existing `ensureColumn` pattern, same as every other column added this way — no manual `node -e` step required on the Pi, just the normal WinSCP-and-`pm2 restart` deploy for the code itself.

### "Weeks scored" renamed to "matches scored" on the win% leaderboards (Kyle, 2026-09-15)

Kyle: "In all the stats, where it says 'weeks scored' it needs to be changed to 'matches scored' as some players might play more than once in a week." Label-only fix, not a logic bug — `sessionWinPercentLeaderboard()`/`overallWinPercentLeaderboard()` in `services/gameScores.js` already `COUNT(*)` qualifying `week_assignments` rows, i.e. one per scored match, which is the right count either way. The name was just wrong: `overallWinPercentLeaderboard()` is the all-time, cross-session board, so a player genuinely can score twice in the same calendar week there (two different sessions both had a match that week, or a `resolved_double_booking` correction), which "weeks" undersold even when the number itself was already correct.

Renamed the SQL alias and returned field (`weeksScored` → `matchesScored`) in both leaderboard functions, and the "Weeks scored" header text / `row.weeksScored` template references in `views/leaderboard.ejs`, `views/admin/all_stats.ejs`, and `views/admin/stats.ejs`. No schema or query-logic change.

Verified with `node --check` on `gameScores.js` and `ejs.compile()` on all three touched views. Touched files: `services/gameScores.js`, `views/leaderboard.ejs`, `views/admin/all_stats.ejs`, `views/admin/stats.ejs`.

### Ball-duty reminder email when games-won scores are missing (Kyle, 2026-09-15)

Kyle: "if the # of games one is not entered within X amount of hours, the person that was scheduled to bring balls should get a reminder email to enter in scores for the week. The X hours needs to be defined on the session page and should default to 24 hours." Read "# of games one" as "games won" (the existing per-player entry this whole feature area is about) — Kyle didn't object when this assumption was reported back.

New per-session column `sessions.games_won_reminder_lead_hours` (`INTEGER NOT NULL DEFAULT 24`, additive `ensureColumn` migration, no "0 = off" escape hatch — same pattern as `follow_up_lead_hours`/`admin_report_lead_hours`/`escalation_lead_hours`; turning the reminder off entirely means turning `games_won_enabled` off for the session), editable on the session form right under the existing games-won-enabled checkbox, defaulting to 24 for new sessions and backfilling to 24 for every existing one on next boot so nobody's session silently goes without the new pass.

New `processScoreReminders()` pass in `services/cron.js`'s `tick()` (runs every 60s alongside the other reminder passes). For every active/scheduled regular session with `games_won_enabled`, it reuses the existing `gameScores.scoreEntryWeeksForSession(sessionId)` — the same function that already defines "who's expected to have a score this week" (`week_assignments.status IN ('scheduled','confirmed')`) and already computes `missing_count`/`scoreable_count` per locked week — rather than re-deriving that logic. A week is due once `match_time + games_won_reminder_lead_hours` has passed, it still has a `missing_count > 0`, and it has a `ball_duty_player_id` set (no ball-duty player, no reminder — nobody to send it to). One reminder per week, deduped the same way every other cron reminder is: an `email_log` lookup on `category = 'score_reminder'` + `related_week_id` + `to_email`, not a separate "_sent_at" column.

New `email.sendScoreReminder()` — plain public link to `/scores?session=&week=` (no token, same as `sendBlackoutNotice()`), names the missing-count, and is explicit that any player can fill in any box on that page so it's not exclusively on the ball-duty person to personally enter every score — just a nudge to get it done. New `email_log.category` value `score_reminder`, added to that column's inline comment in `schema.sql`.

**Verified with a synthetic in-memory `node:sqlite` fixture** (two locked weeks — one with a player still missing `games_won` and a ball-duty player set, one fully entered) exercising `gameScores.scoreEntryWeeksForSession()` directly and asserting `missing_count`/`scoreable_count`/`ball_duty_player_id` come back correct, plus the reminder-due timing math mirrored against the actual `cron.js` logic (lead-hours-after-match-time gate). `device_bash`'s mount was down again this session so no live-server run was possible. `node --check` passed on every edited `.js` file; `ejs.compile()` passed on `session_form.ejs`. Touched files: `db/schema.sql`, `db/index.js`, `services/email.js`, `services/cron.js`, `views/admin/session_form.ejs`, `routes/admin.js`.

No data backfill needed beyond the `ensureColumn` default (every existing session picks up 24h on next boot). Normal WinSCP-and-`pm2 restart` deploy, same as always.

### Ball-duty score reminder added to the "send a test email" template list (Kyle, 2026-09-15)

Kyle: "Can you make sure #2 email gets added to the templates for sending a test email." — referring to the ball-duty scores-still-needed reminder built earlier the same session. That feature added a brand-new email (`email.sendScoreReminder()`) but never wired it into `services/testEmail.js`'s `TEMPLATES` map, so it was invisible on the admin Send Email page's "send a test of any template" list.

Added a `score_reminder` entry to `TEMPLATES` (label "Ball duty — scores still needed reminder"), and added `'sendScoreReminder'` to the `NEEDS_SESSION_WEEK` set so the test harness resolves a real player's own current session/week the same way it does for the other per-week reminder templates. `missingCount` in the test build is a synthetic `2`, same spirit as `adhoc_reminder`'s synthetic `stillNeeded: 2` — a real count only ever comes from `gameScores.scoreEntryWeeksForSession()` at actual cron send time, not worth re-deriving just for a preview. No route or view changes needed — `GET/POST /admin/email` and `custom_email.ejs` are entirely driven off `testEmail.listTemplates()`/`testEmail.TEMPLATES`, so a new entry there is automatically picked up.

Verified with `node --check`, and by hand-checking `sendScoreReminder`'s real parameter names (`recipient`, `week`, `session`, `missingCount`, `test`) against the new template's `build()` return shape — they match exactly. `device_bash`'s mount was still down this session, so no live send/HTTP round-trip through the admin page was possible. Touched file: `services/testEmail.js`.

### Admin-placed subs now count as real subs in Player Behavior stats (Kyle, 2026-09-15)

Kyle: "Let's count a sub as a sub, no matter if it got a sub_offers record tied to it or an admin did the coordination." Direct reversal of the deliberate exclusion built into the Player Behavior stats feature earlier the same session — this is exactly the Ed Bourneuf (excluded) vs. Jim Newell (counted) case from Kyle's earlier question, and the answer was "working as designed, want it changed?"

`playerBehaviorStats.js`'s `subRequestStats()` now treats `sub_requests.status = 'resolved_manually'` (an admin's own direct Reassign/one-time-sub/Correct-player placement) the same as `status = 'filled'` (a self-service claim): both count toward the roster/broader-list/unknown-player source totals and "subs claimed for others," not just toward `subsNeeded` as before. `resolved_double_booking` is still excluded entirely (unchanged) — that remains a schedule correction, not a sub.

The hard part: a `resolved_manually` row has no `sub_offers` winner to read a source from at all (an admin picked the replacement directly, no fan-out/claim happened), and its filler can't always be found via the direct `replaces_assignment_id` link either — a plain in-place Reassign that closes an already-open request overwrites `week_assignments.player_id` on the *same* row rather than inserting a new one, and some pre-2026-09-10 admin placements (Ed Bourneuf's exact case) were never linked at all. Pulled the Stats page's own Sub History "Filled by" column's three-tier resolution (real link → in-place-reassign detection → same-week/team/court legacy heuristic) out of `admin.js` into a new shared `subFlow.resolveSubRequestFiller()`, so both places use the identical logic instead of risking two heuristics quietly disagreeing. Once a `resolved_manually` filler is found, it's bucketed by identity instead of by offer (there's no offer to read): the "One-time sub" flow's `@no-email.invalid` placeholder address means unknown/new person, an email matching an existing `broader_sub_list` entry means broader list, anything else means roster.

Updated `activity_log.ejs`'s description text for the league-wide sub-source summary, which used to explicitly say admin placements were excluded — now says the opposite.

**Verified** with a synthetic in-memory `node:sqlite` fixture covering every path: self-service roster/broader/unknown claims (regression — unchanged), an Ed-Bourneuf-style admin placement with the link missing (resolves via the tier-3 heuristic), a plain in-place Reassign closing an open request (tier 2), a one-time sub with the placeholder email and an intact link (tier 1, buckets unknown), an ambiguous tier-3 case with two equally-plausible candidates (correctly resolves to nobody rather than guessing, still counts toward `subsNeeded`), and `resolved_double_booking` staying fully excluded. Separately verified the extracted `resolveSubRequestFiller()` is byte-for-byte behavior-identical to the original inline `admin.js` heuristic across the same tier/edge-case matrix, so the Sub History table's own numbers don't change. `device_bash`'s mount was down again this session, so no live-server run was possible; `node --check` passed on every edited `.js` file and `ejs.compile()` on `activity_log.ejs`. Touched files: `services/subFlow.js`, `services/playerBehaviorStats.js`, `routes/admin.js`, `views/admin/activity_log.ejs`.

### "Admin confirmed" column added to Player Behavior's Confirmation & subs table (Kyle, 2026-09-15)

Kyle: "Let's add one more stats to the confirmation & sub, by player stats. Let's add an 'admin confirmed' column where the admin confirms a player by the admin panel." Refers specifically to the session-detail page's "Mark confirmed" button (`POST /sessions/:id/weeks/:weekId/mark-confirmed/:assignmentId`) — an admin vouching for a player directly (e.g. the player called and said they're in) rather than the player clicking their own Confirm link. That route already set `status='confirmed'`/`confirmed_at`, with nothing distinguishing it from a real player click.

New column `week_assignments.admin_confirmed` (INTEGER NOT NULL DEFAULT 0, additive `ensureColumn` migration), stamped 1 only by the "Mark confirmed" route — the one and only place it's set. Deliberately NOT set by the one-time-sub/sub-list-reassign/Correct-player flows, which also write `status='confirmed'` directly — those are placing a substitute, a different action from confirming an already-scheduled player, and Kyle's ask was specifically about the latter.

`playerBehaviorStats.js`'s `confirmTimingStats()` now pulls `admin_confirmed=1` rows out into their own bucket FIRST, before splitting the rest into "confirmed on 1st reminder" vs. "confirmed after 2nd reminder" — an admin's direct confirm isn't the player's own response timing at all, so leaving it in either reminder bucket would misattribute the admin's action as player responsiveness (this matters concretely: a player an admin confirmed AFTER a follow-up email had already gone out would otherwise have silently counted as "confirmed after 2nd reminder," which is backwards). The three buckets are now mutually exclusive and exhaustive of every confirmed row. New "Admin confirmed" column added to the Confirmation & subs table in `activity_log.ejs`, between "Confirmed after 2nd reminder" and "Never confirmed," with the table's description text updated to explain it.

**Verified** with a synthetic in-memory `node:sqlite` fixture: a normal before-followup confirm, a normal after-followup confirm, and — the case that actually exercises the fix — an admin-confirmed row where a follow-up email HAD already gone out before the admin's confirm timestamp, confirming it lands only in the admin-confirmed bucket and not "after 2nd reminder." Also confirmed the field surfaces correctly through `playerBehaviorSummary()`'s merged table. `device_bash`'s mount was down again this session, so no live-server run was possible; `node --check` passed on every edited `.js` file, `ejs.compile()` on `activity_log.ejs`. Touched files: `db/schema.sql`, `db/index.js`, `routes/admin.js`, `services/playerBehaviorStats.js`, `views/admin/activity_log.ejs`.

No data backfill needed — every existing confirmed row defaults to `admin_confirmed=0` (an admin-vouched confirm from before this column existed can't be told apart from a real player click after the fact, and there's no reliable way to backfill it; going forward every new "Mark confirmed" click is tracked correctly).

### Player-pair scheduling constraints: "never together" / "always together" (Kyle, 2026-09-23)

Kyle: "when generating the schedule, you can enter in constraints with players. For example. Player 1 does not ever play the same week as player 2. Player 3 plays the same week as player 4. This is not exclusive to team a or team b, this is week to week, so if player 1 is not to be scheduled ever with player 2, then doesn't matter if they are on the same team or playing each other, they don't play on the same court, ever." A new hard constraint type on top of the existing targets and blackout dates, entered per pair from a new session-scoped admin page.

New table `player_constraints` (`session_id`, `player_a_id`, `player_b_id`, `type` — `never_together` | `always_together`), session-scoped rather than global like `blackout_dates` — who has to (or can't) play with whom is a fact about a particular session's group, not a universal calendar fact. `services/playerConstraints.js` normalizes every pair to `(lower id, higher id)` before insert/lookup so a pair can't be entered twice in reversed order, and exposes `getConstraintsForSession()` shaped straight into the `[[a,b], ...]` arrays the engine takes.

The hard part was the engine side. "Never together"/"always together" aren't expressible as simple per-player max-flow edges the way blackout dates and target counts are — max-flow can decide *how many* weeks a player plays and *which* ones independently per player, but it has no native way to couple two players' week-choices together (always-together) or keep them mutually exclusive (never-together) without generalized-flow machinery that's overkill for a roster this size. Instead, `scheduler/engine.js` keeps `solveAssignment()` exactly as-is (still the thing that guarantees every target and blackout date is honored), then folds constraint-satisfaction into the existing simulated-annealing partner-variety pass (`optimizePartnerVariety()`): both kinds of violation are checkable per-week in isolation (never-together = both present in the same week; always-together = exactly one of the two present), so they're tracked incrementally exactly like the existing `partnerCounts` objective, and weighted by a `CONSTRAINT_PENALTY` (1,000,000) that dwarfs the partner-variety objective so the search always prefers fixing a violation over improving pairing spread, however bad that makes the spread. When any pair constraints are present, `generateSeasonSchedule()` runs the annealing pass with more iterations and up to 6 independent random-seed attempts, keeping whichever gets closest to zero violations (a single seed can land in a bad basin; a few tries reliably finds zero for realistic rosters).

Structural impossibilities are caught up front, before wasting any search time: `validateConstraints()` checks a pigeonhole bound for never-together (`targetA + targetB > weeks.length` means they're provably forced to overlap), that an always-together pair has equal targets (they play the exact same weeks, so must want the exact same count), that an always-together pair has enough weeks where *neither* is individually blacked out to hit that target, and that a pair isn't marked both never- and always-together at once (contradiction). If the search still can't reach zero violations after all attempts (a tight-but-not-provably-impossible constraint set), `describeRemainingViolations()` reports exactly which weeks and which pair failed — same "never silently approximate, always report a structured conflict" philosophy as every other infeasibility path in this engine. Multiple always-together pairs chain correctly with no special union-find grouping needed — enforcing "same weeks as" pairwise for A-B and B-C is transitively sufficient to converge all three onto the same weeks, since equality is transitive.

New admin page `GET/POST /admin/sessions/:id/constraints` (`views/admin/constraints.ejs`), same shape as the existing blackout-dates page: pick two players and a constraint type, see the current list, remove one. Linked from session detail ("Manage player constraints," next to "Manage blackout dates") and from the "Regenerate schedule" card on the session edit page. `scheduleRun.js` fetches a session's constraints and passes them into `generateSeasonSchedule()` on every run; any resulting conflict (structural or a search failure) is enriched with real player names the same way `player_target_unreachable`/`combined_conflict` already are, and any named weeks get flagged `needs_attention` the same way understaffed/conflicted weeks already are.

Deliberately scoped to season schedule generation only — a manual Reassign or the sub/swap flows don't check these constraints, so an admin overriding a slot by hand could still put a never-together pair on the same court. Noted as a gap, not built, since Kyle's ask was specifically about schedule *generation*.

**Verified**: added 7 new cases to `src/scheduler/engine.test.js` covering a feasible never-together pair (confirmed zero overlapping weeks across all 17, every target still hit exactly), a pigeonhole-infeasible never-together pair (rejected up front with the right conflict type), a feasible always-together pair (confirmed identical week-sets, exact target), a target-mismatched always-together pair (rejected up front), and a contradictory never+always pair on the same two players (rejected up front) — all passing alongside the original 8 tests, unchanged. Also booted the real app in a scratch sandbox (`SQLITE_PATH` pointed at a throwaway `node:sqlite` file, a seeded admin login and an 8-player/6-week test session) and drove the actual `POST /admin/login` → `POST /admin/sessions/:id/constraints` → `POST /admin/sessions/:id/schedule` flow over real HTTP: confirmed the duplicate-pair rejection, the enriched infeasible-conflict message (real player names) when the constraint was too tight for the roster, and — once loosened to a workable 8-player roster — a real generated schedule where the constrained pair never shared a week, verified straight from `week_assignments`. `node --check` passed on every edited `.js` file. Touched files: `db/schema.sql`, `scheduler/engine.js`, `scheduler/engine.test.js`, `services/playerConstraints.js` (new), `services/scheduleRun.js`, `routes/admin.js`, `views/admin/constraints.ejs` (new), `views/admin/session_detail.ejs`, `views/admin/session_form.ejs`.

### Season sign-ups: self-service, percentage-based roster commitment (Kyle, 2026-09-23)

Kyle: "Before blackout dates are sent out, a player who is going to be on the roster can sign up for a session and declare how much they want to play. The percentages need to be defined by an admin of a session. Typically they are full time = 75%, half time = 50% and quarter time = 25% of the weeks. Based on the # of weeks during a session, that needs to be calculated so the players know how many weeks they are singing up for. The calculations also need to add up so if there are 10 players and 17 weeks, not everybody can sign up for a full time slot. That needs to be flagged on the admin side to ask players to slide up or down in percentage so the numbers work out to the # of slots."

Before this, `session_players.target_games` (each player's season commitment) only ever got set by an admin hand-typing a number on `session_form.ejs`'s roster table (see "`session_players.original_target`" and "Roster picker" above). This adds a self-service alternative that feeds the same field, without replacing the hand-typed path — an admin can still use either one, or mix (sign up some players, hand-type the rest).

**Design decisions, asked directly rather than assumed (see the three-question check-in this session opened with):**
- **Sign-ups stay separate from the real roster until the admin applies them**, rather than writing `session_players` directly the moment a player picks a tier. Two new tables: `session_signup_candidates` (who the admin picked as "going to be on the roster" — mirrors the ad-hoc roster's invite-list pattern, checked off on a new page rather than derived from `session_players`, since at this point in the workflow the real roster doesn't have target numbers yet) and `session_signups` (one row per player's current tier + computed `weeks`, `applied_at` NULL until the admin's explicit "Apply to roster" action, reset to NULL again on any re-save so the review page can tell "applied and unchanged" apart from "changed since, needs re-applying"). `src/services/signup.js`'s `applySignupsToRoster()` mirrors `admin.js`'s `saveRoster()` INSERT-vs-UPDATE shape exactly, including the same original_target-snapshotted-once-at-first-enrollment rule.
- **Fractional weeks round to the nearest whole week** (`weeksForPercent()`) — 75% of 17 is 12.75, which becomes 13, not always floored or always ceiled.
- **The candidate list is admin-picked, not "every active player"** — matches Kyle's own phrasing ("a player who is *going to be on the roster*") and the existing ad-hoc-roster checkbox pattern, rather than opening the sign-up page to the whole player pool.

**Percentages are per-session and admin-editable** (`sessions.signup_pct_full/half/quarter`, `ensureColumn`-backfilled to 75/50/25 for every existing row — Kyle's own stated "typical" numbers, so an untouched session behaves exactly as if an admin had filled those in by hand), not a fixed global default. Changing them only affects sign-ups made or re-saved from then on; an existing sign-up keeps its already-computed `weeks` until it's resubmitted or an admin re-sets it.

**The capacity flag** Kyle asked for — `signup.capacitySummary()` computes `totalSlots` (this session's total match weeks, via the same `ensureWeeksExist()`/week-count the blackout pages already call before scheduling exists, x `players_per_week`) against the sum of every recorded sign-up's `weeks`, exactly the same "does it add up" math `session_form.ejs`'s own live `recalc()` widget already does for hand-typed targets — just asked of sign-ups instead. Surfaced in two places, matching this app's standing "warn, don't block" pattern for every other judgment call (overlap enrollment, understaffed weeks): a full breakdown + per-player table on the new `GET /admin/sessions/:id/signups` page, and a compact flag card on `session_detail.ejs` (only while the session is still `draft` — once scheduled, the roster is whatever it is and the dedicated Sign-ups page is where that gets reviewed) with a "how many weeks over/under" count and a link to go fix it. Nothing about applying or scheduling is actually blocked by an imbalance — it's the admin's call, same as every other soft warning in this app.

**Public side** (`GET/POST /signup`, `views/signup.ejs`) is a near-exact mirror of the existing `/blackout` self-service page: `resolveSession(req, { includeDraft: true, regularOnly: true })` (ad-hoc sessions have no target_games concept for this to feed), `ensureWeeksExist()` on demand, saves directly with no email-confirmation step, same honeypot + rate-limiter treatment (`signupLimiter`, same 20/hour/IP shape as `blackoutLimiter`), locked once the session leaves `draft`. `src/services/email.js`'s `sendSignupNotice()` mirrors `sendBlackoutNotice()` for the "here's your link" email, admin-triggered from the new Sign-Ups page's "Notify candidates" button (defaults to only nudging whoever hasn't answered yet, same repeatable-action shape as `notify-blackouts`).

**Admin side**: new `GET/POST /admin/sessions/:id/signups` routes (`views/admin/signups.ejs`) — tier percentage config, candidate checkbox picker, notify button, capacity summary + per-player sign-up table with an admin override (change/remove any player's tier directly, same "admin can always fix it" latitude as every other override in this file) and the "Apply to roster" action. Linked from `session_detail.ejs`'s action row ("Manage sign-ups," next to "Manage blackout dates") and from a one-line pointer on `session_form.ejs`'s roster section. Also documented in `help.ejs` (new "Signing up for a season" section, right before "Blackout dates" since it happens first chronologically), `admin/guide.ejs` (new §2b), and the session-form order-of-operations cheatsheet.

**Verified**: `node --check` on every edited `.js` file; booted the real app in a scratch sandbox (`rsync`-copied project, fresh `npm install`, seeded example data via `seed-example.js`, a throwaway draft session created directly against `node:sqlite`). Confirmed live: `weeksForPercent()` against the exact 17-week/75-50-25 example from Kyle's own message (13/9/4); a fresh draft session with 9 candidates all signing up full time correctly flagged as oversubscribed (`capacitySummary().delta` positive, matching the manual total-slots math); `applySignupsToRoster()` correctly inserting new `session_players` rows with `original_target` snapshotted, and correctly detecting + re-applying a changed tier on a second pass (added vs. updated names reported separately); the real HTTP flow end to end (`POST /admin/login` → `GET/POST /admin/sessions/:id/signups/*` → `GET/POST /signup` → `POST .../apply`) with the capacity flag rendering correctly on both the Sign-Ups page and the session-detail card once oversubscribed via four admin-override sets; confirmed existing pages (`/admin/sessions/:id/blackouts`, `/admin/sessions/:id/edit`, `/help`) still render with no regressions; re-ran `npm run test:scheduler` (all 15 existing scheduling-engine cases, unrelated to this feature) with no failures. Touched files: `db/schema.sql`, `db/index.js`, `services/signup.js` (new), `services/email.js`, `routes/public.js`, `routes/admin.js`, `views/signup.ejs` (new), `views/admin/signups.ejs` (new), `views/admin/session_detail.ejs`, `views/admin/session_form.ejs`, `views/partials/header.ejs`, `views/help.ejs`, `views/admin/guide.ejs`.

### Season sign-ups: a "sub only" option, downgrading a roster spot (Kyle, 2026-09-23)

Follow-up to "Season sign-ups" above, same day. Kyle: "A player might be on the roster but does not want to play that session so they might be downgraded to a sub. Can we add a sub option?"

Added a fourth choice on `/signup` alongside full/half/quarter: **Sub only (not on the roster)**. Unlike the three percentage tiers, it isn't a fraction of the season — `signup.js`'s `submitSignup()` always computes it as 0 weeks, and it has no `session.signup_pct_*` column of its own (`PERCENT_TIERS` is the new, narrower list the percentage-config form and math actually use; `TIERS` is the full four-option list everything else — the tier dropdowns, the public radio buttons — iterates over).

The real behavior change is in `applySignupsToRoster()`: applying a `sub` sign-up now **removes** any existing `session_players` row for that player (rather than setting a target) and adds them to `session_sub_players` instead — the same table "Manage subs" already uses for a session's own sub candidates (`subFlow.js`'s `sessionSubList()`). The reverse also works: applying a real tier for someone currently only in `session_sub_players` cleans that row up, so a player who changes their mind isn't left listed as both a roster player and a sub candidate. Three transitions, one function: brand-new sub sign-up (added to `session_sub_players`, never touched `session_players`), sub → real tier (moved onto the roster, sub row removed), real tier → sub (existing roster row deleted, added to `session_sub_players`) — all three return their own named list (`added`/`updated`/`movedToSubs`) so the apply route's flash message and activity-log entry can say exactly what happened, not just a bare count.

`capacitySummary()` gained `optedForSub` (sign-ups with `tier = 'sub'`, already contributing 0 toward `signedUpWeeks` by construction) — shown as its own line on the admin Sign-Ups page and distinct from "hasn't signed up yet," since opting for sub is a real answer, not a non-response.

**Verified**: in a scratch sandbox, walked all three transitions directly against `signup.js` — a fresh sub sign-up left `session_players` untouched and added a `session_sub_players` row; switching that same player to full time on a second apply correctly added them to `session_players` and removed the sub row; downgrading a different, already-enrolled player to sub on a third apply correctly deleted their `session_players` row and added them to `session_sub_players` — matching Kyle's own "on the roster... downgraded to a sub" framing exactly. Confirmed over real HTTP too: the public sign-up page renders the new radio option and the "you opted to be a sub" confirmation text, and the admin Sign-Ups page renders the new "Opted to be a sub instead" line with the right name. Re-ran `npm run test:scheduler` (unaffected, all passing). Touched files: `services/signup.js`, `routes/public.js`, `routes/admin.js`, `views/signup.ejs`, `views/admin/signups.ejs`, `views/help.ejs`.

### Season sign-up notice added to the "Send Email" test-template list (Kyle, 2026-09-23)

Kyle: "In the send custom email 'test a template' on the admin panel, can you make a template for the email to be sent to players asking them how much they want to play?" — `sendSignupNotice()` (see "Season sign-ups" above) went live without a matching entry in `testEmail.js`'s `TEMPLATES` map, so there was no way to preview it from Admin -> Send Email the way every other real template already can be (Kyle, 2026-09-01's original "test any template" feature).

Added `signup_notice` to `TEMPLATES` (label "Season sign-ups open — notify candidates"), mirroring `blackout_notice` exactly — same `build(ctx) => ({ recipient: ctx.player, session: ctx.session, test: true })` shape, since `sendSignupNotice()` only ever needs a recipient and a session, same as `sendBlackoutNotice()`. Added `'sendSignupNotice'` to `NEEDS_SESSION_WEEK` so `sendTestEmail()` looks up a real session for the chosen player before building the preview (a bare "any session/week in the system" fallback, same as `blackout_notice`, so a test send never fails just because the test player isn't enrolled anywhere themselves). `listTemplates()`/`custom_email.ejs` are both fully generic over the `TEMPLATES` map, so nothing else needed touching for it to show up in the dropdown.

**Verified**: in a scratch sandbox, confirmed the new option renders in the Send Email page's template dropdown, and a real `POST /admin/email` with `recipient_type=template_test&template_key=signup_notice` logged a `[TEST] Sign up for …` email (dev-mode console log, no SMTP configured in the sandbox) with `category = 'test'`, same as every other test send. Re-ran `npm run test:scheduler` (unaffected, all passing). Touched file: `services/testEmail.js`.

### All-time win % leaderboard skewed toward low-sample players — minimum-matches qualifier (Kyle, 2026-09-23)

Kyle, looking at his real production data: "I'd like to display the All-time win leaderboard in a different way. For example, Ed B has a win % of 57.1%. He's only played 21 games. He will probably not play any more games the whole season as he's a sub but he's got a very high % of win. Other players have played 79, 82, 60+ games. I think it's a bit skewed towards players with a low games played and matches scored." `services/gameScores.js`'s `overallWinPercentLeaderboard()` (see "Win %-based second leaderboard" above) ranked purely by win percentage with no floor at all, so a small, lucky sample could sit above a full season of solid play with nothing to distinguish the two in the table itself.

Discussed the fix with Kyle directly rather than guessing at a threshold. First offered a minimum-games-played floor; Kyle's own correction: "I like option 1 but we have a 17 week session. We are only in week 3 so far. The minimum someone plays is 4 times, so it needs to be more than 40, but maybe it's matches scored and not a min number of games?" — right on both counts. A fixed games-count floor would need re-tuning as the season (and the all-time board, which never resets) progresses, and "games" isn't even a stable unit across matches of different lengths — **matches scored** is the right denominator, since it's a count that means the same thing regardless of how long any one match ran.

`gameScores.js` gained `MIN_MATCHES_FOR_WIN_PCT` (default `2`, deliberately small — early enough in a season that most rostered players clear it quickly, while still ruling out a single lucky match) and `overallWinPercentLeaderboard()` now tags every row with `qualified: r.matches >= minMatches`. Nobody is ever dropped from the page — a sub with one great match still has real, correct numbers — they're just split into a second, clearly-labeled table. `public.js`'s `/leaderboard` route filters the tagged rows into `overallWinBoard` (qualified, ranked) and `overallWinBoardBuilding` (not yet), and `leaderboard.ejs` renders them as two sections: "All-Time Win % Leaderboard" for the first, and "Still building a sample (fewer than N matches scored)" for the second, right below it.

**Follow-up the same day, also explicitly approved by Kyle.** Asked (`AskUserQuestion`) two things after the fix above shipped: whether the new threshold needed documentation anywhere players would find it, and whether it should be a hardcoded constant or a per-session admin field. Kyle selected both offered options — make it per-session, and document it in `/help`.

**Per-session field.** `sessions.min_matches_for_win_pct` (`INTEGER NOT NULL DEFAULT 2`, additive `ensureColumn` migration — a plain integer literal default, so no separate-`UPDATE` backfill workaround needed) replaces the hardcoded constant as the real, effective value — `MIN_MATCHES_FOR_WIN_PCT` in `gameScores.js` is now documented as a fallback default only (used when a session row somehow predates the migration), and `overallWinPercentLeaderboard()` takes an optional `minMatches` parameter defaulting to that constant. Same "configurable, not hardcoded" pattern as every other lead-hours/threshold field on this table (`follow_up_lead_hours`, `admin_report_lead_hours`, `escalation_lead_hours`, `games_won_reminder_lead_hours`) — new `invalidMinMatchesForWinPct(b)` validator in `admin.js` (allows `0`, unlike the lead-hours validators, since "no minimum" is a legitimate choice here — only rejects negative or non-integer values), wired into both the create and update routes' validation/INSERT/UPDATE, a `SESSION_FIELD_LABELS` entry for the session-update activity-log diff, and a new field on `session_form.ejs` right under the existing "Ball duty scores reminder" field.

The one real design wrinkle: the all-time win% board is explicitly cross-session (it sums every session anyone's ever played in), so there's no single session that "owns" the threshold the way there is for `follow_up_lead_hours` or similar. Resolved by having `public.js`'s `/leaderboard` route apply the *currently-selected* session's own value (from the existing session picker) as the cutoff for the all-time table shown alongside it — so switching which session is selected can shift where the all-time cutoff falls. Documented as a deliberate tradeoff in both `gameScores.js`'s and `public.js`'s comments, rather than inventing a separate, session-independent "global" setting. The one other call site (`admin.js`'s cross-session Stats Summary page, `GET /admin/stats`) deliberately keeps using the fallback default with no session-specific argument, since that page aggregates every active session at once with no single session in context to draw a value from — documented in a comment there too.

**`/help` documentation.** New `#scores` section ("Scores & Leaderboard"), added between the existing Player Stats and Pickup games sections (and in the jump-link table of contents), covering: the group score-entry grid vs. the per-player page, how tiebreakers count, the 24-hour self-edit window, the two leaderboard boards (total games, win %) and their all-time counterparts, and — the specific gap Kyle asked about — an explicit explanation of the qualification threshold: a player below the per-session minimum shows up in a separate "still building a sample" list rather than the ranked table, with their real numbers intact, until they cross it.

**Verified**: `node --check` passed on every edited `.js` file (`gameScores.js`, `public.js`, `admin.js`, `db/index.js`). `session_form.ejs` and `help.ejs` were checked for balanced `<div>`/`<h2>` tag counts (217/217 and 20/20 respectively) rather than a full EJS compile, since `node_modules` wasn't available in the working sandbox this round — worth a quick real page-load check by Kyle once deployed. Per this project's standing rule, no live-server verification was run against the connected `data/tennis.db`. Touched files: `db/schema.sql`, `db/index.js`, `services/gameScores.js`, `routes/public.js`, `routes/admin.js`, `views/admin/session_form.ejs`, `views/help.ejs`.


### Stats rework: session / season / master leaderboards, win % and games-per-match graphs, master reset, ad-hoc score entry (Kyle, 2026-09-25)

Kyle's request: graphs on top of the existing leaderboards (cumulative win % per player by week; average games played per match per session), plus rules for when stats start and stop so the all-time board can be reset (e.g., after the indoor season) without losing history and keep accumulating for future sessions. Settled through discussion before building: three tiers of board, and "stats off" means nothing feeds the season or master.

**Three tiers.** *Session* board (one session's scores) → *Season* board (an admin-named group of sessions, e.g. "Indoor Frontenac 2026"; a season can hold one or many sessions, including ad-hoc ones) → *Master* board (every session and player, with a resettable start date). All logic lives in the new `services/statsBoards.js`; `gameScores.js` keeps the per-session queries.

**Inclusion rules** (`statsBoards.js` `scopeSql`): session = all scored rows minus that session's exclusions; season = sessions in the season with `games_won_enabled=1` and `count_toward_season=1`, minus season exclusions, and minus a player's scores from any session they're excluded from (a session exclusion also removes them from the season); master = every `games_won_enabled=1` session with `match_date` on/after the latest non-undone reset, no exclusions at all (exclusions never touch master). A player dropped from a *later* session keeps their earlier-session stats in the season. Win % still counts a row only when games won and the court's shared games played are both entered and games played > 0, and the minimum-matches qualifier applies to every tier (per-season `min_matches_for_win_pct`, `app_settings.master_min_matches_for_win_pct` for master).

**Schema** (additive; `schema.sql` + `ensureColumn` in `db/index.js`): tables `seasons`, `session_stat_exclusions`, `season_stat_exclusions`, `master_stat_resets`; columns `sessions.season_id`, `sessions.count_toward_season`, `app_settings.master_stats_visible`, `app_settings.master_min_matches_for_win_pct`. On first boot `backfillInitialSeason()` creates "Initial season (rename me)" and assigns every season-less session to it (only when no seasons exist). Every new session must pick or create a season.

**Master reset is date-based, not deletion.** Admin → Master Leaderboard (nav label was "Master Board" until 2026-09-27); type `RESET` (case-sensitive) to reset, `UNDO` to undo the last reset. No scores are deleted; the board just starts counting at the reset date. Past master periods are recomputed live from their date window (`pastMasterPeriods`), and a JSON snapshot is also stored in `master_stat_resets.snapshot_json` as an audit record. Session and season boards are unaffected.

**Seasons.** Admin → Seasons (`/admin/seasons`, `/admin/seasons/:id`): create/rename, per-season "show stats publicly" toggle, minimum matches, player exclusions, archive/unarchive. Archiving stamps the same `archived_at` on the season and its sessions; unarchive restores only sessions whose `archived_at` matches the season's. Archived seasons/sessions stay viewable publicly as long as stats are visible. Per-session exclusions are on the session detail page (`partials/session_stats_card.ejs`).

**Stats on/off.** The session form's games-won checkbox is now "Stats (games won & win %)"; turning it off shows an inline red warning, and saving a session with stats off flashes an explicit note that nothing from it counts toward its season or master. A separate "Count this session's stats toward its season's leaderboard" checkbox controls season inclusion only.

**Public `/leaderboard`** was rewritten: a view picker (master, seasons, sessions in optgroups; `?view=`, legacy `?session=` still works) and Leaderboard / Graphs tabs. Graphs are hand-rolled SVG in `public/js/statsCharts.js` (no library or CDN): cumulative-or-weekly win % lines (weeks on X, one line per player, up to 8 at once, dotted until a player reaches the minimum matches, crosshair tooltip, keyboard nav) and average games per match (by week within a session/season, by session for master). Chart data ships in a `<script type="application/json" id="stats-data">` block; `<details>` tables give a non-graphical view. Palette slots `--viz-s1..s8` in `style.css` (light + dark) were validated with the dataviz skill's validator. The admin Stats Summary (`/admin/stats`) now shows the master boards.

**Ad-hoc scoring.** Public score entry already worked for ad-hoc sessions because `adhocFlow.finalizeWeek()` materializes `week_assignments`; this change adds the admin games-won / court games-played forms to the finalized-week block of `adhoc_session_detail.ejs`, reusing the existing admin score routes.

**Verified** with `npm run test:scheduler` and an integration script against a copy of Kyle's real DB (session/season/master inclusion, stats off, exclusions, reset/undo, archive/unarchive, visibility, ad-hoc creation and scoring); new master board output matched the old all-time board exactly on the real data. Help page (`help.ejs`) gained a paragraph on the picker. Files: `db/schema.sql`, `db/index.js`, `services/statsBoards.js` (new), `services/gameScores.js`, `routes/admin.js`, `routes/public.js`, `views/leaderboard.ejs`, `public/js/statsCharts.js` (new), `public/css/style.css`, `views/admin/{seasons,season_detail,master_stats}.ejs` (new), `views/partials/session_stats_card.ejs` (new), `views/admin/{session_form,session_detail,adhoc_session_detail,dashboard,all_stats}.ejs`, `views/partials/admin_header.ejs`, `views/help.ejs`. Existing copy elsewhere that says "season" to mean one session hasn't had a wording pass.

**Follow-up tweaks (Kyle, 2026-09-25).** (1) The leaderboard view picker now labels sessions with `sessionFullTitle()` (name · day · time · court · club). (2) The win % graph keeps weeks with no scores on the X axis when they fall between the first and last scored week: every cumulative line runs flat through the gap and resumes at the next scored week (`statsBoards.winPctSeries` takes `weeks` from `fetchScopeWeeks`; unscored weeks before the first or after the last scored week stay off). (3) The graph now shows every player by default instead of the top 8; the first 8 selected get the fixed colour slots and any beyond that draw in neutral grey (`--viz-grey`), with "Show all", "Show top 8" and "Clear all" links under the chips. Files: `services/statsBoards.js`, `public/js/statsCharts.js`, `public/css/style.css`.

### My Page: "My other tennis" dates in the calendar (Kyle, 2026-09-26)

Kyle: "I want to build on each person's 'my page' a place at the top where it's collapsible section where players can enter in other tennis dates they are playing and those dates are added to both the downloadable calendar and the live subscription calendar." This builds the "player-entered personal calendar dates" backlog item. Before building, the security question from that backlog write-up was raised with Kyle: My Page has no login, and this is a *write* into a calendar feed on the player's phone. He picked the **emailed magic link** option. He also declined a "mark me blacked out too" checkbox: "No need to keep track of Blackout dates. This is just a service that I'm adding to help players to keep all their tennis in one place." So this is purely a calendar convenience, with no link to blackout dates, the scheduler, double-booking, or any admin page.

**Data.** New tables in `schema.sql` (new tables, so `CREATE TABLE IF NOT EXISTS` covers existing installs and no `ensureColumn` is needed). `personal_events` holds player, `event_date`, `start_time` (naive `HH:MM`, same convention as `sessions.match_time`), `duration_minutes` (default 90), and optional free-text `club`/`court`/`notes`. `personal_event_tokens` stores only the SHA-256 hash of each emailed edit link, plus `expires_at`.

**`src/services/personalEvents.js`** holds all of the logic. Edit links are **reusable for 30 days** (`EDIT_TOKEN_DAYS`), unlike the single-use sub/swap verification links, so a player can bookmark one instead of requesting a new link for every date. Validation returns error *codes*, and the view maps them to text through `ERROR_MESSAGES`, so a crafted `?pe_err=` URL can't show arbitrary text on My Page. A player can have at most 100 upcoming entries (an abuse ceiling), text fields are capped at 120 characters, past dates are rejected using the app timezone's "today" (not UTC), and length must be 15–600 minutes. `toIcsEvent()` gives each row a stable `personal-<id>@tennis-scheduler.local` uid, so the subscribe feed updates or removes an entry in place instead of duplicating it, for the same reason `ics.js`'s assignment uids are stable.

**Calendar.** `ics.js`'s `buildPlayerFeedICS()` (subscribe feed) appends **every** personal entry. `buildPlayerICS()` (the one-time per-session download) appends only the entries between that session's `start_date` and `end_date`. The event title is "Tennis — `<club>, <court>`", or plain "Tennis" if both are blank.

**Routes (`public.js`).** `GET /me/:idOrSlug` now builds an `otherTennis` object. The section is read-only unless `?edit=<token>` is a valid, unexpired token **for that same player**. `POST /me/:idOrSlug/other-tennis/request-link` checks the honeypot first (a bot gets the identical "check your email" page), refuses placeholder `@no-email.invalid` players, and emails `email.sendPersonalEventsLink()` (new `email_log` category `personal_events_link`). It's rate-limited to 5/hour/IP because it sends email. `POST .../other-tennis/add` and `POST .../other-tennis/:eventId/delete` require the token in the form body and are rate-limited to 60/hour/IP. They return 403 with an "expired link" page if the token is missing, expired, or belongs to a different player, and `deleteEvent()` also only deletes rows owned by that player. Both log through `logPlayerActivity()` (`other_tennis.add` / `other_tennis.delete`).

**View.** `me.ejs` has a `<details id="other-tennis">` directly under the intro line, collapsed by default and opened automatically when arriving from an edit link. The summary shows the count of upcoming entries. The body always lists upcoming entries. In edit mode it adds an add-a-date form and per-row Delete buttons; otherwise it shows the "Email me a link to add dates" button. The emailed link lands on `#other-tennis`.

Also added a `personal_events_link` entry to `testEmail.js` so Admin -> Send Email can preview it (the fake token lands on My Page as an "expired link" notice, which is harmless), plus a paragraph in `/help` under My Page and a sentence under Calendar.

**Verified** in a scratch copy of the real DB under `$HOME/scratch` (`SQLITE_PATH` pointed at the copy, never the connected `data/tennis.db`), booted as a real server and driven over HTTP:
- The request-link POST logs a `personal_events_link` email.
- A valid token opens the edit form, and a bogus one shows the expired notice.
- Adding a date redirects with `pe=added`. A past date redirects with `pe_err=past_date`, which renders the mapped message, and an unknown `pe_err` value renders nothing.
- A bad token on add returns 403.
- The entry shows in the subscribe feed (`UID:personal-N`, title/location "Tennis Club North, Court 3") and in the per-session download for every session whose range covers the date.
- Kyle's token used against another player's page returns 403. That player's own valid token cannot delete Kyle's row (`not_found`), and the row survives.
- Deleting removes the entry from the feed.
- Both activity-log rows record the right wording.

DTSTART uses the same local-to-UTC conversion league events already use (the ics library converts from the server's local timezone), so personal events and league matches line up the same way on the Pi.

### "My other tennis" renamed to "My Other Dates"; calendar files sorted by date (Kyle, 2026-09-26)

Kyle: "Let's rename this from My other Tennis to My Other Dates as this program might be used for any other sport that requires 4 players. We also want to make sure all dates are sorted by date." This is a follow-up to the entry above, made before that feature had been deployed.

**Rename.** Every player-facing string now says "My Other Dates" / "other dates": the My Page section heading and copy, the empty state, the "expired link" and "check your email" pages, the email subject and body ("games you're playing outside the league"), the Send Email test-template label, and both `/help` paragraphs. The calendar event title is now sport-neutral: "Match — `<club>, <court>`", or plain "Match", instead of "Tennis — …". The form placeholder no longer says "Tennis Club". Internal names were renamed at the same time, since nothing had shipped yet: routes `/me/:idOrSlug/other-dates/{request-link,add,:eventId/delete}`, the `#other-dates` anchor, the view local `otherDates`, the rate-limiter names `other-dates-link`/`other-dates-edit`, and the activity-log actions `other_dates.add`/`other_dates.delete`. The tables (`personal_events`, `personal_event_tokens`) and `personalEvents.js` keep their names; they were never player-facing.

**Sorting.** The My Page list was already `ORDER BY event_date, start_time`. The calendar files were not fully sorted, because `ics.js` gathered league matches session by session and then appended Other Dates at the end. A new `sortByStart()` in `ics.js` sorts every event by its `[y, mo, d, hh, mm]` start before `createEvents()`, in both `buildPlayerICS()` (download) and `buildPlayerFeedICS()` (subscribe feed).

**Verified** on the scratch copy under `$HOME/scratch`, never the connected DB. Four dates were added out of order (Nov 20, Oct 2 19:00, Oct 2 08:15, Sep 30):
- My Page listed them Sep 30, Oct 2 08:15, Oct 2 19:00, Nov 20.
- The subscribe feed's DTSTART lines came out fully sorted (checked with `sort -c`), with Other Dates interleaved among the league matches.
- The feed summary read "Match — Riverside".
- The test email sent OK.

### "Send reminders now" is a forced re-send; Suspend checkboxes on the Status page's upcoming automated actions; "Master Board" nav renamed (Kyle, 2026-09-27)

Three items in one message.

**1) "Send reminders now" now always re-sends.** Kyle: after a power outage the Pi came back up and the cron's catch-up pass sent the week's initial reminders — `email_log` recorded them as `sent` — but nobody received them (an SMTP provider glitch; the provider accepted the messages and then didn't deliver). Clicking "Send reminders now" on that week's card then said "Nothing to send — everyone scheduled for this week has already been reminded", which was the shared `email_log` dedup doing exactly what it was built to do, and exactly the wrong thing for a manual recovery click. He worked around it with "Resend link" on each player individually. His ask: "Clicking the 'send reminders now' should just go ahead and re-send the initial reminders out again."

Same shape of fix as the 2026-09-09 "Send status report now" change above:
- `cron.js`'s `sendReminderEmailsForWeek(week, session, { force = false } = {})` gained a `force` option; when true, the per-player `email_log` "already reminded?" check is skipped.
- `sendRemindersNowForWeek(weekId)` (only called by the manual button) now always passes `{ force: true }`. `processReminders()` still calls it with no options, so the automatic pass still dedups and can never re-send on every 60s tick.
- Every re-send mints an additional token via `tokenStore.issueToken()` (never replaces), so links in the earlier, possibly-delivered email keep working — same reasoning as the follow-up nudge and Resend link.
- Recipients are unchanged: everyone on the week with status `scheduled` or `confirmed`.
- The route (`POST /admin/sessions/:id/weeks/:weekId/send-reminders`) now also verifies the week belongs to the session in the URL, logs `week.send_reminders` to the Activity Log with the count and week, and has a new flash text ("…re-sent to everyone scheduled or confirmed, including anyone already reminded"). The 0-sent branch now only means nobody is scheduled/confirmed that week.
- `session_detail.ejs`'s button gained an `onsubmit` confirm dialog, since one click now emails the whole week even if they already have it.
- Not changed, noted for later: `sendMail()` writes an `email_log` row with `status = 'failed'` on an SMTP exception, and every dedup check ignores `status`, so a hard failure also blocks the automatic retry. Left alone deliberately (auto-retrying failures every tick while SMTP is down would spam the log); the forced manual button is now the recovery path for both cases.

**2) Suspend checkbox per line of the Status page's "Upcoming automated actions".** Kyle: "I want to program a suspend checkbox for each line in the upcoming automated actions. This will suspend the action. Once the automated action passes, then it's complete. Completing that action item requires an admin to manually trigger another way. I also want this to be a logged action for whom suspended the action and also a log when that action was to fire it gets logged as 'suspended - did not fire' log."

Design:
- **New table `suspended_actions`** (`schema.sql`, `CREATE TABLE IF NOT EXISTS`, so it's created on the next boot — no `ensureColumn` needed): `week_id` (FK `ON DELETE CASCADE`, so session delete cleans up with no extra code), `action_type` (`CHECK IN ('reminder','followup','escalation')`), `suspended_by_id` (deliberately **no** FK to `admins`, name snapshotted in `suspended_by_name` instead, same as `admin_activity_log`), `suspended_at`, `skipped_at`, `UNIQUE (week_id, action_type)`.
- **Keyed by (week, action type), not by a due timestamp**, so editing a session's reminder time/lead hours after suspending doesn't orphan the suspension — it just applies at the new due time.
- **New service `src/services/automationSuspend.js`:** `suspend(req, weekId, type)`, `unsuspend(req, weekId, type)`, `skipIfSuspended(week, session, type)`, `suspensionMap()`, plus `SUSPENDABLE`/`LABELS`.
- **Lifecycle.** Checking the box inserts a row and logs `automation.suspend` ("Suspended automated action: Reminder email for <session title> — week of <date>") under the acting admin via `logActivity()`. Unchecking before the due time deletes the row and logs `automation.unsuspend`; the action fires normally. When the due time arrives, the relevant cron pass calls `skipIfSuspended()`. On the first such call it stamps `skipped_at` (guarded `WHERE skipped_at IS NULL`, so it's once-only even across ticks) and logs `automation.suspended_skip` via `logSystemActivity()` ("System (automatic)"), with text "Suspended — did not fire: <label> for <session> — week of <date> (suspended by <admin> on <UTC time>). Needs to be handled manually." Every later tick keeps skipping silently. From then on the action is **complete**: `unsuspend()` refuses (`{ completed: true }`, flashed as an error), and `getUpcomingActions()` drops the event from the list. The admin finishes the job manually: Send reminders now / Resend link for a reminder or follow-up, Reassign / the sub-list flow for an escalation.
- **Cron hook points:**
  - `processReminders()` wraps only the `sendReminderEmailsForWeek()` call. `subFlow.fanOutPendingAdminFlagsForWeek()` right after it still runs on schedule. That's a separate sub-request action that happens to share the reminder threshold, and it isn't a row on the Status page.
  - `processFollowUps()` checks after its `now < followUpAt || now >= matchAt` gate, so a suspended follow-up is only logged as "did not fire" if it would really have fired.
  - `subFlow.escalateOverdueRequests()` checks after its `now < escalateAt` gate (lazy `require('./automationSuspend')`). A suspended escalation leaves the request `'open'`; nothing emails the broader sub list. The suspension is per week, so it covers every open request on that week, matching the Status page line.
- **Week locks are not suspendable.** They're bookkeeping with no manual "lock now" equivalent; a never-locking week would break `processScoreReminders()` (scoped to locked weeks), `weeksPlayed` counts, and token invalidation. The Status page shows "—" in the Suspend column for lock rows. If Kyle ever wants this, it needs a manual "Lock week now" button first.
- **Route:** `POST /admin/status/suspend` (`admin.js`; body `week_id`, `action_type`, `days`, and `suspended` present only when checked) redirects back to `/admin/status?days=<same>` with a flash.
- **View (`status.ejs`):** a new Suspend column, one tiny form per row whose checkbox auto-submits on change after a `confirm()` (reverting the box if cancelled), with a `<noscript>` Save button. A suspended row is dimmed, gets a "suspended" badge in the Action column, and shows "by <admin>". An explanatory paragraph sits under the section intro.
- **Also fixed while here — escalation preview time was wrong.** `getUpcomingActions()` previewed sub escalation at a hard-coded "24h before match" (`addDays(match_date, -1)` at `match_time`), but `escalateOverdueRequests()` has fired at `matchAt - session.escalation_lead_hours` since the 2026-09-08 "Broader sub list escalation time is now per-session" change. The preview now uses the same computation, displayed via `utcToZonedParts()` like the follow-up, so the checkbox lines up with the real firing time. It also now lists every open request on the week (`.all()`), not just the first (`.get()`).
- `admin/guide.ejs`'s Status-page paragraph now describes the checkbox and the new Send-reminders-now behavior.

**3) Nav rename.** `partials/admin_header.ejs`: "Master Board" → "Master Leaderboard" (the page's own `<h1>`/title already said Master Leaderboard). The one inline link on `admin/all_stats.ejs` that also said "Master Board" was renamed to match. The route (`/admin/master-stats`) is unchanged.

**Verified** against a scratch DB seeded with `seed-example.js` (never the connected `data/tennis.db`):
- Two forced sends → 4 + 4 `reminder` rows; a following `processReminders()` added none (automatic dedup intact).
- Suspended week 2's reminder and moved its match to tomorrow so it was due. Two `processReminders()` passes sent 0 emails and wrote exactly one `automation.suspended_skip` entry. `unsuspend` then returned `completed`, and the reminder was gone from `getUpcomingActions()`.
- Suspend-then-resume on a follow-up deleted the row.
- Over HTTP against a running server: login, `/admin/status` rendered the checkboxes and the renamed nav, and `/admin/status/suspend` checked and unchecked correctly with flashes and log entries. `send-reminders` flashed the new re-send text, and `/admin/guide` rendered.
- Escalation suspension wasn't exercised end-to-end (it's the same one-line `skipIfSuspended()` gate); worth watching the Activity Log the first time it's used for real.


### Email Log preview popup; sub-confirmed email names who the sub replaced (Kyle, 2026-09-27)

Two requests in one message.

**1) See the actual email from the Email Log.** Kyle: "In the admin console in the email log site, is there a way to show what the email looks like that was actually sent out, maybe linking from the subject that pulls up a pop up window to show that individual email?" Until now `email_log` stored only recipient/subject/category/status/week — never the body — so there was nothing to show.

- **New column `email_log.body_html`** (nullable `TEXT`; added to `schema.sql` and via a bare `ensureColumn('email_log', 'body_html', 'TEXT')` in `db/index.js` — no default, nothing to backfill). Rows logged before this change stay `NULL` and simply have no preview.
- **`email.js`'s `sendMail()`** now computes `bodyHtml = wrapEmailHtml(html)` once (after the `test` override block) and uses it both as the nodemailer `html` and as the stored `body_html` on all three `INSERT INTO email_log` paths (sent / logged_dev_mode, failed, skipped_no_email). So the stored copy is byte-for-byte what went out, wrapper included.
- **`GET /admin/email-log`** no longer selects `el.*` (that would drag up to 300 full bodies into the list page); it selects explicit columns plus `(el.body_html IS NOT NULL) AS has_body`. Keep it that way if new columns are added to `email_log`.
- **New route `GET /admin/email-log/:id/body`** (behind `requireAdmin` like everything else in `admin.js`) returns the stored body as a tiny standalone HTML document, or 404 if there's no stored body. It sets a strict `Content-Security-Policy` (`default-src 'none'; img-src * data:; style-src 'unsafe-inline'; sandbox`) and CSS `a { pointer-events: none }`.
- **`email_log.ejs`**: subjects with a stored body become links; clicking opens a `<dialog>` with To/sent time and an `<iframe sandbox>` pointing at the body route (plain link fallback without `showModal`). Closes via button, click outside, or Esc; the iframe is blanked on close.
- **Why links are disabled in the preview:** stored bodies contain the recipient's real one-click tokens (Confirm, Need a sub, claim-sub, etc.). Clicking one from the admin page would act as that player. The iframe `sandbox` (no `allow-popups`/`allow-top-navigation`), the CSP `sandbox` directive, and `pointer-events: none` together make links inert; the popup says "Links are disabled in this preview." Don't loosen any of these without replacing that protection.
- Storage cost is a few KB per email in SQLite; nothing prunes `email_log`, same as before.

**2) Sub-confirmed group email names who the sub is replacing.** Kyle: old wording "Shawn Anderson will be subbing in for Monday, Sep 28" → wanted "Shawn Anderson will be subbing for Jim Newell on Monday Sept 28" so the group knows whose spot changed hands.

- **`sendSubFilledNotice()`** gained `originalName = null`. When present: "`<sub>` will be subbing for `<original>` on `<fmtDate>`. See you on the court!"; when absent it falls back to the old wording, so any future caller that omits it doesn't break.
- **`subFlow.js`'s `claimSub()`** passes `originalName: fullName(originalPlayerForLog)` (the original assignment's player, already looked up there for the activity log). Full name, per the emails-use-full-names rule.
- **`testEmail.js`'s `sub_filled`** template passes `originalName` (second "other" roster player, or "Test Player"), so Admin → Send Email → Test a template previews the new wording.
- Date format kept as the app-wide `fmtDate()` ("Monday, Sep 28"), not Kyle's typed "Monday Sept 28", for consistency with every other email; told Kyle, easy to change if he wants.
- Only `claimSub()` sends this email. The admin sub-list/one-time-sub Reassign branches don't send a group notice at all (unchanged).

**Verified** on a copy of the project and DB under `$HOME/t` (never the connected `data/tennis.db`), with SMTP unset so `sendMail()` used dev mode: `sendSubFilledNotice()` with Shawn Anderson/Jim Newell logged a row whose `body_html` contained "Shawn Anderson will be subbing for Jim Newell on Wednesday, Dec 30"; the body route returned 302 to login when unauthenticated, 200 with the CSP header when authenticated (auth stubbed in the test harness), and 404 for an older row with no stored body; the Email Log list page rendered the new link only for the row with a body. The popup itself wasn't clicked through in a real browser. Line endings stayed LF on every edited file. Touched files: `db/schema.sql`, `db/index.js`, `services/email.js`, `services/subFlow.js`, `services/testEmail.js`, `routes/admin.js`, `views/admin/email_log.ejs`, `README.md`.


### Email Log groups each sub request's emails into one trail (Kyle, 2026-09-27)

Kyle: following a sub request's emails in the Email Log was hard, especially when a request comes in inside the escalation window and the roster and broader sub list get emailed at the same time. He asked to group them, plus the "sub confirmed" emails. Settled before building: tag emails with the event they belong to (built general, switched on for sub requests only), leave older emails ungrouped rather than guess, grouped view by default with a toggle, and "sub confirmed" emails live inside the request they filled.

- **New column `email_log.thread_key`** (nullable `TEXT`, bare `ensureColumn` + `idx_email_log_thread_key` index in `db/index.js`; also in `schema.sql`). `sendMail()` takes `threadKey` and stores it; a `test: true` send forces it to `NULL` like category/week.
- **Keys.** `sub:<sub_requests.id>` for every email in a request's trail, via `subFlow.subThreadKey()`. The ten sub email functions in `email.js` accept `threadKey` and pass it through: verification (both kinds), requester's own notice, roster fan-out, escalation, both "sub confirmed" notices, and the three "I found a sub" emails. Tagged at the call sites in `subFlow.js`: `fanOutSubRequest`, `createSubRequest`, `claimSub`, `arrangeSelfSub`, `escalateOverdueRequests`. The admin-flag path is covered because its deferred fan-out goes through `fanOutSubRequest`.
- **Verification emails come before the request exists.** `public.js`'s `/request-sub/start` and `/found-sub/start` tag them `pending-sub:<week_assignments.id>` (`subFlow.pendingSubThreadKey()`). `createSubRequest()`/`arrangeSelfSub()` call `adoptPendingSubThread()` right after inserting the request, re-tagging every `pending-sub:<that assignment>` row to `sub:<id>`. A verification nobody clicks keeps its pending tag and shows as a plain row. The reminder email's own "Need a sub" link skips verification, so that trail starts at the roster step.
- **New `services/emailThreads.js`.** `groupRows()` turns the newest-first rows into items: untagged rows stay single; each `sub:` thread becomes one group placed where its newest email falls. `buildGroup()` splits a thread into steps by category, in fixed order rather than timestamp:
  1. Request
  2. Sent to the roster
  3. Invite to the sub they named
  4. Escalated to the sub list
  5. Admin alert
  6. Sub confirmed

  Unknown categories go to "Other". It adds a note when roster and sub-list emails are within 10 minutes of each other. `describeSubThread()` builds the header (requester, match, session, request status, filled-by via `subFlow.resolveSubRequestFiller()`, same as Sub History). It fetches the session in a separate query on purpose: joining `s.*` overwrote the request's `id`/`status` (caught in testing).
- **`GET /admin/email-log`**: `?view=list` gives the old one-row-per-email view; the default is grouped. `?thread=sub:<id>` shows one trail, uncapped and expanded. The query now also selects `thread_key` and orders by `sent_at DESC, id DESC`. In grouped view, any trail partly inside the 300-row cap gets its remaining rows pulled in with the same filters, so a trail is never shown half. Filters apply to emails, so a filtered trail shows only its matching emails. Still never selects `body_html` in the list.
- **`email_log.ejs`**:
  - View toggle, with the filter form keeping the current view.
  - One shaded header row per trail with a ▸/▾ toggle: requester, date, session title, status badge, filled-by, email count, and step counts.
  - Step sub-headers and indented email rows underneath.
  - Children are hidden by JS on load, so they stay visible without JS.
  - The row markup is one in-template `emailRow()` function used by both views.
- **Stats page Sub History** gained an "Emails" column: an "Email trail (N)" link to `?thread=sub:<id>`, shown only when that request has tagged emails.

**Verified** on a copy of the project and DB under `$HOME/t2` (never the connected `data/tennis.db`), dev-mode email, auth stubbed:
- Moved an unlocked week to tomorrow (inside the 30h escalation window), sent a pending verification, then ran `createSubRequest` → `escalateOverdueRequests` → `claimSub`. That produced 16 tagged emails: Request 2, Roster 2, Sub list 7, Confirmed 5. No `pending-sub:` rows were left over.
- Grouped page: one trail header with "filled", "filled by Shawn Anderson", and the within-minutes note. List view has no headers. `?thread=` shows the expanded trail with "Show all emails". `?category=escalation` still groups. Stats shows "Email trail (16)".
- "I found a sub" with a brand-new person grouped as Request 2 / Invite 1 / Admin alert 1.
- The expand/collapse script itself wasn't clicked in a real browser.

Touched files: `db/schema.sql`, `db/index.js`, `services/email.js`, `services/subFlow.js`, `services/emailThreads.js` (new), `routes/public.js`, `routes/admin.js`, `views/admin/email_log.ejs`, `views/admin/stats.ejs`, `README.md`. Swaps, bulk custom emails and reminder batches aren't grouped yet; they'd each need a new key format and a stage list in `emailThreads.js`.

### News posts and the announcement banner (Kyle, 2026-09-28)

Kyle: "Can we configure an announcement banner on the tennis scheduler app? I'd like to put together a blog style page which I can upload screenshots and provide some text on announcing new features of the program or even announce a happy hour after the season is over. The blog should be multipurpose."

**What it is:**
- A public blog at `/news` (list) and `/news/:id` (post). There's a "News" link in the player nav.
- Admins manage posts at `/admin/news` (new "News" link in the admin nav). Each post has these fields:
  - title and body
  - Published (drafts 404 publicly)
  - Pinned (sorts first)
  - an optional **site banner**
- The banner is a colored strip under the header on every player-facing page (`partials/header.ejs`), linking to the post. Its settings:
  - optional short text (blank = the title)
  - a color: `info` blue / `celebrate` green / `alert` amber
  - an optional inclusive end date (`banner_until`, a `YYYY-MM-DD` in the site timezone). After that date the banner stops showing but the post stays up.
  - If several posts have a live banner, the pinned post wins, then the newest.
- Players can dismiss the banner with ×. The dismissal is saved in `localStorage` (`dismissedNewsBanner`) and keyed to `id:updated_at`, so editing the post brings the banner back once. An inline script placed right after the banner markup hides an already-dismissed banner before first paint (no flash).
- `app.js` sets `res.locals.newsBanner = activeBanner()` in the same per-request middleware as `siteTitle`. It's skipped for `/admin*` paths because `admin_header.ejs` doesn't show the banner.

**Post body format:** a deliberately tiny Markdown-ish syntax, rendered server-side by `news.renderBody()`. There's no Markdown dependency, and every piece of text is HTML-escaped, so raw HTML never passes through.
- Supported: `#`/`##`/`###` headings (rendered as h2 to h4), `**bold**`, `*italic*`, `[text](url)`, bare URLs, `-`/`1.` lists, `> quote` and `---`.
- `![caption](/news/img/N)` on its own line renders as a full-width figure with a caption.
- URLs are limited to http(s), mailto and same-site `/paths`.
- The editor shows a cheat sheet and a Preview button (`POST /admin/news/preview`).

**Screenshots are stored in the DB, not on disk** (`announcement_images`, a BLOB). That way the existing VACUUM INTO backups, local and offsite, include them with no changes. A file-based uploads folder would have been silently left out of every backup.
- Images are served at `/news/img/:id` with a 1-year immutable cache header. That's safe because ids are AUTOINCREMENT and an image never changes.
- **Upload path:** `newsEditor.js` resizes anything wider than 1600px in the browser (canvas). It then POSTs each file as a raw body to `POST /admin/news/images` (`express.raw`, 10 MB cap), so no multer or other new dependency was needed. The response inserts `![](/news/img/N)` at the cursor.
- The editor also accepts screenshots pasted straight into the textarea, or dragged onto it.
- The type is sniffed from magic bytes (PNG, JPEG, GIF, WebP only). SVG is refused because it can carry script. Responses send `nosniff`.
- **Must use `db.raw.prepare` for BLOB inserts and reads.** The `db.prepare()` shim's `normalizeParams` turns a Buffer into a plain object.
- **Cleanup:** images upload with `announcement_id = NULL`, and `claimImages()` links them to the post on save. Deleting a post removes images only it referenced (a `/news/img/N` pasted into another post keeps that image). Images uploaded and then abandoned without saving stay as orphans. That's harmless and small, and a candidate for the stale-token cleanup sweep in the backlog.

Activity Log gets `news.create`, `news.update` (with published/unpublished/banner on/off noted) and `news.delete` entries.

**Verified** on a throwaway DB (never `data/tennis.db`), via `app.js` directly (no cron), with scripted HTTP:
- login, upload, rejecting a fake-PNG SVG, image GET headers
- create, and a validation error keeping the typed body
- draft 404, banner shown on `/schedule`, banner hidden after `banner_until`
- delete removing its images, and Activity Log entries
- Also screenshotted `/schedule`, `/news`, a post and the editor in Chromium (desktop light, mobile dark).
- Paste and drag-drop upload weren't exercised in a real browser.

Touched files: `db/schema.sql`, `services/news.js` (new), `app.js`, `routes/public.js`, `routes/admin.js`, `views/news.ejs`, `views/news_post.ejs`, `views/admin/news.ejs`, `views/admin/news_form.ejs` (all new), `partials/header.ejs`, `partials/admin_header.ejs`, `public/js/newsEditor.js` (new), `public/css/style.css`. There's no email-out of a post yet; a natural follow-up is a "Send this post to all players" button that reuses the Custom email all-players mode.

### Full Schedule: inline per-match Scores column, Leaderboard button removed (Kyle, 2026-09-28)

Kyle: "For Enter your scores, that button should be removed from below the session box and be in-line for the weekly match just right of the ball duty column. The button appears right after the week is locked (match has started) and 24 hours after a match, the button (if scores are entered) turns to the # of games scored for that match. If nobody enters in scores within 48 hours, 'scores needed' is populated in that field. ... Let's remove the leaderboard button. They can get to the leaderboard link through the upper ribbon bar."

**What "# of games" means:** each player enters their own games won, so a match has four numbers. I asked Kyle which to show. He picked the court's shared **total games played** (`week_court_games.games_played`). So "scores are entered" means that court's games-played value is set.

**What changed on `schedule.ejs`:**
- The two buttons above the table are gone.
- When `session.games_won_enabled` is on, there's a new **Scores** column after Ball duty. It has one cell per court row, not a rowspan like Ball duty, because games played is per court.

**Cell rules:** `gameScores.scheduleScoreCell()` works out each cell's state, timed from match start. Match start is `zonedTimeToUtc(match_date, session.match_time, tz)`, the same instant `cron.js` locks the week.

| State | When | Cell shows |
|---|---|---|
| `pending` | week not locked yet | empty |
| `enter` | locked, and either under 24h since start or (no games-played and under 48h) | "Enter scores" button linking to `/scores?session=S&week=W` |
| `scored` | 24h or more since start and games-played entered | "N games" |
| `needed` | 48h or more since start and still no games-played | amber "Scores needed" badge, still a link to the same entry page, since late entry stays allowed |

- Between 24h and 48h with nothing entered, the button just stays up.
- Games-played entered in the first 24h still shows the button until 24h, as Kyle specified.

**Scope:**
- Full Schedule only, as asked. `lookahead.ejs` and `me.ejs` still have their own "Enter your scores"/"Leaderboard" buttons. `leaderboard.ejs` links back to entry.
- `help.ejs`'s Scores section was updated to describe the new column.
- `session_form.ejs`'s games-won help text still says turning it off removes the links from "this session's schedule". Still true in effect, since the column disappears.

**Verified:**
- `scheduleScoreCell` checked directly for all four states.
- Rendered `/schedule` against a copy of the local DB, with week 3's games-played cleared (→ Scores needed) and week 4 moved to "started 2h ago" and locked (→ Enter scores).
- Screenshotted desktop light and mobile dark. On a phone the column is reached by the existing `.table-scroll` horizontal scroll.

Touched files: `services/gameScores.js`, `routes/public.js`, `views/schedule.ejs`, `views/help.ejs`.

### News editor: "Upload failed (200)" → clear "login expired" message (Kyle, 2026-09-28)

Kyle, uploading a PNG on production: "some uploads failed -- tennis_leaderboard.png; Upload Failed (200)."

**What I checked:**
- Uploads worked in a real browser against the same code, both a small PNG and a 2400px PNG that goes through the canvas resize.
- Production did have the feature deployed (`/news` rendered).

**Most likely cause:** admin sessions use express-session's default MemoryStore, so every `pm2 restart` logs admins out. Kyle had just deployed the Full Schedule change, which meant a restart, while the News editor was likely still open.
- The upload `fetch()` then hit `requireAdmin`, which answered with a 302 to `/admin/login`.
- `fetch` followed the redirect silently and got the login page's HTML with status 200.
- The editor couldn't parse that as JSON and reported it as "Upload failed (200)".

**Fix:**
- `requireAdmin` now answers requests whose `Accept` asks for JSON (and not HTML) with a `401 {loginExpired: true}` instead of a redirect. Normal page navigation still redirects exactly as before.
- `newsEditor.js` sends `Accept: application/json` on its upload and preview calls.
- On a 401, or on a response that was redirected to `/admin/login`, the editor shows an inline "Your admin login expired… log in again in a new tab… don't click Save until you've logged back in" box. Clicking Save in that state would redirect and lose the post body.
- Other unexpected responses now show the real HTTP status in plain words.

**Verified in Chromium:** a normal upload still works. After clearing cookies, an upload and a Preview both show the box, and the typed text is kept.

**Possible follow-up (not built):** a persistent session store (SQLite-backed), so deploys stop logging admins out at all.

### Confirm / need-a-sub land on the full schedule; sub claims split by route; Mark confirmed names the admin (Kyle, 2026-09-28)

**1) Confirm and Need a sub redirect to the full schedule.** Kyle: after clicking to confirm, the player "just stays on that confirmation screen." `public.js`'s `POST /confirm/:token` now redirects to `/schedule?session=<id>&notice=confirmed` instead of rendering the "You're confirmed!" page. `POST /need-sub/:token` does the same with `notice=sub_sent&n=<offerCount>`. `GET /schedule` maps those two codes (whitelisted, so a crafted URL can't show arbitrary text) to a green `.flag.success` banner above the session picker: "You're confirmed — see you on the court!" / "Sub request sent to N players — you'll get an email when someone takes your spot." (n = 0 gets its own wording: goes to the sub list closer to the match). Error/edge pages (bad link, already subbed out, already requested, blocked) still render `message.ejs` as before, and so does the success case if the week somehow has no session.

**2) Sub claims split into three Activity Log actions.** Previously every sub accepting a spot logged `sub.claim`, so a self-arranged sub accepting looked the same as someone grabbing a fan-out spot. New nullable `sub_offers.source` (`'roster'` | `'self_arranged'` | `'escalation'`; bare `ensureColumn`, in `schema.sql` too) is set at all three offer-insert sites in `subFlow.js` (`fanOutSubRequest`, `arrangeSelfSub`, `escalateOverdueRequests`). `claimSub()` picks the action via new `offerSource()`:
- `sub.claim` — roster fan-out (unchanged)
- `sub.self_arranged_confirm` — the named sub accepted ("Bret Stanwich confirmed the sub Kyle Krieg arranged for 2026-10-07")
- `sub.claim_escalated` — claimed after escalation to the sub list

Offers from before this change have `source = NULL`; `offerSource()` infers them (self-arranged request: first offer = the invite, later = escalation; otherwise a broader-list offer = escalation, else roster). Old log rows keep their old action names.

**3) Mark confirmed names the admin.** `week.mark_confirmed` now reads "Admin <name> marked <player> confirmed for <date>", plus " (closed their open sub request)" when it closed one.

**Docs.** `/help`'s I Found a Sub section and the admin guide's I Found a Sub flowchart now spell out the accept step (invite email → claim page → one click, goes straight to confirmed, group + original player notified); the guide also lists the four sub action names. The guide's old "it's the same email as any other sub request" line was wrong (it's its own invite email) and was fixed.

**Verified** on a scratch copy of the real DB under `$HOME/sc` (never the connected `data/tennis.db`), real HTTP against `app.js`: confirm → 302 to `/schedule?session=1&notice=confirmed` and the banner renders; need-sub → 302 with `n=3` and the "Sub request sent to 3 players" banner; a crafted `notice=` value renders no banner; a roster claim logged `sub.claim` (offer `source=roster`); an `arrangeSelfSub()` + claim logged `sub.self_arranged` then `sub.self_arranged_confirm` (offer `source=self_arranged`); admin-flag + Mark confirmed logged "Admin Admin User marked Bart Lautenbach confirmed for Wednesday, Oct 7 (closed their open sub request)". The escalation claim path wasn't exercised end to end (same one-line insert change). Touched: `db/schema.sql`, `db/index.js`, `services/subFlow.js`, `routes/public.js`, `routes/admin.js`, `views/schedule.ejs`, `public/css/style.css`, `views/help.ejs`, `views/admin/guide.ejs`.

### Email Log player column, Combined Log, public nav reorder (Kyle, 2026-09-29)

**1) Email Log "Player" column** between Sent and To. `email_log` only stores the address, so `admin.js`'s new `emailNameMap()` resolves it at read time: players first (`fullName()`), then `broader_sub_list.name`, then admin accounts (`"<name> (admin)"`, for admin-report emails), case-insensitive. `namesForAddresses()` handles comma-joined multi-recipient `to_email` values. Unknown addresses show "—". Colspans in `email_log.ejs` bumped by one.

**2) Combined Log (`GET /admin/combined-log`, new `admin/combined_log.ejs`, admin nav link after Activity Log).** Both separate logs stay unchanged; this page merges them on one timeline at read time (nothing stored). Takes the newest 300 of each (same filters), merges newest-first (on a timestamp tie the action sorts above emails), keeps 300. Filters: contains (activity description/action/admin; email subject/recipient/category), session (activity `session_id`; email via `weeks.session_id`), and show (both / actions / emails). Consecutive emails with the same category, `related_week_id` and `thread_key`, sent within 5 minutes of each other, collapse into one "email ×N" row with a `<details>` list (names, addresses, subject, status). Subjects open `/admin/email-log/:id/body` in a new tab, the same CSP-sandboxed route the Email Log popup uses, so links in them stay inert. Most cron emails (reminders, follow-ups) have no matching action row because the cron doesn't log one; the page says so. Email Log and Activity Log both gained a one-line link to it.

**3) Public nav reordered** (`partials/header.ejs`) to Kyle's list: My Page, Full Schedule, Next 4 Weeks, Request a Sub, Swap a Week, Calendar, Print Schedule, News, Sign Up, Blackout Dates, Enter Scores, Score History, Leaderboard, Stats, How It Works, Preferences, Admin, theme toggle. There are the same 17 links as before; none were added or dropped.

**Verified** on a scratch copy of the local DB outside the connected folder, with a throwaway admin, real HTTP against `app.js`: the Email Log (grouped and list) renders the Player column with names resolved; Combined Log renders in all three modes plus a text filter, interleaving actions and emails and collapsing batches; Activity Log still renders; `/schedule`'s nav is in the new order. `node --check admin.js` and `ejs.compile()` on all touched views passed.

### Sub emails go out in order: requests first, confirmations last (Kyle, 2026-09-29)

Kyle saw a requester's "sub requested" confirmation land in the middle of the request emails in the Email Log. Every send loop in `subFlow.js` already awaited one email at a time. Emails still got mixed together because other work could run between those awaits:
- The 60-second cron's `escalateOverdueRequests()` could start sub-list emails for a request made inside the escalation window while its roster fan-out was still going out.
- A sub who claimed quickly could have their "sub found" emails go out mid-loop.

Fix, all in `subFlow.js`:
- **`withSubRequestLock(subRequestId, fn)`:** an in-memory promise chain per request, which is fine because the app runs as a single Node process. Every email-sending step for a request runs through it: `createSubRequest()`, `fanOutPendingAdminFlagsForWeek()`, `arrangeSelfSub()`, `claimSub()`'s notices, and each request in `escalateOverdueRequests()`.
- **Escalation split out:** the per-request body of `escalateOverdueRequests()` is now `escalateOneRequest(id, { onlyIfDue })`. It re-reads the request and only acts if it's still `open`, so a cron pass that waited on the lock won't escalate a second time. It returns `{ result, emailed }`.
- **Request order:** `createSubRequest()` now runs roster fan-out, then `escalateOneRequest()` if already due, then the requester's confirmation. `sendSubRequestOwnConfirmation()` gained `escalatedTo`. When it's set, the "if no one responds within N hours" line becomes "Also right now: … it also went out to this session's sub list: <names>".
- **Admin-flagged fan-out** also escalates right after the roster if already due.
- **"I found a sub" order:** invite, then the admin new-person alert, then the requester's confirmation last. The activity-log calls moved ahead of the emails.
- **Stopping early:** the fan-out and escalation loops check the new `subRequestStillOpen()` before each email and stop once the request is filled or resolved, so nobody is asked about a taken spot. `fanOutSubRequest()` now returns only the candidates actually emailed. `claimSub()`'s DB change is still immediate; only its notices wait for the lock, which is at most one in-flight email once the loop sees `filled`.

**Verified** on a scratch copy of the local DB, with nodemailer stubbed to take 40ms per send so the old interleaving could happen. The test made a sub request inside the escalation window, fired `escalateOverdueRequests()` 30ms later, and in one run claimed a roster offer mid-fan-out:
- **Claim run:** 4 roster emails, the fan-out stopped, then the self-notice, then the group "sub found" emails and the original's notice. No escalation happened because the request was already filled.
- **No-claim run:** 5 roster emails, then 10 sub-list escalations, then the self-notice with the "Also right now" line. The concurrent cron pass escalated nothing (0).

`npm run test:scheduler` is unaffected. Watch the Email Log on the next real in-window request.

### Email Log batch grouping; Combined Log uses the preview popup (Kyle, 2026-09-29)

Kyle: the Combined Log grouped emails but the Email Log didn't. The Email Log's grouped view only ever grouped emails tagged with a sub-request `thread_key`. The production DB had 0 tagged emails (none of its sub requests had happened since that code shipped), so it grouped nothing. `emailThreads.js` gained `collapseBatches(items)`, run on the grouped view after `groupRows()`. It collapses consecutive plain rows with the same category and `related_week_id`, sent within 5 minutes of each other, into a `batch` item. That's the same rule as the Combined Log. A lone email stays a plain row, and a tagged sub-request trail is untouched. `email_log.ejs` renders a batch as a collapsible header (category, count, session, recipient names), reusing the existing thread-toggle JS. The view toggle now reads "Grouped" / "Individual emails". `?thread=` is still uncollapsed.

The Combined Log's subject links used to open a new tab. They now open the same sandboxed popup as the Email Log. The `<dialog>` and its script moved into `partials/email_preview_dialog.ejs`, included by both pages. Any link with class `email-preview-link` and `data-subject`/`data-to`/`data-sent` attributes opens it.

Verified on a scratch copy of the production DB (copied with its WAL, which held most recent rows) over real HTTP: the Email Log grouped view showed reminder×4, sub_filled×4, escalation×7, sub_request×2, etc.; list view unchanged; both pages include the dialog and have no `target="_blank"` links.

**Investigation, same day: who confirmed Shawn Anderson's sub for Jim Newell (week of 2026-09-28)?** It was `claimSub()`, which only runs from `POST /claim-sub/:token`. `GET` only renders the "I'll play" page. That was `sub_offers` id 11, sent to Shawn's own address in the roster fan-out at 19:51:05 UTC and claimed at 20:06:44 UTC. No admin route calls `claimSub()`. Every admin path (Reassign, sub-list reassign, Mark confirmed, Correct player) writes its own activity action, never `sub.claim` or "player self-service", and none were logged that afternoon. Shawn's row: `admin_confirmed=0`, `replaces_assignment_id=819`. The single "please confirm" reminder to Shawn at 20:07:33 UTC, 49 seconds after the claim, fits the admin "Resend link" button, which isn't activity-logged. So the admin's click came after the claim and didn't cause it.

### Super Log: detail_log feed for link opens, clicks with device/IP, un-logged admin buttons, refused attempts (Kyle, 2026-09-29)

Follow-up to the Shawn/Jim investigation. Kyle wants more logging but doesn't want to clutter the Email Log or Activity Log, so the extra events go into a new `detail_log` table (in `schema.sql`, created by `CREATE TABLE IF NOT EXISTS` on boot; no FKs on purpose) that is shown **only** on the renamed **Super Log** (`GET /admin/super-log`, view `admin/super_log.ejs`; `/admin/combined-log` 301-redirects, query string kept). Kyle picked all four event types and the rename via AskUserQuestion.

**`services/detailLog.js`:**
- `record(req, { kind, event, actor, playerId, sessionId, weekId, description })` stores the IP (`CF-Connecting-IP`, else `req.ip`), the raw user agent, and a short `deviceLabel()` like "iPhone · Safari". Known link scanners and preview fetchers (safelinks, proofpoint, Google image proxy, curl, etc.) are labeled "link scanner / bot". It never throws, and prunes rows older than 365 days at most once a day.
- `safePath()` masks long path segments so a raw emailed token is never stored.
- `linkPage(page)` is middleware for the emailed-link routes: `/confirm`, `/need-sub`, `/found-sub`, `/claim-sub`, `/swap/verify`, `/swap/respond`, `/adhoc-signup`, each `:token`, on both GET and POST. It resolves whose token it is *before* the route runs, since several routes delete their token. It wraps `res.render` to capture the outcome, and writes one row on `finish`: GET is `open`, POST is `click`, and a 4xx/5xx or an error-toned `message.ejs` render is `refused`, with the rendered heading/body as the reason.

**Other hooks:**
- `honeypot.isBot()` records `bot_trap` when it trips.
- `rateLimiter` records `rate_limited` on a 429.
- `admin.js` records failed admin logins (`admin.login_failed`, with the typed username) and logout, plus Resend link, Send status report now, and Notify roster (blackouts). None of those are in the Activity Log, which is unchanged.

**Super Log page:** a third source joined to weeks/sessions. On a timestamp tie the sort order is detail, then activity, then email. The type filter gained "Link opens, clicks, refused only", and text search also covers actor, device and IP. Detail rows show a badge (link opened / clicked / admin / refused), who, the description, and a muted device · IP line; hover shows the full user agent. Admin nav, the Email Log/Activity Log cross-links, the admin guide and the README now say Super Log.

**Verified** on a scratch copy of the production DB (with its WAL), over real HTTP with an iPhone user agent and a fake `CF-Connecting-IP`. The test opened and clicked a real Confirm link (logged "opened" then "clicked … went through"), a bogus `/claim-sub` GET and POST (both "refused" with the rendered reason), a honeypot hit on `/request-sub/start`, a failed admin login, and Resend link. All seven showed on `?type=detail` with "iPhone · Safari · IP 203.0.113.7". The full page rendered, `/admin/combined-log?type=email` 301-redirected to `/admin/super-log?type=email`, and the Activity Log got no new rows from any of it besides the tester's own login.

### "I found a sub": no escalation while the named sub can still confirm; reminder, warning, then open it up (Kyle, 2026-09-30)

What happened on Sept 30: Kyle clicked "I found a sub" and named Shawn Anderson at 8:12 AM CT for a 5:30 PM match. 34 seconds later the cron emailed 7 people on the broader sub list. `arrangeSelfSub()` left the request `open`, and `escalateOverdueRequests()` treats any open request inside `escalation_lead_hours` (30 on Kyle's sessions) as overdue. The code comment said this fallback was deliberate ("falls back to normal escalation"), but it meant a self-arranged sub never got any time to answer.

Kyle's rules: while the named sub can still confirm, nobody else is asked. If the sub hasn't confirmed 4 hours after being named, remind both people. If the sub still hasn't confirmed 4 hours before the match, open the spot up to the roster and the sub list, unless the player contacts an admin to confirm. He picked a warning 1 hour before it opens up. "Jim" in his message meant Kyle, the player who arranged the sub.

**Timeline** (`subFlow.selfArrangedTimeline(subRequest, week, session)`, all times computed from `sub_requests.created_at` and two new per-session settings, `sessions.self_arranged_reminder_hours` and `self_arranged_deadline_hours`, both `INTEGER NOT NULL DEFAULT 4`):

- **deadlineAt** = match time − deadline hours. The spot opens up here.
- **warnAt** = deadlineAt − 1 hour. The player gets a warning and the sub a last call.
- **reminderAt** = arranged time + reminder hours. Both get a reminder. It's dropped (null) if it would land less than 15 minutes before warnAt.
- **late** = arranged at or after warnAt, i.e. less than (deadline + 1) hours before the match. Nothing automatic happens: the player's confirmation says so, and `session.admin_report_emails` gets one `self_arranged_late_alert` email.

**Engine.** `escalateOneRequest()` now returns `not_due` for a self-arranged request when `onlyIfDue` is set, so the normal escalation pass skips it. New `processSelfArrangedSubs()` (called from `cron.js`'s `processEscalations()`) runs `stepSelfArrangedRequest(id, now)` per open self-arranged request inside `withSubRequestLock()`. Each step stamps its own column (`sub_requests.self_arranged_reminder_sent_at` / `_warning_sent_at` / `_late_alert_sent_at`) so it runs once. At the deadline it:
- checks the week's escalation Suspend checkbox (same one as normal escalation)
- runs the roster fan-out (`fanOutSubRequest`)
- runs `escalateOneRequest(id, { onlyIfDue: false })`
- emails the player who was just asked

The named sub's invite stays live the whole time; first to confirm wins.

**Named sub isn't re-invited.** `fanOutSubRequest()` and `escalateOneRequest()` now skip anyone who already has an offer on the request. This applies to every request, not just self-arranged ones.

**Second link.** New `sub_offers.nudge_token` (hashed). The reminder and last-call emails mint one via `mintOfferNudgeToken()` so the original invite link keeps working. `claimSub()`, `GET /claim-sub/:token` and `detailLog`'s offer lookup accept either `token` or `nudge_token`.

**Admin confirm on the sub's behalf.** `claimSub()` was split into `claimSub(rawToken)` → `claimOffer(offer, { byAdmin })`. New `adminConfirmSelfArrangedSub(subRequestId)` claims the named sub's pending offer, so the result is the same as the sub clicking their own link, and the player-self-service log line is skipped. Route: `POST /admin/sessions/:id/weeks/:weekId/confirm-arranged-sub`, logged `sub.self_arranged_admin_confirm`. `session_detail.ejs` shows "named sub: X (not confirmed yet)" and a **Confirm X is playing** button while that invite is pending, including after the spot has opened up.

**Emails** (`email.js`):
- `sendSelfArrangedSubConfirmation()` now takes `timeline` and lists the real times (reminder, warning, deadline) or the late wording.
- `sendSelfArrangedSubInvite()` takes `deadlineAt` and says "please confirm by …".
- New `sendSelfArrangedSubNudge()` (category `self_arranged_sub_reminder`, reminder or `final` last call).
- New `sendSelfArrangedRequesterUpdate()` with stages `reminder` / `warning` / `escalated` (categories `self_arranged_requester_reminder`, `self_arranged_warning`, `self_arranged_escalated`).
- New `sendSelfArrangedLateAlert()`.
- Helper `fmtWhen(instant, week)` gives "12:30 PM on match day" or "… on Tuesday, Sep 29".
- `emailThreads.js`: a new "Reminders & warning" stage, `self_arranged_escalated` under "Escalated to the sub list", `self_arranged_late_alert` under "Admin alert".
- `testEmail.js` has 6 new test templates (timeline worked out as if the sub were named 24h before the match).

**Activity Log** new actions: `sub.self_arranged_escalated`, `sub.self_arranged_late`, `sub.self_arranged_admin_confirm`.

**UI and docs:**
- `session_form.ejs`: the two fields, under the escalation field. Saved by `saveSelfArrangedHours()` after the main INSERT/UPDATE, validated by `invalidSelfArrangedHours()`, and added to `SESSION_FIELD_LABELS`.
- `statusPage.js`: the upcoming-escalation preview uses the self-arranged deadline, and skips late ones.
- `getWeekWithSession()` also selects the two new columns.
- `found_sub.ejs`, `help.ejs` and `admin/guide.ejs` were reworded.

**Verified** on a copy of the local DB outside the connected folder, dev-mode email:
- Walked a request named 30h before the match (inside the old 30h window): `escalateOverdueRequests()` left it alone.
- Stepping at the reminder, warning and deadline times sent the right emails exactly once each. At the deadline it went to 5 roster players and 5 sub-list people, with the named sub excluded from both. Admin confirm then filled it and closed the other 10 offers.
- A request named 3h before the match went `late`: only the invite, the confirmation (with the late wording) and one admin alert.
- Over HTTP: GET and POST on a nudge link claimed the spot; session detail showed the button; the confirm route filled the request and logged; the Status page previewed the self-arranged deadline; the edit form rendered the fields.
- All 7 related test templates sent. Scheduler tests pass.

**Known edge case, not fixed:** if a player who gave up their own spot in a week is later named (or claims) as the sub for another spot in that same week, the claim fails on `UNIQUE(week_id, player_id)` (500). This predates this change.

**Existing data:** Sept 30's request (id 8) is already `escalated`, and the new code leaves it as is.

### Subbed-out player claiming another spot; "Playing today / this week / that week"; Active Links page; email map (Kyle, 2026-09-30)

**1) Claim crash fixed.** A player with a `subbed_out` row in a week (they gave up their own spot) could be offered or named for another spot in that same week. Claiming then failed on `week_assignments UNIQUE(week_id, player_id)` with a 500. Found while testing the "I found a sub" follow-ups.
- Everyone with *any* row in the week, `subbed_out` included, is now excluded from:
  - `eligibleSelfArrangedCandidates()`
  - `fanOutSubRequest()`
  - `escalateOneRequest()`, which previously didn't exclude player-type sub-list candidates already in the week at all
- `claimOffer()` also checks before inserting and returns `gave_up_spot` / `already_playing`, which the public claim route and the admin confirm-arranged-sub route turn into plain messages.

**2) Day-relative wording in emails.** Kyle: "Playing that week" is for emails sent weeks ahead, "Playing this week" for the week of the match, "Playing today" for match day.
- New `email.weekPhrase(matchDate)`, computed at send time in the app timezone, returns:
  - `today` on match day
  - `this week` when the match is later in the same Sunday–Saturday calendar week
  - `that week` otherwise
- Used by `currentWeekRosterHtml()` (the "Playing …:" line in the sub request, escalation, sub found, invite and swap-group emails) and by `ballDutyNotice()` ("You're on ball duty today / this week", or "for this match" when further out).
- The follow-up's subject already used `relativeDayPhrase()` (today/tomorrow/weekday) and is unchanged.

**3) Active Links (`GET /admin/links`, `POST /admin/links/cancel`, `services/activeLinks.js`, `views/admin/links.ejs`, admin nav after Status).** Kyle wanted a way to void any emailed link, e.g. so nobody from the sub list takes a spot they shouldn't.
- Lists every link that would still act if clicked, for non-archived sessions and unlocked weeks, with a session filter. Only hashes are stored, so it shows who has a link and what it does, never the link itself.
- Cancel behavior by kind:
  - **Sub links:** grouped per request; cancel one or all. The offer is set to `closed`. A closed offer still counts as "already offered", so a later escalation won't re-invite that person. The request itself stays open ("Clear sub request" calls it off).
  - **Confirm / need-a-sub / "I found a sub" links:** grouped per spot; cancelling deletes all its `week_assignment_tokens`. Resend link issues a new one.
  - **Pending swaps:** set to `cancelled`.
  - **Unclicked swap-proposal verifications:** deleted.
  - **Unclicked pickup sign-ups:** the token is replaced with an unguessable `void:` value, and `reminded_at` is set so the cron doesn't mint a new reminder link.
  - **"My Other Dates" edit links:** deleted.
- Each cancel is logged as `link.cancel`.

**4) Email map.** Kyle: "map out all the escalations and emails … in a concise and consistent way." New `services/emailMap.js` holds one list:
- a default-settings example week
- one table per flow (weekly confirmations, Request a Sub, I Found a Sub, swaps, pickup games, scores, admin/manual)
- rules that apply to every email

It's rendered in the admin guide's section 6 (`#email-map`) and written to `EMAIL_MAP.md` by `npm run email-map` (`src/scripts/write-email-map.js`). README links it. **When an email is added or retimed, update `emailMap.js` and rerun the script.**

**Verified** on a copy of the local DB outside the connected folder:
- `weekPhrase` on Wed Sep 30: today → today; Oct 2–3 → this week; Oct 4 → that week; past → that week. A sub-request email for a match today rendered "Playing today".
- A subbed-out player POSTing a claim link got the "gave up your own spot" page with no 500, and the request stayed open. They were also missing from the candidate list.
- Over HTTP: `/admin/links` listed the offers. Cancelling one closed it, and a second cancel flashed "already used". Cancelling a spot's confirm links made `/confirm/<token>` show "Link not found". Cancel-all closed the rest. Three `link.cancel` log rows were written, the filtered view rendered, and `/admin/guide` rendered the map (9 tables).

### "No reply needed" wording on group sub emails (Kyle, 2026-09-30)

Kyle: sub requests and escalations go out from his personal Gmail, and players were replying to say they couldn't play — the exact email traffic the system was built to stop. He asked for wording along the lines of "if you can't play, no response is needed."

`email.js` gained `noReplyNeededHtml()`, a shaded callout placed right under the "I'll play" button: "**Can't play? No need to reply** — just ignore this email. Replies aren't read by the scheduler, so the button above is the only way to take the spot." It's used in the two emails that go to a whole group racing for one spot: `sendSubRequestFanout()` (roster) and `sendEscalationEmail()` (broader sub list). Also added lighter lines to two other group emails that draw replies: `sendSubFilledNotice()` ("Just a heads-up — no reply needed.") and `sendAdhocReminder()` (matching the wording `sendAdhocInvite()` already had). Deliberately not added to emails sent to one specific person who does need to act (confirmation reminders, the "I found a sub" invite/nudges, swap requests). `/help`'s sub-request email mock got the same callout.

Verified on a scratch copy of the project and DB outside the connected folder: the Send Email test templates for `sub_request`, `escalation`, `sub_filled` and `adhoc_reminder` all send, and each stored `body_html` contains the new line. `node --check` passed on `email.js`.

### CLAUDE.md split, security fixes, demo-data screenshots (Kyle, 2026-09-30)

- **Token cost:** CLAUDE.md was ~730 KB (~180K tokens loaded every session). Moved the whole log here (`docs/HISTORY.md`); CLAUDE.md is now a ~9 KB rules/architecture reference. Code comments that said "see CLAUDE.md" now say `docs/HISTORY.md`.
- **Security review fixes:** names/labels with `<` or `>` are refused at every entry point (players, sub list, admins, one-time subs, session name/club/court, and the public "I found a sub" new-person form), and the new-sub-list admin alert escapes the typed name/email. Missing/short `SESSION_SECRET` now uses a random per-run secret instead of the public fallback string. New headers: X-Frame-Options SAMEORIGIN (the Email Log preview iframe is same-origin), nosniff, Referrer-Policy same-origin (keeps token URLs out of Referer), Permissions-Policy; `x-powered-by` off. 500 pages no longer show `err.message`. News links starting `/\` are refused. `npm audit fix` plus nodemailer 6 → 10.0.13; `npm audit --omit=dev` reports 0. Verified: real send through nodemailer 10 to a local SMTP capture server (multi-recipient To, From name), gmail service still resolves to smtp.gmail.com:465, headers present, `<b>` name rejected, `O'Brien` accepted, scheduler tests pass.
- **Nav:** the admin nav overflowed at 1280px once it reached ~20 links; `header.site nav` now wraps to a second row, links don't break mid-label, and the logout form got its left margin.
- **Screenshots:** regenerated all `/help` images and the admin dashboard/session-detail/players/sub-list images from a made-up demo roster (Playwright in a scratch copy, no real names), and added super-log, status, seasons, master-leaderboard, news-editor, active-links, leaderboard, leaderboard-graphs and news-banner. Admin guide gained §10 "Seasons, leaderboards & news" (wrapping up is now §11) plus Status/Super Log/Active Links images; help's Scores section shows the graphs; README gained a "Newer admin screens" table. Left as-is: session-dashboard-alerts, session-roster, session-weekly-status (already fake data). The old root `screenshots/` folder (real names, no longer referenced) should be removed from the repo.

### "Still open" sub alert to the player and admins (Kyle, 2026-09-30)

- **Ask:** if nobody from the roster or the sub list takes a sub request, the player who asked was never told. The only signals were a fixed "contact your admin if nobody confirms by match time" line, a silent `unfilled` flag at match time, and the admin status report. Kyle wanted a "still open" alert and an immediate one when nobody is left to ask, sent only to the player and admins (no email to the rest of the week). He decided not to email the player when a request escalates to the sub list.
- **New settings/columns:** `sessions.still_open_alert_hours` (default 4) and `sub_requests.still_open_alert_sent_at` (once per request).
- **`subFlow.sendStillOpenAlert(id, {reason, adminsOnly})`** sends `email.sendSubStillOpen` to the player, listing the admin report addresses to contact, and `sendSubStillOpenAdmin` to `admin_report_emails` (asked/still-open link counts, link to the session). It logs `sub.still_open` via `logSystemActivity`.
- **Timed alert:** `processStillOpenSubs()` runs in `cron.processEscalations()` after the self-arranged pass. It fires at match − `still_open_alert_hours` for open/escalated/unfilled requests.
- **Self-arranged requests:**
  - skipped while still inside the named-sub window, or if named too late
  - admins only if the spot opened up at or after the alert time, since the player just got the "your spot is open" email
- **Immediate "nobody left":** `escalateOneRequest()`, when the sub list has nobody to email and no roster links are still pending, marks the request unfilled and sends the alert right away. It goes to admins only for self-arranged requests, whose "open" email already tells the player.
- **Other updates:**
  - Status page previews it (not suspendable).
  - Email Log gets a "Still open" stage.
  - 3 test templates.
  - The requester's confirmation email now says they'll hear if nobody has taken it N hours before.
  - Session form field.
  - `emailMap.js` → `EMAIL_MAP.md`.
  - `/help` and `/admin/guide` flowcharts, and the README Request a Sub diagram.
- **Verified** on a scratch DB copy:
  - A request 3h out sent both alerts once, and a second pass sent none.
  - An empty sub list with roster links closed sent both immediately on escalation.
  - An "I found a sub" request opening at its deadline sent the admin copy only.
  - Status, edit form, Email Log, guide and help all rendered, and the test sends worked.
- **Note:** request #8 (Kyle/Shawn, Sept 30) is `escalated`, so once deployed it'll get this alert at 4h before its match if still open.

### Reassign "as sub" checkbox for roster picks (Kyle, 2026-09-30)
- **Ask:** Pete D requested a sub for 10/5; Randy J (same roster) said yes on the group email. Kyle used Reassign, which overwrote Pete's row in place, so Pete vanished from 10/5 and Randy looked like a regular player, not Pete's sub.
- **Root cause:** only the sub-list and one-time-sub Reassign branches use sub semantics (original row → `subbed_out`, new `is_sub=1` row with `replaces_assignment_id`). A roster pick always did the in-place swap.
- **Change:** new `as_sub` checkbox on each Reassign form (`session_detail.ejs`), pre-ticked when the row is `needs_sub`. When ticked with a roster pick, `POST /sessions/:id/weeks/:weekId/reassign` keeps the original as `subbed_out` and inserts an `is_sub=1`, `scheduled`, `manually_placed=1` row pointing back at it. Closes the open sub request (or logs an `admin` Sub History row if none), cancels a pending swap, logs `week.reassign_as_sub`. **No email sent now** (Kyle's call): the normal reminder pass picks the sub up. Blackouts stay a warning; Kyle clears them by hand. Guards: locked week, same player, row already `subbed_out`. Unticked = old in-place behavior. Admin guide §4 updated.
- **Data fix:** `Claude outputs/fix-pete-randy-1005.js` (dry run by default, `--apply` to write, idempotent) turns the 10/5 slot back into Pete `subbed_out` + Randy as his sub. Already applied on production (Kyle, 2026-09-30); kept for reference.
- **Verified** on a scratch DB copy: fix script dry-run/apply/re-run; week card shows "Randy Jacobsmeyer · sub — subbing for Peter DiGasbarro"; Sub History shows Randy as filled-by. Over HTTP: open request (Brian→Greg) closed as resolved_manually with the sub row linked; no-request case logs an admin Sub History row; unticked reassign unchanged; self-pick, already-in-week and subbed-out-row guards flash errors with no DB change.

### Early sub claims start "scheduled"; Unconfirm button (Kyle, 2026-09-30)
- **Ask:** Shawn A claimed Pete D's 10/19 spot almost three weeks out and was marked confirmed on the spot, so he'd get no follow-up nudge and the admin pages showed him as settled. Kyle wants early subs to confirm through the regular reminder like everyone else, plus a way to undo a confirmation by hand.
- **Change:** new `subClaimStatus(week, session)` in `subFlow.js`. `claimOffer()` (every self-service, escalation and "I found a sub" claim, and admin-confirmed self-arranged subs) inserts the sub's row as `scheduled` (no `confirmed_at`) when the claim is before that week's reminder time (`reminder_days_before` at `reminder_time`), else `confirmed` as before. Also `confirmed` when the session's automatic reminders are paused or it isn't a regular session. One-time subs, Correct player and the sub-list/"as sub" Reassign paths are unchanged.
- The sub's own copy of "Sub confirmed" (`sendSubFilledNotice`, new `reminderNote`) and the "You're in!" page say to click Confirm when the regular reminder comes; teammates' copies are unchanged. New test template `sub_filled_sub_copy`; `emailMap.js` → `EMAIL_MAP.md` note.
- **Unconfirm:** `POST /sessions/:id/weeks/:weekId/unconfirm/:assignmentId`, button on confirmed rows of unlocked weeks. Sets `scheduled`, clears `confirmed_at`/`admin_confirmed`, sends no email, logs `week.unconfirm`; the flash says whether this week's reminder already went to them. Admin guide §4 updated.
- **Verified** on a scratch copy: `subClaimStatus` gives scheduled at 10/3 08:59 CT and confirmed at 09:00 for a 10/5 match (2 days, 9:00), and confirmed when reminders are paused or for adhoc. A real HTTP claim of Brian P's 10/19 offer inserted Greg J as `scheduled`; only Greg's copy of the email had the reminder line; the claim page showed it. Unconfirm on Shawn's 10/19 row → `scheduled`; a second click and a wrong week id were refused. `npm run test:scheduler` passes.
- **Data:** Shawn's existing 10/19 row is fixed by clicking Unconfirm after deploying (no script).

### Status page "Send now" button (Kyle, 2026-09-30)
- Ask: on Status → Upcoming automated actions, a "Send now" next to Suspend, e.g. to send an open sub request to the broader sub list early instead of waiting for escalation_lead_hours. All the normal links must go out.
- New `services/automationSendNow.js` + `POST /admin/status/send-now`; new "Send now" column on reminder / follow-up / sub-escalation lines (not still-open alerts or week locks).
- Each runs the cron's own send, so templates, fresh tokens and dedup are identical: reminder → `cron.sendReminderEmailsForWeek` (non-forced, only not-yet-reminded) + `fanOutPendingAdminFlagsForWeek`; follow-up → new `cron.sendFollowUpsForWeek` (split out of `processFollowUps`); escalation → new `subFlow.escalateNowForWeek` (roster fan-out first if an admin-flagged request hasn't had one, then sub list via `escalateOneRequest({onlyIfDue:false, ignoreSuspend:true})`; "I found a sub" requests open up via new `openUpSelfArranged()`, requester email worded "an admin has opened it up ahead of schedule" via `early:true`).
- A pending Suspend on the same line is cleared. Logged to Activity Log as `automation.send_now`. Cron won't resend (email_log dedup / request status moves to escalated).
- Verified on a scratch copy of the DB: escalation (7 sub-list emails, each with its own /claim-sub/ link, thread sub:<id>, suspension cleared, cron + second click send nothing), reminder and follow-up (sent once, second click nothing), self-arranged (roster + sub list + early-worded requester email), and the real HTTP route.


### Player blackout removal, yellow "subbed out", second scores reminder, email template previews, admin guide sweep (Kyle, 2026-10-02)
- **Remove my own blackout dates.** Ask: once the schedule is made, a player can remove (never add) upcoming blackout dates themselves, via an emailed link, from an "Edit dates" button on My Page's blackout line and on /blackout. New `services/blackoutEdit.js` + `blackout_edit_tokens` table (same shape as `personal_event_tokens`, 7-day reusable link, hash only). Routes: `POST /blackout/edit-link` (honeypot + 5/hr limit), `GET /blackout/edit/:token`, `POST /blackout/edit/:token/remove` (60/hr). Removing deletes every `blackout_dates` row for that player + date (any session, `self` or `admin` source), only for dates >= today in the app time zone. Doesn't touch the schedule; the player just becomes a sub/swap candidate again. Logged as `blackout.self_remove` (notes when an admin had entered it). New email `sendBlackoutEditLink` (category `blackout_edit_link`) in testEmail + emailMap; Active Links lists/cancels these links. /blackout locked-state wording now says dates can't be *added*.
- **"Subbed out" badge is yellow** (`--badge-subbed_out-bg/-fg`, light + dark), brighter than the admin-only amber "email sent - unconfirmed". Archived/locked labels that borrowed `.badge.subbed_out` now use new `.badge.muted` (gray).
- **Second scores reminder.** New `sessions.games_won_second_reminder_hours` (default 48, 0 = off, must be later than the first; validated on the session form). `processScoreReminders()` sends `score_reminder_2` to the ball-duty player only after the first went out and only while scores are still missing; never both on one tick; skips if more than 24h past due so the deploy doesn't fire for every old week. Subject/body say "Reminder:"/"Second reminder". emailMap + EMAIL_MAP.md regenerated.
- **Email template previews** at the bottom of Send Email: `email.captureEmails(fn)` (AsyncLocalStorage) collects `sendMail()` calls instead of sending/logging; `testEmail.renderPreviews(playerId)` runs every TEMPLATES entry with the same sample data as "Test a template". Table shows subject, when/who (looked up from emailMap by category, "Same time" expanded), and a Preview popup (`GET /admin/email/preview/:key`, same CSP lockdown as the Email Log body). Sample player picker. Page now `wideMain`.
- **Admin guide sweep:** Lock this schedule text was stale (it gates sub requests since 2026-09-10); added player constraints, blackout removal, Send Email previews, Correct on locked weeks, Resolve conflicts, the two score reminders, Admins/Settings; "Sign-Ups" → "Manage sign-ups"; Active Links list. /help and README updated for blackout removal. New/updated screenshots from a fake demo roster (scratch DB): admin-guide `session-weekly-status.png` (now shows yellow badge, as-sub, Unconfirm), new `email-previews.png`; help `my-page.png` (Edit dates), new `blackout-edit.png`.
- **Verified** on scratch DB copies: edit-link email → page lists Greg J's dates across both sessions → remove deletes both session rows, logs; repeat → not_found, past date → refused, bad token → 403. Session form rejects second=12 when first=24, saves 72. Cron with second=36 sent two `score_reminder_2` for 9/30 only, a second pass sent none. Preview page rendered all 41 templates and wrote nothing to email_log; "Test a template" still sends. `npm run test:scheduler` passes.
- **Not built yet:** #2 Injured flag — design questions sent to Kyle (multiple subs per week, early return, notify player).

### Injured players (Kyle, 2026-10-02)
- **Ask:** an "Injured" checkbox + "out through" date on the Players roster (e.g. out 6 weeks for knee surgery). Kyle's calls: their weeks go to needs sub but sub requests wait for each week's first confirmation reminder; back early → weeks whose request hasn't gone out return to scheduled, already-sent requests play out, filled spots stay; pushing the date out flags the new weeks; email the player (and add it to the test/preview template lists); ball-duty weeks flagged for the admin. Two-subs-in-one-week is the next item, not this one.
- **Built:** `players.injured`, `players.injured_until` (inclusive), `sub_requests.injury`; new `services/injury.js`. `syncPlayer()` is idempotent: adds `blackout_dates` rows with `source='injury'` for the range in every regular session the player is on (roster or session sub players), runs `subFlow.adminFlagNeedsSub()` on each unlocked scheduled/confirmed week in range (no email; fan-out at that week's reminder time; ball duty cleared + week flagged, as before), and reverts open, not-yet-fanned-out injury requests outside the range to `resolved_injury_return` (excluded from Sub History and Player Behavior stats, refused by claimSub). A request the admin cleared by hand is never re-flagged. Weeks blocked by another open request or an unlocked schedule wait and show on the Status page; cron's `processInjuries()` (first thing each tick) retries them and clears the flag the day after `injured_until`.
- `POST /admin/players/:id/injury` (Players page "Injured" column, Set button), logs `player.injured` / `player.injury_cleared`; cron logs `player.injury_flag` / `player.injury_ended`. Email `sendInjuryNotice` (`injury_notice`) on mark or date change; in testEmail + emailMap. Players can't remove `injury` blackouts from the Edit dates page. Admin guide §2 + new `players-injured.png` screenshot.
- **Verified** on a scratch copy: Kyle K through 11/13 → 5 weeks needs_sub with injury requests, 11/11 ball duty cleared + flagged, injury blackouts across sessions 1/2/3, notice emailed; moved to 10/20 → 3 weeks back to scheduled (`resolved_injury_return`), new email; moved to 11/20 → those 3 + 11/18 re-flagged; with 10/7's fan-out marked sent, unchecking reverted everything except 10/7. Randy J through 10/19 → 10/19 waited (Brian P's open request) and showed on Status; after closing that request `processInjuries()` flagged it. An injury dated yesterday auto-cleared. Test send + preview render the new template.

### Player and admin guides as Markdown for GitHub (Kyle, 2026-10-02)
- **Ask:** put the How It Works and Admin Guide pages on GitHub as documentation.
- **Built:** `src/scripts/write-guides.js` (`npm run guides`) boots the real app against a throwaway temp database (never `data/tennis.db`), logs in as a temporary admin, fetches `/help` and `/admin/guide`, and converts each page's `<main>` with turndown (+ gfm tables) into `docs/USER_GUIDE.md` and `docs/ADMIN_GUIDE.md`. Custom rules: flowchart steps → blockquotes with ↓ arrows and "If: …" branch lists; badges → inline code; sample emails → a quoted "Example email"; screenshots → `../src/public/img/...` so GitHub shows them; heading ids kept as `<a id>` anchors; links between the two guides rewritten, other in-app links become bold text. The EJS pages stay the source of truth (generated-file banner at the top of each). New devDependencies `turndown`, `turndown-plugin-gfm` (pure JS). README, HANDOFF and CLAUDE.md link/mention them.
- **Verified:** both files generate; every referenced image exists; rendered with marked + GitHub's markdown CSS to check flowcharts, tables, sample emails and screenshots read correctly.

### Two players needing a sub the same week: shared sub requests (Kyle, 2026-10-02)
- **Ask:** when two players ask for a sub for the same week, don't email the roster twice. The first request's email goes out; the second joins it. First "I'll play" click fills the first request, second click fills the second. Same for the sub-list escalation. Decided with Kyle: (1) links stay open until every request is filled; if the first request is already completely filled before the second player asks, the second gets a fresh roster email (the app can't hold for a request that doesn't exist yet, and everyone already saw "Sub found"); each player still gets their own "your sub is confirmed" right away. (2) An "I found a sub" request stays separate while its named sub has time, then joins the open request when it opens up; the named sub's link always fills that player's spot; admins fix any odd outcome with Reassign. (3) No extra email to the roster when the second request joins.
- **Before:** `hasActiveConcurrentSubRequest()` refused any second request in a week ("the admin will sort out multiple sub requests in the same week manually"), and injured players' weeks waited on the Status page.
- **Changed:** `sub_requests.pool_id` (the request whose outreach is shared; NULL = own) and `sub_requests.shared_at` (part of a group's outreach; NULL while an admin flag waits for reminder time or an "I found a sub" waits on its named sub), with a backfill for open rows. `subFlow.js` "Shared sub requests" block: `startOutreach()` joins the week's open group (`joinablePoolForWeek()`/`joinPool()`, no emails) or fans out; `claimOffer()` picks the target via `claimTarget()` (named sub → own request; else oldest open in the group) and only closes the group's links once nothing in it is open; `escalateOneRequest()` sends the sub list once per group and marks the rest escalated, and a joiner of an already-escalated group is escalated immediately; `closeActiveSubRequestForAssignment()` leaves links live for the rest of the group. Only a second request on the *same slot* is refused now (`hasActiveSubRequestForAssignment`, reason `already_requested`). Admin flags/injury weeks join an open group immediately. Emails: joined variants of `sub_request_self_notice` and `self_arranged_escalated`; `sub_filled` adds "This match still needs one more sub" while another request that week is open. Claim page and "You're in!" say whose spot the sub is covering. Session page lists every open request with "1st/2nd in line" and its own Clear button (routes take `sub_request_id`). Status page groups the sub-list preview into one line. Active Links shows a filled request's links while its group is still open. Email map has a new "Two players need a sub the same week" section; admin guide, help, README, CLAUDE.md updated.
- **Verified:** scratch DB (seeded example, never `data/tennis.db`) script covering: A+B together (one roster email; clicks fill A then B; links close after B; 3rd click refused; "one more sub" only on the first Sub found); A filled before B asks (fresh email, the first sub not re-asked); B joining an escalated A (no new emails, escalated at once; sub-list and roster claims fill A then B); A+B escalating together (one sub-list email per person); "I found a sub" C separate from D, C opening up into E's group with only the requester note, Bob's link filling C; admin flag joining; clearing A keeping links live for B; duplicate same-slot request refused; still-open alert for a joined request. Booted the server on the scratch DB: session page badges/Clear buttons, claim page "covering X's spot", Status page. Migration run against a copy of the real DB. `npm run test:scheduler` passes.

### HISTORY.md split into a recent log + archive (Kyle, 2026-10-02)
- **Ask:** cut down the docs a handoff session reads, to save tokens.
- **Changed:** everything before the 2026-09-15 entries (the original CLAUDE.md architecture notes, backlog design notes and early dated entries, ~600 KB) moved word-for-word to `docs/HISTORY_ARCHIVE.md`; `docs/HISTORY.md` keeps 2026-09-15 on (~135 KB) and still takes new entries. `CLAUDE.md` and `HANDOFF.md` say to search the archive when this file has nothing. `Full_Scope_Of_Work.md` marked as an archive.
- **Verified:** archive + this file reproduce the original content line for line.

### Score-reminder link names who entered scores (Kyle, 2026-10-02)
- **Ask:** if someone enters scores from the ball-duty "scores still needed" email link, the Activity Log should say who; going to /scores on your own stays generic.
- **Changed:** new `score_link_tokens` table + `services/scoreLinkTokens.js` (random token per email, only the hash stored, scoped to that week). `sendScoreReminder()` adds `&t=<token>` to its link. GET /scores carries a valid token into the form as a hidden field; POST /scores resolves it and `logGroupScoreActivity()` logs `"<recipient> (score reminder link)"` with "by <name> via the score reminder email link" in the description. Missing/unknown/other-week token → the old "(group entry)" entry. The token is attribution only, never a gate. The post-save redirect keeps `t` so a second save is attributed too.
- **Verified:** scratch copy with seeded DB: sent a reminder, opened its link, saved two boxes (logged under the recipient), saved one from plain /scores (generic), bogus token renders no hidden field.

### Ball-duty player told to enter scores, with a direct link (Kyle, 2026-10-02)
- **Ask:** in the weekly match reminders, the player on ball duty should be told it's also their job to enter the match scores afterward, with a direct link to that match's scores.
- **Changed:** `ballDutyNotice(player, week, session)` in email.js (confirmation reminder + follow-up) adds a line saying they're responsible for entering everyone's scores after the match, linking to `/scores?session=&week=&t=<token>`. Only for regular sessions with `games_won_enabled`. The token reuses `scoreLinkTokens`, so a save from that link is logged under their name; the Activity Log label for any emailed link is now "(emailed score link)". GET /scores shows "Scores for <date> open once that match starts" if the linked week isn't locked yet, instead of silently showing another week.
- **Verified:** scratch copy with seeded DB: ball-duty recipient got the line + link, other player didn't; link before lock showed the not-open notice, after lock showed the grid and the save was logged under the ball-duty player.
- **Follow-up (same day):** "Are those in the email templates too?" The normal Confirmation/Follow-up test templates only show the ball-duty box if the test recipient happens to be that week's ball-duty player. Added `reminder_ball_duty` and `follow_up_ball_duty` to `services/testEmail.js` (labels "… — ball duty version"), which force the recipient onto ball duty and `games_won_enabled` on so the box and scores link always show. Verified by sending all three to a non-ball-duty player in the scratch copy.

### Session form roster note removed; Email Log groups visually set apart (Kyle, 2026-10-03)
- **Ask:** (1) drop the "Need a new player? … Priority only matters if…" paragraph under the regular-session roster table (redundant). (2) On the grouped Email Log, the last email in an expanded group was easy to confuse with the ungrouped email below it.
- **Changed:** `admin/session_form.ejs` paragraph removed (the ad-hoc roster's one-line "Need a new player?" note stays). `admin/email_log.ejs` + `style.css`: new `--thread-head-bg`, `--thread-child-bg`, `--thread-accent` (light + dark). Group header rows are tinted (blue left edge when open); rows inside a group are tinted, indented 40px and carry a 4px blue left rail; the page script tags each group's last row `thread-last`, which gets a 3px blue bottom edge closing the group. Inline `bg-soft`/padding styles on those rows moved to CSS.
- **Verified:** scratch copy of the app on a copy of the DB, logged in, rendered `/admin/email-log` and screenshotted light and dark with groups expanded.
