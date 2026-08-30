# Konfident Interview 2025

A complete, high-concurrency interview management platform: students browse mentors and book calendar slots with real-time auto-fetch, mentors conduct interviews, track attendance (`Attended` vs `Absent`), and submit evaluations, and administrators oversee the entire lifecycle with live telemetry, rescheduling tools, and CSV exports.

Built with **Node.js 22+ (Native SQLite engine), Express 5, EJS, and the Cohere Enterprise Design System**.

---

## 🚀 Setup & Installation Guide

### 1. Prerequisites
- **Node.js 22.5.0 or newer** (Uses Node.js's built-in `node:sqlite` engine — **zero native database installation or C++ build tools required**).
- **npm** (comes bundled with Node.js).

---

### 2. Quick Setup (Clean Production Setup)

```bash
# 1. Clone the repository and enter it
cd konfident

# 2. Install dependencies
npm install

# 3. Copy the environment template and edit it
cp .env.example .env

# 4. Initialize a fresh database with only the root administrator
npm run init

# 5. Start the server
npm start
```

Open **`http://localhost:3000`** in your browser.

#### Initial Administrator Credentials

`npm run init` creates exactly one account: the administrator named by
`ADMIN_EMAIL` in your `.env` (default `admin@yourinstitution.edu`).

- If you set `ADMIN_PASSWORD`, that is the password.
- If you leave it blank, a strong password is **generated and printed once** by
  `npm run init`. Copy it before clearing your terminal — it is not recoverable.

Change it at `/profile#password` after your first sign-in.

### 2b. Demo / Development Dataset

```bash
npm run seed     # 5 staff admins, 7 mentors, 40 candidates, a full week of slots
```

Every seeded demo account uses the password `pass123`. **Never run this against
a production database.**

---

### 3. Environment Configuration (`.env`)

`.env.example` documents every supported variable. The ones that matter most:

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `3000`). |
| `NODE_ENV` | `development`, `production` or `test`. |
| `SESSION_SECRET` | **Required in production** — the process exits without it. Generate with `openssl rand -base64 48`. |
| `DB_DRIVER` | `sqlite` or `postgres`. Unset means: Postgres if `DATABASE_URL` is set and `DB_PATH` is not, otherwise SQLite. The chosen driver is printed at startup. |
| `DB_PATH` | Override the SQLite file location (default `./data/konfident.db`). |
| `DATABASE_URL` | Neon/Postgres connection string. Required when `DB_DRIVER=postgres`. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | Root administrator created by `npm run init`. |
| `RESET_LINK_VISIBLE` | `true`/`false`. Controls whether password-reset links are shown in the browser (see below). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Enable Google sign-in and Calendar sync. Leave blank to disable the integration cleanly. |
| `GOOGLE_REDIRECT_URI` | Optional. When unset the callback URL is derived from the request, which is what you want behind Vercel or a custom domain. |

Never commit `.env` — it is git-ignored.

---

### 4. Password Recovery

`/forgot-password` issues a single-use reset link that expires after one hour
and invalidates every other outstanding link for that account.

**There is no mail provider wired into this project.** The link is therefore:

- always written to the server log (`[password-reset] link for <email>: <url>`), and
- additionally shown in the browser when `NODE_ENV` is not `production`, so the
  placement cell can pass it to the candidate directly.

Set `RESET_LINK_VISIBLE=false` to force log-only behaviour, or replace the
`console.log` in `src/routes/authRoutes.js` with a real mail call. Administrators
can also reset any password directly from `/admin/students/:id` and `/admin/mentors`.

---

## 📖 Complete Platform Operational Workflow

### Step 1: Admin Configuration (`/admin`)
1. Log in with the **Admin** account.
2. Go to **Mentors (`/admin/mentors`)** $\rightarrow$ Click **"Register a new mentor"** $\rightarrow$ Enter their name, email, password, and assign their capabilities (`Technical` and/or `HR`).
3. Go to **Students (`/admin/students`)** $\rightarrow$ Click **"Register a candidate"** $\rightarrow$ Enter their name, email, password, roll number, and branch.
4. Go to **Slots (`/admin/slots`)** $\rightarrow$ Create batches of interview slots for mentors using the duration generator or 1-click presets (*Morning*, *Afternoon*, *Evening*).

