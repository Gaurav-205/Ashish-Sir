'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin } = require('../auth');

const router = express.Router();

const HOME = { admin: '/admin', mentor: '/mentor', student: '/student' };

router.get('/', (req, res) => {
  if (req.session.user) return res.redirect(HOME[req.session.user.role]);
  res.redirect('/login');
});

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(HOME[req.session.user.role]);
  res.render('login', { title: 'Sign in', error: null, email: '' });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const row = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);

  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).render('login', {
      title: 'Sign in', error: 'Invalid email or password.', email: req.body.email || '',
    });
  }
  if (!row.active) {
    return res.status(403).render('login', {
      title: 'Sign in', error: 'This account has been deactivated. Contact the admin.', email: req.body.email || '',
    });
  }
  req.session.user = { id: row.id, name: row.name, email: row.email, role: row.role };
  const to = req.session.redirectTo;
  delete req.session.redirectTo;
  res.redirect(to || HOME[row.role]);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/profile', requireLogin, (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('profile', { title: 'My profile', me, error: null, ok: null });
});

router.post('/profile/password', requireLogin, (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const { current, next1, next2 } = req.body;
  let error = null, ok = null;
  if (!bcrypt.compareSync(String(current || ''), me.password_hash)) error = 'Current password is incorrect.';
  else if (String(next1 || '').length < 6) error = 'New password must be at least 6 characters.';
  else if (next1 !== next2) error = 'The two new passwords do not match.';
  else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(bcrypt.hashSync(String(next1), 10), me.id);
    ok = 'Password updated.';
  }
  res.render('profile', { title: 'My profile', me, error, ok });
});

module.exports = router;
