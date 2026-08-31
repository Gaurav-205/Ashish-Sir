'use strict';
/**
 * Konfident Interview 2025 — Database Initializer & Seeder
 * 
 * 1. Development Mode (npm run seed / npm run seed:dev):
 *    -> Seeds exactly 1 account of each type (Admin, Technical Mentor, HR Mentor, Dual Mentor, Student)
 *       plus fresh upcoming calendar slots.
 * 
 * 2. Clean Production Mode (npm run init / npm run clean-db):
 *    -> Initializes pristine database with only the Root Administrator account. Zero mock records.
 * 
 * 3. Test Mode (npm test):
 *    -> Populates automated test cohort.
 */
const bcrypt = require('bcryptjs');
const db = require('./db');
const h = require('./helpers');

const isCleanArg = process.argv.includes('--clean');
const isEmptyArg = process.argv.includes('--empty');
const isDevArg = process.argv.includes('--dev');

let mode = 'dev';
if (isEmptyArg || process.env.SEED_MODE === 'empty') {
  mode = 'empty';
} else if (isCleanArg || process.env.SEED_MODE === 'clean') {
  mode = 'clean';
} else if (process.env.DB_PATH && process.env.DB_PATH.includes('test.db')) {
  mode = 'test';
} else if (process.env.SEED_MODE) {
  mode = process.env.SEED_MODE;
}
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const adminEmail = process.env.ADMIN_EMAIL || 'utkarsha.kasar@kalvium.com';
let adminPassword = process.env.ADMIN_PASSWORD;
let isGenerated = false;
if (mode === 'test') {
  adminPassword = 'pass123';
} else if (!adminPassword) {
  if (mode === 'dev') {
    adminPassword = 'pass123';
  } else {
    adminPassword = crypto.randomBytes(12).toString('base64url');
    isGenerated = true;
  }
}
const adminName = process.env.ADMIN_NAME || 'Utkarsha Kasar';
const PW = bcrypt.hashSync(adminPassword, 10);

// Clear existing tables. student_feedbacks and password_resets cascade from
// interviews/users, but are named explicitly so the intent is not implicit.
db.exec(`DELETE FROM student_feedbacks; DELETE FROM evaluations; DELETE FROM interviews; DELETE FROM slots;
         DELETE FROM password_resets; DELETE FROM users; DELETE FROM audit_logs; DELETE FROM settings;`);
if (!db.isPostgres) {
  try {
    db.exec(`DELETE FROM sqlite_sequence WHERE name IN
             ('users','slots','interviews','evaluations','student_feedbacks','password_resets','audit_logs');`);
  } catch (_) { /* sqlite_sequence only exists once an AUTOINCREMENT table has rows */ }
}

// Clear session store if exists
try {
  const sessionsDbPath = path.join(__dirname, '..', 'data', 'sessions.db');
  if (fs.existsSync(sessionsDbPath)) {
    const { DatabaseSync } = require('node:sqlite');
    const sdb = new DatabaseSync(sessionsDbPath);
    sdb.exec('DELETE FROM sessions;');
    sdb.close();
  }
} catch (_) {}