---

### Step 2: Student Booking & Live Auto-Fetch (`/student`)
1. Candidates log in at `/login` using their credentials or 1-click **Google Sign-In**.
2. Visit **Mentors Directory (`/student/mentors`)** to browse verified evaluators and open capacities.
3. Visit **Book Slots (`/student/slots`)**:
   - The platform **auto-fetches** live open slots in real-time.
   - Click **"Quick Book Earliest Slot"** or pick a specific time slot.
   - Candidates book **1 Technical Interview** and **1 HR Interview**.

---

### Step 3: Mentor Conducting, Attendance & Scoring (`/mentor`)
1. Mentors log in to their dashboard (`/mentor`) to view assigned candidates and session timings.
2. Open the interview session (`/mentor/interview/:id`) $\rightarrow$ Click **"Open resume"** to review the student's CV.
3. Track Meeting Attendance:
   - Click **"✓ Mark Attended (Present)"**: Confirms presence and unlocks the rubric evaluation form.
   - Click **"✗ Mark Absent / No-Show"**: Records missed sessions and protects against unauthorized grading.
4. Fill in category marks according to the official criteria:
   - **Technical Interview (30 Marks)**: Resume Readiness (10), Project Defence (10), DSA (10).
   - **HR Interview (20 Marks)**: Behavioural Skills (10), HR Performance (10).
5. Enter qualitative feedback and submit.

---

### Step 4: Performance Results & Export
- **Students (`/student/results`)**: View grand total score (/50), category marks breakdown, grade, mentor qualitative feedback, and click **"🖨️ Print scorecard / Save PDF"**.
- **Admin Reports (`/admin/reports`)**: View cohort averages, attendance telemetry, and download a 1-click **CSV Data Export (`/admin/reports.csv`)**.

---

## 🧪 Automated Test Suite

```bash
npm test
```

The suite boots the real server against a throwaway SQLite database and drives
it over HTTP exactly as a browser would — cookies, form posts, redirects — then
asserts against the database. It covers security headers and CSRF, all three
role guards, booking concurrency, the evaluation rubric boundaries, password
change and password recovery, the audit log, and every page render.

```text
Total: 148 assertions, 0 failed
```

---

## 🛠️ Commands Reference

| Command | Action |
|---|---|
| `npm start` | Start the server. |
| `npm run dev` | Start with `--watch` for local development. |
| `npm run init` | Fresh database containing only the root administrator. |
| `npm run seed` | Development/demo dataset (admins, mentors, 40 candidates, a week of slots). |
| `npm run empty-db` | Wipe every record, including the administrator. |
| `npm test` | Run the end-to-end suite. |

---

## 🗄️ Data Layer Notes

- **SQLite (default)** uses Node's built-in `node:sqlite` — no native build step.
- **Postgres/Neon** is supported for serverless deployment. The application layer
  is synchronous, so Postgres access goes through a blocking shim
  (`src/db.js`) that uses Neon's HTTP SQL endpoint, falling back to `pg`.
  Query failures throw rather than returning empty result sets, so the UI can
  never silently disagree with the database.

  Postgres does **not** self-migrate. Apply `sql/schema.postgres.sql` before the
  first deploy and after pulling schema changes — every statement is
  `IF NOT EXISTS` and safe to re-run:

  ```bash
  psql "$DATABASE_URL_UNPOOLED" -f sql/schema.postgres.sql
  ```
- **All interview times are stored as wall-clock IST** (`YYYY-MM-DD` +
  `HH:MM`). Every "is this slot in the past" comparison — in SQL and in
  JavaScript — goes through `src/helpers.js` (`nowMinute()`, `today()`,
  `isPast()`), so the application behaves identically on a UTC server and an
  IST one.
