'use strict';
/**
 * Seeds the database. By default, it sets up a clean database (no mock data, admin only).
 * If run during tests (detected via DB_PATH containing 'test.db') or with SEED_MOCK=true,
 * it seeds the full demo dataset.
 * Usage: npm run seed
 */
const bcrypt = require('bcryptjs');
const db = require('./db');
const h = require('./helpers');

const PW = bcrypt.hashSync('pass123', 10);

db.exec(`DELETE FROM evaluations; DELETE FROM interviews; DELETE FROM slots; DELETE FROM users;
         DELETE FROM sqlite_sequence WHERE name IN ('users','slots','interviews','evaluations');`);

const addUser = db.prepare(`INSERT INTO users
  (name,email,password_hash,role,phone,roll_no,branch,resume_url,can_technical,can_hr)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);

// Default admin
addUser.run('Konfident Admin', 'admin@konfident.in', PW, 'admin', '9800000000', null, null, null, 0, 0);

const isTest = process.env.DB_PATH && process.env.DB_PATH.includes('test.db');
const seedMock = isTest || process.env.SEED_MOCK !== 'false';

if (seedMock) {
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

  /* ------------------------------- slots -------------------------------- */
  const addSlot = db.prepare(`INSERT INTO slots (mentor_id,type,slot_date,start_time,end_time,mode,location)
                              VALUES (?,?,?,?,?,?,?)`);
  const start = h.addDays(h.today(), -2);           // two days of past slots, five ahead
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
          // stagger HR slots by 15 min so a dual-skill mentor has no clash
          const s2 = s + 15;
          try { addSlot.run(m.id, 'hr', date, fmt(s2), fmt(s2 + 30), 'Online', 'https://meet.konfident.in/hr-' + m.id); } catch (_) {}
        }
      }
    }
  }

  /* ------------------------------ bookings ------------------------------ */
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

  const techFeedback = [
    'Strong fundamentals; explain time complexity more confidently.',
    'Good project depth. Practise writing clean code under time pressure.',
    'Resume is well structured. Revise trees and graphs before placements.',
    'Clear communication. Needs more practice with DP problems.',
  ];
  const hrFeedback = [
    'Confident and articulate. Prepare sharper answers on long-term goals.',
    'Good attitude and clarity. Work on structuring the "tell me about yourself" answer.',
    'Polite and composed throughout. Add concrete examples of teamwork.',
  ];
  const pick = (arr, i) => arr[i % arr.length];
  const rnd = (min, max, i) => min + ((i * 7 + 3) % (max - min + 1)); // deterministic spread

  students.forEach((st, i) => {
    if (i < 6) {
      // fully done: both interviews completed & evaluated
      const t = book(st, 'technical', true);
      const hr = book(st, 'hr', true);
      if (t) {
        const a = rnd(6, 10, i), b = rnd(5, 10, i + 1), c = rnd(4, 10, i + 2);
        addEval.run(t.id, t.mentor_id, a, b, c, null, null, a + b + c, pick(techFeedback, i));
      }
      if (hr) {
        const a = rnd(6, 10, i + 3), b = rnd(6, 10, i + 4);
        addEval.run(hr.id, hr.mentor_id, null, null, null, a, b, a + b, pick(hrFeedback, i));
      }
    } else if (i < 8) {
      // technical done & scored, HR upcoming
      const t = book(st, 'technical', true);
      if (t) {
        const a = rnd(5, 10, i), b = rnd(5, 10, i + 2), c = rnd(3, 10, i + 4);
        addEval.run(t.id, t.mentor_id, a, b, c, null, null, a + b + c, pick(techFeedback, i));
      }
      book(st, 'hr', false);
    } else if (i < 9) {
      // completed but mentor has not scored yet
      book(st, 'technical', true);
      book(st, 'hr', false);
    } else if (i < 11) {
      // both booked, upcoming
      book(st, 'technical', false);
      book(st, 'hr', false);
    } else {
      // nothing booked yet
    }
  });
}

const c = (s) => db.prepare(s).get().c;
if (seedMock) {
  console.log(`
  Seed complete (with mock data).
    users:      ${c('SELECT COUNT(*) c FROM users')}
    slots:      ${c('SELECT COUNT(*) c FROM slots')} (${c("SELECT COUNT(*) c FROM slots WHERE status='open'")} open)
    interviews: ${c('SELECT COUNT(*) c FROM interviews')}
    evaluations:${c('SELECT COUNT(*) c FROM evaluations')}

  Sign in with password: pass123
    Admin:    admin@konfident.in
    Mentor:   arjun.mentor@konfident.in
    Student:  aisha@student.in
  `);
} else {
  console.log(`
  Clean database setup complete (no mock data).
    users:      ${c('SELECT COUNT(*) c FROM users')} (Admin only)
    slots:      ${c('SELECT COUNT(*) c FROM slots')}
    interviews: ${c('SELECT COUNT(*) c FROM interviews')}
    evaluations:${c('SELECT COUNT(*) c FROM evaluations')}

  Sign in with password: pass123
    Admin: admin@konfident.in
  `);
}
