'use strict';
/**
 * Konfident Interview 2025 — MongoDB Database Initializer & Seeder
 *
 *   node src/seed.js --clean   (npm run init / npm run clean-db)
 *     -> Pristine database: only the root administrator account. Zero mock data.
 *
 *   node src/seed.js --dev     (npm run seed)
 *     -> Kalvium demo cohort: staff admins, mentors, 40 candidates and a full
 *        week of open interview slots. Every account password is `pass123`.
 *
 *   node src/seed.js --empty
 *     -> Removes every document from every collection (including the admin).
 *
 *   node src/seed.js --test    (used by `npm test`)
 *     -> Same as --dev but guaranteed deterministic and silent-ish, so the
 *        integration suite always has an admin, a mentor and a student to log in.
 *
 * The seeder is destructive: it clears the collections it manages before
 * re-seeding. It refuses to run against a database that is not obviously local
 * unless SEED_ALLOW_REMOTE=1 is set.
 */
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const h = require('./helpers');
const {
  User, Slot, Interview, Evaluation, StudentFeedback, AuditLog, PasswordReset, Setting,
} = require('./models');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/konfident';

const argv = process.argv.slice(2);
let mode = 'dev';
if (argv.includes('--empty') || process.env.SEED_MODE === 'empty') mode = 'empty';
else if (argv.includes('--clean') || process.env.SEED_MODE === 'clean') mode = 'clean';
else if (argv.includes('--test') || process.env.SEED_MODE === 'test') mode = 'test';
else if (argv.includes('--dev') || process.env.SEED_MODE === 'dev') mode = 'dev';

const adminEmail = (process.env.ADMIN_EMAIL || 'admin@konfident.edu').toLowerCase().trim();
const adminName = process.env.ADMIN_NAME || 'Head Administrator';
let adminPassword = process.env.ADMIN_PASSWORD;
let generatedAdminPw = false;
if (mode === 'dev' || mode === 'test') {
  adminPassword = adminPassword || 'pass123';
} else if (mode === 'clean' && !adminPassword) {
  adminPassword = crypto.randomBytes(12).toString('base64url');
  generatedAdminPw = true;
}

function isLocalUri(uri) {
  return /(?:@|\/\/)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(uri) ||
    /mongodb:\/\/(?:localhost|127\.0\.0\.1)/i.test(uri);
}

const kalviumAdmins = [
  { name: 'Utkarsha Kasar', email: 'utkarsha.kasar@kalvium.com' },
  { name: 'Prachi Sharma', email: 'prachi.sharma@kalvium.com' },
  { name: 'Ashish Suresh', email: 'ashish.suresh@kalvium.com' },
  { name: 'Akshata Sanap', email: 'akshata.sanap@kalvium.com', can_hr: 1 },
];

const kalviumMentors = [
  { name: 'Manav Verma', email: 'manav.verma@kalvium.com', can_technical: 1 },
  { name: 'Muskan Srivastava', email: 'muskan.srivastava@kalvium.com', can_hr: 1 },
  { name: 'Ritu Soni', email: 'ritu.soni@kalvium.com', can_technical: 1 },
  { name: 'Shikhar Agarwal', email: 'shikhar.agarwal@kalvium.com', can_technical: 1 },
  { name: 'Aditya Kulshreshtha', email: 'aditya.kulshreshtha@kalvium.com', can_technical: 1 },
  { name: 'Sneha Kulkarni', email: 'sneha.kulkarni@kalvium.com', can_hr: 1 },
  { name: 'Arjun Mehta', email: 'arjun.mehta@kalvium.com', can_technical: 1, can_hr: 1 },
];

function makeStudents() {
  const out = [];
  const squads = [['116', 18], ['115', 22]];
  const firsts = ['Isha', 'Aditya', 'Digvijay', 'Anisha', 'Areesh', 'Kanishka', 'Shubham', 'Yashraj',
    'Aryan', 'Om', 'Gauri', 'Avadhut', 'Riddhima', 'Hardik', 'Tejas', 'Khushal', 'Aayushman', 'Prithvi',
    'Palakshi', 'Ruhaa', 'Pratite', 'Shriram', 'Varad', 'Raina', 'Shaurya', 'Aadi', 'Parnil', 'Atharv',
    'Sasmit', 'Rakshaad', 'Sohini', 'Rishikesh', 'Vinayak', 'Gitesh', 'Devansh', 'Aamir', 'Shruti',
    'Manas', 'Kavya', 'Nikhil'];
  const lasts = ['Agrawal', 'Talikoti', 'Patil', 'Ahmed', 'Girnar', 'Reddy', 'Jagtap', 'Lonkar', 'Mhetre',
    'Pawar', 'Sinhal', 'Kaurani', 'Pujari', 'Rajput', 'Shukla', 'Rajvanshi', 'Verma', 'Bhalerao',
    'Acharya', 'Awchar', 'Shahane', 'George', 'Undre', 'Jain', 'Vyawhare', 'Hargude', 'Narnaware',
    'Kolhe', 'Tandon', 'Bagal', 'Kulkarni', 'Chaudhari', 'Itkalkar'];
  let n = 0;
  for (const [squad, count] of squads) {
    for (let i = 1; i <= count; i++) {
      const first = firsts[n % firsts.length];
      const last = lasts[n % lasts.length];
      const roll = `KAL${squad}${String(i).padStart(3, '0')}`;
      out.push({
        name: `${first} ${last}`,
        email: `${first}.${last}.s.${squad}@kalvium.community`.toLowerCase(),
        roll_no: roll,
        squad,
        branch: 'CSE',
        phone: '+91 98765 43210',
        resume_url: `https://drive.google.com/file/d/${roll}/view`,
      });
      n++;
    }
  }
  return out;
}

