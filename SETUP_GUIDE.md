# Konfident Interview 2025 — Complete Setup & Credentials Guide

A complete, production-ready operational runbook for configuring local development, Google Cloud Console OAuth & Google Calendar sync, Neon Postgres cloud database, and Vercel serverless deployment.

---

## 1. Quick Credentials Cheat Sheet (Default Seeded Accounts)

When running locally with `npm run seed:demo` (or when seeded in development mode), all accounts use the master demo password:
> **Default Master Password**: `pass123`

### Administrator Accounts
| Name | Email | Role | Scope / Perms |
| :--- | :--- | :--- | :--- |
| **Utkarsha Kasar** | `utkarsha.kasar@kalvium.com` | `admin` | Full Platform & User Management |
| **Prachi Sharma** | `prachi.sharma@kalvium.com` | `admin` | Full Platform & User Management |
| **Ashish Suresh** | `ashish.suresh@kalvium.com` | `admin` | Full Platform & User Management |
| **Akshata Sanap** | `akshata.sanap@kalvium.com` | `admin` | Admin + HR Mentor Dual Role |

### Mentor Accounts (Strict Tech vs. HR Segregation)
| Name | Email | Role | Interview Type Capability |
| :--- | :--- | :--- | :--- |
| **Manav Verma** | `manav.verma@kalvium.com` | `mentor` | **Technical Only** (30 marks) |
| **Muskan Srivastava** | `muskan.srivastava@kalvium.com` | `mentor` | **HR Only** (20 marks) |
| **Ritu Soni** | `ritu.soni@kalvium.com` | `mentor` | **Technical Only** (30 marks) |
| **Shikhar Agarwal** | `shikhar.agarwal@kalvium.com` | `mentor` | **Technical Only** (30 marks) |
| **Shivam Shrivastava** | `shivam.shrivastava@kalvium.com` | `mentor` | **Technical Only** (30 marks) |
| **Aditya Kulshreshtha** | `aditya.kulshreshtha@kalvium.com` | `mentor` | **Technical Only** (30 marks) |
| **Hrituparno C** | `hrituparno.c@kalvium.com` | `mentor` | **Technical Only** (30 marks) |

### Sample Student Accounts
| Candidate Name | Roll Number | Squad | Login Email |
| :--- | :--- | :--- | :--- |
| **Isha Agrawal** | `KAL116001` | Squad 116 | `isha.agrawal.s.116@kalvium.community` |
| **Aditya Talikoti** | `KAL116002` | Squad 116 | `aditya.talikoti.s.116@kalvium.community` |
| **Digvijay Patil** | `KAL116003` | Squad 116 | `digvijay.patil.s.116@kalvium.community` |
| **Aryan Patil** | `KAL116011` | Squad 116 | `aryan.patil.s.116@kalvium.community` |
| **Aayushman Shukla** | `KAL115001` | Squad 115 | `aayushman.shukla.s.115@kalvium.community` |
| **Prithvi Rajvanshi** | `KAL115002` | Squad 115 | `prithvi.rajvanshi.s.115@kalvium.community` |
| **Palakshi Verma** | `KAL115003` | Squad 115 | `palakshi.verma.s.115@kalvium.community` |

*(Note: Any new student who signs in with Google whose email is not in the system is automatically registered as a Student).*

---

## 2. Environment Variables Reference

Create a `.env` file in the project root:

```ini
# --- Server Environment ---
PORT=3000
NODE_ENV=development

# --- Session & Security Secret (Required in Production) ---
# Generate a strong 32+ char random secret (e.g. openssl rand -base64 32)
SESSION_SECRET=konfident-interview-2025-production-super-secret-key

# --- Google OAuth & Calendar Integration ---
# From Google Cloud Console -> APIs & Services -> Credentials
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret

# Optional: Exact override redirect URI. If omitted or running in production,
# the app dynamically derives this from the incoming request domain.
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/callback/google

# --- Neon Postgres Database (Production / Vercel) ---
# When deployed to Vercel or when DATABASE_URL is set, Postgres mode is active.
# Leave blank or unset to run on local high-performance SQLite engine (zero setup).
DATABASE_URL=postgresql://neondb_owner:YOUR_PASSWORD@ep-lively-mouse-78881067-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
DATABASE_URL_UNPOOLED=postgresql://neondb_owner:YOUR_PASSWORD@ep-lively-mouse-78881067.us-east-2.aws.neon.tech/neondb?sslmode=require
```

---

## 3. Google Cloud Console Setup (OAuth & Calendar API)

