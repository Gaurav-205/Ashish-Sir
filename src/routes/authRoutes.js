'use strict';
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { User, PasswordReset } = require('../models');
const h = require('../helpers');
const { requireLogin, homeFor, isUserDeveloper, isDualRoleUser } = require('../auth');
const google = require('../services/googleService');
const { createRateLimiter } = require('../middleware/security');
const { setAuthSession, clearAuthSession } = require('../middleware/sessionAuth');
const { logAudit } = require('../middleware/auditLog');

const router = express.Router();
const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 15, message: 'Too many login attempts. Please try again in 15 minutes.' });
const forgotLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many password reset requests. Please try again in 15 minutes.' });

const DUMMY_HASH = bcrypt.hashSync('timing-defence-dummy-secret', 10);

router.get(['/', '/dashboard', '/home'], (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect(homeFor(req.session.user.role));
  }
  res.redirect('/login');
});

router.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect(homeFor(req.session.user.role));
  }
  res.render('login', {
    title: 'Sign in',
    error: null,
    email: '',
    googleConfigured: google.isConfigured(),
  });
});

router.post('/login', authLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  
  let row = null;
  try {
    row = await User.findOne({ email }).lean();
    if (!row) {
      const safeEmailRegex = new RegExp('^' + email.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '$', 'i');
      row = await User.findOne({ email: safeEmailRegex }).lean();
    }
  } catch (err) {
    console.error('DB error during login:', err);
  }

  const hashToCheck = (row && row.password_hash) ? row.password_hash : DUMMY_HASH;
  const passwordOk = bcrypt.compareSync(password, hashToCheck);

  if (!row || !passwordOk) {
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
    return res.status(401).render('login', {
      title: 'Sign in',
      error: 'Invalid email or password.',
      email: req.body.email || '',
      googleConfigured: google.isConfigured(),
    });
  }
  
  let to = req.session.redirectTo;
  if (to) {
    const isDev = isUserDeveloper(row);
    if (!isDev) {
      if (to.startsWith('/admin') && row.role !== 'admin') to = null;
      else if (to.startsWith('/student') && row.role !== 'student') to = null;
      else if (to.startsWith('/mentor') && row.role !== 'mentor') to = null;
    }
  }

  row.id = row._id;
  const redirectTo = to || homeFor(row.role);
  delete req.session.redirectTo;

  const finishLogin = () => {
    authLimiter.reset(req);
    setAuthSession(req, res, row);
    logAudit(req, 'AUTH_LOGIN_SUCCESS', { email: row.email, role: row.role }, row._id);
    if (req.session && typeof req.session.save === 'function') {
      req.session.save((err) => {
        if (err) console.error('Session save error during login:', err);
        res.redirect(redirectTo);
      });
    } else {
      res.redirect(redirectTo);
    }
  };

  if (typeof req.session.regenerate === 'function') {
    req.session.regenerate((err) => {
      if (err) {
        console.warn('Session regeneration warning:', err.message);
      }
      finishLogin();
    });
  } else {
    finishLogin();
  }
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
  const state = crypto.randomBytes(32).toString('base64url');
  req.session.oauth_state = state;
  const redirectUri = google.getRedirectUri(req);
  res.redirect(google.getAuthUrl(state, redirectUri));
});

