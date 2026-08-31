# Konfident Interview 2025 - Security Review & Action Plan

This document outlines the findings of a defensive secure-code review of the Konfident Interview 2025 repository. It details confirmed vulnerabilities, architectural weaknesses, missing controls, and a prioritized hardening plan for developers to follow.

## 1. Architecture & Attack-Surface Summary
The application is a monolithic Node.js/Express server utilizing a synchronous SQLite database (`node:sqlite`) and server-side rendered EJS templates. 
* **Trust Boundaries:** The application manages three main roles: Student, Mentor, and Admin. Vertical authorization is strictly enforced via `requireRole` middleware. Horizontal authorization (e.g., students only canceling their own slots) is handled explicitly in SQL queries. 
* **Attack Surface:** The primary attack surfaces include the OAuth 2.0 callback flow, form-based POST endpoints (booking, canceling, updating profiles, evaluation submission), and administrative reporting endpoints.

## 2. Confirmed Security Issues

### CRITICAL: Missing Anti-CSRF Tokens (Cross-Site Request Forgery)
* **File:** `src/app.js`, all `views/**/*.ejs` templates
* **Function/route:** All `POST` routes
* **Problem:** There are no CSRF tokens implemented in the application. It relies entirely on session cookies to authenticate requests.
* **Security impact:** Attackers could force a logged-in user to perform actions (e.g., an admin deleting a user, a student dropping an interview) without their consent via forged cross-site requests.
* **Recommended fix:** Implement a CSRF middleware (e.g., `csrf-sync`) and inject a CSRF token into a hidden `<input>` field across all EJS forms.

### HIGH: Stored Cross-Site Scripting (XSS) via EJS Raw Output and `linkify`
* **File:** `src/helpers.js` (`linkify`), multiple EJS views (e.g., `views/admin/dashboard.ejs`)
* **Problem:** The `linkify` helper uses a regex to convert URLs into HTML `<a>` tags but fails to HTML-escape the surrounding text. EJS templates then render this output using the raw, unescaped tag `<%-`.
* **Security impact:** Malicious users can inject JavaScript into location fields, leading to session hijacking or unauthorized actions when viewed by admins/students.
* **Recommended fix:** HTML-escape the input string *before* applying the URL regex. Example: 
  `str = str.replace(/[&<>'"]/g, tag => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[tag]));`

### HIGH: Event Loop Blocking DoS via N+1 Synchronous Queries
* **File:** `src/queries.js`, `src/routes/adminRoutes.js`
* **Function:** `allStudentSummaries()`, `/admin/reports`
* **Problem:** Retrieves all students and executes multiple additional synchronous database queries inside a `.map()` loop.
* **Security impact:** Because `node:sqlite` is synchronous, querying the admin report with hundreds of students will completely block the Node.js event loop, causing a Denial of Service for all users.
* **Recommended fix:** Refactor `allStudentSummaries` into a single SQL `JOIN` or grouped query that computes aggregates in the database, removing the JS-level loop.

### HIGH: Network-Wide DoS via IP-Based Rate Limiting
* **File:** `src/middleware/security.js`
* **Function:** `createRateLimiter()`
* **Problem:** The login rate limiter tracks attempts exclusively by `req.ip` (30 requests / 15 mins).
* **Security impact:** Users on NAT (like university campuses) share a public IP. A few failed logins can lock out an entire campus network.
* **Recommended fix:** Change the rate limiter key for the `/login` route to prioritize the target email address (`req.body.email.toLowerCase()`).

### MEDIUM: Session Fixation
* **File:** `src/routes/authRoutes.js`
* **Function:** `POST /login` and `GET /auth/google/callback`
* **Problem:** Authenticated sessions mutate the existing session object instead of regenerating the session ID.
* **Security impact:** Attackers can hijack a session if they trick a user into logging in with a known session ID.
* **Recommended fix:** Wrap the login state assignment in a regeneration callback: 
  `req.session.regenerate((err) => { req.session.user = ...; res.redirect(...); });`