To enable **Sign in with Google** and **Automatic Google Calendar sync with Google Meet video links**:

### Step 3.1: Create Project & Enable APIs
1. Open the **[Google Cloud Console](https://console.cloud.google.com/)**.
2. Click the project dropdown at the top and click **New Project** (e.g. `Konfident-Interview-2025`).
3. Go to **APIs & Services** → **Library**.
4. Search for and **Enable** the following two APIs:
   - **Google Calendar API**
   - **Google People API** (or Google Identity)

### Step 3.2: Configure OAuth Consent Screen
1. Navigate to **APIs & Services** → **OAuth consent screen**.
2. Choose User Type:
   - **Internal** (if using Google Workspace / Kalvium domain accounts — best choice, bypasses Google review).
   - **External** (if testing with personal Gmail accounts; set Publishing status to *Testing* and add your email under *Test users*).
3. Fill in:
   - **App name**: `Konfident Interview 2025`
   - **User support email**: your email
   - **Developer contact information**: your email
4. Click **Save and Continue**.
5. Under **Scopes**, click **Add or Remove Scopes** and select:
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `openid`
   - `https://www.googleapis.com/auth/calendar.events` (for scheduling interviews)
6. Click **Save and Continue**.

### Step 3.3: Create OAuth 2.0 Web Credentials
1. Go to **APIs & Services** → **Credentials**.
2. Click **Create Credentials** → **OAuth client ID**.
3. Set **Application type**: `Web application`.
4. Set **Name**: `Konfident Web Client`.
5. Under **Authorized JavaScript origins**, add:
   ```
   http://localhost:3000
   https://<your-vercel-domain>.vercel.app
   https://<your-custom-domain.com>
   ```
6. Under **Authorized redirect URIs**, add all three valid variants (to guarantee zero redirect errors):
   ```
   http://localhost:3000/api/auth/callback/google
   http://localhost:3000/auth/google/callback
   https://<your-vercel-domain>.vercel.app/api/auth/callback/google
   https://<your-vercel-domain>.vercel.app/auth/google/callback
   https://<your-custom-domain.com>/api/auth/callback/google
   https://<your-custom-domain.com>/auth/google/callback
   ```
7. Click **Create**.
8. Copy the **Client ID** and **Client Secret** into your `.env` (and into Vercel Project Settings).

> [!TIP]
> **Production URL Helper Endpoint**:
> Open `https://<your-domain>/auth/google/debug` in your browser at any time. It inspects your live server and prints the exact list of URLs you need to paste into Google Cloud Console!

---

## 4. Local Development Setup (Quickstart)

1. **Clone repository & install dependencies**:
   ```bash
   npm install
   ```

2. **Initialize & seed local database**:
   ```bash
   # Seeds admin accounts, mentors, students, and calendar slots
   npm run seed:demo
   ```

3. **Start local server**:
   ```bash
   npm start
   ```
   Open `http://localhost:3000` in your browser.

4. **Verify tests**:
   ```bash
   npm test
   ```
   Runs 126 end-to-end security, role-based access, and concurrency tests.

---

## 5. Neon Cloud Database Setup (Production / PostgreSQL)

1. Create a free Postgres database at **[neon.tech](https://neon.tech/)**.
2. From your Neon dashboard, copy your **Connection String**:
   - Pooled connection (`...-pooler...`): Set as `DATABASE_URL`
   - Direct connection: Set as `DATABASE_URL_UNPOOLED`
3. Run the schema initializer to set up tables and seed demo accounts into Neon:
   ```bash
   node scratch/init-neon.js
   ```

---

## 6. Vercel Production Deployment

1. Import the repository into your **[Vercel Dashboard](https://vercel.com/)**.
2. Framework Preset: **Other** (Root directory: `./`).
3. Add the following **Environment Variables** in Vercel Project Settings:
   - `SESSION_SECRET`: Random 32+ character string.
   - `DATABASE_URL`: Your Neon pooled connection string.
   - `DATABASE_URL_UNPOOLED`: Your Neon direct connection string.
   - `GOOGLE_CLIENT_ID`: Your Google OAuth Client ID (strip any quotes).
   - `GOOGLE_CLIENT_SECRET`: Your Google OAuth Client Secret (strip any quotes).
   - *(Optional)* `GOOGLE_REDIRECT_URI`: `https://your-domain.vercel.app/api/auth/callback/google`.
4. Click **Deploy**.
5. Once deployed, visit `https://your-domain.vercel.app/auth/google/debug` to verify that your domain, protocol, and Google OAuth redirect URIs are active and healthy.
