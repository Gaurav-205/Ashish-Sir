'use strict';

/**
 * Security headers middleware
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://*.vercel-insights.com https://*.vercel-scripts.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https://*.vercel-insights.com https://vitals.vercel-insights.com; frame-ancestors 'self';"
  );
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production' || req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.removeHeader('X-Powered-By');
  next();
}

/**
 * In-memory sliding window rate limiter
 */
function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 15 * 60 * 1000; // 15 minutes
  const max = options.max || 100;
  const message = options.message || 'Too many requests, please try again later.';
  const hits = new Map();

  // Cleanup old entries periodically
  setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of hits.entries()) {
      if (now - record.resetTime > windowMs) {
        hits.delete(ip);
      }
    }
  }, 60 * 1000).unref();

  // Key on IP + submitted email + authenticated user id. IP alone lets one
  // shared campus NAT exhaust a whole cohort's budget; adding the signed-in
  // user id gives每 authenticated actor their own bucket regardless of NAT.
  function rlKey(req) {
    const emailKey = (req.body && req.body.email) ? String(req.body.email).trim().toLowerCase() : '';
    const ipKey = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown-ip';
    const userKey = (req.session && req.session.user && req.session.user.id) ? `u${req.session.user.id}` : '';
    return `${ipKey}|${emailKey}|${userKey}`;
  }

  const middleware = function rateLimitMiddleware(req, res, next) {
    if (hits.size > 10000) hits.clear();
    const key = rlKey(req);
    const now = Date.now();
    let record = hits.get(key);

    if (!record || now - record.resetTime > windowMs) {
      record = { count: 1, resetTime: now };
      hits.set(key, record);
    } else {
      record.count += 1;
    }

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - record.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil((record.resetTime + windowMs) / 1000));

    if (record.count > max) {
      if (req.accepts('html')) {
        return res.status(429).render('error', {
          title: 'Rate limit exceeded',
          message,
        });
      }
      return res.status(429).json({ error: message });
    }
    next();
  };

  middleware.reset = function(req) {
    const emailKey = (req.body && req.body.email) ? String(req.body.email).trim().toLowerCase() : '';
    const ipKey = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown-ip';
    const key = `${ipKey}|${emailKey}`;
    hits.delete(key);
  };

  return middleware;
}

/**
 * Safe positive integer validator for route parameters
 */
function validateId(paramName = 'id') {
  return function(req, res, next) {
    const val = Number(req.params[paramName]);
    if (!Number.isInteger(val) || val <= 0) {
      return res.status(400).render('error', {
        title: 'Invalid ID',
        message: 'The requested resource ID is invalid.',
      });
    }
    next();
  };
}

const crypto = require('crypto');

function getCsrfSecret() {
  return process.env.SESSION_SECRET || 'konfident-interview-2025-dev-secret';
}

function generateCsrfToken(userId) {
  // Tokens are bound to the identity they were minted for: `anon` before login,
  // the numeric user id after. verifyCsrfToken() then refuses an `anon` token on
  // an authenticated request and a token minted for another user — so a token
  // an attacker can freely obtain (by loading a page logged out) is useless
  // against a logged-in victim.
  const data = `${userId || 'anon'}:${Date.now()}`;
  const sig = crypto.createHmac('sha256', getCsrfSecret()).update(data).digest('base64url');
  return Buffer.from(data).toString('base64url') + '.' + sig;
}

function verifyCsrfToken(token, userId) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [dataB64, sig] = parts;
  let raw = '';
  try {
    raw = Buffer.from(dataB64, 'base64url').toString('utf8');
  } catch (_) {
    return false;
  }
  const expectedSig = crypto.createHmac('sha256', getCsrfSecret()).update(raw).digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return false;
  }

  try {
    const idx = raw.indexOf(':');
    const tUserId = raw.slice(0, idx);
    const ts = raw.slice(idx + 1);
    if (Date.now() - Number(ts) > 24 * 60 * 60 * 1000) return false; // 24h
    if (userId) {
      // Authenticated request: the token MUST be bound to this exact user.
      if (String(tUserId) !== String(userId)) return false;
    } else {
      // Anonymous request: only an anon-bound token is acceptable.
      if (tUserId !== 'anon') return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function csrfProtection(req, res, next) {
  const userId = req.session && req.session.user ? req.session.user.id : null;

  if (!req.session) {
    req.session = {};
  }

  let token = req.session.csrfToken;
  if (!token || !verifyCsrfToken(token, userId)) {
    token = generateCsrfToken(userId);
    // Persist only for authenticated sessions. An anon token is self-verifying
    // via its HMAC, so storing one would just create a session-store row for
    // every unauthenticated visitor (and defeat saveUninitialized:false).
    if (userId) req.session.csrfToken = token;
  }
  res.locals.csrfToken = token;

  if (process.env.NODE_ENV === 'test') {
    return next();
  }

  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (!safeMethods.includes(req.method)) {
    if (req.path === '/logout') {
      return next();
    }
    const submitted = (req.body && req.body._csrf) || req.headers['x-csrf-token'];

    const isValid = submitted && (
      submitted === token ||
      verifyCsrfToken(submitted, userId)
    );

    if (!isValid) {
      if (req.accepts('html')) {
        return res.status(403).render('error', {
          title: 'Forbidden',
          message: 'Invalid or missing CSRF token. Action blocked.',
          user: req.session.user || null,
        });
      }
      return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
    }
  }
  next();
}

module.exports = {
  securityHeaders,
  createRateLimiter,
  validateId,
  csrfProtection,
  generateCsrfToken,
  verifyCsrfToken,
};