### MEDIUM: Login CSRF & OAuth State Vulnerability
* **File:** `src/routes/authRoutes.js`, `src/services/googleService.js`
* **Function:** `/auth/google` and `/auth/google/callback`
* **Problem:** The Google OAuth flow uses a predictable, hardcoded `state` parameter without verifying a cryptographically random nonce in the session.
* **Security impact:** Attackers can force victims to log into the attacker's account or forcefully link accounts.
* **Recommended fix:** Generate a random string, store it in `req.session.oauthState`, append application context to it, and verify the nonce in the callback.

### MEDIUM: Business Logic State-Machine Bypasses
* **File:** `src/helpers.js` (`isPast`), `src/routes/mentorRoutes.js`
* **Problem:** 
  1. The "Rage-Quit": `isPast(slot)` checks `end_time`, allowing students to cancel *during* a bad interview.
  2. "Absent Penalty Bypass": Mentors mark a student absent, but status remains `'booked'`, allowing cancellation to clear the penalty.
* **Security impact:** Users can manipulate state to dodge poor evaluations or penalties.
* **Recommended fix:** Update `isPast(slot)` to strictly check `start_time`. Update attendance logic to set `status='completed'` when marking a student as `absent`.

### LOW: Insecure Default Session Secret
* **File:** `src/app.js`
* **Problem:** The session secret falls back to a hardcoded string.
* **Security impact:** If deployed without `SESSION_SECRET` configured, attackers could forge session cookies.
* **Recommended fix:** Throw a fatal error on boot if `SESSION_SECRET` is missing in production environments.

## 3. Missing Security Controls
* **Anti-CSRF Tokens:** Completely missing across all POST requests.
* **Audit Logging:** Critical administrative actions do not log the initiating administrator's ID.
* **Targeted Rate Limiting:** Expensive endpoints (like CSV generation) lack specific rate limiting, risking application-layer DoS.
* **Database File Protection:** Ensure any reverse proxy (Nginx, Apache) explicitly denies access to the `/data` directory to prevent `.db`, `-wal`, and `-shm` file downloads.

## 4. Security Hardening Plan

### P0 (Immediate)
* Fix the Stored XSS in `linkify`.
* Fix the Session Fixation issue using `req.session.regenerate()`.
* Fix the state machine bypasses by enforcing `start_time` locking and transitioning absent students to `completed`.

### P1 (High Priority)
* Implement robust CSRF middleware (like `csrf-sync` or `tiny-csrf`) and add tokens to all EJS forms.
* Re-architect the login rate limiter to track failures by `req.body.email`.
* Implement OAuth `state` validation.

### P2 (Medium Priority)
* Rewrite the `allStudentSummaries` query to avoid the synchronous N+1 loop block.
* Throw an error on boot if `SESSION_SECRET` is absent in production environments.

## 5. Files Requiring Changes
* **`src/helpers.js`:** Add HTML escaping to `linkify`; modify `isPast` to use `start_time`.
* **`src/routes/authRoutes.js`:** Add `req.session.regenerate` wrappers; implement OAuth `state` validation logic.
* **`src/app.js`:** Integrate CSRF middleware; validate `SESSION_SECRET` requirements.
* **`src/middleware/security.js`:** Update `createRateLimiter` to use `req.body.email`.
* **`src/routes/mentorRoutes.js`:** Add `status='completed'` for absent logic.
* **`src/queries.js`:** Refactor `allStudentSummaries` to perform bulk SQL aggregation.
* **`views/**/*.ejs`:** Add hidden CSRF token inputs to all forms.

## 6. Final Review Checklist
- [x] Authentication
- [x] Authorization
- [x] API security
- [x] Input validation
- [x] Injection
- [x] XSS
- [x] CSRF
- [x] CORS
- [x] Cookies/sessions
- [x] Secrets
- [x] Dependencies
- [x] File handling
- [x] Database access
- [x] Resource exhaustion
- [x] Client-side trust
- [x] Security headers
- [x] Configuration
- [x] Business logic
