# Security Issues & Remediation Guide

> **Project:** Konfident Interview 2025  
> **Reviewed:** 2026-08-29  
> **Total Issues Found:** 10 Confirmed · 4 Potential · 13 Missing Controls

---

## Issue 1 — Stored XSS via `linkify()` Helper

**Severity:** 🔴 HIGH  
**File:** `src/helpers.js` → `linkify()` (line 46–61)  
**Affected Views:** Every template rendering slot locations (~15 places across all roles)

### What's Wrong

The `linkify()` function builds raw HTML (`<a href="...">`) and templates inject it via EJS unescaped output `<%- %>`. If a mentor or admin sets a slot `location` field to something like:

```
https://evil.com" onmouseover="alert(document.cookie)
```

or:

```
<img src=x onerror=alert(1)> https://example.com
```

The HTML is rendered directly in every user's browser without sanitization.

### How to Fix

**Step 1 — Add an HTML escape utility in `src/helpers.js`:**

```javascript
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

**Step 2 — Rewrite `linkify()` to escape first:**

```javascript
function linkify(str) {
  if (!str) return '';
  const safe = escapeHtml(str);
  const urlRegex = /(https?:\/\/[^\s<&]+)/g;
  if (!urlRegex.test(safe)) return safe;
  return safe.replace(urlRegex, (url) => {
    let label = `${url} ↗`;
    if (url.includes('calendar.google.com') || url.includes('appointments/schedules')) {
      label = 'Google Calendar Appointment ↗';
    } else if (url.includes('meet.google.com') || url.includes('meet.konfident')) {
      label = 'Google Meet ↗';
    } else if (url.includes('zoom.us')) {
      label = 'Zoom Meeting ↗';
    }
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="meet-link">${label}</a>`;
  });
}
```

**Step 3 — Also validate the `location` field on input** in `adminRoutes.js` and `mentorRoutes.js` when creating/updating slots:

```javascript
// Only allow URLs or short text, reject HTML tags
const location = String(req.body.location || '').trim();
if (/<[^>]+>/.test(location)) {
  throw new Error('Location field cannot contain HTML tags.');
}
```

---

## Issue 2 — No CSRF Protection

**Severity:** 🔴 HIGH  
**File:** `src/app.js` + all views with `<form>` tags  
**Affected:** Every POST endpoint in the application

### What's Wrong

There is zero CSRF (Cross-Site Request Forgery) protection anywhere. A malicious website can auto-submit forms to perform actions as the logged-in user:

```html
<!-- Attacker's website — resets a student's password silently -->
<form method="POST" action="https://your-app.com/admin/students/1/reset-password">
  <input name="password" value="hacked123">
</form>
<script>document.forms[0].submit();</script>
```

`SameSite=Lax` on cookies does NOT prevent this because form POSTs from cross-origin are still allowed in most browsers.

### How to Fix

**Step 1 — Install a CSRF library:**

```bash
npm install csrf-csrf
```

**Step 2 — Add CSRF middleware in `src/app.js`:**

```javascript
const { doubleCsrf } = require('csrf-csrf');

const { doubleCsrfProtection, generateToken } = doubleCsrf({
  getSecret: () => process.env.SESSION_SECRET || 'konfident-interview-2025-dev-secret',
  cookieName: '_csrf',
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
  getTokenFromRequest: (req) => req.body._csrf || req.headers['x-csrf-token'],
});

// Apply CSRF protection to all POST routes (after body parsers, after session)
app.use(doubleCsrfProtection);

// Make token available to all views
app.use((req, res, next) => {
  res.locals.csrfToken = generateToken(req, res);
  next();
});
```

**Step 3 — Add the hidden token field to every `<form>` across all `.ejs` views:**

```html
<form method="post" action="/login">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">
  <!-- ... existing fields ... -->
</form>
```

> You need to add this to every `<form method="post">` in:
> - `views/login.ejs`
> - `views/profile.ejs` (4 forms)
> - `views/admin/students.ejs`, `views/admin/student-detail.ejs`
> - `views/admin/mentors.ejs`
> - `views/admin/slots.ejs`
> - `views/student/slots.ejs`
> - `views/student/dashboard.ejs`
> - `views/mentor/dashboard.ejs`
> - `views/mentor/interview.ejs`
> - `views/partials/nav.ejs` (logout form)

---

## Issue 3 — Session Fixation (No Session Regeneration on Login)

**Severity:** 🔴 HIGH  
**File:** `src/routes/authRoutes.js` → `POST /login` (line 62–65) and Google OAuth callback (line 139)

### What's Wrong

After a user logs in, the session ID stays the same. The code comment says "Session fixation protection" but never actually calls `req.session.regenerate()`. If an attacker sets a known session cookie on the victim's browser before login, the attacker can hijack the session after the victim authenticates.

Current code:
```javascript
// This does NOT regenerate the session — the session ID stays the same
req.session.user = { id: row.id, name: row.name, email: row.email, role: row.role };
```

### How to Fix

**Replace the login session assignment in `authRoutes.js` (password login, ~line 62):**

```javascript
const userData = { id: row.id, name: row.name, email: row.email, role: row.role };
const redirectTo = to || HOME[row.role];

req.session.regenerate((err) => {
  if (err) {
    console.error('Session regeneration error:', err);
    return res.status(500).render('error', {
      title: 'Login error',
      message: 'Could not complete login. Please try again.',
    });
  }
  req.session.user = userData;
  res.redirect(redirectTo);
});
```

**Do the same for Google OAuth login (~line 139):**

```javascript
const userData = { id: user.id, name: user.name, email: user.email, role: user.role };
const redirectTo = to || HOME[user.role];

req.session.regenerate((err) => {
  if (err) return res.redirect('/login');
  req.session.user = userData;
  res.redirect(redirectTo);
});
```

---

## Issue 4 — Hardcoded Session Secret

**Severity:** 🔴 HIGH  
**File:** `src/app.js` (line 24)

### What's Wrong

```javascript
secret: process.env.SESSION_SECRET || 'konfident-interview-2025-dev-secret',
```

This secret is publicly visible in the source code. Anyone who reads it can forge valid session cookies and impersonate any user, including the admin.

### How to Fix

**In `src/app.js`, fail fast in production:**

```javascript
const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret && process.env.NODE_ENV === 'production') {
  console.error('FATAL: SESSION_SECRET environment variable must be set in production.');
  console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}

// ... later in session config:
app.use(session({
  // ...
  secret: sessionSecret || 'dev-only-' + require('crypto').randomBytes(32).toString('hex'),
  // ...
}));
```

This ensures:
- Production **refuses to start** without a proper secret.
- Development generates a random secret each restart (acceptable for dev).

---

## Issue 5 — `SELECT *` Leaks Sensitive Data

**Severity:** 🟠 MEDIUM  
**Files:** `src/queries.js`, `src/routes/authRoutes.js`, `src/routes/mentorRoutes.js`, `src/routes/adminRoutes.js`

### What's Wrong

Queries like `SELECT * FROM users` fetch `password_hash`, `google_access_token`, `google_refresh_token`, and `google_token_expiry` — then pass the entire object to EJS templates or JSON responses. Even though templates don't render these fields, they exist in the rendering context and could leak via errors or debugging.

### How to Fix

**Define a safe column list and use it everywhere:**

```javascript
// In src/queries.js — add at the top
const USER_SAFE_COLS = 'id, name, email, role, phone, roll_no, branch, resume_url, can_technical, can_hr, active, google_id, google_calendar_enabled, created_at';
```

**Then replace all `SELECT * FROM users` with:**

```sql
SELECT id, name, email, role, phone, roll_no, branch, resume_url,
       can_technical, can_hr, active, google_id, google_calendar_enabled, created_at
FROM users ...
```

**Exception:** The login query in `authRoutes.js` needs `password_hash` to verify the password — that's fine, but strip it before passing to session/views.

---

## Issue 6 — JSON API Exposes Mentor PII

**Severity:** 🟠 MEDIUM  
**File:** `src/routes/studentRoutes.js` → `GET /student/api/slots/available` (line 84–132)

### What's Wrong

The response uses `...sl` (spread operator) to copy all database columns into the JSON output, including `mentor_email` and `mentor_phone`. Students shouldn't see mentor phone numbers.

### How to Fix

**Shape the response objects explicitly:**

```javascript
const formattedSlots = slots.map(sl => ({
  id: sl.id,
  type: sl.type,
  slot_date: sl.slot_date,
  start_time: sl.start_time,
  end_time: sl.end_time,
  mode: sl.mode,
  location: sl.location,
  mentor_name: sl.mentor_name,
  dateFormatted: h.fmtDate(sl.slot_date),
  timeFormatted: `${h.fmtTime(sl.start_time)} – ${h.fmtTime(sl.end_time)}`,
  slotFormatted: h.fmtSlot(sl),
}));
```

Remove `mentor_email`, `mentor_phone`, `mentor_id`, and any other internal fields from the response.

---

## Issue 7 — Google OAuth State Parameter Not Validated

**Severity:** 🟠 MEDIUM  
**File:** `src/routes/authRoutes.js` (line 78 and 98)

### What's Wrong

The OAuth `state` parameter is predictable (`'auth'` or `'link:123'`). An attacker can craft OAuth flows with forged state values to link their Google account to someone else's profile.

### How to Fix

**Step 1 — Generate a random state and store it in session:**

```javascript
const crypto = require('crypto');

router.get('/auth/google', (req, res) => {
  if (!google.isConfigured()) { /* ... existing error handling ... */ }

  const stateToken = crypto.randomBytes(32).toString('hex');
  const action = req.query.link === '1' && req.session.user ? 'link' : 'auth';
  req.session.oauthState = { token: stateToken, action };
  
  res.redirect(google.getAuthUrl(stateToken));
});
```

**Step 2 — Verify on callback:**

```javascript
router.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  
  // Verify state matches session
  if (!req.session.oauthState || req.session.oauthState.token !== state) {
    return res.status(403).render('login', {
      title: 'Sign in',
      error: 'Invalid OAuth state. Please try signing in again.',
      email: '',
      googleConfigured: google.isConfigured(),
    });
  }
  
  const action = req.session.oauthState.action;
  delete req.session.oauthState; // one-time use
  
  // ... rest of callback, use `action` instead of parsing `state`
});
```

---

## Issue 8 — Hardcoded Default Credentials in Seed

**Severity:** 🟠 MEDIUM  
**File:** `src/seed.js` (lines 19–22, 196)

### What's Wrong

```javascript
const adminPassword = process.env.ADMIN_PASSWORD || 'pass123';
// ... later ...
console.log(`  Password for all accounts: ${adminPassword}`);
```

Default password `pass123` is trivially guessable. Passwords are logged to console output.

### How to Fix

```javascript
const crypto = require('crypto');

const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
const isGenerated = !process.env.ADMIN_PASSWORD;

// ... later in console output ...
if (isGenerated) {
  console.log(`  ⚠️  Auto-generated admin password: ${adminPassword}`);
  console.log(`  ⚠️  Save this now — it will not be shown again.`);
  console.log(`  💡 Set ADMIN_PASSWORD env var to use your own password.`);
} else {
  console.log(`  Admin password: [set via ADMIN_PASSWORD env var]`);
}
```

---

## Issue 9 — Health Endpoint Leaks Internal State

**Severity:** 🟡 LOW  
**File:** `src/app.js` (lines 50–58)

### What's Wrong

`GET /health` exposes Node.js version, memory usage, and uptime to unauthenticated users — useful for attacker reconnaissance.

### How to Fix

```javascript
app.get('/health', (req, res) => {
  // Basic health check — safe for public access
  res.json({ status: 'healthy' });
});

// Detailed health — admin only
app.get('/health/details', requireRole('admin'), (req, res) => {
  res.json({
    status: 'healthy',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    node: process.version,
    memory: process.memoryUsage(),
  });
});
```

---

## Issue 10 — Admin Password Reset Without Re-authentication

**Severity:** 🟡 LOW  
**File:** `src/routes/adminRoutes.js` (lines 82–91, 135–144)

### What's Wrong

An admin can reset any user's password without confirming their own password first. Combined with the CSRF vulnerability (Issue 2), a single malicious link could silently reset any user's password.

### How to Fix

**Add admin password verification to reset routes:**

```javascript
router.post('/students/:id/reset-password', (req, res) => {
  const admin = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.session.user.id);
  const adminPw = String(req.body.admin_password || '');
  
  if (!bcrypt.compareSync(adminPw, admin.password_hash)) {
    flash(req, 'err', 'Enter your admin password to confirm the reset.');
    return res.redirect('/admin/students/' + req.params.id);
  }
  
  const pw = String(req.body.password || '');
  if (pw.length < 6) {
    flash(req, 'err', 'Password must be at least 6 characters.');
  } else {
    db.prepare(`UPDATE users SET password_hash=? WHERE id=? AND role='student'`)
      .run(bcrypt.hashSync(pw, 10), Number(req.params.id));
    flash(req, 'ok', 'Password reset.');
  }
  res.redirect('/admin/students/' + req.params.id);
});
```

**Update the form in `views/admin/student-detail.ejs`:**

```html
<form method="post" action="/admin/students/<%= s.student.id %>/reset-password" class="btn-row">
  <input name="admin_password" type="password" placeholder="Your admin password" required style="max-width:200px">
  <input name="password" placeholder="New password for student" minlength="6" required style="max-width:200px">
  <button class="btn">Reset password</button>
</form>
```

---

## Missing Controls — Quick Checklist

| # | Control | Where to Add | Effort |
|---|---|---|---|
| 1 | **Invalidate sessions on password change** | `authRoutes.js` — after updating `password_hash`, delete all other sessions for that user from the SQLite session store | Medium |
| 2 | **Audit logging** | Create `src/middleware/auditLog.js` — log login, logout, password changes, admin CRUD actions with timestamp + user ID + IP | Medium |
| 3 | **Pagination** | `queries.js` — add `LIMIT ? OFFSET ?` to `allStudentSummaries()`, `allInterviews()` | Easy |
| 4 | **Stronger password policy** | `authRoutes.js`, `adminRoutes.js` — require min 8 chars, at least 1 number, 1 uppercase | Easy |
| 5 | **Use `validateId` middleware** | All routes with `:id` — it's defined in `security.js` but never imported/used in any route file | Easy |
| 6 | **Remove `unsafe-inline` from CSP** | `src/middleware/security.js` — move inline `<script>` in `mentor/interview.ejs` to external file, then use nonce-based CSP | Medium |
| 7 | **Encrypt Google tokens at rest** | `googleService.js`, `authRoutes.js` — encrypt with `crypto.createCipheriv` before storing, decrypt on read | Hard |
| 8 | **Configure `trust proxy`** | `app.js` — add `app.set('trust proxy', 1)` if behind nginx/load balancer | Easy |
| 9 | **Run `npm audit fix`** | Terminal — fixes 7 known vulnerabilities (1 critical in `tar`) | Easy |
| 10 | **Validate `location` field** | `adminRoutes.js`, `mentorRoutes.js` — reject HTML, validate URL format | Easy |

---

## Fix Priority Order

**Do these first (P0 — blocks production):**
1. Issue 2 — CSRF protection
2. Issue 1 — XSS in `linkify()`
3. Issue 3 — Session regeneration
4. Issue 4 — Session secret enforcement

**Do these next (P1 — before production):**
5. Issue 5 — Remove `SELECT *`
6. Issue 6 — Shape API responses
7. Issue 7 — OAuth state validation
8. Issue 8 — Seed script credentials
9. Run `npm audit fix`

**Do these for hardening (P2):**
10. Issue 9 — Health endpoint
11. Issue 10 — Admin re-auth
12. All missing controls from the checklist above