router.get(['/auth/google/callback', '/api/auth/callback/google'], async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    console.error('OAuth authorization error:', oauthError);
    return res.render('login', {
      title: 'Sign in',
      error: 'Google authentication was cancelled or failed.',
      email: '',
      googleConfigured: google.isConfigured(),
    });
  }

  if (!code || !state || !req.session.oauth_state || state !== req.session.oauth_state) {
    delete req.session.oauth_state;
    return res.status(400).render('login', {
      title: 'Sign in',
      error: 'Invalid or expired authentication state. Please try signing in again.',
      email: '',
      googleConfigured: google.isConfigured(),
    });
  }
  delete req.session.oauth_state;

  const redirectUri = google.getRedirectUri(req);
  const tokenData = await google.exchangeCode(code, redirectUri);
  if (!tokenData || !tokenData.tokens) {
    return res.render('login', {
      title: 'Sign in',
      error: 'Could not verify Google authentication. Please try again.',
      email: '',
      googleConfigured: google.isConfigured(),
    });
  }

  const { tokens, profile } = tokenData;
  if (!profile || !profile.email) {
    return res.render('login', {
      title: 'Sign in',
      error: 'No email address received from Google account.',
      email: '',
      googleConfigured: google.isConfigured(),
    });
  }

  const email = profile.email.toLowerCase().trim();
  const tokenExpiry = Date.now() + ((tokens.expires_in || 3600) * 1000);

  // Link to existing user or auto-provision
  let user = await User.findOne({
    $or: [{ google_id: profile.id }, { email }],
  }).lean();

  if (user) {
    if (!user.active) {
      logAudit(req, 'AUTH_OAUTH_LOGIN_DEACTIVATED', { email });
      return res.status(401).render('login', {
        title: 'Sign in',
        error: 'Your account has been deactivated. Please contact an administrator.',
        email: '',
        googleConfigured: google.isConfigured(),
      });
    }

    const updateFields = {
      google_id: profile.id,
      google_access_token: tokens.access_token,
      google_token_expiry: tokenExpiry,
    };
    if (tokens.refresh_token) {
      updateFields.google_refresh_token = tokens.refresh_token;
    }

    await User.findByIdAndUpdate(user._id, { $set: updateFields });
    user = await User.findById(user._id).lean();
    user.id = user._id;
  } else {
    const role = 'student';
    const randomPw = crypto.randomBytes(32).toString('hex');
    const pwHash = bcrypt.hashSync(randomPw, 10);

    const newUser = await User.create({
      name: profile.name || email.split('@')[0],
      email,
      password_hash: pwHash,
      role,
      google_id: profile.id,
      google_access_token: tokens.access_token,
      google_refresh_token: tokens.refresh_token || null,
      google_token_expiry: tokenExpiry,
      google_calendar_enabled: 1,
      active: 1,
    });
    user = newUser.toObject();
    user.id = user._id;
    logAudit(req, 'AUTH_OAUTH_USER_AUTO_CREATED', { email, role }, user._id);
  }

  let to = req.session.redirectTo;
  if (to) {
    const isDev = isUserDeveloper(user);
    if (!isDev) {
      if (to.startsWith('/admin') && user.role !== 'admin') to = null;
      else if (to.startsWith('/student') && user.role !== 'student') to = null;
      else if (to.startsWith('/mentor') && user.role !== 'mentor') to = null;
    }
  }
  const redirectTo = to || homeFor(user.role);
  delete req.session.redirectTo;

  req.session.regenerate((regenErr) => {
    if (regenErr) {
      console.error('OAuth session regeneration error:', regenErr);
      return res.status(500).render('error', { title: 'Login error', message: 'Could not complete login. Please try again.' });
    }
    setAuthSession(req, res, user);
    if (user.role === 'mentor' || user.role === 'admin' || user.can_technical || user.can_hr) {
      google.syncUpcomingMentorSlots(user).catch(() => {});
    }
    req.session.save(() => {
      logAudit(req, 'AUTH_OAUTH_LOGIN_SUCCESS', { email: user.email, role: user.role }, user.id || user._id);
      res.redirect(redirectTo);
    });
  });
});

/* ------------------------------ Password Recovery ----------------------------- */
router.get('/forgot-password', (req, res) => {
  res.render('forgot-password', {
    title: 'Reset password',
    sent: false,
    error: null,
  });
});

router.post('/forgot-password', forgotLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email || !h.isValidEmail(email)) {
    return res.status(400).render('forgot-password', {
      title: 'Reset password',
      sent: false,
      error: 'Please enter a valid email address.',
    });
  }

  const user = await User.findOne({ email }).lean();
  if (user && user.active) {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await PasswordReset.updateMany({ user_id: user._id, used_at: null }, { $set: { used_at: new Date() } });
    await PasswordReset.create({
      user_id: user._id,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });

    const resetLink = `${req.protocol}://${req.get('host')}/reset-password/${rawToken}`;
    console.log(`[password-reset] link for ${email}: ${resetLink}`);
    logAudit(req, 'AUTH_PASSWORD_RESET_REQUESTED', { email }, user._id);
  }

  res.render('forgot-password', {
    title: 'Reset password',
    sent: true,
    error: null,
  });
});

router.get('/reset-password/:token', async (req, res) => {
  const rawToken = String(req.params.token || '');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const record = await PasswordReset.findOne({
    token_hash: tokenHash,
    used_at: null,
    expires_at: { $gt: new Date() },
  }).lean();

  if (!record) {
    return res.status(400).render('error', {
      title: 'Invalid reset link',
      message: 'This password reset link is invalid or has expired.',
      backHref: '/forgot-password',
      backLabel: 'Request a new link',
    });
  }

  res.render('reset-password', {
    title: 'Choose a new password',
    token: rawToken,
    error: null,
  });
});

router.post('/reset-password/:token', authLimiter, async (req, res) => {
  const rawToken = String(req.params.token || '');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');

  const record = await PasswordReset.findOne({
    token_hash: tokenHash,
    used_at: null,
    expires_at: { $gt: new Date() },
  }).lean();

  if (!record) {
    return res.status(400).render('error', {
      title: 'Invalid reset link',
      message: 'This password reset link is invalid or has expired.',
      backHref: '/forgot-password',
      backLabel: 'Request a new link',
    });
  }

  if (password.length < 6) {
    return res.status(400).render('reset-password', {
      title: 'Choose a new password',
      token: rawToken,
      error: 'Password must be at least 6 characters.',
    });
  }

  if (password !== confirm) {
    return res.status(400).render('reset-password', {
      title: 'Choose a new password',
      token: rawToken,
      error: 'Passwords do not match.',
    });
  }

  const pwHash = bcrypt.hashSync(password, 10);
  const nowMs = Date.now();

  await User.findByIdAndUpdate(record.user_id, {
    $set: { password_hash: pwHash, sessions_invalid_before: nowMs },
  });
  await PasswordReset.findByIdAndUpdate(record._id, { $set: { used_at: new Date() } });

  logAudit(req, 'AUTH_PASSWORD_RESET_COMPLETED', {}, record.user_id);
  req.session.flash = { type: 'ok', msg: 'Your password has been reset. Please sign in with your new password.' };
  res.redirect('/login');
});

