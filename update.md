# Codebase Audit: Bugs, Logic Errors, and Security Issues

Based on a thorough review of the Konfident Interview 2025 codebase, here are the critical issues identified:

## 🚨 Cheating Loopholes & Logic Errors

### 1. The "Rage-Quit" Cheat (Mid-Interview Cancellation)
In `src/routes/studentRoutes.js`, the `/cancel/:id` route prevents cancellation only if `h.isPast(slot)` returns true. However, `isPast` checks the slot's **`end_time`**. 
- **The Loophole:** If a student joins an interview, realizes they are doing poorly or gets asked a hard question, they can quickly go to their dashboard and click "Cancel" *before the 30-minute slot ends*. 
- **The Result:** The interview is instantly wiped (status set to `cancelled`), the slot opens up, and the student can immediately book a new interview with a different mentor, completely dodging a bad evaluation.

### 2. The Absent Penalty Bypass
In `src/routes/mentorRoutes.js`, when a mentor marks a student as a no-show (`absent`), the system updates `attendance='absent'` but **leaves the `status` as `'booked'`**.
- **The Loophole:** If a mentor marks a student absent 5 minutes into the slot, the student can log in, see their status is still `booked`, and cancel the interview (because the `end_time` hasn't passed yet). This clears the absent mark and lets them rebook without penalty.

### 3. The "Absent Lockout" Bug
Conversely, if a student is marked absent and the slot time *does* pass, they are now permanently stuck. Because their status is still `'booked'` (not `completed` or `cancelled`), the system's "one active booking per type" rule prevents them from booking a new slot, but they also cannot cancel the past slot. They are permanently locked out of finishing their interviews without admin database intervention.

## 🔒 Security Vulnerabilities

### 1. Stored Cross-Site Scripting (XSS) via Meeting Links
In `src/helpers.js`, the `linkify` function converts URLs to `<a>` tags but **fails to HTML-escape the rest of the string**. 
In the EJS views (like `views/student/slots.ejs` and `views/admin/dashboard.ejs`), the location is rendered using the raw output tag `<%-`:
```ejs
<%- h.linkify ? h.linkify(sl.location) : sl.location %>
```
- **The Exploit:** A malicious mentor or admin can set a slot's location to something like `"><script>alert(document.cookie)</script> https://meet.google.com/...`. When a student or admin views the slots page, the script will execute in their browser. This can be used to steal session cookies or perform unauthorized actions.

### 2. Campus-Wide Denial of Service (DoS) via Rate Limiting
In `src/middleware/security.js`, `createRateLimiter` limits login attempts based on the user's IP address.
- **The Risk:** Because universities and dorms often use NAT (Network Address Translation), hundreds of students will share the same public IP address. If one student forgets their password and triggers the 30-request limit, **every student on the campus network will be locked out of logging in for 15 minutes**.

## 🛠️ Recommended Fixes

1. **Fix Cancellations:** Change the cancellation logic in `studentRoutes.js` to block cancellations if the current time is past the **`start_time`** of the slot, not the `end_time`—or enforce a 12-hour cancellation notice window.
2. **Fix Absent Logic:** In `mentorRoutes.js`, marking a student as `absent` should set `status='completed'` (so they can't cancel it) but leave the total score as `0` or explicitly handle rebooking penalties.
3. **Fix XSS:** In `src/helpers.js`, use a library like `escape-html` on the input string *before* running the regex URL replacement, or strictly validate that `location` only contains valid URLs.
4. **Fix Rate Limiting:** Apply rate limiting per-email-address on the login route rather than globally per-IP, or increase the threshold significantly for IP-based limits.