const addUser = db.prepare(`INSERT INTO users
  (name,email,password_hash,role,phone,roll_no,branch,squad,resume_url,can_technical,can_hr)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

// 1. Administrator accounts.
//    'clean' provisions exactly one root administrator (the account named by
//    ADMIN_EMAIL) so a production install starts with no unexpected logins.
//    'dev' and 'test' additionally provision the Kalvium staff cohort.
if (mode === 'dev' || mode === 'test') {
  const kalviumAdmins = [
    { name: 'Utkarsha Kasar', email: 'utkarsha.kasar@kalvium.com', can_t: 0, can_hr: 0 },
    { name: 'Prachi Sharma', email: 'prachi.sharma@kalvium.com', can_t: 0, can_hr: 0 },
    { name: 'Ashish Suresh', email: 'ashish.suresh@kalvium.com', can_t: 0, can_hr: 0 },
    { name: 'Arvind', email: 'arvind@kalvium.com', can_t: 0, can_hr: 0, is_dev: 1 },
    { name: 'Akshata Sanap', email: 'akshata.sanap@kalvium.com', can_t: 0, can_hr: 1 },
    { name: 'Gaurav Khandelwal', email: 'gauravkhandelwal205@gmail.com', can_t: 0, can_hr: 0, is_dev: 1 },
    { name: 'Heramb Inamke', email: 'heramb15012006@gmail.com', can_t: 0, can_hr: 0, is_dev: 1 },
    { name: 'Test User', email: 'test@user.com', password: 'test@1501', can_t: 1, can_hr: 1, is_dev: 1 },
  ];

  kalviumAdmins.forEach((a) => {
    try {
      const pHash = a.password ? bcrypt.hashSync(a.password, 10) : PW;
      addUser.run(a.name, a.email.toLowerCase(), pHash, 'admin', '+91 98000 00000', null, null, null, null, a.can_t, a.can_hr);
      if (a.is_dev) {
        db.prepare(`UPDATE users SET is_developer = 1, can_technical = 0, can_hr = 0 WHERE lower(email) = ?`).run(a.email.toLowerCase());
      }
    } catch (_) {}
  });
}

if (mode !== 'empty') {
  // Guarantee the configured root administrator exists in every non-empty mode.
  const rootExists = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(adminEmail.toLowerCase());
  if (!rootExists) {
    addUser.run(adminName, adminEmail.toLowerCase(), PW, 'admin', null, null, null, null, null, 0, 0);
  }
}

// 2. Kalvium Mentor Accounts (Strict Tech vs Non-Tech segregation)
const kalviumMentors = [
  { name: 'Manav Verma', email: 'manav.verma@kalvium.com', can_t: 1, can_hr: 0 },
  { name: 'Muskan Srivastava', email: 'muskan.srivastava@kalvium.com', can_t: 0, can_hr: 1 },
  { name: 'Ritu Soni', email: 'ritu.soni@kalvium.com', can_t: 1, can_hr: 0 },
  { name: 'Shikhar Agarwal', email: 'shikhar.agarwal@kalvium.com', can_t: 1, can_hr: 0 },
  { name: 'Shivam Shrivastava', email: 'shivam.shrivastava@kalvium.com', can_t: 1, can_hr: 0 },
  { name: 'Aditya Kulshreshtha', email: 'aditya.kulshreshtha@kalvium.com', can_t: 1, can_hr: 0 },
  { name: 'Hrituparno C', email: 'hrituparno.c@kalvium.com', can_t: 1, can_hr: 0 },
];

const kalviumStudents = [
  // Squad 116 (18 candidates)
  { name: 'Isha Agrawal', email: 'isha.agrawal.s.116@kalvium.community', squad: '116', roll_no: 'KAL116001' },
  { name: 'Aditya Talikoti', email: 'aditya.talikoti.s.116@kalvium.community', squad: '116', roll_no: 'KAL116002' },
  { name: 'Digvijay Patil', email: 'digvijay.patil.s.116@kalvium.community', squad: '116', roll_no: 'KAL116003' },
  { name: 'Anisha Santosh Agrawal', email: 'anisha.agrawal.s.116@kalvium.community', squad: '116', roll_no: 'KAL116004' },
  { name: 'Areesh Ahmed', email: 'areesh.ahmed.s.116@kalvium.community', squad: '116', roll_no: 'KAL116005' },
  { name: 'Kanishka Nishchal Girnar', email: 'kanishka.girnar.s.116@kalvium.community', squad: '116', roll_no: 'KAL116006' },
  { name: 'Aditya Sudhir Nagane', email: 'aditya.nagane.s.116@kalvium.community', squad: '116', roll_no: 'KAL116007' },
  { name: 'Shubham Uddhav Reddy', email: 'shubham.reddy.s.116@kalvium.community', squad: '116', roll_no: 'KAL116008' },
  { name: 'Yashwardhan Santosh Chaudhari', email: 'yashwardhan.chaudhari.s.116@kalvium.community', squad: '116', roll_no: 'KAL116009' },
  { name: 'Yashraj Jagtap', email: 'yashraj.jagtap.s.116@kalvium.community', squad: '116', roll_no: 'KAL116010' },
  { name: 'Aryan Patil', email: 'aryan.patil.s.116@kalvium.community', squad: '116', roll_no: 'KAL116011' },
  { name: 'Om Lonkar', email: 'om.lonkar.s.116@kalvium.community', squad: '116', roll_no: 'KAL116012' },
  { name: 'Gauri Mhetre', email: 'gauri.mhetre.s.116@kalvium.community', squad: '116', roll_no: 'KAL116013' },
  { name: 'Avadhut Murlidhar Pawar', email: 'avadhut.pawar.s.116@kalvium.community', squad: '116', roll_no: 'KAL116014' },
  { name: 'Riddhima Sinhal', email: 'riddhima.sinhal.s.116@kalvium.community', squad: '116', roll_no: 'KAL116015' },
  { name: 'Hardik Kaurani', email: 'hardik.kaurani.s.116@kalvium.community', squad: '116', roll_no: 'KAL116016' },
  { name: 'Tejas Vijaykumar Pujari', email: 'tejas.pujari.s.116@kalvium.com', squad: '116', roll_no: 'KAL116017' },
  { name: 'Khushal Rajput', email: 'khushal.rajput.s.116@kalvium.community', squad: '116', roll_no: 'KAL116018' },

  // Squad 115 (22 candidates)
  { name: 'Aayushman Shukla', email: 'aayushman.shukla.s.115@kalvium.community', squad: '115', roll_no: 'KAL115001' },
  { name: 'Prithvi Rajvanshi', email: 'prithvi.rajvanshi.s.115@kalvium.community', squad: '115', roll_no: 'KAL115002' },
  { name: 'Palakshi Verma', email: 'palakshi.verma.s.115@kalvium.community', squad: '115', roll_no: 'KAL115003' },
  { name: 'Ruhaa Bhalerao', email: 'ruhaa.bhalerao.s.115@kalvium.community', squad: '115', roll_no: 'KAL115004' },
  { name: 'Pratite Acharya', email: 'pratite.a.s.115@kalvium.community', squad: '115', roll_no: 'KAL115005' },
  { name: 'Ayush Shriam Awchar', email: 'shriram.awchar.s.115@kalvium.community', squad: '115', roll_no: 'KAL115006' },
  { name: 'varad shahane', email: 'varad.shahane.s.115@kalvium.community', squad: '115', roll_no: 'KAL115007' },
  { name: 'Raina George', email: 'raina.george.s.115@kalvium.community', squad: '115', roll_no: 'KAL115008' },
  { name: 'Shauryvardhan Dadasaheb Undre', email: 'shauryvardhan.undre.s.115@kalvium.community', squad: '115', roll_no: 'KAL115009' },
  { name: 'Om Jagtap', email: 'om.jagtap.s.115@kalvium.community', squad: '115', roll_no: 'KAL115010' },
  { name: 'Aadi Jain', email: 'aadi.jain.s.115@kalvium.community', squad: '115', roll_no: 'KAL115011' },
  { name: 'Parnil Vyawhare', email: 'parnil.vyawahare.s.115@kalvium.community', squad: '115', roll_no: 'KAL115012' },
  { name: 'Atharv Nitin Hargude', email: 'atharv.hargude.s.115@kalvium.community', squad: '115', roll_no: 'KAL115013' },
  { name: 'Sasmit Narnaware', email: 'sasmit.narnaware.s.115@kalvium.community', squad: '115', roll_no: 'KAL115014' },
  { name: 'Rakshaad Ashok Kolhe', email: 'rakshaad.kolhe.s.115@kalvium.community', squad: '115', roll_no: 'KAL115015' },
  { name: 'Sohini Tandon', email: 'sohini.tandon.s.115@kalvium.community', squad: '115', roll_no: 'KAL115016' },
  { name: 'Rishikesh Bagal', email: 'rishikesh.bagal.s.115@kalvium.community', squad: '115', roll_no: 'KAL115017' },
  { name: 'vinayak kulkarni', email: 'vinayak.kulkarni.s.115@kalvium.community', squad: '115', roll_no: 'KAL115018' },
  { name: 'Gitesh Makunda Chaudhari', email: 'gitesh.c.s.115@kalvium.community', squad: '115', roll_no: 'KAL115019' },
  { name: 'Devansh Subhash Pujari', email: 'devansh.pujari.s.115@kalvium.community', squad: '115', roll_no: 'KAL115020' },
  { name: 'Mohammad Aamir Patloo', email: 'mohammad.patloo.s.115@kalvium.community', squad: '115', roll_no: 'KAL115021' },
  { name: 'Shruti Shardul Itkalkar', email: 'shruti.itkalkar.s.115@kalvium.community', squad: '115', roll_no: 'KAL115022' }
];

if (mode === 'test') {
  // Test suite fixture: Kalvium Mentors + Fallback Test Mentors
  kalviumMentors.forEach((m) => {
    try {
      addUser.run(m.name, m.email.toLowerCase(), PW, 'mentor', null, null, null, null, null, m.can_t, m.can_hr);
    } catch (_) {}
  });

  const fallbackTestMentors = [
    ['Arjun Mehta',    'arjun.mentor@konfident.in',  1, 0],
    ['Sneha Kulkarni', 'sneha.mentor@konfident.in',  0, 1],
  ];
  fallbackTestMentors.forEach(([name, email, t, hr]) => {
    try { addUser.run(name, email, PW, 'mentor', null, null, null, null, null, t, hr); } catch (_) {}
  });

  const mentors = db.prepare(`SELECT * FROM users WHERE role='mentor' OR can_technical=1 OR can_hr=1`).all();

  const students = kalviumStudents.map((st) => {
    addUser.run(st.name, st.email, PW, 'student', '+91 98765 43210', st.roll_no, 'CSE', st.squad,
      `https://example.com/resumes/${st.roll_no}.pdf`, 0, 0);
    return db.prepare('SELECT * FROM users WHERE email=?').get(st.email);
  });

  const addSlot = db.prepare(`INSERT INTO slots (mentor_id,type,slot_date,start_time,end_time,mode,location)
                              VALUES (?,?,?,?,?,?,?)`);
  const start = h.addDays(h.today(), -2);
  const techTimes = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30'];
  const hrTimes = ['14:00', '14:30', '15:00', '15:30', '16:00', '16:30'];
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  for (let d = 0; d < 7; d++) {
    const date = h.addDays(start, d);
    for (const m of mentors) {
      if (m.can_technical) {
        for (const t of techTimes) {
          const [hh, mm] = t.split(':').map(Number);
          const s = hh * 60 + mm;
          try { addSlot.run(m.id, 'technical', date, t, fmt(s + 30), 'Online', h.generateMeetingLink('technical')); } catch (_) {}
        }
      }
      if (m.can_hr) {
        for (const t of hrTimes) {
          const [hh, mm] = t.split(':').map(Number);
          const s = hh * 60 + mm;
          try { addSlot.run(m.id, 'hr', date, t, fmt(s + 30), 'Online', h.generateMeetingLink('hr')); } catch (_) {}
        }
      }
    }
  }

  const addInterview = db.prepare(`INSERT INTO interviews (student_id,mentor_id,slot_id,type,status,attendance,completed_at,attendance_marked_at)
                                   VALUES (?,?,?,?,?,?,?,?)`);
  const addEval = db.prepare(`INSERT INTO evaluations
    (interview_id,mentor_id,resume_marks,project_marks,dsa_marks,behaviour_marks,hr_perf_marks,total,feedback)
    VALUES (?,?,?,?,?,?,?,?,?)`);

  function book(student, type, past) {
    const when = past
      ? `(slot_date || ' ' || end_time) < ?`
      : `(slot_date || ' ' || start_time) > ?`;
    const slots = db.prepare(`SELECT * FROM slots WHERE type=? AND status='open' AND ${when}
        ORDER BY slot_date ${past ? 'DESC' : 'ASC'}, start_time ASC`).all(type, h.nowMinute());
    for (const slot of slots) {
      const clash = db.prepare(`
        SELECT 1 FROM interviews i JOIN slots s2 ON s2.id = i.slot_id
         WHERE i.student_id = ? AND i.status <> 'cancelled'
           AND s2.slot_date = ? AND s2.start_time < ? AND s2.end_time > ?`)
        .get(student.id, slot.slot_date, slot.end_time, slot.start_time);
      if (!clash) {
        db.prepare(`UPDATE slots SET status='booked' WHERE id=?`).run(slot.id);
        const status = past ? 'completed' : 'booked';
        const attendance = past ? 'attended' : 'pending';
        const completedAt = past ? h.nowStamp() : null;
        addInterview.run(student.id, slot.mentor_id, slot.id, type, status, attendance, completedAt, completedAt);
        return db.prepare('SELECT * FROM interviews WHERE slot_id=?').get(slot.id);
      }
    }
    return null;
  }

  const rnd = (min, max, i) => min + ((i * 7 + 3) % (max - min + 1));
  students.forEach((st, i) => {
    if (i < 6) {
      const t = book(st, 'technical', true);
      const hr = book(st, 'hr', true);
      if (t) {
        const a = rnd(6, 10, i), b = rnd(5, 10, i + 1), c = rnd(4, 10, i + 2);
        addEval.run(t.id, t.mentor_id, a, b, c, null, null, a + b + c, 'Strong performance in DSA.');
      }
      if (hr) {
        const a = rnd(6, 10, i + 3), b = rnd(6, 10, i + 4);
        addEval.run(hr.id, hr.mentor_id, null, null, null, a, b, a + b, 'Good communication and clarity.');
      }
    } else if (i < 8) {
      const t = book(st, 'technical', true);
      if (t) {
        const a = rnd(5, 10, i), b = rnd(5, 10, i + 2), c = rnd(3, 10, i + 4);
        addEval.run(t.id, t.mentor_id, a, b, c, null, null, a + b + c, 'Good project depth.');
      }
      book(st, 'hr', false);
    } else if (i < 9) {
      book(st, 'technical', true);
      book(st, 'hr', false);
    } else if (i < 11) {
      book(st, 'technical', false);
      book(st, 'hr', false);
    }
  });
} else if (mode === 'dev' || process.env.SEED_DEV === 'true') {
  // Kalvium Mentors
  kalviumMentors.forEach((m) => {
    try {
      addUser.run(m.name, m.email.toLowerCase(), PW, 'mentor', null, null, null, null, null, m.can_t, m.can_hr);
    } catch (_) {}
  });

  // 40 Real Kalvium Candidates (Squads 115 & 116)
  kalviumStudents.forEach((st) => {
    try {
      addUser.run(st.name, st.email, PW, 'student', null, st.roll_no, 'CSE', st.squad, null, 0, 0);
    } catch (_) {}
  });
}

