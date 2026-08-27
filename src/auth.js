'use strict';
function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.redirectTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}
function requireRole(...roles) {
  return function (req, res, next) {
    if (!req.session.user) {
      req.session.redirectTo = req.originalUrl;
      return res.redirect('/login');
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('error', {
        title: 'Access denied',
        message: 'You do not have permission to view this page.',
      });
    }
    next();
  };
}
module.exports = { requireLogin, requireRole };
