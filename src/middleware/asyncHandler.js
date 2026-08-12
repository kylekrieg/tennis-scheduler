'use strict';

/**
 * Wraps an async Express route handler so a thrown error or rejected
 * promise is forwarded to next(err) instead of becoming an unhandled
 * promise rejection.
 *
 * Express 4 only auto-catches errors thrown by *synchronous* handlers —
 * calling an async function always returns a promise, even for a throw on
 * the first line, so Express's own try/catch around the handler call never
 * sees it. Without this wrapper, an error inside an `async (req, res) => {}`
 * route (a DB constraint violation, a bug, anything) becomes an unhandled
 * promise rejection: the request just hangs with no response, and — since
 * Node 15 — an unhandled rejection crashes the entire process by default,
 * taking the whole site down for everyone, not just that one request.
 *
 * Wrap every async route handler with this: router.post('/x', asyncHandler(async (req, res) => {...}))
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
