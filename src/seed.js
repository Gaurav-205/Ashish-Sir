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

const mode = process.env.SEED_MODE || (process.env.DB_PATH && process.env.DB_PATH.includes('test.db') ? 'test' : 'dev');
const crypto = require('crypto');

const adminEmail = process.env.ADMIN_EMAIL || 'admin@konfident.in';
let adminPassword = process.env.ADMIN_PASSWORD;
let isGenerated = false;
if (!adminPassword) {
  if (mode === 'test') {
    adminPassword = 'pass123';
  } else {
    adminPassword = crypto.randomBytes(12).toString('base64url');
    isGenerated = true;
  }
}
const adminName = process.env.ADMIN_NAME || 'Platform Administrator';
const PW = bcrypt.hashSync(adminPassword, 10);

// Clear existing tables
db.exec(`DELETE FROM evaluations; DELETE FROM interviews; DELETE FROM slots; DELETE FROM users; DELETE FROM audit_logs;
         DELETE FROM sqlite_sequence WHERE name IN ('users','slots','interviews','evaluations','audit_logs');`);

const addUser = db.prepare(`INSERT INTO users
  (name,email,password_hash,role,phone,roll_no,branch,resume_url,can_technical,can_hr)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);

// 1. Root Admin Account
addUser.run(adminName, adminEmail.trim().toLowerCase(), PW, 'admin', '+91 98000 00000', null, null, null, 0, 0);

if (mode === 'test') {
  // Test suite fixture
  const mentors = [
    ['Arjun Mehta',    'arjun.mentor@konfident.in',  1, 0],
    ['Priya Nair',     'priya.mentor@konfident.in',  1, 0],
    ['Rohit Sharma',   'rohit.mentor@konfident.in',  1, 1],
    ['Sneha Kulkarni', 'sneha.mentor@konfident.in',  0, 1],
    ['Imran Qureshi',  'imran.mentor@konfident.in',  0, 1],
  ].map(([name, email, t, hr]) => {
    addUser.run(name, email, PW, 'mentor', null, null, null, null, t, hr);
    return db.prepare('SELECT * FROM users WHERE email=?').get(email);
  });

  const studentData = [
    ['Aisha Khan',        'aisha@student.in',    'KON2025001', 'CSE'],
    ['Rahul Verma',       'rahul@student.in',    'KON2025002', 'CSE'],
    ['Meera Iyer',        'meera@student.in',    'KON2025003', 'IT'],
    ['Karan Singh',       'karan@student.in',    'KON2025004', 'ECE'],
    ['Divya Rao',         'divya@student.in',    'KON2025005', 'CSE'],
    ['Sahil Gupta',       'sahil@student.in',    'KON2025006', 'IT'],
    ['Nikita Joshi',      'nikita@student.in',   'KON2025007', 'CSE'],
    ['Aman Tiwari',       'aman@student.in',     'KON2025008', 'ECE'],
    ['Pooja Deshmukh',    'pooja@student.in',    'KON2025009', 'IT'],
    ['Vikram Chauhan',    'vikram@student.in',   'KON2025010', 'CSE'],
    ['Fatima Sheikh',     'fatima@student.in',   'KON2025011', 'CSE'],
    ['Harsh Patel',       'harsh@student.in',    'KON2025012', 'IT'],
  ];
  const students = studentData.map(([name, email, roll, branch]) => {
    addUser.run(name, email, PW, 'student', null, roll, branch,
      `https://example.com/resumes/${roll}.pdf`, 0, 0);
    return db.prepare('SELECT * FROM users WHERE email=?').get(email);
  });

  const addSlot = db.prepare(`INSERT INTO slots (mentor_id,type,slot_date,start_time,end_time,mode,location)
                              VALUES (?,?,?,?,?,?,?)`);
  const start = h.addDays(h.today(), -2);
  const times = ['10:00', '10:30', '11:00', '11:30', '14:00', '14:30'];
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  for (let d = 0; d < 7; d++) {
    const date = h.addDays(start, d);
    for (const m of mentors) {
      for (const t of times) {
        const [hh, mm] = t.split(':').map(Number);
        const s = hh * 60 + mm;
        if (m.can_technical) {
          try { addSlot.run(m.id, 'technical', date, t, fmt(s + 30), 'Online', 'https://meet.konfident.in/tech-' + m.id); } catch (_) {}
        }
        if (m.can_hr) {
          const s2 = s + 15;
          try { addSlot.run(m.id, 'hr', date, fmt(s2), fmt(s2 + 30), 'Online', 'https://meet.konfident.in/hr-' + m.id); } catch (_) {}
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
      ? `datetime(slot_date || ' ' || end_time) < datetime('now','localtime')`
      : `datetime(slot_date || ' ' || start_time) > datetime('now','localtime')`;
    const slot = db.prepare(`SELECT * FROM slots WHERE type=? AND status='open' AND ${when}
        ORDER BY slot_date ${past ? 'DESC' : 'ASC'}, start_time LIMIT 1`).get(type);
    if (!slot) return null;
    db.prepare(`UPDATE slots SET status='booked' WHERE id=?`).run(slot.id);
    const status = past ? 'completed' : 'booked';
    const attendance = past ? 'attended' : 'pending';
    const completedAt = past ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;
    addInterview.run(student.id, slot.mentor_id, slot.id, type, status, attendance, completedAt, completedAt);
    return db.prepare('SELECT * FROM interviews WHERE slot_id=?').get(slot.id);
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
  // Exactly 1 account of each role
  // 2. Technical Mentor
  addUser.run('Arjun Mehta (Tech Mentor)', 'tech.mentor@konfident.in', PW, 'mentor', '+91 98111 11111', null, null, null, 1, 0);

  // 3. HR Mentor
  addUser.run('Sneha Kulkarni (HR Mentor)', 'hr.mentor@konfident.in', PW, 'mentor', '+91 98222 22222', null, null, null, 0, 1);

  // 4. Dual-Skill Mentor (Technical + HR)
  addUser.run('Rohit Sharma (Tech & HR)', 'mentor@konfident.in', PW, 'mentor', '+91 98333 33333', null, null, null, 1, 1);

  // 5. Student Account
  addUser.run('Aisha Khan', 'student@konfident.in', PW, 'student', '+91 98444 44444', 'KON2025001', 'CSE',
    'https://drive.google.com/sample-resume.pdf', 0, 0);

  // Seed sample available slots for tomorrow and the upcoming week
  const addSlot = db.prepare(`INSERT INTO slots (mentor_id,type,slot_date,start_time,end_time,mode,location)
                              VALUES (?,?,?,?,?,?,?)`);
  
  const techMentor = db.prepare('SELECT id FROM users WHERE email=?').get('tech.mentor@konfident.in');
  const hrMentor = db.prepare('SELECT id FROM users WHERE email=?').get('hr.mentor@konfident.in');
  const dualMentor = db.prepare('SELECT id FROM users WHERE email=?').get('mentor@konfident.in');

  const tomorrow = h.addDays(h.today(), 1);
  const dayAfter = h.addDays(h.today(), 2);
  const day3 = h.addDays(h.today(), 3);

  // Technical slots
  if (techMentor) {
    addSlot.run(techMentor.id, 'technical', tomorrow, '10:00', '10:30', 'Online', 'https://meet.google.com/tech-session-1');
    addSlot.run(techMentor.id, 'technical', tomorrow, '10:30', '11:00', 'Online', 'https://meet.google.com/tech-session-2');
    addSlot.run(techMentor.id, 'technical', dayAfter, '14:00', '14:30', 'Online', 'https://meet.google.com/tech-session-3');
  }

  // HR slots
  if (hrMentor) {
    addSlot.run(hrMentor.id, 'hr', tomorrow, '11:30', '12:00', 'Online', 'https://meet.google.com/hr-session-1');
    addSlot.run(hrMentor.id, 'hr', tomorrow, '12:00', '12:30', 'Online', 'https://meet.google.com/hr-session-2');
    addSlot.run(hrMentor.id, 'hr', dayAfter, '15:00', '15:30', 'Online', 'https://meet.google.com/hr-session-3');
  }

  // Dual slots
  if (dualMentor) {
    addSlot.run(dualMentor.id, 'technical', day3, '10:00', '10:30', 'Online', 'https://meet.google.com/dual-tech');
    addSlot.run(dualMentor.id, 'hr', day3, '11:00', '11:30', 'Online', 'https://meet.google.com/dual-hr');
  }
}

const c = (s) => db.prepare(s).get().c;
if (mode === 'dev') {
  let pwString = `Password for all accounts: ${adminPassword}`;
  if (isGenerated) {
    pwString = `⚠️  Auto-generated password for all accounts: ${adminPassword}\n  ⚠️  Save this now — it will not be shown again.\n  💡 Set ADMIN_PASSWORD env var to use your own password.`;
  }
  console.log(`
  =============================================================
  [Development Dataset Initialized — 1 Account of Each Role]
  =============================================================
  ${pwString}

  1. Admin Account:
     Email:    admin@konfident.in
     Role:     Platform Administrator

  2. Technical Mentor Account:
     Email:    tech.mentor@konfident.in
     Role:     Mentor (Technical Interviews)

  3. HR Mentor Account:
     Email:    hr.mentor@konfident.in
     Role:     Mentor (HR Interviews)

  4. Dual-Skill Mentor Account:
     Email:    mentor@konfident.in
     Role:     Mentor (Technical + HR Interviews)

  5. Student Account:
     Email:    student@konfident.in
     Role:     Student (Candidate: Aisha Khan · Roll: KON2025001)

  -------------------------------------------------------------
  Open Slots Generated: ${c("SELECT COUNT(*) c FROM slots WHERE status='open'")} available slots
  Total Accounts:       ${c('SELECT COUNT(*) c FROM users')}
  =============================================================
  `);
} else if (mode === 'clean') {
  console.log(`
  =============================================================
  [Clean Production Database Initialized]
  =============================================================
  Users:       1 (Root Admin: ${adminEmail})
  Students:    0
  Mentors:     0
  Slots:       0
  Interviews:  0
  Evaluations: 0
  =============================================================
  `);
}
