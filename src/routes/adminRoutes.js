'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const q = require('../queries');
const h = require('../helpers');
const { requireRole } = require('../auth');
const { RUBRIC, GRAND_TOTAL } = require('../rubric');
const google = require('../services/googleService');

const router = express.Router();
router.use(requireRole('admin'));

const flash = (req, type, msg) => { req.session.flash = { type, msg }; };

/* ------------------------------ dashboard ------------------------------ */
router.get('/', (req, res) => {
  const stats = q.adminStats();
  const upcoming = db.prepare(`
    SELECT i.id, i.type, i.status, s.slot_date, s.start_time, s.end_time, s.mode, s.location,
           st.name AS student_name, m.name AS mentor_name
      FROM interviews i
      JOIN slots s ON s.id = i.slot_id
      JOIN users st ON st.id = i.student_id
      JOIN users m ON m.id = i.mentor_id
     WHERE i.status = 'booked'
     ORDER BY s.slot_date, s.start_time LIMIT 8`).all();
  const pendingEval = db.prepare(`
    SELECT i.id, i.type, s.slot_date, s.mode, s.location, st.name AS student_name, m.name AS mentor_name
      FROM interviews i
      JOIN slots s ON s.id = i.slot_id
      JOIN users st ON st.id = i.student_id
      JOIN users m ON m.id = i.mentor_id
      LEFT JOIN evaluations e ON e.interview_id = i.id
     WHERE i.status = 'completed' AND e.id IS NULL
     ORDER BY s.slot_date LIMIT 8`).all();
  const studentSummaries = q.allStudentSummaries();
  const notBooked = db.prepare(`
    SELECT * FROM (
      SELECT u.id, u.name, u.roll_no,
        (SELECT COUNT(*) FROM interviews i WHERE i.student_id=u.id AND i.status<>'cancelled') AS booked
        FROM users u WHERE u.role='student'
    ) WHERE booked < 2 ORDER BY booked, name LIMIT 10`).all();
  res.render('admin/dashboard', { title: 'Admin dashboard', stats, upcoming, pendingEval, notBooked, studentSummaries, GRAND_TOTAL });
});

/* ------------------------------- students ------------------------------ */
router.get('/students', (req, res) => {
  const summaries = q.allStudentSummaries();
  res.render('admin/students', { title: 'Students', summaries, error: null });
});

router.post('/students', (req, res) => {
  const { name, email, password, roll_no, branch, phone, resume_url } = req.body;
  try {
    if (!name || !email || !password) throw new Error('Name, email and password are required.');
    db.prepare(`INSERT INTO users (name,email,password_hash,role,roll_no,branch,phone,resume_url)
                VALUES (?,?,?,'student',?,?,?,?)`)
      .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10),
           roll_no || null, branch || null, phone || null, resume_url || null);
    flash(req, 'ok', `Student ${name} added.`);
  } catch (e) {
    flash(req, 'err', e.message.includes('UNIQUE') ? 'That email is already registered.' : e.message);
  }
  res.redirect('/admin/students');
});

router.post('/students/:id/update', (req, res) => {
  const { name, roll_no, branch, phone, resume_url, active } = req.body;
  if (!name || !name.trim()) {
    flash(req, 'err', 'Name is required.');
    return res.redirect('/admin/students/' + req.params.id);
  }
  db.prepare(`UPDATE users SET name=?, roll_no=?, branch=?, phone=?, resume_url=?, active=?
              WHERE id=? AND role='student'`)
    .run(name.trim(), roll_no || null, branch || null, phone || null, resume_url || null,
         active ? 1 : 0, Number(req.params.id));
  flash(req, 'ok', 'Student updated.');
  res.redirect('/admin/students/' + req.params.id);
});

router.post('/students/:id/reset-password', (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 6) flash(req, 'err', 'Password must be at least 6 characters.');
  else {
    db.prepare(`UPDATE users SET password_hash=? WHERE id=? AND role='student'`)
      .run(bcrypt.hashSync(pw, 10), Number(req.params.id));
    flash(req, 'ok', 'Password reset.');
  }
  res.redirect('/admin/students/' + req.params.id);
});

router.get('/students/:id', (req, res) => {
  const summary = q.studentSummary(Number(req.params.id));
  if (!summary) return res.status(404).render('error', { title: 'Not found', message: 'No such student.' });
  res.render('admin/student-detail', { title: summary.student.name, s: summary });
});

