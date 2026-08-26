'use strict';

/**
 * NOTE: every function here takes `db` as an explicit parameter rather than
 * requiring the singleton module — db/index.js itself needs these functions
 * for its one-time backfill, while it's still mid-initialization (before
 * module.exports is assigned), so a top-level `require('../db')` here would
 * see an incomplete module and crash. Passing `db` in avoids the circular
 * require entirely; every other caller (e.g. admin.js) just passes the
 * normal `db` singleton it already imports.
 *
 * Name-based "My Page" URLs (Kyle, 2026-08-26): "players personal URL end
 * with a number. Is there a way to change that so the URL is their name? If
 * we do have 2 'Brian B' or 'John H' we'll need to figure out another
 * method but as of right now, everybody has a unique first name and last
 * initial."
 *
 * players.slug is a stable, app-level-unique (not DB-constrained — see
 * db/index.js's backfill comment) short identifier derived from the
 * player's name at the moment they're created, and deliberately NEVER
 * regenerated automatically when a name is later edited — the whole point
 * of a bookmarkable URL is that it keeps working, so a name correction or
 * an admin fixing a typo shouldn't quietly break every link a player has
 * already bookmarked, printed, or saved in a calendar app. If a real
 * collision ever does happen (two "Brian B"s), the admin can manually set a
 * distinct slug for one of them from the Players page — see admin.js's
 * invalidSlug()/slugTaken() and admin/players.ejs's new "URL slug" field.
 */

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Turns a display name into a URL-safe slug: lowercase, non-alphanumeric
 * runs collapsed to a single hyphen, leading/trailing hyphens trimmed.
 * Falls back to 'player' for a name that has no alphanumeric characters at
 * all (shouldn't happen in practice since name is a required field, but
 * this keeps generateUniqueSlug() from ever producing an empty base). */
function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'player';
}

/** Returns true if `slug` is already in use by some player other than
 * `excludePlayerId` (pass null/undefined when checking a brand-new player).
 * `db` is any object exposing `.prepare(sql).get(...args)` — the real db
 * singleton, or db/index.js's own low-level `raw` connection during its
 * own boot-time backfill (see note above on why this isn't just imported). */
function slugTaken(db, slug, excludePlayerId) {
  const row = excludePlayerId
    ? db.prepare('SELECT id FROM players WHERE slug = ? AND id != ?').get(slug, excludePlayerId)
    : db.prepare('SELECT id FROM players WHERE slug = ?').get(slug);
  return !!row;
}

/** Generates a slug from `name` that's not currently in use, appending
 * -2, -3, ... on collision (same "graceful degradation, never a hard fail"
 * pattern used elsewhere in this app for name/scheduling collisions). */
function generateUniqueSlug(db, name, excludePlayerId) {
  const base = slugify(name);
  let candidate = base;
  let n = 2;
  while (slugTaken(db, candidate, excludePlayerId)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

module.exports = { SLUG_RE, slugify, slugTaken, generateUniqueSlug };
