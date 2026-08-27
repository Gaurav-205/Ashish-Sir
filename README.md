# Konfident Interview 2025

A complete interview management system: students book slots, mentors conduct interviews and submit
evaluations, and the admin runs the whole process from one dashboard.

Built with **Node.js + Express + EJS + SQLite** — no external database, no build step, no API keys.

---

## Quick start

```bash
npm install      # install dependencies
npm run seed     # create the database and load demo data
npm start        # http://localhost:3000
```

Requires **Node.js 22.5 or newer** (it uses Node's built-in SQLite, so nothing needs compiling).
Check yours with `node -v`.

### Demo accounts — password `pass123` for everyone

| Role | Email | Notes |
|---|---|---|
| Admin | `admin@konfident.in` | Full control |
| Mentor (Technical) | `arjun.mentor@konfident.in` | Has upcoming + completed interviews |
| Mentor (Technical + HR) | `rohit.mentor@konfident.in` | Has one interview waiting to be scored |
| Mentor (HR) | `sneha.mentor@konfident.in` | |
| Student | `aisha@student.in` | Both interviews done and evaluated |
| Student | `nikita@student.in` | Technical scored, HR upcoming |
| Student | `harsh@student.in` | Nothing booked yet — try the booking flow |

`npm run seed` wipes the database and reloads this demo set, so you can always get back to a clean state.

---

## What each role can do

### Student
- Sign in and see a three-step progress tracker (book → attend → results).
- Browse only the slots the admin has published, grouped by date, for Technical and HR separately.
- Book **one Technical** and **one HR** interview. The mentor comes from the slot — students never choose one.
- See the confirmed date, time, mode, meeting link and assigned mentor.
- Cancel an upcoming booking (the slot reopens for everyone) and rebook a different one.
- View category-wise marks, totals, mentor feedback and an overall grade once both evaluations are in.

### Mentor
- See only the interviews the admin assigned to them, split into upcoming and completed.
- Open a candidate's details and resume link.
- Mark an interview **Completed**, then enter category marks with a live running total and optional feedback.
- Submit the final evaluation. Submitted evaluations are read-only afterwards.

### Admin
- Dashboard: students, mentors, open slots, fully-booked students, upcoming, completed, evaluated,
  plus lists of interviews awaiting evaluation and students who have not finished booking.
- Add and edit students and mentors, reset passwords, deactivate accounts.
- Mark which interview types each mentor can take (Technical, HR, or both).
- Create slots in bulk (pick mentor, date, start time, slot length and how many back-to-back slots).
- Filter slots by date range, single date, type and status. Reschedule, reassign the mentor,
  release a booking or cancel/reopen a slot.
- Browse every interview with filters for type, status and mentor, including marks and scores.
- Reports page with averages and a full score sheet, plus a **CSV export**.

---

## Evaluation scheme

The requirement document's headline numbers (75 / 50) disagree with its own criteria tables and with
section 7. The tables and the "Overall Evaluation: 50 Marks" section were used, so:

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

**Overall: 30 + 20 = 50 marks.**

All of this lives in one file — `src/rubric.js`. Change the criteria, labels or maximums there and every
form, table, report and CSV export follows automatically. No other file needs editing.

---

## Business rules enforced

| Rule | How it is enforced |
|---|---|
| A student gets exactly one Technical and one HR interview | Partial unique index on `(student_id, type)` for non-cancelled rows, plus a check in the booking route |
| Students can only book slots the admin published | Booking reads from `slots` where `status='open'` only |
| A slot can never be double-booked | `BEGIN IMMEDIATE` transaction + status re-check + partial unique index on `slot_id` |
| Students cannot change their mentor | The mentor is copied from the slot; there is no route that lets a student set one |
| Mentors score only their own interviews | Every mentor route compares `interview.mentor_id` with the session user |
| Scores only after the interview is completed | The evaluate route rejects anything not in `completed` status |
| Marks stay inside their category maximum | Server-side validation against `rubric.js` (the HTML `min`/`max` is only a convenience) |
| One evaluation per interview | Unique constraint on `evaluations.interview_id` + a route check |
| Students see results once submitted | The results page renders whatever evaluations exist |
| Completed interviews cannot be cancelled or released | Guarded in the admin slot routes |
| Past slots cannot be booked | Checked in the booking route and filtered out of the student's slot list |

---

## Tests

```bash
npm test
```

Boots the real server against a throwaway database and drives it over HTTP the way a browser would —
cookies, form posts, redirects. 66 assertions covering login, role separation, slot creation,
double-booking, mentor permissions, mark validation, score maths, rescheduling, CSV export and every
page rendering. It leaves your main database untouched.

---

## Project layout

```
server.js              start the server
src/
  app.js               express setup, sessions, view locals
  db.js                SQLite schema (tables, constraints, indexes)
  rubric.js            evaluation criteria and maximums  ← edit here to change the scheme
  auth.js              login / role guards
  helpers.js           date and time formatting
  queries.js           shared reporting queries and score roll-ups
  seed.js              demo data
  routes/
    authRoutes.js      login, logout, profile
    adminRoutes.js     students, mentors, slots, interviews, reports, CSV
    studentRoutes.js   slot list, booking, cancel, results
    mentorRoutes.js    assigned interviews, complete, evaluate
views/                 EJS templates, one folder per role
public/style.css       all styling (single file, no framework)
test/e2e.js            end-to-end test suite
data/                  SQLite database files (created on first run)
```

---

## Notes for production

- Set `SESSION_SECRET` to a random value and run behind HTTPS with `cookie.secure = true`.
- Passwords are hashed with bcrypt; there is no self-signup by design — the admin creates all accounts.
- SQLite handles a few hundred students comfortably. For much larger cohorts, the queries are plain SQL
  and port to Postgres with little change.
- Add email/SMS reminders by hooking into the booking and reschedule routes.