/* -------------------------------- mentors ------------------------------ */
router.get('/mentors', (req, res) => {
  const mentors = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM slots s WHERE s.mentor_id=u.id AND s.status<>'cancelled') AS slot_count,
      (SELECT COUNT(*) FROM interviews i WHERE i.mentor_id=u.id AND i.status='booked') AS upcoming,
      (SELECT COUNT(*) FROM interviews i WHERE i.mentor_id=u.id AND i.status='completed') AS done
      FROM users u WHERE u.role='mentor' ORDER BY u.name`).all();
  res.render('admin/mentors', { title: 'Mentors', mentors });
});

router.post('/mentors', (req, res) => {
  const { name, email, password, phone } = req.body;
  try {
    if (!name || !email || !password) throw new Error('Name, email and password are required.');
    db.prepare(`INSERT INTO users (name,email,password_hash,role,phone,can_technical,can_hr)
                VALUES (?,?,?,'mentor',?,?,?)`)
      .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), phone || null,
           req.body.can_technical ? 1 : 0, req.body.can_hr ? 1 : 0);
    flash(req, 'ok', `Mentor ${name} added.`);
  } catch (e) {
    flash(req, 'err', e.message.includes('UNIQUE') ? 'That email is already registered.' : e.message);
  }
  res.redirect('/admin/mentors');
});

router.post('/mentors/:id/update', (req, res) => {
  db.prepare(`UPDATE users SET name=?, phone=?, can_technical=?, can_hr=?, active=?
              WHERE id=? AND role='mentor'`)
    .run(req.body.name, req.body.phone || null,
         req.body.can_technical ? 1 : 0, req.body.can_hr ? 1 : 0,
         req.body.active ? 1 : 0, Number(req.params.id));
  flash(req, 'ok', 'Mentor updated.');
  res.redirect('/admin/mentors');
});

router.post('/mentors/:id/reset-password', (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 6) flash(req, 'err', 'Password must be at least 6 characters.');
  else {
    db.prepare(`UPDATE users SET password_hash=? WHERE id=? AND role='mentor'`)
      .run(bcrypt.hashSync(pw, 10), Number(req.params.id));
    flash(req, 'ok', 'Password reset.');
  }
  res.redirect('/admin/mentors');
});

/* --------------------------------- slots ------------------------------- */
router.get('/slots', (req, res) => {
  const filter = {
    type: req.query.type || '',
    status: req.query.status || '',
    when: req.query.when || 'upcoming',
    date: req.query.date || '',
  };
  const where = [];
  const args = [];
  if (filter.type)   { where.push('s.type = ?');   args.push(filter.type); }
  if (filter.status) { where.push('s.status = ?'); args.push(filter.status); }
  if (filter.date)   { where.push('s.slot_date = ?'); args.push(filter.date); }
  else if (filter.when === 'upcoming') { where.push("s.slot_date >= date('now','localtime')"); }
  else if (filter.when === 'past')     { where.push("s.slot_date <  date('now','localtime')"); }
  const slots = db.prepare(`
    SELECT s.*, m.name AS mentor_name,
           st.name AS student_name, st.roll_no, i.id AS interview_id, i.status AS interview_status
      FROM slots s
      JOIN users m ON m.id = s.mentor_id
      LEFT JOIN interviews i ON i.slot_id = s.id AND i.status <> 'cancelled'
      LEFT JOIN users st ON st.id = i.student_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY s.slot_date, s.start_time`).all(...args);
  res.render('admin/slots', {
    title: 'Interview slots', slots, filter,
    techMentors: q.mentorsList('technical'), hrMentors: q.mentorsList('hr'),
    defaultDate: h.addDays(h.today(), 1),
  });
});

router.post('/slots', (req, res) => {
  const { type, mentor_id, slot_date, start_time, duration, count, mode, location } = req.body;
  try {
    const mentor = db.prepare(`SELECT * FROM users WHERE id=? AND role='mentor'`).get(Number(mentor_id));
    if (!mentor) throw new Error('Pick a mentor.');
    if (type === 'technical' && !mentor.can_technical) throw new Error(`${mentor.name} is not enabled for Technical interviews.`);
    if (type === 'hr' && !mentor.can_hr) throw new Error(`${mentor.name} is not enabled for HR interviews.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slot_date)) throw new Error('Pick a valid date.');
    if (!/^\d{2}:\d{2}$/.test(start_time)) throw new Error('Pick a valid start time.');
    const loc = (location && location.trim()) ? location.trim() : 'https://meet.konfident.in/room';

    const mins = Number(duration) || 30;
    const n = Math.min(Math.max(Number(count) || 1, 1), 20);
    const [sh, sm] = start_time.split(':').map(Number);
    let made = 0, skipped = 0;
    const ins = db.prepare(`INSERT INTO slots (mentor_id,type,slot_date,start_time,end_time,mode,location)
                            VALUES (?,?,?,?,?,?,?)`);
    for (let k = 0; k < n; k++) {
      const startMin = sh * 60 + sm + k * mins;
      const endMin = startMin + mins;
      if (endMin > 24 * 60) break;
      const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      const s_time = fmt(startMin);
      const e_time = fmt(endMin);

      const overlap = db.prepare(`
        SELECT 1 FROM slots
         WHERE mentor_id = ? AND slot_date = ? AND status <> 'cancelled'
           AND start_time < ? AND end_time > ?
      `).get(mentor.id, slot_date, e_time, s_time);

      if (overlap) {
        skipped++;
        continue;
      }

      try {
        ins.run(mentor.id, type, slot_date, s_time, e_time, mode || 'Online', loc);
        made++;
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) skipped++; else throw e;
      }
    }
    flash(req, made ? 'ok' : 'err',
      `${made} slot(s) created${skipped ? `, ${skipped} skipped (mentor already has an overlapping slot at that time)` : ''}.`);
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/admin/slots');
});

