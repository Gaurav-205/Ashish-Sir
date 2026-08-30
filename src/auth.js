'use strict';
const db = require('./db');
const { clearAuthSession } = require('./middleware/sessionAuth');

const HOME = { admin: '/admin', mentor: '/mentor', student: '/student' };

/** Where a signed-in user belongs. Unknown roles fall back to the profile page. */
function homeFor(role) {
  return HOME[role] || '/profile';
}

/**
 * Re-reads the session user from the database on every request so that a
 * deactivated, deleted or role-changed account cannot keep using a session
 * that was minted before the change.
 *
 * Returns the fresh row, or null when the caller has already responded.
 */
function resolveCurrentUser(req, res) {
  if (!req.session || !req.session.user) {
    if (req.method === 'GET') req.session.redirectTo = req.originalUrl;
    respondUnauthenticated(req, res);
    return null;
  }

  let user = null;
  try {
    user = db.prepare('SELECT id, name, email, role, active FROM users WHERE id = ?')
      .get(req.session.user.id);
  } catch (err) {
    console.error('Auth lookup failed:', err);
  }

  if (!user || !user.active) {
    // Tear down *both* halves of the session: the server-side record and the
    // signed cookie that would otherwise rehydrate it on the next request.
    clearAuthSession(req, res, () => respondUnauthenticated(req, res));
    return null;
  }

  req.session.user.name = user.name;
  req.session.user.email = user.email;
  req.session.user.role = user.role;
  res.locals.user = req.session.user;
  return user;
}

function respondUnauthenticated(req, res) {
  if (res.headersSent) return;
  if (req.accepts('html')) return res.redirect('/login');
  return res.status(401).json({ error: 'Authentication required.' });
}

function requireLogin(req, res, next) {
  if (!resolveCurrentUser(req, res)) return;
  next();
}

function requireRole(...roles) {
  return function (req, res, next) {
    const user = resolveCurrentUser(req, res);
    if (!user) return;

    if (!roles.includes(user.role)) {
      if (!req.accepts('html')) {
        return res.status(403).json({ error: 'You do not have permission to perform this action.' });
      }
      return res.status(403).render('error', {
        title: 'Access denied',
        message: 'You do not have permission to view this page.',
        backHref: homeFor(user.role),
        backLabel: 'Go to my dashboard',
      });
    }
    next();
  };
}

module.exports = { requireLogin, requireRole, homeFor, HOME };