const c = (s) => db.prepare(s).get().c;
if (mode === 'dev') {
  let pwString = `Password for all accounts: ${adminPassword}`;
  if (isGenerated) {
    pwString = `⚠️  Auto-generated password for all accounts: ${adminPassword}\n  ⚠️  Save this now — it will not be shown again.\n  💡 Set ADMIN_PASSWORD env var to use your own password.`;
  }
  console.log(`
  =============================================================
  [Development Dataset Initialized — Kalvium Cohort 2025]
  =============================================================
  ${pwString}

  1. Kalvium Admin Accounts (4):
     • utkarsha.kasar@kalvium.com
     • prachi.sharma@kalvium.com
     • ashish.suresh@kalvium.com
     • akshata.sanap@kalvium.com (Admin & Non-Tech Evaluator)

  2. Kalvium Mentor Accounts (7):
     • manav.verma@kalvium.com (Tech)
     • muskan.srivastava@kalvium.com (Non-Tech / HR)
     • ritu.soni@kalvium.com (Tech)
     • shikhar.agarwal@kalvium.com (Tech)
     • shivam.shrivastava@kalvium.com (Tech)
     • aditya.kulshreshtha@kalvium.com (Tech)
     • hrituparno.c@kalvium.com (Tech)

  3. 40 Kalvium Candidate Accounts (Squads 115 & 116):
     • 18 Candidates in Squad 116 (e.g. isha.agrawal.s.116@kalvium.community)
     • 22 Candidates in Squad 115 (e.g. aayushman.shukla.s.115@kalvium.community)

  -------------------------------------------------------------
  Open Slots Generated: ${c("SELECT COUNT(*) c FROM slots WHERE status='open'")} available slots
  Total Accounts:       ${c('SELECT COUNT(*) c FROM users')} (${c("SELECT COUNT(*) c FROM users WHERE role='admin'")} Admins, ${c("SELECT COUNT(*) c FROM users WHERE role='mentor'")} Mentors, ${c("SELECT COUNT(*) c FROM users WHERE role='student'")} Students)
  =============================================================
  `);
} else if (mode === 'clean') {
  const credentials = isGenerated
    ? `Password:    ${adminPassword}\n  ⚠️  Auto-generated — save it now, it is not stored anywhere and will not be shown again.\n  💡 Set ADMIN_PASSWORD before running this command to choose your own.`
    : `Password:    ${adminPassword}`;
  console.log(`
  =============================================================
  [Clean Production Database Initialized]
  =============================================================
  Root Admin:  ${adminEmail}
  ${credentials}

  Users:       ${c('SELECT COUNT(*) c FROM users')}
  Students:    0
  Mentors:     0
  Slots:       0
  Interviews:  0
  Evaluations: 0
  =============================================================
  Sign in, then change this password at /profile#password.
  =============================================================
  `);
} else if (mode === 'empty') {
  console.log(`
  =============================================================
  [Database Emptied — All Records Cleared]
  =============================================================
  Users:       0
  Students:    0
  Mentors:     0
  Slots:       0
  Interviews:  0
  Evaluations: 0
  Audit Logs:  0
  Sessions:    Cleared
  =============================================================
  `);
}
