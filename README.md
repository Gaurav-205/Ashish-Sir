# Konfident Interview 2025

A complete interview management platform: students browse mentors and book calendar slots, mentors conduct interviews, track attendance (`Attended` vs `Absent`) and submit evaluations, and administrators oversee the entire lifecycle with live reporting, calendar synchronization, and CSV export.

Built with **Node.js + Express + EJS + SQLite** — hardened with enterprise HTTP security headers, sliding-window rate limiting, and Google OAuth2 & Google Calendar integration.

---

## Quick start

```bash
npm install      # install dependencies
npm run seed     # create database and load demo dataset
npm start        # launch at http://localhost:3000
```

Requires **Node.js 22.5 or newer** (uses Node's built-in SQLite engine with zero native build dependencies).

### Demo accounts — password `pass123` for everyone

| Role | Email | Notes |
|---|---|---|
| Admin | `admin@konfident.in` | Full system control, slot management, CSV export |
| Mentor (Technical) | `arjun.mentor@konfident.in` | Has upcoming & completed interviews |
| Mentor (Technical + HR) | `rohit.mentor@konfident.in` | Has interview waiting for attendance & scoring |
| Mentor (HR) | `sneha.mentor@konfident.in` | Dedicated HR evaluator |
| Student | `aisha@student.in` | Both interviews completed and evaluated |
| Student | `nikita@student.in` | Technical scored, HR upcoming |
| Student | `harsh@student.in` | Fresh account — test mentors directory & slot booking |

`npm run seed` resets the database and loads the full demo dataset for clean testing.

---

## Key Features

### 1. Mentors Directory & Calendar Slot Booking
- **Mentors Directory (`/student/mentors`)**: Students can browse verified mentors, inspect their interview capabilities (Technical / HR), and view open slot availability.
- **Mentor Filter**: In `/student/slots`, students can filter slots by specific mentors or view all available dates.
- **Calendar Event Sync**: Connect Google Calendar in `/profile` for automatic meeting event creation and schedule updates on booking, rescheduling, and cancellation.

### 2. Meeting Attendance Tracking & Rubric Scoring
- **Attendance Verification (`/mentor/interview/:id`)**: Mentors record candidate attendance with explicit actions:
  - **`✓ Mark Attended (Present)`**: Confirms attendance and immediately unlocks the rubric evaluation form.
  - **`✗ Mark Absent / No-Show`**: Records missed meetings and prevents accidental score submission.
- **Candidate Breakdown**: Real-time score calculator, criterion validation against `src/rubric.js`, and qualitative feedback.

### 3. Enterprise-Grade Security
- **HTTP Security Headers**: Injected `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `X-XSS-Protection`, `Referrer-Policy`, `Content-Security-Policy`, and `Permissions-Policy`.
- **Rate Limiting**: Sliding-window rate limiting on `/login` and `/auth/google` to defend against credential stuffing and brute force.
- **Session Protection**: Session fixation mitigation with fresh session generation on authentication.
- **Database Transaction Isolation**: Atomic `BEGIN IMMEDIATE ... COMMIT / ROLLBACK` SQLite transactions on all booking, release, and cancellation operations.

---

## Evaluation Scheme

**Technical — 30 marks**
| Criteria | Marks |
|---|---|
| Resume Readiness | 10 |
| Project Defence | 10 |
| DSA | 10 |

**HR — 20 marks**
| Criteria | Marks |
|---|---|
| Behavioural Skills | 10 |
| HR Interview Performance | 10 |

**Overall Grand Total: 30 + 20 = 50 marks.**

Managed centrally in `src/rubric.js`.

---

## Automated Tests

```bash
npm test
```

Runs **83 end-to-end assertions** over real HTTP requests covering security headers, rate limiting, role-based access control, slot overlapping constraints, attendance flows, scoring rules, and page renders:

```text
83 passed, 0 failed
```

---

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `SESSION_SECRET` | `konfident-interview-2025-dev-secret` | Session cookie encryption secret |
| `GOOGLE_CLIENT_ID` | `—` | Google OAuth2 Client ID |
| `GOOGLE_CLIENT_SECRET` | `—` | Google OAuth2 Client Secret |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3000/auth/google/callback` | OAuth2 callback URL |

