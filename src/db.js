'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'konfident.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('admin','mentor','student')),
  phone         TEXT,
  -- student-only fields
  roll_no       TEXT,
  branch        TEXT,
  resume_url    TEXT,
  -- mentor-only fields: which interview types they can take
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
  slot_date     TEXT    NOT NULL,           -- YYYY-MM-DD
  start_time    TEXT    NOT NULL,           -- HH:MM
  end_time      TEXT    NOT NULL,           -- HH:MM
  mode          TEXT    NOT NULL DEFAULT 'Online',
  location      TEXT,                       -- meeting link or room
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
  google_event_id TEXT,
  booked_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);
-- Business rule: a student may hold at most one active interview of each type.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_per_type
  ON interviews (student_id, type) WHERE status <> 'cancelled';
-- Business rule: a slot can hold at most one active booking (cancelled ones free it up).
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_per_slot
  ON interviews (slot_id) WHERE status <> 'cancelled';

CREATE TABLE IF NOT EXISTS evaluations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id   INTEGER NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
  mentor_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- technical criteria (each out of 10)
  resume_marks   INTEGER,
  project_marks  INTEGER,
  dsa_marks      INTEGER,
  -- hr criteria (each out of 10)
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
`);

// Safe migrations for existing databases
const migrations = [
  'ALTER TABLE users ADD COLUMN google_id TEXT UNIQUE',
  'ALTER TABLE users ADD COLUMN google_access_token TEXT',
  'ALTER TABLE users ADD COLUMN google_refresh_token TEXT',
  'ALTER TABLE users ADD COLUMN google_token_expiry INTEGER',
  'ALTER TABLE users ADD COLUMN google_calendar_enabled INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE interviews ADD COLUMN google_event_id TEXT',
];
for (const m of migrations) {
  try { db.exec(m); } catch (_) {}
}

module.exports = db;
