'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;
let db = {};

// Helper to convert SQLite '?' placeholders to PostgreSQL '$1', '$2'...
function convertSql(sql) {
  let paramIndex = 1;
  let converted = sql.replace(/\?/g, () => `$${paramIndex++}`);
  converted = converted.replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP::text');
  converted = converted.replace(/datetime\('now','localtime'\)/gi, 'CURRENT_TIMESTAMP::text');
  converted = converted.replace(/datetime\(([^)]+)\)/gi, '($1)::timestamp');
  converted = converted.replace(/AUTOINCREMENT/gi, '');
  return converted;
}

// Use Neon Postgres unless DB_PATH is explicitly set for file-based tests or URL is a template placeholder
if (DATABASE_URL && !process.env.DB_PATH && !DATABASE_URL.includes('YOUR_PASSWORD')) {
  // --- Neon Postgres Mode ---
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const runPgQuerySync = (sql, params = []) => {
    const converted = convertSql(sql);
    const code = `
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      pool.query(${JSON.stringify(converted)}, ${JSON.stringify(params)})
        .then(res => { console.log(JSON.stringify(res.rows)); process.exit(0); })
        .catch(err => { console.error(JSON.stringify({ error: err.message })); process.exit(1); });
    `;
    try {
      const out = execFileSync(process.execPath, ['-e', code], {
        env: { ...process.env, DATABASE_URL },
        encoding: 'utf8',
      });
      return JSON.parse(out.trim() || '[]');
    } catch (e) {
      console.error('Neon Query Error:', e.stderr || e.message);
      return [];
    }
  };

  db = {
    isPostgres: true,
    pool,
    exec(sql) {
      return runPgQuerySync(sql, []);
    },
    prepare(sql) {
      return {
        all(...args) {
          const params = Array.isArray(args[0]) ? args[0] : args;
          return runPgQuerySync(sql, params);
        },
        get(...args) {
          const params = Array.isArray(args[0]) ? args[0] : args;
          const rows = runPgQuerySync(sql, params);
          return rows[0] || null;
        },
        run(...args) {
          const params = Array.isArray(args[0]) ? args[0] : args;
          const rows = runPgQuerySync(sql, params);
          return { changes: rows.length, lastInsertRowid: rows[0]?.id || 1 };
        },
      };
    },
    async query(sql, params = []) {
      const converted = convertSql(sql);
      const res = await pool.query(converted, params);
      return res.rows;
    },
  };
} else {
  // --- SQLite Mode (Local / Test Fallback) ---
  const { DatabaseSync } = require('node:sqlite');
  const DATA_DIR = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'konfident.db');
  const sqliteDb = new DatabaseSync(DB_PATH);

  sqliteDb.exec('PRAGMA foreign_keys = ON');
  sqliteDb.exec('PRAGMA journal_mode = WAL');

  sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('admin','mentor','student')),
    phone         TEXT,
    roll_no       TEXT,
    branch        TEXT,
    squad         TEXT,
    resume_url    TEXT,
    can_technical INTEGER NOT NULL DEFAULT 0,
    can_hr        INTEGER NOT NULL DEFAULT 0,
    active        INTEGER NOT NULL DEFAULT 1,
    google_id     TEXT UNIQUE,
    google_access_token TEXT,
    google_refresh_token TEXT,
    google_token_expiry INTEGER,
    google_calendar_enabled INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS slots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    mentor_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type          TEXT    NOT NULL CHECK (type IN ('technical','hr')),
    slot_date     TEXT    NOT NULL,
    start_time    TEXT    NOT NULL,
    end_time      TEXT    NOT NULL,
    mode          TEXT    NOT NULL DEFAULT 'Online',
    location      TEXT,
    status        TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','booked','cancelled')),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (mentor_id, slot_date, start_time)
  );

  CREATE TABLE IF NOT EXISTS interviews (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mentor_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot_id       INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
    type          TEXT    NOT NULL CHECK (type IN ('technical','hr')),
    status        TEXT    NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','completed','cancelled')),
    attendance    TEXT    NOT NULL DEFAULT 'pending' CHECK (attendance IN ('pending','attended','absent')),
    attendance_marked_at TEXT,
    google_event_id TEXT,
    booked_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    completed_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS evaluations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    interview_id   INTEGER NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
    mentor_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resume_marks   INTEGER,
    project_marks  INTEGER,
    dsa_marks      INTEGER,
    behaviour_marks INTEGER,
    hr_perf_marks   INTEGER,
    total          INTEGER NOT NULL,
    feedback       TEXT,
    submitted_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER,
    action     TEXT NOT NULL,
    details    TEXT,
    ip         TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `);

  db = sqliteDb;
}

module.exports = db;
