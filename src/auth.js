'use strict';
const db = require('./db');

function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.redirectTo = req.originalUrl;
    return res.redirect('/login');
  }
  // Verify user still exists in database
  const user = db.prepare('SELECT id, name, email, role, active FROM users WHERE id = ?').get(req.session.user.id);
  if (!user || !user.active) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  // Refresh session cache
  req.session.user.name = user.name;
  req.session.user.role = user.role;
  next();
}

function requireRole(...roles) {
  return function (req, res, next) {
    if (!req.session.user) {
      req.session.redirectTo = req.originalUrl;
      return res.redirect('/login');
    }
    const user = db.prepare('SELECT id, name, email, role, active FROM users WHERE id = ?').get(req.session.user.id);
    if (!user || !user.active) {
      return req.session.destroy(() => res.redirect('/login'));
    }
    req.session.user.name = user.name;
    req.session.user.role = user.role;

    if (!roles.includes(user.role)) {
      return res.status(403).render('error', {
        title: 'Access denied',
        message: 'You do not have permission to view this page.',
      });
    }
    next();
  };
}

module.exports = { requireLogin, requireRole };
