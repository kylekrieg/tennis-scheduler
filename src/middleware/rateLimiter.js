'use strict';

/**
 * Simple in-memory, per-client-IP rate limiter for public POST routes that
 * can trigger outbound email off a small, sequential, guessable id
 * (week_assignments.id) rather than an unguessable random token — see
 * "Rate limiting on Request a Sub and Propose a Swap" in CLAUDE.md. The
 * email-verification gate on both those routes already stops a bot from
 * ever reaching a *third party's* inbox, and the honeypot field already
 * catches bots that don't inspect the form — this closes the remaining
 * gap: a script that walks assignment_id=1,2,3... one at a time, replaying
 * the real (non-honeypot) fields a browser would send, could otherwise
 * trigger a "confirm it's you" verification email to every currently-
 * scheduled player in a single sitting.
 *
 * Deliberately not a new npm dependency (e.g. express-rate-limit) — this
 * app already prefers hand-rolled solutions for genuinely simple needs over
 * adding a package (see offsiteBackup.js's choice of the system `rsync`
 * binary over a new library), and a single in-memory Map is exactly enough
 * machinery for one Node process on one Pi with no need to share state
 * across multiple server instances.
 *
 * Keyed by the real client IP, not `req.ip` — this app runs behind a
 * Cloudflare Tunnel (cloudflared), so `req.ip`/`req.socket.remoteAddress`
 * is always the tunnel daemon's own loopback connection, never the actual
 * visitor. Cloudflare's edge sets `CF-Connecting-IP` to the real client IP
 * on every request passing through it, and overwrites any client-supplied
 * value of that header, so it's safe to trust here. Falls back to `req.ip`
 * for local/dev use with no Cloudflare in front (e.g. every scratch-sandbox
 * verification run in this app's own history).
 */

const buckets = new Map(); // "<name>:<ip>" -> array of hit timestamps (ms)

function clientKey(req) {
  return req.headers['cf-connecting-ip'] || req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Periodic sweep so buckets for IPs that stopped hitting eventually get
// garbage-collected instead of accumulating forever over a long Pi uptime.
// This is independent of any individual limiter's own window — it's just
// housekeeping, so a generous fixed threshold is fine regardless of what
// windowMs a particular limiter was configured with. unref()'d so it never
// keeps the process alive on its own (matters for clean shutdowns in tests).
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const STALE_AFTER_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of buckets) {
    const stillLive = hits.filter((t) => now - t < STALE_AFTER_MS);
    if (stillLive.length === 0) buckets.delete(key);
    else buckets.set(key, stillLive);
  }
}, SWEEP_INTERVAL_MS).unref();

/** Returns Express middleware enforcing `max` requests per `windowMs`
 * milliseconds, per client IP. `name` scopes the bucket namespace so
 * different routes using this factory don't share a budget with each
 * other. */
function rateLimiter({ name, windowMs, max }) {
  return function (req, res, next) {
    const key = `${name}:${clientKey(req)}`;
    const now = Date.now();
    let hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);

    if (hits.length >= max) {
      const retryMinutes = Math.max(1, Math.ceil((windowMs - (now - hits[0])) / 60000));
      res.status(429);
      return res.render('message', {
        title: 'Slow down',
        heading: 'Too many requests',
        body: `You've hit this a few too many times in a short window — try again in about ${retryMinutes} minute${retryMinutes === 1 ? '' : 's'}.`,
        tone: 'error',
      });
    }

    hits.push(now);
    buckets.set(key, hits);
    next();
  };
}

module.exports = { rateLimiter };
