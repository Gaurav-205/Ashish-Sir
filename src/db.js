'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;
const isVercel = Boolean(process.env.VERCEL || process.env.NOW_REGION || process.env.AWS_LAMBDA_FUNCTION_NAME);
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

// On Vercel or when DATABASE_URL is provided, default directly to Postgres mode
const usePostgres = Boolean(DATABASE_URL && !DATABASE_URL.includes('YOUR_PASSWORD'));

if (usePostgres) {
  // --- Neon Postgres Mode ---
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const runPgQuerySync = (sql, params = []) => {
    const converted = convertSql(sql);

    // Method 1: Fast HTTP REST query via curl (ideal for Vercel / serverless Lambda)
    if (DATABASE_URL && DATABASE_URL.includes('@')) {
      try {
        const u = new URL(DATABASE_URL);
        const httpUrl = `https://${u.hostname}/sql`;
        const payload = JSON.stringify({ query: converted, params });
        const out = execFileSync('curl', [
          '-s', '-X', 'POST', httpUrl,
          '-H', 'Content-Type: application/json',
          '-H', `Neon-Connection-String: ${DATABASE_URL}`,
          '--data-binary', payload
        ], { encoding: 'utf8', timeout: 5000 });

        if (out && out.trim()) {
          const parsed = JSON.parse(out.trim());
          if (parsed.rows) return parsed.rows;
          if (parsed.message) console.error('Neon HTTP SQL Error:', parsed.message);
        }
      } catch (e) {
        // Fallback to Method 2 below if curl fails
      }
    }

    // Method 2: Node pg query fallback
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
        timeout: 5000,
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
  // --- SQLite Mode (Local / Fallback) ---
  let DatabaseSync;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch (_) {
    DatabaseSync = null;
  }

  if (!DatabaseSync) {
    console.warn('SQLite (node:sqlite) unavailable in environment. Operating in mock fallback mode.');
    db = {
      isPostgres: false,
      exec() {},
      prepare() {
        return {
          all: () => [],
          get: () => null,
          run: () => ({ changes: 0, lastInsertRowid: 1 }),
        };
      },
      async query() { return []; },
    };
  } else {
    try {
      const DATA_DIR = isVercel
        ? '/tmp'
        : (process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, '..', 'data'));
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const DB_PATH = isVercel
        ? path.join(DATA_DIR, 'konfident.db')
        : (process.env.DB_PATH || path.join(DATA_DIR, 'konfident.db'));
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

      CREATE TABLE IF NOT EXISTS student_feedbacks (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        interview_id   INTEGER NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
        student_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mentor_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        satisfaction   INTEGER NOT NULL CHECK (satisfaction BETWEEN 1 AND 5),
        structured     INTEGER NOT NULL CHECK (structured IN (0, 1)),
        hr_relevant    INTEGER CHECK (hr_relevant IN (0, 1)),
        feedback_text  TEXT,
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
    } catch (sqliteErr) {
      console.error('SQLite initialization error:', sqliteErr.message);
      db = {
        isPostgres: false,
        exec() {},
        prepare() {
          return {
            all: () => [],
            get: () => null,
            run: () => ({ changes: 0, lastInsertRowid: 1 }),
          };
        },
        async query() { return []; },
      };
    }
  }
}

module.exports = db;
