# Codebase Audit: Missing Logic & Bugs

## 1. Vercel/Postgres Transaction Race Conditions (Major Bug)
In `src/db.js`, when running in Postgres mode (which is triggered when `DATABASE_URL` is set, such as on Vercel), queries are sent using stateless connections (via `curl` over HTTP or `execFileSync` to a detached Node process).
- As a result, when routes like `studentRoutes.js` (`/book`, `/cancel/:id`) and `adminRoutes.js` (`/slots/:id/allot`) execute `db.exec('BEGIN IMMEDIATE')`, it doesn't actually begin a stateful transaction. The subsequent `SELECT` and `INSERT`/`UPDATE` calls run on completely separate connections.
- **Impact:** This introduces severe race conditions. If two students click "Book" on the same open slot at the exact same millisecond, they could both successfully book the interview.

## 2. Absent Students Can Submit Feedback (Logic Error)
In `src/routes/studentRoutes.js` around line 282 for the `/feedback/:interviewId` route, the condition to prevent early feedback is written as an `&&`:
```javascript
if (iv.status !== 'completed' && iv.attendance !== 'attended') {
  flash(req, 'err', 'Feedback can only be submitted for completed interviews.');
}
```
- When a mentor marks a student as `absent`, the backend sets `status = 'completed'` and `attendance = 'absent'`.
- This makes the logic evaluate to `false && true`, which equals `false`.
- **Impact:** Students who were a no-show/absent can still submit feedback for the mentor. It should be changed to use `||` instead of `&&`.

## 3. Mentors Can "Resurrect" Cancelled Interviews (Missing Logic)
In `src/routes/mentorRoutes.js` (`/interview/:id/attendance` and `/interview/:id/complete`), there is no validation to check if the interview was already cancelled (`iv.status !== 'cancelled'`).
- If a student cancels their booking, the slot is released to `'open'` and the interview is marked as `'cancelled'`.
- However, if the mentor has the interview page open and submits an attendance form for that cancelled interview, the backend sets its status to `'completed'`.
- **Impact:** The cancelled interview is resurrected. If another student booked that reopened slot in the meantime, the system will have overlapping completed/booked interviews for the exact same timeslot.

## 4. Changing Attendance After Evaluation (Logic Bug)
In `src/routes/mentorRoutes.js`, the `/interview/:id/attendance` endpoint allows a mentor to toggle a candidate between `attended` and `absent`.
- If a mentor marks them `attended`, submits the evaluation form (saving marks in the DB), and later changes the attendance back to `absent`, the evaluation row still exists.
- In `src/queries.js`, the `studentSummary` only verifies if `status === 'completed'` and `eval_id != null` before giving the student their score.
- **Impact:** A student marked as `absent` could still retain their evaluation score and have it count towards their total if the mentor changed the attendance post-evaluation.

## Can you access other routes without auth?
**No, you cannot access protected routes without authentication.**

The security implementation around route access is solid:
- In `src/app.js`, the application correctly directs traffic to routers (`authRoutes`, `adminRoutes`, `studentRoutes`, `mentorRoutes`).
- At the very top of each role-specific router file, it executes `router.use(requireRole('<role>'))`. 
- The `requireRole` middleware strictly checks if `req.session.user` exists, if their account is active, and if their assigned role matches the route they are attempting to access. If any of those fail, the user is safely kicked out or shown a 403 Access Denied error.
- Only safe unauthenticated pages like `/login`, `/auth/google`, and `/health` are exposed.