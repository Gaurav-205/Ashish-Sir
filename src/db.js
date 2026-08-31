'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;
const isVercel = Boolean(process.env.VERCEL || process.env.NOW_REGION || process.env.AWS_LAMBDA_FUNCTION_NAME);
let db = {};

const sqlConversionCache = new Map();

// Helper to convert SQLite '?' placeholders to PostgreSQL '$1', '$2'...
function convertSql(sql) {
  const cache = typeof sqlConversionCache !== 'undefined' ? sqlConversionCache : null;
  if (cache && cache.has(sql)) return cache.get(sql);

  let paramIndex = 1;
  let converted = sql.replace(/\?/g, () => `$${paramIndex++}`);
  
  // Convert comparisons of datetime(slot_date || ' ' || start_time) first to avoid type mismatch
  converted = converted.replace(/datetime\(([^)]+)\)\s*(>=|<=|>|<|=|<>)\s*datetime\('now'(?:,'localtime')?\)/gi, 
    '($1)::timestamp $2 (CURRENT_TIMESTAMP AT TIME ZONE \'Asia/Kolkata\')::timestamp');
  
  // Convert standard SQLite datetime/date functions to equivalent PostgreSQL IST expressions
  converted = converted.replace(/datetime\('now','localtime'\)/gi, '((CURRENT_TIMESTAMP AT TIME ZONE \'Asia/Kolkata\')::timestamp)::text');
  converted = converted.replace(/datetime\('now'\)/gi, '((CURRENT_TIMESTAMP AT TIME ZONE \'Asia/Kolkata\')::timestamp)::text');
  converted = converted.replace(/date\('now','localtime'\)/gi, '((CURRENT_TIMESTAMP AT TIME ZONE \'Asia/Kolkata\')::date)::text');
  converted = converted.replace(/date\('now'\)/gi, '((CURRENT_TIMESTAMP AT TIME ZONE \'Asia/Kolkata\')::date)::text');
  
  converted = converted.replace(/datetime\(([^)]+)\)/gi, '($1)::timestamp');
  converted = converted.replace(/BEGIN\s+IMMEDIATE/gi, 'BEGIN');
  converted = converted.replace(/AUTOINCREMENT/gi, '');
  // Postgres has no lastInsertRowid / changes counter, so every mutation is
  // asked to return its affected rows. That is what backs `run()` below.
  //
  // Only for a *single* statement: exec() is also used for multi-statement
  // batches (the seeder) and for BEGIN/COMMIT, where a trailing RETURNING is a
  // syntax error.
  const trimmed = converted.trim().replace(/;+\s*$/, '');
  const isSingleStatement = !trimmed.includes(';');
  let result = converted;
  if (isSingleStatement
      && /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(trimmed)
      && !/\bRETURNING\b/i.test(trimmed)) {
    result = `${trimmed} RETURNING *`;
  }
  if (cache) cache.set(sql, result);
  return result;
}

/*
 * Driver selection.
 *   DB_DRIVER=sqlite | postgres  -> explicit, always wins.
 *   otherwise                    -> Postgres when a usable DATABASE_URL is set
 *                                   and no DB_PATH override forces a local file.
 * The active driver is logged once at startup so a misconfigured environment is
 * obvious instead of silently reading from the wrong database.
 */
const driverOverride = String(process.env.DB_DRIVER || '').trim().toLowerCase();
const hasUsableUrl = Boolean(DATABASE_URL && !DATABASE_URL.includes('YOUR_PASSWORD'));

if (driverOverride && !['sqlite', 'postgres'].includes(driverOverride)) {
  throw new Error(`Invalid DB_DRIVER "${process.env.DB_DRIVER}". Use "sqlite" or "postgres".`);
}
if (driverOverride === 'postgres' && !hasUsableUrl) {
  throw new Error('DB_DRIVER=postgres requires a valid DATABASE_URL.');
}

const usePostgres = driverOverride
  ? driverOverride === 'postgres'
  : Boolean(hasUsableUrl && !process.env.DB_PATH);

