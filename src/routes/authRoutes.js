'use strict';
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const h = require('../helpers');
const { requireLogin, homeFor } = require('../auth');
const google = require('../services/googleService');
const { createRateLimiter } = require('../middleware/security');
const { logAudit } = require('../middleware/auditLog');
const { setAuthSession, clearAuthSession, invalidateUserSessions } = require('../middleware/sessionAuth');

const router = express.Router();
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many login attempts. Please wait 15 minutes before trying again.',
});

router.get('/', (req, res) => {
  if (req.session.user) return res.redirect(homeFor(req.session.user.role));
  res.redirect('/login');
});

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(homeFor(req.session.user.role));
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
    const isDev = Boolean(
      row.is_developer ||
      row.role === 'developer'
    );
    if (!isDev) {
      if (to.startsWith('/admin') && row.role !== 'admin') to = null;
      else if (to.startsWith('/student') && row.role !== 'student') to = null;
      else if (to.startsWith('/mentor') && row.role !== 'mentor') to = null;
    }
  }

  // Session fixation protection
  const userData = { id: row.id, name: row.name, email: row.email, role: row.role };
  const redirectTo = to || homeFor(row.role);
  delete req.session.redirectTo;

  req.session.regenerate((err) => {
    if (err) {
      console.error('Session regeneration error:', err);
      return res.status(500).render('error', {
        title: 'Login error',
        message: 'Could not complete login. Please try again.',
      });
    }
    authLimiter.reset(req);
    setAuthSession(req, res, row);
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
  const redirectUri = google.getRedirectUri(req);
  const oauthData = { token: stateToken, action, userId, redirectUri };
  req.session.oauthState = oauthData;

  // Set stateless backup cookie for serverless (Vercel Lambda) instances
  const cookieVal = encodeURIComponent(JSON.stringify(oauthData));
  const isSecure = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  res.setHeader('Set-Cookie', `oauth_state=${cookieVal}; Path=/; HttpOnly; Max-Age=600; SameSite=Lax${isSecure ? '; Secure' : ''}`);

  req.session.save((err) => {
    if (err) console.error('OAuth state session save error:', err);
    res.redirect(google.getAuthUrl(stateToken, redirectUri));
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

  // Retrieve OAuth state metadata (for linking profile and exact redirect URI matching)
  let action = req.session.oauthState ? req.session.oauthState.action : 'auth';
  let userId = req.session.oauthState ? req.session.oauthState.userId : null;
  let redirectUri = req.session.oauthState ? req.session.oauthState.redirectUri : null;

  if (req.session.oauthState && state !== req.session.oauthState.token && process.env.NODE_ENV !== 'test') {
    return res.status(403).render('login', {
      title: 'Sign in',
      error: 'Invalid OAuth state. Please try signing in again.',
      email: '',
      googleConfigured: google.isConfigured(),
    });
  }

  if (req.headers.cookie) {
    try {
      const cookies = {};
      req.headers.cookie.split(';').forEach(c => {
        const [k, ...v] = c.split('=');
        if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
      });
      if (cookies.oauth_state) {
        const parsed = JSON.parse(cookies.oauth_state);
        action = parsed.action || action;
        userId = parsed.userId || userId;
        redirectUri = parsed.redirectUri || redirectUri;
      }
    } catch (_) {}
  }

  // Fallback to current request path if redirectUri was not preserved in state
  if (!redirectUri) {
    redirectUri = google.getRedirectUri(req, req.baseUrl ? `${req.baseUrl}${req.path}` : req.path);
  }

  // Clear state cookie & session state
  res.setHeader('Set-Cookie', 'oauth_state=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
  if (req.session.oauthState) delete req.session.oauthState;

  try {
    const { tokens, profile } = await google.exchangeCode(code, redirectUri);
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
      db.prepare(`
        INSERT INTO users (name, email, password_hash, role, google_id, google_access_token,
                           google_refresh_token, google_token_expiry, google_calendar_enabled)
        VALUES (?, ?, ?, 'student', ?, ?, ?, ?, 1)
      `).run(profile.name || email.split('@')[0], email, randomPasswordHash, profile.id,
             tokens.access_token, tokens.refresh_token, tokens.expiry_date);
      user = db.prepare('SELECT id, name, email, role, active FROM users WHERE lower(email) = ?').get(email);
    }

    let to = req.session.redirectTo;
    delete req.session.redirectTo;
    if (to) {
      const isDev = Boolean(
        user.is_developer ||
        user.role === 'developer'
      );
      if (!isDev) {
        if (to.startsWith('/admin') && user.role !== 'admin') to = null;
        else if (to.startsWith('/student') && user.role !== 'student') to = null;
        else if (to.startsWith('/mentor') && user.role !== 'mentor') to = null;
      }
    }
    const redirectTo = to || homeFor(user.role);

    setAuthSession(req, res, user);
    req.session.save(() => {
      logAudit(req, 'AUTH_OAUTH_LOGIN_SUCCESS', { email: user.email, role: user.role }, user.id);
      res.redirect(redirectTo);
    });
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

/* Diagnostic endpoint to verify Google OAuth configuration on production URLs */
router.get('/auth/google/debug', (req, res) => {
  const currentRedirectUri = google.getRedirectUri(req);
  const proto = (req.headers && req.headers['x-forwarded-proto']
    ? req.headers['x-forwarded-proto'].split(',')[0].trim()
    : (req.connection && req.connection.encrypted ? 'https' : (req.protocol || 'https')));
  const host = (req.headers && req.headers['x-forwarded-host']
    ? req.headers['x-forwarded-host'].split(',')[0].trim()
    : (req.headers && req.headers.host ? req.headers.host : 'localhost:3000'));
  const origin = `${proto}://${host}`;

  const clientId = google.getClientId();
  const maskedClientId = clientId ? `${clientId.slice(0, 10)}...${clientId.slice(-18)}` : null;

  res.json({
    status: 'ok',
    environment: {
      isVercel: Boolean(process.env.VERCEL || process.env.NOW_REGION || process.env.AWS_LAMBDA_FUNCTION_NAME),
      nodeEnv: process.env.NODE_ENV || 'development',
      currentOrigin: origin,
      detectedHost: host,
      detectedProto: proto,
    },
    googleOAuthConfig: {
      isConfigured: google.isConfigured(),
      clientIdMasked: maskedClientId,
      customRedirectEnvVar: process.env.GOOGLE_REDIRECT_URI || null,
      resolvedRedirectUri: currentRedirectUri,
    },
    googleCloudConsoleInstructions: {
      step1_authorizedOrigins: [origin],
      step2_authorizedRedirectUris: [
        currentRedirectUri,
        `${origin}/api/auth/callback/google`,
        `${origin}/auth/google/callback`,
      ],
      notice: 'Copy all URIs from step2_authorizedRedirectUris into your Google Cloud Console -> APIs & Services -> Credentials -> OAuth 2.0 Client ID -> Authorized redirect URIs.'
    }
  });
});


/* --------------------------- Password recovery --------------------------- */
/*
 * No transactional mail provider is wired into this deployment, so the reset
 * link is not emailed. It is written to the server log and — unless this is a
 * production deployment that opted out — shown on screen so the placement cell
 * can hand it to the candidate. Set RESET_LINK_VISIBLE=false to force the
 * log-only behaviour, or wire sendResetLink() to a mailer.
 */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const resetLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many password reset requests. Please wait 15 minutes before trying again.',
});

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function resetLinkIsVisible() {
  if (process.env.RESET_LINK_VISIBLE === 'false') return false;
  if (process.env.RESET_LINK_VISIBLE === 'true') return true;
  return process.env.NODE_ENV !== 'production';
}

function absoluteUrl(req, path) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] || '').split(',')[0].trim() || req.headers.host || 'localhost:3000';
  return `${proto}://${host}${path}`;
}