router.post('/slots/:id/reschedule', (req, res) => {
  const id = Number(req.params.id);
  const slot = db.prepare('SELECT * FROM slots WHERE id=?').get(id);
  if (!slot) { flash(req, 'err', 'Slot not found.'); return res.redirect('/admin/slots'); }
  try {
    const iv = db.prepare(`SELECT * FROM interviews WHERE slot_id=? AND status<>'cancelled'`).get(id);
    if (iv && iv.status === 'completed') {
      throw new Error('Completed interviews cannot be rescheduled.');
    }

    const { slot_date, start_time, end_time, mentor_id, mode, location } = req.body;
    const mentor = db.prepare(`SELECT * FROM users WHERE id=? AND role='mentor'`).get(Number(mentor_id));
    if (!mentor) throw new Error('Pick a mentor.');
    const col = slot.type === 'hr' ? 'can_hr' : 'can_technical';
    if (!mentor[col]) throw new Error(`${mentor.name} is not enabled for ${h.titleCase(slot.type)} interviews.`);

    const clash = db.prepare(`
      SELECT 1 FROM slots
       WHERE mentor_id = ? AND slot_date = ? AND status <> 'cancelled' AND id <> ?
         AND start_time < ? AND end_time > ?
    `).get(mentor.id, slot_date, id, end_time, start_time);
    if (clash) throw new Error('That mentor already has an overlapping slot at that time.');

    if (iv) {
      const studentClash = db.prepare(`
        SELECT 1 FROM interviews i JOIN slots s2 ON s2.id = i.slot_id
         WHERE i.student_id = ? AND i.status <> 'cancelled' AND i.id <> ?
           AND s2.slot_date = ? AND s2.start_time < ? AND s2.end_time > ?
      `).get(iv.student_id, iv.id, slot_date, end_time, start_time);
      if (studentClash) throw new Error('The booked student already has another interview at that time.');
    }

    db.prepare(`UPDATE slots SET slot_date=?, start_time=?, end_time=?, mentor_id=?, mode=?, location=? WHERE id=?`)
      .run(slot_date, start_time, end_time, mentor.id, mode || 'Online', location || null, id);
    // keep the linked interview's mentor in sync
    db.prepare(`UPDATE interviews SET mentor_id=? WHERE slot_id=? AND status<>'cancelled'`).run(mentor.id, id);

    // Sync Google Calendar event update if present
    if (iv && iv.google_event_id) {
      const student = db.prepare('SELECT * FROM users WHERE id=?').get(iv.student_id);
      google.updateCalendarEvent({
        eventId: iv.google_event_id,
        student,
        mentor,
        slot: { slot_date, start_time, end_time, mode: mode || 'Online', location, type: slot.type }
      }).catch(() => {});
    }

    flash(req, 'ok', 'Slot updated. The student and mentor now see the new schedule.');
  } catch (e) {
    flash(req, 'err', e.message.includes('UNIQUE') ? 'That mentor already has a slot at that time.' : e.message);
  }
  res.redirect('/admin/slots');
});

