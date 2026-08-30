'use strict';
const crypto = require('crypto');
const db = require('../db');

const COOKIE_NAME = 'konfident_auth';
const COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours

function getSecret() {
  return process.env.SESSION_SECRET || 'konfident-interview-2025-dev-secret';
}

/**
 * Creates a cryptographically signed auth token (HMAC-SHA256).
 */
function signToken(payload) {
  const secret = getSecret();
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

/**
 * Verifies and parses a signed auth token.
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, signature] = parts;
  const secret = getSecret();
  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload || !payload.id || !payload.ts) return null;
    if (Date.now() - payload.ts > COOKIE_MAX_AGE_MS) return null; // Expired
    return payload;
  } catch (_) {
    return null;
  }
}

/**
 * Parses cookies from raw request cookie header.
 */
function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((c) => {
    const [k, ...v] = c.split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('=').trim());
  });
  return cookies;
}

/**
 * Sets both session state and a stateless backup cookie (for serverless/Vercel Lambdas).
 */
function setAuthSession(req, res, user) {
  const userData = { id: user.id, name: user.name, email: user.email, role: user.role };
  if (req.session) {
    req.session.user = userData;
  }

  const token = signToken({ id: user.id, role: user.role, ts: Date.now() });
  const isSecure = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  const maxAgeSec = Math.floor(COOKIE_MAX_AGE_MS / 1000);

  res.appendHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Max-Age=${maxAgeSec}; SameSite=Lax${isSecure ? '; Secure' : ''}`);
}

/**
 * Clears both session state and the stateless backup cookie.
 */
function clearAuthSession(req, res, callback) {
  const isSecure = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  res.appendHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax${isSecure ? '; Secure' : ''}`);
  if (req.session) {
    delete req.session.user;
    req.session.destroy(() => {
      if (typeof callback === 'function') callback();
    });
  } else if (typeof callback === 'function') {
    callback();
  }
}

/**
 * Middleware to rehydrate req.session.user from the signed backup cookie
 * across serverless Lambda instances where in-memory sessions are not shared.
 */
function sessionRehydrateMiddleware(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return next();

  const payload = verifyToken(token);
  if (!payload) return next();

  try {
    const row = db.prepare('SELECT id, name, email, role, active FROM users WHERE id = ?').get(payload.id);
    if (row && row.active) {
      if (!req.session) req.session = {};
      req.session.user = { id: row.id, name: row.name, email: row.email, role: row.role };
      res.locals.user = req.session.user;
    }
  } catch (err) {
    // Database query failed or unavailable, proceed
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  signToken,
  verifyToken,
  setAuthSession,
  clearAuthSession,
  sessionRehydrateMiddleware,
};