/* ------------------------------ Profile & Role Switch ----------------------------- */
router.get('/profile', requireLogin, async (req, res) => {
  const me = await User.findById(req.session.user.id).lean();
  if (me) me.id = me._id;
  res.render('profile', {
    title: 'My profile',
    me,
    error: null,
    ok: null,
    googleConfigured: google.isConfigured(),
  });
});

router.post(['/profile', '/profile/update'], requireLogin, async (req, res) => {
  const me = await User.findById(req.session.user.id).lean();
  if (!me) return res.redirect('/login');
  me.id = me._id;

  const name = String(req.body.name || '').trim();
  if (!name || name.length < 2) {
    return res.status(400).render('profile', {
      title: 'My profile',
      me,
      error: 'Full name must be at least 2 characters.',
      ok: null,
      googleConfigured: google.isConfigured(),
    });
  }
  const phone = String(req.body.phone || '').trim() || null;
  if (phone && !h.isValidPhone(phone)) {
    return res.status(400).render('profile', {
      title: 'My profile',
      me,
      error: 'Please enter a valid contact phone number.',
      ok: null,
      googleConfigured: google.isConfigured(),
    });
  }
  const branch = me.role === 'student' ? (String(req.body.branch || '').trim() || null) : me.branch;
  const squad = me.role === 'student' ? (String(req.body.squad || '').trim() || null) : me.squad;
  const resume_url = me.role === 'student' ? (String(req.body.resume_url || '').trim() || null) : me.resume_url;

  if (resume_url && !h.isValidUrl(resume_url)) {
    return res.status(400).render('profile', {
      title: 'My profile',
      me,
      error: 'Resume link must be a valid URL starting with http:// or https://',
      ok: null,
      googleConfigured: google.isConfigured(),
    });
  }

  await User.findByIdAndUpdate(me._id, {
    $set: { name, phone, branch, squad, resume_url },
  });

  logAudit(req, 'AUTH_PROFILE_UPDATE', { name, phone }, me._id);
  req.session.user.name = name;
  req.session.flash = { type: 'ok', msg: 'Profile details updated successfully.' };
  res.redirect('/profile');
});

router.post('/profile/google/disconnect', requireLogin, async (req, res) => {
  await User.findByIdAndUpdate(req.session.user.id, {
    $set: {
      google_id: null,
      google_access_token: null,
      google_refresh_token: null,
      google_token_expiry: null,
      google_calendar_enabled: 0,
    },
  });
  req.session.flash = { type: 'ok', msg: 'Google account and Calendar disconnected.' };
  res.redirect('/profile');
});

router.post('/profile/google/toggle-calendar', requireLogin, async (req, res) => {
  const me = await User.findById(req.session.user.id).lean();
  const enabled = me && me.google_calendar_enabled ? 0 : 1;
  await User.findByIdAndUpdate(req.session.user.id, { $set: { google_calendar_enabled: enabled } });
  req.session.flash = {
    type: 'ok',
    msg: enabled ? 'Google Calendar sync enabled.' : 'Google Calendar sync paused.',
  };
  res.redirect('/profile');
});

router.post('/profile/password', requireLogin, (req, res) => {
  req.session.flash = { type: 'err', msg: 'Password updates are disabled. Authentication is managed via Google Sign-In.' };
  res.redirect('/profile');
});

router.post('/switch-role', async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  const user = await User.findById(req.session.user.id).lean();
  if (!user || !user.active) {
    return res.redirect('/login');
  }

  const isDev = isUserDeveloper(user);
  const isDual = isDualRoleUser(user);

  if (!isDual) {
    req.session.flash = { type: 'err', msg: 'You do not have permission to switch roles.' };
    return res.redirect('/profile');
  }

  const targetRole = String(req.body.targetRole || '').trim().toLowerCase();
  const allowedRoles = isDev ? ['admin', 'mentor', 'student', 'developer'] : ['admin', 'mentor'];

  if (!allowedRoles.includes(targetRole)) {
    req.session.flash = { type: 'err', msg: 'Invalid role requested.' };
    return res.redirect('/profile');
  }

  req.session.activeRole = targetRole;
  req.session.user.role = targetRole;
  logAudit(req, 'AUTH_ROLE_SWITCH', { new_role: targetRole });

  req.session.flash = { type: 'ok', msg: `Switched view mode to ${targetRole === 'admin' ? 'Admin Dashboard' : 'Mentor Desk'}.` };
  
  if (targetRole === 'admin') return res.redirect('/admin');
  if (targetRole === 'mentor') return res.redirect('/mentor');
  if (targetRole === 'student') return res.redirect('/student');
  return res.redirect('/admin');
});

router.post('/logout', (req, res) => {
  logAudit(req, 'AUTH_LOGOUT');
  clearAuthSession(req, res, () => {
    res.redirect('/login');
  });
});

module.exports = router;