router.post('/slots/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  const iv = db.prepare(`SELECT * FROM interviews WHERE slot_id=? AND status<>'cancelled'`).get(id);
  if (iv && iv.status === 'completed') {
    flash(req, 'err', 'This interview is already completed — it cannot be cancelled.');
    return res.redirect('/admin/slots');
  }
  if (iv) db.prepare(`UPDATE interviews SET status='cancelled' WHERE id=?`).run(iv.id);
  db.prepare(`UPDATE slots SET status='cancelled' WHERE id=?`).run(id);
  flash(req, 'ok', iv ? 'Slot cancelled and the booking released.' : 'Slot cancelled.');
  res.redirect('/admin/slots');
});

router.post('/slots/:id/reopen', (req, res) => {
  db.prepare(`UPDATE slots SET status='open' WHERE id=? AND status='cancelled'`).run(Number(req.params.id));
  flash(req, 'ok', 'Slot reopened for booking.');
  res.redirect('/admin/slots');
});

router.post('/slots/:id/release', async (req, res) => {
  const id = Number(req.params.id);
  const iv = db.prepare(`SELECT * FROM interviews WHERE slot_id=? AND status<>'cancelled'`).get(id);
  if (!iv) { flash(req, 'err', 'That slot is not booked.'); return res.redirect('/admin/slots'); }
  if (iv.status === 'completed') { flash(req, 'err', 'Completed interviews cannot be released.'); return res.redirect('/admin/slots'); }
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`UPDATE interviews SET status='cancelled' WHERE id=?`).run(iv.id);
    db.prepare(`UPDATE slots SET status='open' WHERE id=?`).run(id);
    db.exec('COMMIT');

    if (iv.google_event_id) {
      const student = db.prepare('SELECT * FROM users WHERE id=?').get(iv.student_id);
      const mentor = db.prepare('SELECT * FROM users WHERE id=?').get(iv.mentor_id);
      google.removeCalendarEvent({ eventId: iv.google_event_id, student, mentor }).catch(() => {});
    }

    flash(req, 'ok', 'Booking released — the slot is open again.');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    flash(req, 'err', 'Could not release slot: ' + e.message);
  }
  res.redirect('/admin/slots');
});

/* ------------------------------ interviews ----------------------------- */
router.get('/interviews', (req, res) => {
  const filters = {
    type: req.query.type || '',
    status: req.query.status || '',
    attendance: req.query.attendance || '',
    mentor: req.query.mentor || '',
  };
  const list = q.allInterviews(filters);
  res.render('admin/interviews', {
    title: 'Interviews', list, filters,
    mentors: db.prepare(`SELECT id,name FROM users WHERE role='mentor' ORDER BY name`).all(),
  });
});

/* -------------------------------- reports ------------------------------ */
router.get('/reports', (req, res) => {
  const summaries = q.allStudentSummaries();
  const done = summaries.filter((s) => s.allEvaluated);
  const avg = done.length ? done.reduce((a, s) => a + s.total, 0) / done.length : null;
  const avgTech = done.length ? done.reduce((a, s) => a + s.techScore, 0) / done.length : null;
  const avgHr = done.length ? done.reduce((a, s) => a + s.hrScore, 0) / done.length : null;
  res.render('admin/reports', {
    title: 'Reports', summaries, doneCount: done.length,
    avg, avgTech, avgHr, stats: q.adminStats(),
  });
});

router.get('/reports.csv', (req, res) => {
  const rows = q.allStudentSummaries();
  const head = ['Roll No', 'Student', 'Email', 'Branch',
    ...RUBRIC.technical.criteria.map((c) => c.label), 'Technical Total',
    ...RUBRIC.hr.criteria.map((c) => c.label), 'HR Total',
    `Grand Total (/${GRAND_TOTAL})`, 'Percent', 'Technical Status', 'Technical Attendance', 'HR Status', 'HR Attendance'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(esc).join(',')];
  for (const s of rows) {
    const t = s.technical, hr = s.hr;
    const techMarks = RUBRIC.technical.criteria.map((c) => (t && t.eval_id ? t[c.key] : ''));
    const hrMarks = RUBRIC.hr.criteria.map((c) => (hr && hr.eval_id ? hr[c.key] : ''));
    lines.push([
      s.student.roll_no, s.student.name, s.student.email, s.student.branch,
      ...techMarks, s.techScore,
      ...hrMarks, s.hrScore,
      s.total, s.percent,
      t ? t.status : 'not booked', t ? t.attendance : '—',
      hr ? hr.status : 'not booked', hr ? hr.attendance : '—',
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="konfident-2025-results.csv"');
  res.send(lines.join('\n'));
});

module.exports = router;
