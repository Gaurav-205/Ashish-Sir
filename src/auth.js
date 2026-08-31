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
  // Authority is the DB only. Do NOT grant developer by email string: emails
  // are guessable / registerable (Google sign-in auto-provisions accounts), so
  // an email allow-list here is a privilege-escalation backdoor.
  return Boolean(user.is_developer || user.role === 'developer');
}

function isDualRoleUser(user) {
  if (!user) return false;
  if (isUserDeveloper(user)) return true;
  // Dual-role = an admin who is also enabled as an evaluator (Technical/HR).
  // Derived from DB state only — no email allow-list.
  const canEval = Boolean(user.can_technical || user.can_hr);
  return user.role === 'admin' && canEval;
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
  } else if (process.env.NODE_ENV !== 'test' && req.session._cachedUser && req.session._cachedUserAt && (Date.now() - req.session._cachedUserAt < 3000) && req.session._cachedUser.id === req.session.user.id) {
    user = req.session._cachedUser;
    req._resolvedUser = user;
  } else {
    try {
      user = db.prepare('SELECT * FROM users WHERE id = ?')
        .get(req.session.user.id);
      if (user) {
        req._resolvedUser = user;
        req.session._cachedUser = user;
        req.session._cachedUserAt = Date.now();
      }
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

  // A password change/reset bumps `sessions_invalid_before`. Any session (or
  // stateless cookie) issued before that instant is dead — this is what makes
  // "log out my other devices" work even on the serverless MemoryStore.
  if (user.sessions_invalid_before && req.session.user) {
    if (!req.session.user.iat) {
      req.session.user.iat = Date.now();
    } else if (Number(req.session.user.iat) < Number(user.sessions_invalid_before)) {
      clearAuthSession(req, res, () => respondUnauthenticated(req, res));
      return null;
    }
  }

  const isDev = isUserDeveloper(user);
  const isDual = isDualRoleUser(user);

  req.session.user.name = user.name;
  req.session.user.email = user.email;
  req.session.user.is_developer = isDev;
  req.session.user.is_dual_role = isDual;

  if (req.session.activeRole && (isDev || isDual)) {
    req.session.user.role = req.session.activeRole;
  } else {
    // Not (or no longer) dev/dual: a stale activeRole from a past switch must
    // NOT keep granting the switched role after a demotion. Drop it and fall
    // back to the account's real role.
    if (req.session.activeRole) delete req.session.activeRole;
    req.session.user.role = isDev ? 'developer' : user.role;
  }

  res.locals.user = req.session.user;
  res.locals.isDeveloper = isDev;
  res.locals.isDualRole = isDual;
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
    if (isDev) {
      return next();
    }

    const isDual = isDualRoleUser(user);
    const currentRole = (req.session.user && req.session.user.role) || req.session.activeRole || user.role;

    if (isDual && roles.includes(currentRole)) {
      return next();
    }

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

module.exports = { requireLogin, requireRole, homeFor, isUserDeveloper, isDualRoleUser, HOME };
