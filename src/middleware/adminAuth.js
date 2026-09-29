'use strict';

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  // Background fetch() calls from admin pages (e.g. the News editor's image
  // upload/preview, Kyle 2026-09-28) send Accept: application/json. For those,
  // a redirect would be silently followed to the login page's HTML and show up
  // as a baffling "Upload failed (200)" — answer with a clear 401 instead so
  // the page can say "your login expired" (sessions live in memory, so every
  // pm2 restart logs admins out).
  const accept = req.get('Accept') || '';
  if (accept.includes('application/json') && !accept.includes('text/html')) {
    return res.status(401).json({ error: 'Your admin login has expired (the app was probably restarted).', loginExpired: true });
  }
  return res.redirect('/admin/login');
}

module.exports = { requireAdmin };
