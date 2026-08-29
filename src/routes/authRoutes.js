'use strict';
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin } = require('../auth');
const google = require('../services/googleService');
const { createRateLimiter } = require('../middleware/security');
const { logAudit } = require('../middleware/auditLog');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function invalidateOtherSessions(userId, currentSessionId) {
  setTimeout(() => {
    try {
      const sessionsDbPath = path.join(__dirname, '..', '..', 'data', 'sessions.db');
      if (fs.existsSync(sessionsDbPath)) {
        const sdb = new DatabaseSync(sessionsDbPath);
        sdb.exec('PRAGMA busy_timeout = 5000');
        sdb.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.user.id') = ? AND sid <> ?")
           .run(Number(userId), String(currentSessionId));
        sdb.close();
      }
    } catch (err) {
      console.error('Failed to invalidate other sessions:', err);
    }
  }, 100);
}

const router = express.Router();
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many login attempts. Please wait 15 minutes before trying again.',
});

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

router.post('/login', authLimiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const row = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);

  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    logAudit(req, 'AUTH_LOGIN_FAILED', { email });
    return res.status(401).render('login', {
      title: 'Sign in',
      error: 'Invalid email or password.',
      email: req.body.email || '',
      googleConfigured: google.isConfigured(),
    });
  }
  if (!row.active) {
    logAudit(req, 'AUTH_LOGIN_DEACTIVATED', { email });
    return res.status(403).render('login', {
      title: 'Sign in',
      error: 'This account has been deactivated. Contact the admin.',
      email: req.body.email || '',
      googleConfigured: google.isConfigured(),
    });
  }
  
  let to = req.session.redirectTo;
  if (to) {
    if (to.startsWith('/admin') && row.role !== 'admin') to = null;
    else if (to.startsWith('/student') && row.role !== 'student') to = null;
    else if (to.startsWith('/mentor') && row.role !== 'mentor') to = null;
  }

  // Session fixation protection
  const userData = { id: row.id, name: row.name, email: row.email, role: row.role };
  const redirectTo = to || HOME[row.role];
  delete req.session.redirectTo;

  req.session.regenerate((err) => {
    if (err) {
      console.error('Session regeneration error:', err);
      return res.status(500).render('error', {
        title: 'Login error',
        message: 'Could not complete login. Please try again.',
      });
    }
    req.session.user = userData;
    logAudit(req, 'AUTH_LOGIN_SUCCESS', { email: row.email, role: row.role }, row.id);
    res.redirect(redirectTo);
  });
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
  const stateToken = crypto.randomBytes(32).toString('hex');
  const action = req.query.link === '1' && req.session.user ? 'link' : 'auth';
  const userId = req.session.user ? req.session.user.id : null;
  req.session.oauthState = { token: stateToken, action, userId };
  req.session.save((err) => {
    if (err) console.error('OAuth state session save error:', err);
    res.redirect(google.getAuthUrl(stateToken));
  });
});

router.get(['/auth/google/callback', '/api/auth/callback/google', '/api/auth/callback'], async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) {
    return res.render('login', {
      title: 'Sign in',
      error: error ? `Google authentication failed: ${error}` : 'Authorization code was not provided.',
      email: '',
      googleConfigured: google.isConfigured(),
    });
  }

  // Verify OAuth state token
  if (!req.session.oauthState || req.session.oauthState.token !== state) {
    return res.status(403).render('login', {
      title: 'Sign in',
      error: 'Invalid OAuth state. Please try signing in again.',
      email: '',
      googleConfigured: google.isConfigured(),
    });
  }
  const { action, userId } = req.session.oauthState;
  delete req.session.oauthState;

  try {
    const { tokens, profile } = await google.exchangeCode(code);
    const email = profile.email.toLowerCase();

    // Check if this was a profile link request
    if (action === 'link' && req.session.user && req.session.user.id === userId) {
      db.prepare(`UPDATE users SET google_id=?, google_access_token=?, google_refresh_token=COALESCE(?, google_refresh_token),
                  google_token_expiry=?, google_calendar_enabled=1 WHERE id=?`)
        .run(profile.id, tokens.access_token, tokens.refresh_token, tokens.expiry_date, req.session.user.id);
      req.session.flash = { type: 'ok', msg: 'Google account and Calendar connected successfully.' };
      return res.redirect('/profile');
    }

    // Find existing user by google_id or email
    let user = db.prepare('SELECT id, name, email, role, active FROM users WHERE google_id = ?').get(profile.id);
    if (!user) {
      user = db.prepare('SELECT id, name, email, role, active FROM users WHERE lower(email) = ?').get(email);
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
      const randomPasswordHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
      const insert = db.prepare(`
        INSERT INTO users (name, email, password_hash, role, google_id, google_access_token,
                           google_refresh_token, google_token_expiry, google_calendar_enabled)
        VALUES (?, ?, ?, 'student', ?, ?, ?, ?, 1)
      `).run(profile.name || email.split('@')[0], email, randomPasswordHash, profile.id,
             tokens.access_token, tokens.refresh_token, tokens.expiry_date);
      user = db.prepare('SELECT id, name, email, role, active FROM users WHERE id = ?').get(insert.lastInsertRowid);
    }

    let to = req.session.redirectTo;
    delete req.session.redirectTo;
    if (to) {
      if (to.startsWith('/admin') && user.role !== 'admin') to = null;
      else if (to.startsWith('/student') && user.role !== 'student') to = null;
      else if (to.startsWith('/mentor') && user.role !== 'mentor') to = null;
    }
    const userData = { id: user.id, name: user.name, email: user.email, role: user.role };
    const redirectTo = to || HOME[user.role];

    req.session.regenerate((err) => {
      if (err) return res.redirect('/login');
      req.session.user = userData;
      logAudit(req, 'AUTH_OAUTH_LOGIN_SUCCESS', { email: user.email, role: user.role }, user.id);
      res.redirect(redirectTo);
    });
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.render('login', {
      title: 'Sign in',
      error: `Google login failed: ${err.message}. Please click "Sign in with Google" again to start a fresh authorization request.`,
      email: '',
      googleConfigured: google.isConfigured(),
    });
  }
});



