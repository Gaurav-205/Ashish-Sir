'use strict';
require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');

const sql = neon(process.env.DATABASE_URL);

function addDays(dStr, days) {
  const d = new Date(dStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

async function seedFullNeon() {
  console.log('--- Initializing & Seeding Neon Database (neondb) ---');
  console.log('Endpoint:', process.env.DATABASE_URL.split('@')[1]);

  // 1. Create Schema
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          TEXT    NOT NULL,
      email         TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL CHECK (role IN ('admin','mentor','student')),
      phone         TEXT,
      roll_no       TEXT,
      branch        TEXT,
      squad         TEXT,
      resume_url    TEXT,
      can_technical INTEGER NOT NULL DEFAULT 0,
      can_hr        INTEGER NOT NULL DEFAULT 0,
      active        INTEGER NOT NULL DEFAULT 1,
      google_id     TEXT UNIQUE,
      google_access_token TEXT,
      google_refresh_token TEXT,
      google_token_expiry BIGINT,
      google_calendar_enabled INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS slots (
      id            SERIAL PRIMARY KEY,
      mentor_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type          TEXT    NOT NULL CHECK (type IN ('technical','hr')),
      slot_date     TEXT    NOT NULL,
      start_time    TEXT    NOT NULL,
      end_time      TEXT    NOT NULL,
      mode          TEXT    NOT NULL DEFAULT 'Online',
      location      TEXT,
      status        TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','booked','cancelled')),
      created_at    TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
      UNIQUE (mentor_id, slot_date, start_time)
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS interviews (
      id            SERIAL PRIMARY KEY,
      student_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mentor_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slot_id       INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
      type          TEXT    NOT NULL CHECK (type IN ('technical','hr')),
      status        TEXT    NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','completed','cancelled')),
      attendance    TEXT    NOT NULL DEFAULT 'pending' CHECK (attendance IN ('pending','attended','absent')),
      attendance_marked_at TEXT,
      google_event_id TEXT,
      booked_at     TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
      completed_at  TEXT
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS evaluations (
      id             SERIAL PRIMARY KEY,
      interview_id   INTEGER NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
      mentor_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resume_marks   INTEGER,
      project_marks  INTEGER,
      dsa_marks      INTEGER,
      behaviour_marks INTEGER,
      hr_perf_marks   INTEGER,
      total          INTEGER NOT NULL,
      feedback       TEXT,
      submitted_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS student_feedbacks (
      id             SERIAL PRIMARY KEY,
      interview_id   INTEGER NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
      student_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mentor_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      satisfaction   INTEGER NOT NULL CHECK (satisfaction BETWEEN 1 AND 5),
      structured     INTEGER NOT NULL CHECK (structured IN (0, 1)),
      hr_relevant    INTEGER CHECK (hr_relevant IN (0, 1)),
      feedback_text  TEXT,
      submitted_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
    );
  `;

  console.log('✓ All 7 tables verified in Neon DB');

  const PW = bcrypt.hashSync('pass123', 10);

  // 2. Admins
  const kalviumAdmins = [
    { name: 'Utkarsha Kasar', email: 'utkarsha.kasar@kalvium.com', can_t: 0, can_hr: 0 },
    { name: 'Prachi Sharma', email: 'prachi.sharma@kalvium.com', can_t: 0, can_hr: 0 },
    { name: 'Ashish Suresh', email: 'ashish.suresh@kalvium.com', can_t: 0, can_hr: 0 },
    { name: 'Akshata Sanap', email: 'akshata.sanap@kalvium.com', can_t: 0, can_hr: 1 },
  ];

  await Promise.all(kalviumAdmins.map(a => sql`
    INSERT INTO users (name, email, password_hash, role, phone, can_technical, can_hr)
    VALUES (${a.name}, ${a.email.toLowerCase()}, ${PW}, 'admin', '+91 98000 00000', ${a.can_t}, ${a.can_hr})
    ON CONFLICT (email) DO NOTHING;
  `));
  console.log('✓ Kalvium Admin accounts seeded (4)');

  // 3. Mentors
  const kalviumMentors = [
    { name: 'Manav Verma', email: 'manav.verma@kalvium.com', can_t: 1, can_hr: 0 },
    { name: 'Muskan Srivastava', email: 'muskan.srivastava@kalvium.com', can_t: 0, can_hr: 1 },
    { name: 'Ritu Soni', email: 'ritu.soni@kalvium.com', can_t: 1, can_hr: 0 },
    { name: 'Shikhar Agarwal', email: 'shikhar.agarwal@kalvium.com', can_t: 1, can_hr: 0 },
    { name: 'Shivam Shrivastava', email: 'shivam.shrivastava@kalvium.com', can_t: 1, can_hr: 0 },
    { name: 'Aditya Kulshreshtha', email: 'aditya.kulshreshtha@kalvium.com', can_t: 1, can_hr: 0 },
    { name: 'Hrituparno C', email: 'hrituparno.c@kalvium.com', can_t: 1, can_hr: 0 },
  ];

  await Promise.all(kalviumMentors.map(m => sql`
    INSERT INTO users (name, email, password_hash, role, can_technical, can_hr)
    VALUES (${m.name}, ${m.email.toLowerCase()}, ${PW}, 'mentor', ${m.can_t}, ${m.can_hr})
    ON CONFLICT (email) DO NOTHING;
  `));
  console.log('✓ Kalvium Mentor accounts seeded (7)');

  // 4. Students (40)
  const kalviumStudents = [
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

  await Promise.all(kalviumStudents.map(st => sql`
    INSERT INTO users (name, email, password_hash, role, roll_no, branch, squad)
    VALUES (${st.name}, ${st.email}, ${PW}, 'student', ${st.roll_no}, 'CSE', ${st.squad})
    ON CONFLICT (email) DO NOTHING;
  `));
  console.log('✓ Kalvium Candidate accounts seeded (40)');

  // 5. Open Slots
  const mentors = await sql`SELECT * FROM users WHERE role='mentor' OR can_technical=1 OR can_hr=1;`;
  const today = todayStr();
  const tomorrow = addDays(today, 1);
  const dayAfter = addDays(today, 2);

  const slotPromises = [];
  for (let idx = 0; idx < mentors.length; idx++) {
    const m = mentors[idx];
    const timeOffset = (idx % 4) * 30;
    const sh = 10 + Math.floor(timeOffset / 60);
    const sm = timeOffset % 60;
    const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    const sTime = fmt(sh * 60 + sm);
    const eTime = fmt(sh * 60 + sm + 30);

    if (m.can_technical) {
      slotPromises.push(sql`
        INSERT INTO slots (mentor_id, type, slot_date, start_time, end_time, mode, location)
        VALUES (${m.id}, 'technical', ${tomorrow}, ${sTime}, ${eTime}, 'Online', 'https://meet.google.com/abc-defg-hij')
        ON CONFLICT DO NOTHING;
      `);
    }
    if (m.can_hr) {
      slotPromises.push(sql`
        INSERT INTO slots (mentor_id, type, slot_date, start_time, end_time, mode, location)
        VALUES (${m.id}, 'hr', ${dayAfter}, ${sTime}, ${eTime}, 'Online', 'https://meet.google.com/xyz-uvwx-rst')
        ON CONFLICT DO NOTHING;
      `);
    }
  }
  await Promise.all(slotPromises);
  console.log('✓ Available upcoming slots seeded for mentors');

  // Summary
  const usersCount = await sql`SELECT COUNT(*) FROM users;`;
  const slotsCount = await sql`SELECT COUNT(*) FROM slots;`;
  const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';`;

  console.log('\n=============================================================');
  console.log('  [Neon Database Fully Seeded — Kalvium Cohort 2025]');
  console.log('=============================================================');
  console.log('  Live Tables:', tables.map(t => t.table_name).join(', '));
  console.log('  Total Users: ', usersCount[0].count);
  console.log('  Open Slots:  ', slotsCount[0].count);
  console.log('  Default Pass: pass123');
  console.log('=============================================================\n');
}

seedFullNeon().catch(err => {
  console.error('Neon seed error:', err);
  process.exit(1);
});
