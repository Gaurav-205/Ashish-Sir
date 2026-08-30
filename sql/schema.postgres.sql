-- ---------------------------------------------------------------------------
-- Konfident Interview 2025 — Postgres / Neon schema
--
-- The SQLite driver creates its own schema on boot (see src/db.js). Postgres
-- does not, so this file is the authoritative Postgres schema: run it against
-- a fresh database before the first deploy, and again after pulling changes
-- (every statement is IF NOT EXISTS and safe to re-run).
--
--   psql "$DATABASE_URL_UNPOOLED" -f sql/schema.postgres.sql
--
-- Timestamps are stored as text in Asia/Kolkata wall-clock time, matching
-- src/helpers.js. Do not switch these columns to `timestamptz` without
-- updating the helpers and the SQL comparisons together.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id                      SERIAL PRIMARY KEY,
  name                    TEXT    NOT NULL,
  email                   TEXT    NOT NULL UNIQUE,
  password_hash           TEXT    NOT NULL,
  role                    TEXT    NOT NULL CHECK (role IN ('admin','mentor','student')),
  phone                   TEXT,
  roll_no                 TEXT,
  branch                  TEXT,
  squad                   TEXT,
  resume_url              TEXT,
  can_technical           INTEGER NOT NULL DEFAULT 0,
  can_hr                  INTEGER NOT NULL DEFAULT 0,
  active                  INTEGER NOT NULL DEFAULT 1,
  google_id               TEXT UNIQUE,
  google_access_token     TEXT,
  google_refresh_token    TEXT,
  google_token_expiry     BIGINT,
  google_calendar_enabled INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT    NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::timestamp(0)::text)
);

CREATE TABLE IF NOT EXISTS slots (
  id         SERIAL PRIMARY KEY,
  mentor_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL CHECK (type IN ('technical','hr')),
  slot_date  TEXT    NOT NULL,
  start_time TEXT    NOT NULL,
  end_time   TEXT    NOT NULL,
  mode       TEXT    NOT NULL DEFAULT 'Online',
  location   TEXT,
  status     TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','booked','cancelled')),
  created_at TEXT    NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::timestamp(0)::text),
  UNIQUE (mentor_id, slot_date, start_time)
);

CREATE TABLE IF NOT EXISTS interviews (
  id                   SERIAL PRIMARY KEY,
  student_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mentor_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot_id              INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  type                 TEXT    NOT NULL CHECK (type IN ('technical','hr')),
  status               TEXT    NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','completed','cancelled')),
  attendance           TEXT    NOT NULL DEFAULT 'pending' CHECK (attendance IN ('pending','attended','absent')),
  attendance_marked_at TEXT,
  google_event_id      TEXT,
  booked_at            TEXT    NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::timestamp(0)::text),
  completed_at         TEXT
);

CREATE TABLE IF NOT EXISTS evaluations (
  id              SERIAL PRIMARY KEY,
  interview_id    INTEGER NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
  mentor_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resume_marks    INTEGER,
  project_marks   INTEGER,
  dsa_marks       INTEGER,
  behaviour_marks INTEGER,
  hr_perf_marks   INTEGER,
  total           INTEGER NOT NULL,
  feedback        TEXT,
  submitted_at    TEXT NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::timestamp(0)::text)
);

CREATE TABLE IF NOT EXISTS student_feedbacks (
  id            SERIAL PRIMARY KEY,
  interview_id  INTEGER NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mentor_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  satisfaction  INTEGER NOT NULL CHECK (satisfaction BETWEEN 1 AND 5),
  structured    INTEGER NOT NULL CHECK (structured IN (0, 1)),
  hr_relevant   INTEGER CHECK (hr_relevant IN (0, 1)),
  feedback_text TEXT,
  submitted_at  TEXT NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::timestamp(0)::text)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Was missing from the Postgres schema: logAudit() swallows its own errors, so
-- on Postgres every audit write failed silently and the trail stayed empty.
CREATE TABLE IF NOT EXISTS audit_logs (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  details    TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::timestamp(0)::text)
);

-- Backs the /forgot-password flow. Only the SHA-256 hash of a reset token is
-- stored, so a database leak cannot be replayed into account takeovers.
CREATE TABLE IF NOT EXISTS password_resets (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT    NOT NULL UNIQUE,
  expires_at TEXT    NOT NULL,
  used_at    TEXT,
  created_at TEXT    NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::timestamp(0)::text)
);

CREATE INDEX IF NOT EXISTS idx_slots_lookup      ON slots (status, type, slot_date, start_time);
CREATE INDEX IF NOT EXISTS idx_slots_mentor      ON slots (mentor_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_interviews_stud   ON interviews (student_id, type, status);
CREATE INDEX IF NOT EXISTS idx_interviews_mentor ON interviews (mentor_id, status);
CREATE INDEX IF NOT EXISTS idx_interviews_slot   ON interviews (slot_id);
CREATE INDEX IF NOT EXISTS idx_audit_action      ON audit_logs (action, created_at);
CREATE INDEX IF NOT EXISTS idx_resets_user       ON password_resets (user_id);
