'use strict';
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

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(securityHeaders);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1d' }));

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret && process.env.NODE_ENV === 'production') {
  console.error('FATAL: SESSION_SECRET environment variable must be set in production.');
  process.exit(1);
}

const isVercel = Boolean(process.env.VERCEL || process.env.NOW_REGION || process.env.AWS_LAMBDA_FUNCTION_NAME);

let sessionStore;
if (isVercel) {
  sessionStore = new session.MemoryStore();
} else {
  try {
    const SQLiteStore = require('connect-sqlite3')(session);
    sessionStore = new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, '..', 'data') });
  } catch (_) {
    sessionStore = new session.MemoryStore();
  }
}

app.use(session({
  store: sessionStore,
  secret: sessionSecret || 'konfident-interview-2025-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 8,
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
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.user = req.session.user || null;
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

// Detailed health diagnostics for administrators
app.get('/health/details', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }
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
  res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  const message = process.env.NODE_ENV === 'production'
    ? 'An unexpected error occurred. Please contact the administrator.'
    : err.message;
  res.status(500).render('error', { title: 'Something went wrong', message });
});

module.exports = app;
