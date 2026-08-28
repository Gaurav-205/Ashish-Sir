'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin } = require('../auth');
const google = require('../services/googleService');

const router = express.Router();

const HOME = { admin: '/admin', mentor: '/mentor', student: '/student' };

router.get('/', (req, res) => {
  if (req.session.user) return res.redirect(HOME[req.session.user.role]);
  res.redirect('/login');
});

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(HOME[req.session.user.role]);
  res.render('login', {
    title: 'Sign in',
    error: null,
    email: '',
    googleConfigured: google.isConfigured(),
  });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const row = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);

  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).render('login', {
      title: 'Sign in',
      error: 'Invalid email or password.',
      email: req.body.email || '',
      googleConfigured: google.isConfigured(),
    });
  }
  if (!row.active) {
    return res.status(403).render('login', {
      title: 'Sign in',
      error: 'This account has been deactivated. Contact the admin.',
      email: req.body.email || '',
      googleConfigured: google.isConfigured(),
    });
  }
  req.session.user = { id: row.id, name: row.name, email: row.email, role: row.role };
  let to = req.session.redirectTo;
  delete req.session.redirectTo;
  if (to) {
    if (to.startsWith('/admin') && row.role !== 'admin') to = null;
    else if (to.startsWith('/student') && row.role !== 'student') to = null;
    else if (to.startsWith('/mentor') && row.role !== 'mentor') to = null;
  }
  res.redirect(to || HOME[row.role]);
});

/* ------------------------------ Google OAuth ----------------------------- */
router.get('/auth/google', (req, res) => {
  if (!google.isConfigured()) {
    return res.render('login', {
      title: 'Sign in',
      error: 'Google Sign-In is not configured yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your environment.',
      email: '',
      googleConfigured: false,
    });
  }
  const state = req.query.link === '1' && req.session.user ? `link:${req.session.user.id}` : 'auth';
  res.redirect(google.getAuthUrl(state));
});

router.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) {
    return res.render('login', {
      title: 'Sign in',
      error: error ? `Google authentication failed: ${error}` : 'Authorization code was not provided.',
      email: '',
      googleConfigured: google.isConfigured(),
    });
  }

  try {
    const { tokens, profile } = await google.exchangeCode(code);
    const email = profile.email.toLowerCase();

    // Check if this was a profile link request
    if (state && state.startsWith('link:') && req.session.user) {
      db.prepare(`UPDATE users SET google_id=?, google_access_token=?, google_refresh_token=COALESCE(?, google_refresh_token),
                  google_token_expiry=?, google_calendar_enabled=1 WHERE id=?`)
        .run(profile.id, tokens.access_token, tokens.refresh_token, tokens.expiry_date, req.session.user.id);
      req.session.flash = { type: 'ok', msg: 'Google account and Calendar connected successfully.' };
      return res.redirect('/profile');
    }

    // Find existing user by google_id or email
    let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.id);
    if (!user) {
      user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
    }

    if (user) {
      if (!user.active) {
        return res.status(403).render('login', {
          title: 'Sign in',
          error: 'This account has been deactivated. Contact the admin.',
          email: '',
          googleConfigured: google.isConfigured(),
        });
      }

      // Update google tokens
      db.prepare(`UPDATE users SET google_id=?, google_access_token=?,
                  google_refresh_token=COALESCE(?, google_refresh_token),
                  google_token_expiry=? WHERE id=?`)
        .run(profile.id, tokens.access_token, tokens.refresh_token, tokens.expiry_date, user.id);
    } else {
      // Auto-register new user as Student
      const randomPasswordHash = bcrypt.hashSync(Math.random().toString(36), 10);
      const insert = db.prepare(`
        INSERT INTO users (name, email, password_hash, role, google_id, google_access_token,
                           google_refresh_token, google_token_expiry, google_calendar_enabled)
        VALUES (?, ?, ?, 'student', ?, ?, ?, ?, 1)
      `).run(profile.name || email.split('@')[0], email, randomPasswordHash, profile.id,
             tokens.access_token, tokens.refresh_token, tokens.expiry_date);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(insert.lastInsertRowid);
    }

    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    let to = req.session.redirectTo;
    delete req.session.redirectTo;
    if (to) {
      if (to.startsWith('/admin') && user.role !== 'admin') to = null;
      else if (to.startsWith('/student') && user.role !== 'student') to = null;
      else if (to.startsWith('/mentor') && user.role !== 'mentor') to = null;
    }
    res.redirect(to || HOME[user.role]);
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.render('login', {
      title: 'Sign in',
      error: `Google login failed: ${err.message}`,
      email: '',
      googleConfigured: google.isConfigured(),
    });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/profile', requireLogin, (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('profile', {
    title: 'My profile',
    me,
    error: null,
    ok: null,
    googleConfigured: google.isConfigured(),
  });
});

router.post('/profile/google/disconnect', requireLogin, (req, res) => {
  db.prepare(`UPDATE users SET google_id=NULL, google_access_token=NULL, google_refresh_token=NULL,
              google_token_expiry=NULL, google_calendar_enabled=0 WHERE id=?`)
    .run(req.session.user.id);
  req.session.flash = { type: 'ok', msg: 'Google account and Calendar disconnected.' };
  res.redirect('/profile');
});

router.post('/profile/google/toggle-calendar', requireLogin, (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const enabled = me.google_calendar_enabled ? 0 : 1;
  db.prepare('UPDATE users SET google_calendar_enabled = ? WHERE id = ?').run(enabled, me.id);
  req.session.flash = {
    type: 'ok',
    msg: enabled ? 'Google Calendar sync enabled.' : 'Google Calendar sync paused.',
  };
  res.redirect('/profile');
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
  res.render('profile', {
    title: 'My profile',
    me,
    error,
    ok,
    googleConfigured: google.isConfigured(),
  });
});

module.exports = router;
