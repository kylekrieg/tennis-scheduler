'use strict';

/**
 * Public name vs. full name (Kyle, 2026-09-07): "In the player roster... I
 * used Kyle K, or John G. This is what shows up on the public screen. This is
 * fine as last names are not shown, but for the broader sub list, I have full
 * names called out... everywhere we have a public facing page, we should use
 * the public name field. Any where we have an admin looking at it, it should
 * be a full name... in emails for confirms, subs, swaps, etc... we should use
 * full names as that's a trusted system and not a public [page]."
 *
 * `players.name` keeps its existing meaning: the short public form (e.g.
 * "Kyle K"), read directly wherever a page is unauthenticated — /schedule,
 * /lookahead, /me, /blackout, /request-sub, /swap, /found-sub, the PDF, the
 * .ics calendar, the public /stats page. No helper needed for that side;
 * just read `.name` like every public template already does.
 *
 * `players.full_name` is the new column, shown everywhere an admin is
 * logged in and in every email. It starts NULL until an admin fills it in
 * on the Players page, so `fullName()` below falls back to the public name
 * rather than ever rendering blank.
 *
 * `broader_sub_list` rows have no `full_name` column of their own — a
 * broader-sub-list entry's single `name` field already IS the full name
 * (Kyle: "for the broader sub list, I have full names called out" — that's
 * fine and intentional, since that list is admin-managed and used in
 * emails, never rendered on its own on a public page). fullName() still
 * works correctly on a broader_sub_list row for exactly this reason: with
 * no `full_name` property at all, it falls straight through to `.name`,
 * which is already the real full name.
 */
function fullName(player) {
  if (!player) return '';
  // Accepts either a raw DB row (players.full_name / broader_sub_list has no
  // such column at all) or one of this app's constructed candidate objects
  // (subFlow.js's sessionSubList()/eligibleSelfArrangedCandidates()/
  // arrangeSelfSub(), which use a camelCase .fullName since they're plain JS
  // objects, not query results) — checking both spellings here means every
  // call site can just say fullName(x) without knowing which shape x is.
  return player.full_name || player.fullName || player.name || '';
}

/**
 * Auto-derived public name for a player created from a full name only — a
 * broader-sub-list conversion (claimSub, arrangeSelfSub, the Reassign
 * dropdown's "Sub list" broader:<id> branch) or a one-time sub typed
 * straight into the Reassign form. "First LastInitial" — matches Kyle's own
 * existing roster convention exactly (e.g. "Kyle Krieg" -> "Kyle K"),
 * deliberately no period after the initial, matching every hand-entered
 * public name already in the roster.
 *
 * This is just a starting guess, not guaranteed collision-free — two
 * players both showing as "Kyle K" is fine and already how this app has
 * always worked (players.slug is the thing that actually needs to be
 * unique, and this never touches that). Editable afterward on the Players
 * page like any other name field.
 */
function deriveShortName(full) {
  const parts = (full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const lastInitial = parts[parts.length - 1][0];
  return `${first} ${lastInitial}`;
}

module.exports = { fullName, deriveShortName };
