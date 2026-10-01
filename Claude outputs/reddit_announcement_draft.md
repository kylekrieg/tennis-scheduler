# Reddit announcement draft — Tennis Doubles Scheduler

**Suggested title:**
"I built a free, open-source scheduler for recurring doubles groups (season scheduling, subs, no login for players) — self-hostable"

---

**Post body:**

My tennis group has been running a weekly doubles league for a while, and like a lot of groups we were doing the actual scheduling by hand — texting around for subs, a shared spreadsheet nobody kept updated, someone always double-booked or unsure if they were "in" this week. I ended up building a real website for it instead, and since I know a lot of other tennis and pickleball groups deal with the exact same headache, I open-sourced it in case it's useful to anyone else.

It's a no-login website for a recurring doubles group. The short version of what it does:

- **Builds the whole season automatically.** Give it your roster, how many games each person wants to play, and everyone's blackout dates, and it schedules every week, balances total playing time fairly, and mixes up partners so the same two people aren't always paired. If a week genuinely can't be fully staffed, it schedules what it can with who's available and flags it — it doesn't hold the rest of the season hostage over one bad week.
- **No accounts, no passwords, for players.** Everyone gets a bookmarkable personal page and email links — confirm you're playing, request a sub, or propose a direct week swap with a specific teammate, all with one click.
- **Handles subs the annoying way you'd actually want:** a reminder email goes out, if you can't make it you hit "need a sub," it fans out to your group's sub list, first person to claim it gets it, and if nobody responds in time it escalates automatically. No more group texts into the void.
- **Works for loose pickup games too, not just season leagues** — there's a second mode built for first-come-first-served pickup sessions (invite goes out, courts fill as people click "I'm in," done) rather than a fairness-scheduled season. That mode in particular seems like a good fit for how a lot of pickleball groups actually run.
- **The extras you'd expect:** a subscribable calendar feed that stays current, a printable season PDF, a public stats page (who's played how much, ball duty, etc.), dark mode, and it all works fine on a phone.

It's self-hosted — you run it yourself rather than signing up for a hosted service. It's a plain Node.js app with no other services required, and I deliberately built it to run comfortably on something as cheap as a Raspberry Pi, so hosting cost is basically nothing. That does mean it's more of a weekend project for someone reasonably comfortable poking around a terminal (or who has a friend who is) than a one-click app-store install — but the README walks through the whole setup, including getting it reachable from outside your home network.

It's MIT licensed and free to clone, run, and modify for your own group — the one restriction is you can't turn around and resell it or sell hosting for it. Not trying to build a SaaS here, just sharing something that's been genuinely useful for our group.

GitHub: https://github.com/kylekrieg/tennis-scheduler

Screenshots and the full feature list are in the README. Happy to answer questions in the comments, and issues/PRs are welcome if you end up running it and hit something.