async function clearManagedCollections() {
  await Promise.all([
    User.deleteMany({}),
    Slot.deleteMany({}),
    Interview.deleteMany({}),
    Evaluation.deleteMany({}),
    StudentFeedback.deleteMany({}),
    AuditLog.deleteMany({}),
    PasswordReset.deleteMany({}),
    Setting.deleteMany({}),
  ]);
}

async function seed() {
  if (!isLocalUri(MONGODB_URI) && process.env.SEED_ALLOW_REMOTE !== '1') {
    console.error(
      'Refusing to seed: MONGODB_URI does not look like a local database.\n' +
      'This wipes every collection. If you really mean to, re-run with SEED_ALLOW_REMOTE=1.'
    );
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  const host = mongoose.connection.host || 'localhost';

  await clearManagedCollections();

  const pwHash = bcrypt.hashSync(mode === 'clean' ? adminPassword : 'pass123', 10);
  const adminPwHash = bcrypt.hashSync(adminPassword, 10);

  // Root administrator — present in every non-empty mode.
  if (mode !== 'empty') {
    await User.create({
      name: adminName,
      email: adminEmail,
      password_hash: adminPwHash,
      role: 'admin',
      active: 1,
    });
  }

  let mentorDocs = [];
  let studentDocs = [];

  if (mode === 'dev' || mode === 'test') {
    for (const a of kalviumAdmins) {
      await User.create({
        name: a.name,
        email: a.email.toLowerCase(),
        password_hash: pwHash,
        role: 'admin',
        can_technical: a.can_technical || 0,
        can_hr: a.can_hr || 0,
        active: 1,
      });
    }

    mentorDocs = await User.insertMany(kalviumMentors.map((m) => ({
      name: m.name,
      email: m.email.toLowerCase(),
      password_hash: pwHash,
      role: 'mentor',
      phone: '+91 90000 00000',
      can_technical: m.can_technical || 0,
      can_hr: m.can_hr || 0,
      active: 1,
    })));

    studentDocs = await User.insertMany(makeStudents().map((s) => ({
      name: s.name,
      email: s.email,
      password_hash: pwHash,
      role: 'student',
      roll_no: s.roll_no,
      squad: s.squad,
      branch: s.branch,
      phone: s.phone,
      resume_url: s.resume_url,
      active: 1,
    })));

    // A full week of open slots (yesterday .. +6 days) for every mentor.
    const techTimes = ['09:00', '09:45', '10:30', '11:15', '12:00'];
    const hrTimes = ['14:00', '14:45', '15:30', '16:15', '17:00'];
    const addMin = (t, m) => {
      const [hh, mm] = t.split(':').map(Number);
      const tot = hh * 60 + mm + m;
      return `${String(Math.floor(tot / 60)).padStart(2, '0')}:${String(tot % 60).padStart(2, '0')}`;
    };
    const start = h.addDays(h.today(), -1);
    const slotsToInsert = [];
    for (let d = 0; d < 8; d++) {
      const date = h.addDays(start, d);
      for (const m of mentorDocs) {
        if (m.can_technical) {
          for (const t of techTimes) {
            slotsToInsert.push({
              mentor_id: m._id, type: 'technical', slot_date: date,
              start_time: t, end_time: addMin(t, 40), mode: 'Online',
              location: h.generateMeetingLink('technical'), status: 'open',
            });
          }
        }
        if (m.can_hr) {
          for (const t of hrTimes) {
            slotsToInsert.push({
              mentor_id: m._id, type: 'hr', slot_date: date,
              start_time: t, end_time: addMin(t, 40), mode: 'Online',
              location: h.generateMeetingLink('hr'), status: 'open',
            });
          }
        }
      }
    }
    await Slot.insertMany(slotsToInsert);
  }

  // Reporting.
  const [users, admins, mentors, students, openSlots] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ role: 'admin' }),
    User.countDocuments({ role: 'mentor' }),
    User.countDocuments({ role: 'student' }),
    Slot.countDocuments({ status: 'open' }),
  ]);

  if (mode === 'clean') {
    const pwLine = generatedAdminPw
      ? `Password:    ${adminPassword}\n  (auto-generated — save it now, it is not stored anywhere else)`
      : `Password:    ${adminPassword}`;
    console.log(`
  =============================================================
  [Clean Production Database Initialized — MongoDB @ ${host}]
  =============================================================
  Root Admin:  ${adminEmail}
  ${pwLine}

  Users: ${users}   Students: ${students}   Mentors: ${mentors}   Open slots: ${openSlots}
  =============================================================
  Sign in, then change this password at /profile.
  =============================================================
`);
  } else if (mode === 'empty') {
    console.log(`
  =============================================================
  [Database Emptied — MongoDB @ ${host}]
  All managed collections cleared (users, slots, interviews,
  evaluations, feedback, audit logs, password resets, settings).
  =============================================================
`);
  } else {
    console.log(`
  =============================================================
  [${mode === 'test' ? 'Test' : 'Development'} Dataset Initialized — MongoDB @ ${host}]
  =============================================================
  Every account password: pass123

  Admins:   ${admins}   (root: ${adminEmail})
  Mentors:  ${mentors}
  Students: ${students}
  Open interview slots: ${openSlots}
  =============================================================
`);
  }

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('Seeding failed:', err && err.message ? err.message : err);
  process.exit(1);
});