router.post('/logout', (req, res) => {
  logAudit(req, 'AUTH_LOGOUT');
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/profile', requireLogin, (req, res) => {
  const me = db.prepare('SELECT id, name, email, role, phone, roll_no, branch, squad, resume_url, can_technical, can_hr, active, google_id, google_calendar_enabled FROM users WHERE id = ?').get(req.session.user.id);
  res.render('profile', {
    title: 'My profile',
    me,
    error: null,
    ok: null,
    googleConfigured: google.isConfigured(),
  });
});

router.post('/profile/update', requireLogin, (req, res) => {
  const me = db.prepare('SELECT id, name, email, role, phone, roll_no, branch, squad, resume_url, can_technical, can_hr, active FROM users WHERE id = ?').get(req.session.user.id);
  const name = String(req.body.name || '').trim();
  if (!name) {
    return res.status(400).render('profile', {
      title: 'My profile',
      me,
      error: 'Name cannot be blank.',
      ok: null,
      googleConfigured: google.isConfigured(),
    });
  }
  const phone = String(req.body.phone || '').trim() || null;
  const branch = me.role === 'student' ? (String(req.body.branch || '').trim() || null) : me.branch;
  const squad = me.role === 'student' ? (String(req.body.squad || '').trim() || null) : me.squad;
  const resume_url = me.role === 'student' ? (String(req.body.resume_url || '').trim() || null) : me.resume_url;

  db.prepare('UPDATE users SET name=?, phone=?, branch=?, squad=?, resume_url=? WHERE id=?')
    .run(name, phone, branch, squad, resume_url, me.id);
  req.session.user.name = name;
  req.session.flash = { type: 'ok', msg: 'Profile details updated successfully.' };
  res.redirect('/profile');
});

router.post('/profile/google/disconnect', requireLogin, (req, res) => {
  db.prepare(`UPDATE users SET google_id=NULL, google_access_token=NULL, google_refresh_token=NULL,
              google_token_expiry=NULL, google_calendar_enabled=0 WHERE id=?`)
    .run(req.session.user.id);
  req.session.flash = { type: 'ok', msg: 'Google account and Calendar disconnected.' };
  res.redirect('/profile');
});

router.post('/profile/google/toggle-calendar', requireLogin, (req, res) => {
  const me = db.prepare('SELECT id, google_calendar_enabled FROM users WHERE id = ?').get(req.session.user.id);
  const enabled = me.google_calendar_enabled ? 0 : 1;
  db.prepare('UPDATE users SET google_calendar_enabled = ? WHERE id = ?').run(enabled, me.id);
  req.session.flash = {
    type: 'ok',
    msg: enabled ? 'Google Calendar sync enabled.' : 'Google Calendar sync paused.',
  };
  res.redirect('/profile');
});

router.post('/profile/password', requireLogin, (req, res) => {
  const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(req.session.user.id);
  const { current, next1, next2 } = req.body;
  let error = null, ok = null;
  if (!bcrypt.compareSync(String(current || ''), user.password_hash)) error = 'Current password is incorrect.';
  else if (String(next1 || '').length < 6) error = 'New password must be at least 6 characters.';
  else if (next1 !== next2) error = 'The two new passwords do not match.';
  else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(bcrypt.hashSync(String(next1), 10), user.id);
    invalidateOtherSessions(user.id, req.sessionID);
    logAudit(req, 'AUTH_PASSWORD_CHANGE', null, user.id);
    ok = 'Password updated.';
  }
  const me = db.prepare('SELECT id, name, email, role, phone, roll_no, branch, resume_url, can_technical, can_hr, active, google_id, google_calendar_enabled FROM users WHERE id = ?').get(req.session.user.id);
  res.render('profile', {
    title: 'My profile',
    me,
    error,
    ok,
    googleConfigured: google.isConfigured(),
  });
});

module.exports = router;
