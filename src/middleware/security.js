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
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; frame-ancestors 'self';"
  );
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
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

  return function rateLimitMiddleware(req, res, next) {
    const emailKey = (req.body && req.body.email) ? String(req.body.email).trim().toLowerCase() : '';
    const key = emailKey || (req.ip || (req.connection && req.connection.remoteAddress) || 'unknown-ip');
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

function csrfProtection(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (process.env.NODE_ENV === 'test') {
    return next();
  }

  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (!safeMethods.includes(req.method)) {
    const submitted = req.body._csrf || req.headers['x-csrf-token'];
    if (!submitted || submitted !== req.session.csrfToken) {
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
};
