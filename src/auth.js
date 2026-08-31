'use strict';
const db = require('./db');
const { clearAuthSession } = require('./middleware/sessionAuth');

const HOME = { admin: '/admin', mentor: '/mentor', student: '/student', developer: '/admin' };

/** Where a signed-in user belongs. Unknown roles fall back to the profile page. */
function homeFor(role) {
  return HOME[role] || '/profile';
}

function isUserDeveloper(user) {
  if (!user) return false;
  const email = (user.email || '').toLowerCase();
  return Boolean(
    user.is_developer ||
    user.role === 'developer' ||
    email === 'gauravkhandelwal205@gmail.com' ||
    email === 'heramb15012006@gmail.com'
  );
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
  if (req._resolvedUser && req._resolvedUser.id === req.session.user.id) {
    user = req._resolvedUser;
  } else {
    try {
      user = db.prepare('SELECT * FROM users WHERE id = ?')
        .get(req.session.user.id);
      if (user) req._resolvedUser = user;
    } catch (err) {
      console.error('Auth lookup failed:', err);
    }
  }

  if (!user || !user.active) {
    // Tear down *both* halves of the session: the server-side record and the
    // signed cookie that would otherwise rehydrate it on the next request.
    clearAuthSession(req, res, () => respondUnauthenticated(req, res));
    return null;
  }

  const isDev = isUserDeveloper(user);

  req.session.user.name = user.name;
  req.session.user.email = user.email;
  req.session.user.is_developer = isDev;

  if (isDev && req.session.activeRole) {
    req.session.user.role = req.session.activeRole;
  } else {
    req.session.user.role = isDev ? (req.session.activeRole || user.role || 'developer') : user.role;
  }

  res.locals.user = req.session.user;
  res.locals.isDeveloper = isDev;
  res.locals.activeRole = req.session.user.role;
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

    const isDev = isUserDeveloper(user);
    // Developer can access everything across all roles
    if (isDev) {
      return next();
    }

    const currentRole = (req.session.user && req.session.user.role) || user.role;
    if (!roles.includes(currentRole)) {
      if (!req.accepts('html')) {
        return res.status(403).json({ error: 'You do not have permission to perform this action.' });
      }
      return res.status(403).render('error', {
        title: 'Access denied',
        message: 'You do not have permission to view this page.',
        backHref: homeFor(currentRole),
        backLabel: 'Go to my dashboard',
      });
    }
    next();
  };
}

module.exports = { requireLogin, requireRole, homeFor, isUserDeveloper, HOME };
