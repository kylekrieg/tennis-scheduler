'use strict';

// Bot-deterrent for public, unauthenticated forms that trigger email
// (Request a Sub, Propose a Swap) — separate from, and much cheaper than,
// the email-verification-first gate those two routes also have (see
// "Propose a Swap: email-gated..." in CLAUDE.md). That gate stops a
// targeted attempt from ever reaching a third party's inbox; this catches
// generic, unsophisticated bots (the ones that blindly fill every field in
// a scraped HTML form) even earlier, before a verification email goes out
// to the *initiator* at all.
//
// FIELD_NAME is a plain <input type="text"> in the form, hidden from real
// people with CSS (never type="hidden" — some bots know to skip those) and
// marked tabindex="-1"/autocomplete="off"/aria-hidden="true" so a sighted
// user tabbing through the form and a screen reader both skip over it
// entirely. A real submission's value is always empty; anything else means
// whatever submitted the form filled in a field no human could see.
const FIELD_NAME = 'website';

/** True if the honeypot field came back non-empty — i.e. this submission is
 * almost certainly a bot, not a real player. */
function isBot(req) {
  const value = req.body && req.body[FIELD_NAME];
  return typeof value === 'string' && value.trim().length > 0;
}

module.exports = { FIELD_NAME, isBot };
