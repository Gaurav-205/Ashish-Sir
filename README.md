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
# 1. Clone the repository
git clone https://github.com/Gaurav-205/Ashish-Sir.git
cd konfident

# 2. Install dependencies
npm install

# 3. Initialize fresh production database (cleans out all mock records, sets up Root Admin)
npm run init

# 4. Start the server
npm start
```

Open **`http://localhost:3000`** in your browser.

#### Initial Administrator Credentials:
- **Email**: `admin@konfident.in`
- **Password**: `pass123`
*(You can change your password immediately after logging in at `/profile`)*

---

### 3. Optional Environment Configuration (`.env`)

Create a `.env` file in the root directory to customize your deployment:

```env
# Server Port
PORT=3000

# Environment Mode (development or production)
NODE_ENV=production

# Custom Session Encryption Secret (Required for production!)
SESSION_SECRET=your-secure-random-secret-key-here

# Root Administrator Setup
ADMIN_EMAIL=admin@yourcollege.edu
ADMIN_PASSWORD=yourStrongPasswordHere
ADMIN_NAME=Platform Administrator

# Optional: Google OAuth & Live Google Calendar Sync
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=https://yourdomain.com/auth/google/callback
```

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

Run the full end-to-end test suite:

```bash
npm test
```

```text
Security & HTTP headers (nosniff, SAMEORIGIN, CSP) ............ 3 passed
Authentication & RBAC access control ........................... 11 passed
Admin — creating mentors, students and slots ................... 8 passed
Student — booking rules, mentors directory, auto-fetch ......... 13 passed
Mentor — attendance, scoring, duplicate checks ................. 9 passed
Student results & maths breakdown .............................. 4 passed
Admin — monitoring, rescheduling, release, CSV export .......... 11 passed
Student cancel & rebook ........................................ 6 passed
Google OAuth & Calendar Integration ............................ 5 passed
Full page renders (Admin, Student, Mentor, 404) ................ 15 passed
System Health Probe (GET /health) .............................. 1 passed
-------------------------------------------------------------------------
Total: 86 passed, 0 failed (100% Pass Rate)
```

---

## 🛠️ Production Commands Reference

| Command | Action |
|---|---|
| `npm run init` | Initializes fresh production database with 0 mock data and creates Root Admin |
| `npm start` | Starts the production server |
| `npm test` | Executes 86 automated end-to-end test assertions |
| `npm run seed:demo` | Optional: populates demo mock dataset for local test environments |