if (usePostgres) {
  // --- Neon Postgres Mode ---
  const { Pool } = require('pg');
  const { Worker } = require('worker_threads');
  const cleanDbUrl = DATABASE_URL;
  const pool = new Pool({
    connectionString: cleanDbUrl,
    ssl: { rejectUnauthorized: false },
  });

  const QUERY_TIMEOUT_MS = Number(process.env.DB_QUERY_TIMEOUT_MS) || 15000;

  // High-performance synchronous bridge using a persistent Worker thread & SharedArrayBuffer.
  // Eliminates process spawning overhead (~150ms saved per query).
  const BUFFER_SIZE = 8 * 1024 * 1024; // 8MB shared memory
  let pgWorker = null;
  let sab = null;
  let control = null;
  let dataBuf = null;

  try {
    sab = new SharedArrayBuffer(BUFFER_SIZE);
    control = new Int32Array(sab, 0, 4);
    dataBuf = Buffer.from(sab, 16);

    pgWorker = new Worker(path.join(__dirname, 'pgWorker.js'), {
      workerData: { sab, databaseUrl: cleanDbUrl },
    });
    pgWorker.unref();

    const startWait = Date.now();
    while (Atomics.load(control, 0) !== 100 && (Date.now() - startWait) < 5000) {
      Atomics.wait(control, 0, 0, 100);
    }
    if (Atomics.load(control, 0) !== 100) {
      try { pgWorker.terminate(); } catch (_) {}
      pgWorker = null;
      console.warn('[db] PG Worker initialization timed out, using HTTP/subprocess fallback');
    }
  } catch (workerErr) {
    console.warn('[db] PG Worker initialization failed, using HTTP/subprocess fallback:', workerErr.message);
    pgWorker = null;
  }

  /*
   * The application layer is synchronous throughout (it was written against
   * node:sqlite's synchronous API), so Postgres access goes through our
   * zero-overhead worker bridge, falling back to Neon's HTTP SQL endpoint
   * or a subprocess if worker is unavailable.
   */
  const runPgQuerySync = (sql, params = []) => {
    const converted = convertSql(sql);
    const problems = [];

    // Method 1: Persistent in-memory Worker Thread via SharedArrayBuffer (Fastest, ~50ms, 0 child processes)
    if (pgWorker && control && dataBuf) {
      try {
        const payload = Buffer.from(JSON.stringify({ sql: converted, params }), 'utf8');
        if (payload.length <= dataBuf.length) {
          dataBuf.set(payload);
          Atomics.store(control, 1, payload.length);
          Atomics.store(control, 0, 1); // 1 = request ready
          Atomics.notify(control, 0, 1);

          Atomics.wait(control, 0, 1, QUERY_TIMEOUT_MS);

          const resLen = Atomics.load(control, 2);
          const isErr = Atomics.load(control, 3);
          const resStr = dataBuf.toString('utf8', 0, resLen);

          Atomics.store(control, 0, 0); // reset state to idle

          if (isErr) {
            throw new Error(resStr);
          }
          return JSON.parse(resStr || '[]');
        }
      } catch (workerErr) {
        problems.push(`PG Worker: ${workerErr.message}`);
      }
    }

    // Method 2: Neon HTTP SQL endpoint (fast fallback on Lambda/serverless)
    if (DATABASE_URL.includes('@')) {
      try {
        const u = new URL(DATABASE_URL);
        const payload = JSON.stringify({ query: converted, params });
        const out = execFileSync('curl', [
          '-sS', '--fail-with-body', '-X', 'POST', `https://${u.hostname}/sql`,
          '-H', 'Content-Type: application/json',
          '-H', `Neon-Connection-String: ${DATABASE_URL}`,
          '--data-binary', payload,
        ], { encoding: 'utf8', timeout: QUERY_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'] });

        if (out && out.trim()) {
          const parsed = JSON.parse(out.trim());
          if (Array.isArray(parsed.rows)) return parsed.rows;
          problems.push(`Neon HTTP: ${parsed.message || parsed.error || 'unexpected response'}`);
        } else {
          problems.push('Neon HTTP: empty response');
        }
      } catch (e) {
        problems.push(`Neon HTTP: ${e.message}`);
      }
    }

    // Method 2: `pg` in a child process.
    const code = `
      process.removeAllListeners('warning');
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      pool.query(${JSON.stringify(converted)}, ${JSON.stringify(params)})
        .then(res => {
          // A multi-statement batch resolves to an array of results.
          const rows = Array.isArray(res)
            ? (res.length ? (res[res.length - 1].rows || []) : [])
            : (res.rows || []);
          process.stdout.write(JSON.stringify(rows));
          process.exit(0);
        })
        .catch(err => { process.stderr.write(String(err && err.message || err)); process.exit(1); });
    `;
    try {
      const out = execFileSync(process.execPath, ['-e', code], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, DATABASE_URL },
        encoding: 'utf8',
        timeout: QUERY_TIMEOUT_MS,
      });
      return JSON.parse(out.trim() || '[]');
    } catch (e) {
      problems.push(`pg: ${(e.stderr || e.message || '').toString().trim()}`);
    }

    const err = new Error(`Database query failed. ${problems.join(' | ')}`);
    err.sql = converted;
    throw err;
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
          const id = rows[0] && rows[0].id != null ? rows[0].id : null;
          return { changes: rows.length, lastInsertRowid: id };
        },
      };
    },
    async query(sql, params = []) {
      const converted = convertSql(sql);
      const res = await pool.query(converted, params);
      return res.rows;
    },
  };

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER,
      action     TEXT NOT NULL,
      details    TEXT,
      ip         TEXT,
      created_at TEXT NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::timestamp(0)::text)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT    NOT NULL UNIQUE,
      expires_at TEXT    NOT NULL,
      used_at    TEXT,
      created_at TEXT    NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::timestamp(0)::text)
    )`);
    db.exec(`ALTER TABLE slots ADD COLUMN IF NOT EXISTS google_event_id TEXT`);
    db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_developer INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE users SET is_developer = 1, can_technical = 0, can_hr = 0 WHERE lower(email) = 'gauravkhandelwal205@gmail.com'`);
    db.exec(`UPDATE users SET role = 'admin', active = 1 WHERE lower(email) = 'arvind@kalvium.com'`);
    db.exec(`UPDATE users SET role = 'mentor', can_hr = 1, active = 1 WHERE lower(email) = 'akshata.sanap@kalvium.com'`);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_slots_mentor_status ON slots(mentor_id, status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_slots_date_status ON slots(slot_date, status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_interviews_student ON interviews(student_id, status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_interviews_mentor ON interviews(mentor_id, status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_interviews_slot ON interviews(slot_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_evaluations_interview ON evaluations(interview_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, active)`);
  } catch (_) {}
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
        created_at    TEXT    NOT NULL DEFAULT (datetime('now','+5 hours','+30 minutes'))
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
        google_event_id TEXT,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now','+5 hours','+30 minutes')),
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
        booked_at     TEXT    NOT NULL DEFAULT (datetime('now','+5 hours','+30 minutes')),
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
        submitted_at   TEXT NOT NULL DEFAULT (datetime('now','+5 hours','+30 minutes'))
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
        submitted_at   TEXT NOT NULL DEFAULT (datetime('now','+5 hours','+30 minutes'))
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS password_resets (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash  TEXT    NOT NULL UNIQUE,
        expires_at  TEXT    NOT NULL,
        used_at     TEXT,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now','+5 hours','+30 minutes'))
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER,
        action     TEXT NOT NULL,
        details    TEXT,
        ip         TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','+5 hours','+30 minutes'))
      );
      `);

      try {
        sqliteDb.exec("ALTER TABLE slots ADD COLUMN google_event_id TEXT;");
      } catch (_) {}
      try {
        sqliteDb.exec("ALTER TABLE users ADD COLUMN is_developer INTEGER NOT NULL DEFAULT 0;");
      } catch (_) {}
      try {
        sqliteDb.exec("UPDATE users SET is_developer = 1, can_technical = 0, can_hr = 0 WHERE lower(email) = 'gauravkhandelwal205@gmail.com';");
      } catch (_) {}
      try {
        sqliteDb.exec("UPDATE users SET role = 'admin', active = 1 WHERE lower(email) = 'arvind@kalvium.com';");
      } catch (_) {}
      try {
        sqliteDb.exec("UPDATE users SET role = 'mentor', can_hr = 1, active = 1 WHERE lower(email) = 'akshata.sanap@kalvium.com';");
      } catch (_) {}
      try {
        sqliteDb.exec(`
          CREATE INDEX IF NOT EXISTS idx_slots_mentor_status ON slots(mentor_id, status);
          CREATE INDEX IF NOT EXISTS idx_slots_date_status ON slots(slot_date, status);
          CREATE INDEX IF NOT EXISTS idx_interviews_student ON interviews(student_id, status);
          CREATE INDEX IF NOT EXISTS idx_interviews_mentor ON interviews(mentor_id, status);
          CREATE INDEX IF NOT EXISTS idx_interviews_slot ON interviews(slot_id);
          CREATE INDEX IF NOT EXISTS idx_evaluations_interview ON evaluations(interview_id);
          CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, active);
        `);
      } catch (_) {}

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

db.driver = usePostgres ? 'postgres' : (db.isPostgres === false ? 'sqlite-fallback' : 'sqlite');
if (process.env.NODE_ENV !== 'test' && !process.env.DB_QUIET) {
  console.log(`  [db] driver: ${db.driver}`);
}

module.exports = db;
