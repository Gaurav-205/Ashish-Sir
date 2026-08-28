'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const helpers = require('./helpers');
const { RUBRIC, GRAND_TOTAL, grade } = require('./rubric');
const { securityHeaders } = require('./middleware/security');

const app = express();

app.disable('x-powered-by');
app.use(securityHeaders);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1d' }));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, '..', 'data') }),
  secret: process.env.SESSION_SECRET || 'konfident-interview-2025-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 8,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
}));

// flash messages
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
  next();
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
