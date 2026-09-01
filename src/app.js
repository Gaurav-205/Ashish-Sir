'use strict';
require('dotenv').config();
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch (_) {}
}
const path = require('path');
const express = require('express');
const session = require('express-session');

const helpers = require('./helpers');
const { RUBRIC, GRAND_TOTAL, grade } = require('./rubric');
const { securityHeaders, csrfProtection } = require('./middleware/security');
const { sessionRehydrateMiddleware } = require('./middleware/sessionAuth');

const compression = require('compression');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(securityHeaders);

if (process.env.NODE_ENV !== 'test') {
  app.enable('view cache');
}

// Standard streaming HTTP compression (Gzip / Deflate / Brotli)
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '30d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css') || filePath.endsWith('.js') || filePath.endsWith('.svg') || filePath.endsWith('.woff2')) {
      res.setHeader('Cache-Control', 'public, max-age=2592000, stale-while-revalidate=86400');
    }
  },
}));

const sessionSecret = process.env.SESSION_SECRET || 'konfident-interview-2025-prod-fallback-secret-key-3b98f';
if (!process.env.SESSION_SECRET) {
  console.warn('[security] SESSION_SECRET is not set in environment — using robust fallback secret key.');
}

const db = require('./db');
const { MongoStore } = require('connect-mongo');

let sessionStore;
try {
  if (process.env.MONGODB_URI) {
    sessionStore = MongoStore.create({
      clientPromise: db.connectDb().then(() => db.mongoose.connection.getClient()).catch((err) => {
        console.warn('[session] MongoStore clientPromise connection error:', err.message);
        return null;
      }),
      collectionName: 'sessions',
      ttl: 14 * 24 * 60 * 60, // 14 days
      autoRemove: 'native',
    });
    if (sessionStore && typeof sessionStore.on === 'function') {
      sessionStore.on('error', (err) => {
        console.warn('[session] MongoStore session store warning:', err.message);
      });
    }
  } else {
    sessionStore = new session.MemoryStore();
  }
} catch (e) {
  console.warn('[session] MongoStore fallback to MemoryStore:', e.message);
  sessionStore = new session.MemoryStore();
}

app.use(session({
  store: sessionStore,
  secret: sessionSecret || 'konfident-interview-2025-dev-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
  },
}));

app.use(sessionRehydrateMiddleware);

/*
 * View locals and flash messages.
 *
 * This must run BEFORE csrfProtection: a rejected request still renders the
 * error page, and that page (via the nav partial) needs `user`, `path` and the
 * view helpers. Registering them afterwards turned every CSRF rejection into a
 * 500.
 */
app.use((req, res, next) => {
  res.locals.flash = (req.session && req.session.flash) ? req.session.flash : null;
  if (req.session) delete req.session.flash;
  res.locals.user = (req.session && req.session.user) ? req.session.user : null;
  res.locals.h = helpers;
  res.locals.RUBRIC = RUBRIC;
  res.locals.GRAND_TOTAL = GRAND_TOTAL;
  res.locals.grade = grade;
  res.locals.path = req.path;
  res.locals.title = 'Konfident Interview 2025';

  // Signed-in pages contain personal data. Without this the browser's
  // back/forward cache happily re-displays a dashboard after sign-out.
  if ((req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/health')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(csrfProtection);

// Safe health check endpoint for uptime and orchestrator probes
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Detailed health diagnostics for administrators. requireRole re-validates the
// user against the DB every call (active flag, post-password-change watermark),
// so a stale session role can't reach this.
const { requireRole } = require('./auth');
app.get('/health/details', requireRole('admin'), (req, res) => {
  res.json({
    status: 'healthy',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    node: process.version,
    memory: process.memoryUsage(),
  });
});

app.use('/', require('./routes/authRoutes'));
app.use('/admin', require('./routes/adminRoutes'));
app.use('/student', require('./routes/studentRoutes'));
app.use('/mentor', require('./routes/mentorRoutes'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.', user: (res.locals && res.locals.user) || null });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[App Error]', err);
  const isDbErr = err && (err.name === 'MongooseServerSelectionError' || (err.message && err.message.includes('MongoDB')));
  const message = process.env.NODE_ENV === 'production' && !isDbErr
    ? 'An unexpected error occurred. Please contact the administrator.'
    : (isDbErr ? 'Database connection failure. Please check MONGODB_URI and MongoDB Atlas network access.' : err.message);
  res.status(500).render('error', { title: 'Something went wrong', message, user: (res.locals && res.locals.user) || null });
});

module.exports = app;