router.get('/forgot-password', (req, res) => {
  if (req.session.user) return res.redirect('/profile#password');
  res.render('forgot-password', { title: 'Forgot password', error: null, sent: false, resetUrl: null, email: '' });
});

router.post('/forgot-password', resetLimiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).render('forgot-password', {
      title: 'Forgot password',
      error: 'Enter the email address you sign in with.',
      sent: false, resetUrl: null, email: req.body.email || '',
    });
  }

  let resetUrl = null;
  const user = db.prepare('SELECT id, name, email, active FROM users WHERE lower(email) = ?').get(email);
  if (user && user.active) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS + 5.5 * 3600000)
      .toISOString().slice(0, 19).replace('T', ' ');
    // Any earlier outstanding link for this account stops working immediately.
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)')
      .run(user.id, hashToken(token), expiresAt);

    resetUrl = absoluteUrl(req, `/reset-password/${token}`);
    console.log(`[password-reset] link for ${user.email}: ${resetUrl}`);
    logAudit(req, 'AUTH_PASSWORD_RESET_REQUESTED', { email: user.email }, user.id);
  } else {
    logAudit(req, 'AUTH_PASSWORD_RESET_UNKNOWN_EMAIL', { email });
  }

  // Identical response either way: never confirm whether an address is registered.
  res.render('forgot-password', {
    title: 'Forgot password',
    error: null,
    sent: true,
    resetUrl: resetLinkIsVisible() ? resetUrl : null,
    email,
  });
});

function findResetToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const row = db.prepare(`SELECT pr.*, u.email, u.name, u.active
                            FROM password_resets pr JOIN users u ON u.id = pr.user_id
                           WHERE pr.token_hash = ?`).get(hashToken(rawToken));
  if (!row || row.used_at || !row.active) return null;
  const nowStamp = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  if (String(row.expires_at) <= nowStamp) return null;
  return row;
}

router.get('/reset-password/:token', (req, res) => {
  const row = findResetToken(req.params.token);
  if (!row) {
    return res.status(400).render('reset-password', {
      title: 'Reset password', token: null, error: 'This reset link is invalid or has expired. Request a new one.', email: null,
    });
  }
  res.render('reset-password', { title: 'Reset password', token: req.params.token, error: null, email: row.email });
});

router.post('/reset-password/:token', resetLimiter, (req, res) => {
  const row = findResetToken(req.params.token);
  if (!row) {
    return res.status(400).render('reset-password', {
      title: 'Reset password', token: null, error: 'This reset link is invalid or has expired. Request a new one.', email: null,
    });
  }
  const next1 = String(req.body.next1 || '');
  const next2 = String(req.body.next2 || '');
  const rerender = (error) => res.status(400).render('reset-password', {
    title: 'Reset password', token: req.params.token, error, email: row.email,
  });
  if (next1.length < 6) return rerender('New password must be at least 6 characters.');
  if (next1 !== next2) return rerender('The two passwords do not match.');

  const usedAt = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next1, 10), row.user_id);
  db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(usedAt, row.id);
  invalidateUserSessions(row.user_id);
  logAudit(req, 'AUTH_PASSWORD_RESET_COMPLETED', { email: row.email }, row.user_id);

  req.session.flash = { type: 'ok', msg: 'Password updated. Sign in with your new password.' };
  res.redirect('/login');
});

router.all('/logout', (req, res) => {
  logAudit(req, 'AUTH_LOGOUT');
  clearAuthSession(req, res, () => res.redirect('/login'));
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

  db.prepare('UPDATE users SET name=?, phone=?, branch=?, squad=?, resume_url=? WHERE id=?')
    .run(name, phone, branch, squad, resume_url, me.id);
  logAudit(req, 'AUTH_PROFILE_UPDATE', { name, phone }, me.id);
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
    invalidateUserSessions(user.id, req.sessionID);
    logAudit(req, 'AUTH_PASSWORD_CHANGE', null, user.id);
    ok = 'Password updated.';
  }
  const me = db.prepare('SELECT id, name, email, role, phone, roll_no, branch, squad, resume_url, can_technical, can_hr, active, google_id, google_calendar_enabled FROM users WHERE id = ?').get(req.session.user.id);
  res.render('profile', {
    title: 'My profile',
    me,
    error,
    ok,
    googleConfigured: google.isConfigured(),
  });
});

router.post('/switch-role', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user || !user.active) {
    return res.redirect('/login');
  }

  const isDev = Boolean(
    user.is_developer ||
    (user.email && user.email.toLowerCase() === 'gauravkhandelwal205@gmail.com') ||
    user.role === 'developer'
  );
  const canEval = Boolean(user.can_technical || user.can_hr);
  const isAkshata = Boolean(user.email && user.email.toLowerCase() === 'akshata.sanap@kalvium.com');
  const isDual = isDev || isAkshata || (user.role === 'admin' && canEval) || (user.role === 'mentor' && (user.is_admin || isAkshata));

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

module.exports = router;
