'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const q = require('../queries');
const h = require('../helpers');
const { requireRole } = require('../auth');
const { RUBRIC, GRAND_TOTAL } = require('../rubric');
const google = require('../services/googleService');
const emailService = require('../services/emailService');
const { validateId } = require('../middleware/security');
const { logAudit } = require('../middleware/auditLog');
const { invalidateUserSessions } = require('../middleware/sessionAuth');

const router = express.Router();
router.use(requireRole('admin'));

const flash = (req, type, msg) => { req.session.flash = { type, msg }; };

/* ------------------------------ dashboard ------------------------------ */
router.get('/', (req, res) => {
  const stats = q.adminStats();
  const upcoming = db.prepare(`
    SELECT i.id, i.type, i.status, s.slot_date, s.start_time, s.end_time, s.location,
           st.name AS student_name, m.name AS mentor_name
      FROM interviews i
      JOIN slots s ON s.id = i.slot_id
      JOIN users st ON st.id = i.student_id
      JOIN users m ON m.id = i.mentor_id
     WHERE i.status = 'booked'
     ORDER BY s.slot_date, s.start_time LIMIT 8`).all();
  const pendingEval = db.prepare(`
    SELECT i.id, i.type, s.slot_date, s.location, st.name AS student_name, m.name AS mentor_name
      FROM interviews i
      JOIN slots s ON s.id = i.slot_id
      JOIN users st ON st.id = i.student_id
      JOIN users m ON m.id = i.mentor_id
      LEFT JOIN evaluations e ON e.interview_id = i.id
     WHERE i.status = 'completed' AND e.id IS NULL
     ORDER BY s.slot_date LIMIT 8`).all();
  const studentSummaries = q.allStudentSummaries();
  const notBooked = studentSummaries
    .filter((s) => s.bookedCount < 2 && s.student.active)
    .sort((a, b) => a.bookedCount - b.bookedCount || a.student.name.localeCompare(b.student.name))
    .slice(0, 10)
    .map((s) => ({ ...s.student, booked: s.bookedCount }));
  res.render('admin/dashboard', { title: 'Admin dashboard', stats, upcoming, pendingEval, notBooked, studentSummaries, GRAND_TOTAL });
});

/* ------------------------------- students ------------------------------ */
router.get('/students', (req, res) => {
  const summaries = q.allStudentSummaries();
  res.render('admin/students', { title: 'Students', summaries, error: null });
});

router.post('/students', (req, res) => {
  const { name, email, password, roll_no, branch, squad, phone, resume_url } = req.body;
  try {
    if (!name || !name.trim() || !email || !email.trim() || !password) throw new Error('Name, email and password are required.');
    const cleanResume = (resume_url && resume_url.trim()) ? resume_url.trim() : null;
    if (cleanResume && !/^https?:\/\//i.test(cleanResume)) {
      throw new Error('Resume link must be a valid URL starting with http:// or https://');
    }
    db.prepare(`INSERT INTO users (name,email,password_hash,role,roll_no,branch,squad,phone,resume_url)
                VALUES (?,?,?,'student',?,?,?,?,?)`)
      .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10),
           roll_no || null, branch || null, squad || null, phone || null, cleanResume);
    logAudit(req, 'ADMIN_CREATE_STUDENT', { email: email.trim().toLowerCase() });
    flash(req, 'ok', `Student ${name} added.`);
  } catch (e) {
    flash(req, 'err', e.message.includes('UNIQUE') ? 'That email is already registered.' : e.message);
  }
  res.redirect('/admin/students');
});

router.post('/students/:id/update', validateId('id'), (req, res) => {
  const { name, roll_no, branch, squad, phone, resume_url, active } = req.body;
  if (!name || !name.trim()) {
    flash(req, 'err', 'Name is required.');
    return res.redirect('/admin/students/' + req.params.id);
  }
  const cleanResume = (resume_url && resume_url.trim()) ? resume_url.trim() : null;
  if (cleanResume && !/^https?:\/\//i.test(cleanResume)) {
    flash(req, 'err', 'Resume link must be a valid URL starting with http:// or https://');
    return res.redirect('/admin/students/' + req.params.id);
  }
  const isActive = active ? 1 : 0;
  db.prepare(`UPDATE users SET name=?, roll_no=?, branch=?, squad=?, phone=?, resume_url=?, active=?
              WHERE id=? AND role='student'`)
    .run(name.trim(), roll_no || null, branch || null, squad || null, phone || null, cleanResume,
         isActive, Number(req.params.id));
  if (!isActive) {
    invalidateUserSessions(req.params.id);
  }
  logAudit(req, 'ADMIN_UPDATE_STUDENT', { target_user_id: req.params.id });
  flash(req, 'ok', 'Student updated.');
  res.redirect('/admin/students/' + req.params.id);
});

router.post('/students/:id/reset-password', validateId('id'), (req, res) => {
  const admin = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.session.user.id);
  const adminPw = String(req.body.admin_password || '');
  if (!bcrypt.compareSync(adminPw, admin.password_hash)) {
    flash(req, 'err', 'Enter your admin password to confirm the reset.');
    return res.redirect('/admin/students/' + req.params.id);
  }
  const pw = String(req.body.password || '');
  if (pw.length < 6) flash(req, 'err', 'Password must be at least 6 characters.');
  else {
    db.prepare(`UPDATE users SET password_hash=? WHERE id=? AND role='student'`)
      .run(bcrypt.hashSync(pw, 10), Number(req.params.id));
    invalidateUserSessions(req.params.id);
    logAudit(req, 'ADMIN_RESET_STUDENT_PASSWORD', { target_user_id: req.params.id });
    flash(req, 'ok', 'Password reset.');
  }
  res.redirect('/admin/students/' + req.params.id);
});

router.get('/students/:id', validateId('id'), (req, res) => {
  const summary = q.studentSummary(Number(req.params.id));
  if (!summary) return res.status(404).render('error', { title: 'Not found', message: 'No such student.' });
  res.render('admin/student-detail', { title: summary.student.name, s: summary });
});

/* -------------------------------- mentors ------------------------------ */
router.get('/mentors', (req, res) => {
  const mentors = db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.can_technical, u.can_hr, u.active,
      (SELECT COUNT(*) FROM slots s WHERE s.mentor_id=u.id AND s.status<>'cancelled') AS slot_count,
      (SELECT COUNT(*) FROM interviews i WHERE i.mentor_id=u.id AND i.status='booked') AS upcoming,
      (SELECT COUNT(*) FROM interviews i WHERE i.mentor_id=u.id AND i.status='completed') AS done
      FROM users u WHERE u.role='mentor' ORDER BY u.name`)
    .all()
    .map((m) => ({
      ...m,
      slot_count: Number(m.slot_count) || 0,
      upcoming: Number(m.upcoming) || 0,
      done: Number(m.done) || 0,
    }));
  res.render('admin/mentors', { title: 'Mentors', mentors });
});

router.post('/mentors', (req, res) => {
  const { name, email, password, phone } = req.body;
  try {
    if (!name || !name.trim() || !email || !email.trim() || !password) throw new Error('Name, email and password are required.');
    db.prepare(`INSERT INTO users (name,email,password_hash,role,phone,can_technical,can_hr)
                VALUES (?,?,?,'mentor',?,?,?)`)
      .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), phone || null,
           req.body.can_technical ? 1 : 0, req.body.can_hr ? 1 : 0);
    logAudit(req, 'ADMIN_CREATE_MENTOR', { email: email.trim().toLowerCase() });
    flash(req, 'ok', `Mentor ${name} added.`);
  } catch (e) {
    flash(req, 'err', e.message.includes('UNIQUE') ? 'That email is already registered.' : e.message);
  }
  res.redirect('/admin/mentors');
});

router.post('/mentors/:id/update', validateId('id'), (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) {
    flash(req, 'err', 'Name is required.');
    return res.redirect('/admin/mentors');
  }
  const isActive = req.body.active ? 1 : 0;
  db.prepare(`UPDATE users SET name=?, phone=?, can_technical=?, can_hr=?, active=?
              WHERE id=? AND role='mentor'`)
    .run(name, req.body.phone || null,
         req.body.can_technical ? 1 : 0, req.body.can_hr ? 1 : 0,
         isActive, Number(req.params.id));
  if (!isActive) {
    invalidateUserSessions(req.params.id);
  }
  logAudit(req, 'ADMIN_UPDATE_MENTOR', { target_user_id: req.params.id });
  flash(req, 'ok', 'Mentor updated.');
  res.redirect('/admin/mentors');
});

router.post('/mentors/:id/reset-password', validateId('id'), (req, res) => {
  const admin = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.session.user.id);
  const adminPw = String(req.body.admin_password || '');
  if (!bcrypt.compareSync(adminPw, admin.password_hash)) {
    flash(req, 'err', 'Enter your admin password to confirm the reset.');
    return res.redirect('/admin/mentors');
  }
  const pw = String(req.body.password || '');
  if (pw.length < 6) flash(req, 'err', 'Password must be at least 6 characters.');
  else {
    db.prepare(`UPDATE users SET password_hash=? WHERE id=? AND role='mentor'`)
      .run(bcrypt.hashSync(pw, 10), Number(req.params.id));
    invalidateUserSessions(req.params.id);
    logAudit(req, 'ADMIN_RESET_MENTOR_PASSWORD', { target_user_id: req.params.id });
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
  else if (filter.when === 'upcoming') { where.push('s.slot_date >= ?'); args.push(h.today()); }
  else if (filter.when === 'past')     { where.push('s.slot_date <  ?'); args.push(h.today()); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // A seeded cohort easily produces several hundred slots; render them a page
  // at a time so the table stays usable and the query stays cheap.
  const PER_PAGE = 50;
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM slots s JOIN users m ON m.id = s.mentor_id ${whereSql}`)
    .get(...args).c) || 0;
  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pageCount);

  const slots = db.prepare(`
    SELECT s.*, m.name AS mentor_name,
           st.name AS student_name, st.roll_no, i.id AS interview_id, i.status AS interview_status
      FROM slots s
      JOIN users m ON m.id = s.mentor_id
      LEFT JOIN interviews i ON i.slot_id = s.id AND i.status <> 'cancelled'
      LEFT JOIN users st ON st.id = i.student_id
      ${whereSql}
     ORDER BY s.slot_date, s.start_time, s.id
     LIMIT ? OFFSET ?`).all(...args, PER_PAGE, (page - 1) * PER_PAGE);
  const students = db.prepare("SELECT id, name, roll_no, email FROM users WHERE role='student' AND active=1 ORDER BY name").all();

  const baseQuery = new URLSearchParams();
  Object.entries(filter).forEach(([k, v]) => { if (v) baseQuery.set(k, v); });

  res.render('admin/slots', {
    title: 'Interview slots', slots, filter,
    techMentors: q.mentorsList('technical'), hrMentors: q.mentorsList('hr'),
    students,
    defaultDate: h.addDays(h.today(), 1),
    today: h.today(),
    page, pageCount, total, perPage: PER_PAGE,
    baseQuery: baseQuery.toString(),
  });
});

router.post('/slots', (req, res) => {
  const { type, mentor_id, slot_date, end_date, repeat_days, exclude_weekends, start_time, duration, count, mode, location } = req.body;
  try {
    if (type !== 'technical' && type !== 'hr') throw new Error('Invalid interview type. Must be technical or hr.');
    const mentor = db.prepare(`SELECT id, name, can_technical, can_hr FROM users WHERE id=? AND role='mentor'`).get(Number(mentor_id));
    if (!mentor) throw new Error('Pick a mentor.');
    if (type === 'technical' && !mentor.can_technical) throw new Error(`${mentor.name} is not enabled for Technical interviews.`);
    if (type === 'hr' && !mentor.can_hr) throw new Error(`${mentor.name} is not enabled for HR interviews.`);
    
    const selectedList = (req.body.selected_dates ? String(req.body.selected_dates).split(',') : [])
      .map(d => d.trim())
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const cleanDate = String(slot_date || (selectedList.length ? selectedList[0] : '')).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate) && !selectedList.length) throw new Error('Pick a valid starting date.');
    const cleanStart = h.normalizeTime(start_time);
    if (!cleanStart) throw new Error('Pick a valid start time.');

    // Build target dates array
    let dates = [];
    const cleanEndDate = String(end_date || '').trim();
    const repDays = parseInt(repeat_days || 1, 10);

    if (selectedList.length > 0) {
      dates = [...new Set(selectedList)].sort();
    } else if (cleanEndDate && /^\d{4}-\d{2}-\d{2}$/.test(cleanEndDate)) {
      if (cleanEndDate < cleanDate) throw new Error('End date must be on or after start date.');
      let cur = cleanDate;
      let safety = 0;
      while (cur <= cleanEndDate && safety < 60) {
        dates.push(cur);
        cur = h.addDays(cur, 1);
        safety++;
      }
    } else if (repDays > 1) {
      const countDays = Math.min(Math.max(repDays, 1), 60);
      for (let d = 0; d < countDays; d++) {
        dates.push(h.addDays(cleanDate, d));
      }
    } else {
      dates.push(cleanDate);
    }

    if (exclude_weekends === '1' || exclude_weekends === 'true' || exclude_weekends === 'on') {
      dates = dates.filter((d) => {
        const dayOfWeek = new Date(d + 'T00:00:00Z').getUTCDay();
        return dayOfWeek !== 0 && dayOfWeek !== 6;
      });
    }
    if (!dates.length) throw new Error('No valid dates selected after filtering weekends.');

    if (duration !== undefined && duration !== null && String(duration).trim() !== '') {
      const minsVal = Number(duration);
      if (isNaN(minsVal) || minsVal <= 0) throw new Error('Duration must be a positive number.');
    }
    const mins = Number(duration) || 30;
    const n = Math.min(Math.max(Number(count) || 1, 1), 30);
    const [sh, sm] = cleanStart.split(':').map(Number);
    let made = 0, skipped = 0;
    const ins = db.prepare(`INSERT INTO slots (mentor_id,type,slot_date,start_time,end_time,mode,location)
                            VALUES (?,?,?,?,?,?,?)`);

    for (const targetDate of dates) {
      for (let k = 0; k < n; k++) {
        const startMin = sh * 60 + sm + k * mins;
        const endMin = startMin + mins;
        if (endMin > 24 * 60) break;
        const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
        const s_time = fmt(startMin);
        const e_time = fmt(endMin);

        const isPastSlot = (targetDate < h.today() || (targetDate === h.today() && s_time <= h.nowTime()));
        if (isPastSlot) {
          skipped++;
          continue;
        }

        const overlap = db.prepare(`
          SELECT 1 FROM slots
           WHERE mentor_id = ? AND slot_date = ? AND status <> 'cancelled'
             AND start_time < ? AND end_time > ?
        `).get(mentor.id, targetDate, e_time, s_time);

        if (overlap) {
          skipped++;
          continue;
        }

        const loc = (location && location.trim()) ? location.trim() : h.generateMeetingLink(type);
        try {
          const resIns = ins.run(mentor.id, type, targetDate, s_time, e_time, mode || 'Online', loc);
          made++;
          const newSlot = {
            id: resIns.lastInsertRowid,
            mentor_id: mentor.id,
            type,
            slot_date: targetDate,
            start_time: s_time,
            end_time: e_time,
            mode: mode || 'Online',
            location: loc,
          };
          google.createSlotCalendarEvent({ mentor, slot: newSlot }).catch(() => {});
        } catch (e) {
          if (String(e.message).includes('UNIQUE')) skipped++; else throw e;
        }
      }
    }
    logAudit(req, 'ADMIN_CREATE_SLOTS', { type, mentor_id: mentor.id, count: made, days: dates.length });
    flash(req, made ? 'ok' : 'err',
      `${made} slot(s) created across ${dates.length} day(s)${skipped ? ` (${skipped} skipped due to past time or existing overlap)` : ''}.`);
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/admin/slots');
});

router.post('/slots/:id/reschedule', validateId('id'), (req, res) => {
  const id = Number(req.params.id);
  const slot = db.prepare('SELECT * FROM slots WHERE id=?').get(id);
  if (!slot) { flash(req, 'err', 'Slot not found.'); return res.redirect('/admin/slots'); }
  try {
    const iv = db.prepare(`SELECT * FROM interviews WHERE slot_id=? AND status<>'cancelled'`).get(id);
    if (iv && iv.status === 'completed') {
      throw new Error('Completed interviews cannot be rescheduled.');
    }

    const { slot_date, start_time, end_time, mentor_id, mode, location } = req.body;
    const cleanDate = String(slot_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) throw new Error('Pick a valid date.');
    const cleanStart = h.normalizeTime(start_time);
    const cleanEnd = h.normalizeTime(end_time);
    if (!cleanStart) throw new Error('Pick a valid start time.');
    if (!cleanEnd) throw new Error('Pick a valid end time.');
    if (cleanStart >= cleanEnd) throw new Error('Start time must be before end time.');
    if (cleanDate < h.today() || (cleanDate === h.today() && cleanStart <= h.nowTime())) {
      throw new Error('Cannot reschedule a slot to a time in the past.');
    }
    if (location && /<[^>]+>/.test(location)) throw new Error('Location cannot contain HTML tags.');

    const mentor = db.prepare(`SELECT id, name, can_technical, can_hr FROM users WHERE id=? AND role='mentor'`).get(Number(mentor_id));
    if (!mentor) throw new Error('Pick a mentor.');
    const col = slot.type === 'hr' ? 'can_hr' : 'can_technical';
    if (!mentor[col]) throw new Error(`${mentor.name} is not enabled for ${h.titleCase(slot.type)} interviews.`);

    const clash = db.prepare(`
      SELECT 1 FROM slots
       WHERE mentor_id = ? AND slot_date = ? AND status <> 'cancelled' AND id <> ?
         AND start_time < ? AND end_time > ?
    `).get(mentor.id, cleanDate, id, cleanEnd, cleanStart);
    if (clash) throw new Error('That mentor already has an overlapping slot at that time.');

    if (iv) {
      const studentClash = db.prepare(`
        SELECT 1 FROM interviews i JOIN slots s2 ON s2.id = i.slot_id
         WHERE i.student_id = ? AND i.status <> 'cancelled' AND i.id <> ?
           AND s2.slot_date = ? AND s2.start_time < ? AND s2.end_time > ?
      `).get(iv.student_id, iv.id, slot_date, end_time, start_time);
      if (studentClash) throw new Error('The booked student already has another interview at that time.');
    }

    const loc = (location && location.trim()) ? location.trim() : (slot.location || h.generateMeetingLink(slot.type));
    db.prepare(`UPDATE slots SET slot_date=?, start_time=?, end_time=?, mentor_id=?, mode=?, location=? WHERE id=?`)
      .run(slot_date, start_time, end_time, mentor.id, mode || 'Online', loc, id);
    // keep the linked interview's mentor in sync
    db.prepare(`UPDATE interviews SET mentor_id=? WHERE slot_id=? AND status<>'cancelled'`).run(mentor.id, id);

    // Sync Google Calendar event update if present
    if (iv && iv.google_event_id) {
      const student = db.prepare('SELECT id, name, email, google_calendar_enabled, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(iv.student_id);
      google.updateCalendarEvent({
        eventId: iv.google_event_id,
        student,
        mentor,
        slot: { slot_date, start_time, end_time, mode: mode || 'Online', location, type: slot.type }
      }).catch(() => {});
    }

    logAudit(req, 'ADMIN_RESCHEDULE_SLOT', { slot_id: id, slot_date, start_time, end_time, mentor_id });
    flash(req, 'ok', 'Slot updated. The student and mentor now see the new schedule.');
  } catch (e) {
    flash(req, 'err', e.message.includes('UNIQUE') ? 'That mentor already has a slot at that time.' : e.message);
  }
  res.redirect('/admin/slots');
});

router.post('/slots/:id/cancel', validateId('id'), (req, res) => {
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

router.post('/slots/:id/reopen', validateId('id'), (req, res) => {
  db.prepare(`UPDATE slots SET status='open' WHERE id=? AND status='cancelled'`).run(Number(req.params.id));
  flash(req, 'ok', 'Slot reopened for booking.');
  res.redirect('/admin/slots');
});

router.post(['/slots/:id/release', '/slots/:id/cancel-booking'], validateId('id'), async (req, res) => {
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
      const student = db.prepare('SELECT id, name, email, google_calendar_enabled, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(iv.student_id);
      const mentor = db.prepare('SELECT id, name, email, google_calendar_enabled, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(iv.mentor_id);
      google.removeCalendarEvent({ eventId: iv.google_event_id, student, mentor }).catch(() => {});
    }
    const studentObj = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(iv.student_id);
    const mentorObj = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(iv.mentor_id);
    const slotObj = db.prepare('SELECT * FROM slots WHERE id=?').get(id);
    emailService.sendBookingCancellation({ student: studentObj, mentor: mentorObj, slot: slotObj }).catch(() => {});

    logAudit(req, 'ADMIN_RELEASE_SLOT', { slot_id: id, interview_id: iv.id });

    flash(req, 'ok', 'Booking released — the slot is open again.');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    flash(req, 'err', 'Could not release slot: ' + e.message);
  }
  res.redirect('/admin/slots');
});

router.post('/slots/:id/allot', validateId('id'), async (req, res) => {
  const slotId = Number(req.params.id);
  const studentId = Number(req.body.student_id);
  if (!studentId || isNaN(studentId)) {
    flash(req, 'err', 'Please select a student to allot this slot to.');
    return res.redirect('/admin/slots');
  }

  try {
    db.exec('BEGIN IMMEDIATE');
    const slot = db.prepare(`SELECT s.*, m.active AS mentor_active, m.name AS mentor_name,
                             m.email AS mentor_email, m.google_calendar_enabled AS mentor_cal,
                             m.google_access_token AS mentor_token, m.google_refresh_token AS mentor_ref,
                             m.google_token_expiry AS mentor_exp
                             FROM slots s
                             JOIN users m ON m.id = s.mentor_id WHERE s.id = ?`).get(slotId);
    if (!slot) throw new Error('That slot does not exist.');
    if (slot.status !== 'open') throw new Error('This slot is already booked or cancelled.');
    if (!slot.mentor_active) throw new Error('The assigned mentor is inactive.');
    if (h.isPast(slot)) throw new Error('Cannot allot a past slot.');

    const student = db.prepare(`SELECT id, name, email, role, active,
                                google_calendar_enabled, google_access_token,
                                google_refresh_token, google_token_expiry
                                FROM users WHERE id = ? AND role = 'student'`).get(studentId);
    if (!student) throw new Error('Student not found.');
    if (!student.active) throw new Error('This student account is inactive.');

    const existing = db.prepare(`SELECT id FROM interviews
                                 WHERE student_id = ? AND type = ? AND status <> 'cancelled'`).get(studentId, slot.type);
    if (existing) throw new Error(`${student.name} already has an active ${h.titleCase(slot.type)} interview.`);

    // check clash for student at that date/time
    const clash = db.prepare(`
      SELECT 1 FROM interviews i JOIN slots s2 ON s2.id = i.slot_id
       WHERE i.student_id = ? AND i.status <> 'cancelled'
         AND s2.slot_date = ? AND s2.start_time < ? AND s2.end_time > ?`)
      .get(studentId, slot.slot_date, slot.end_time, slot.start_time);
    if (clash) throw new Error(`${student.name} already has another interview at that date and time.`);

    const insert = db.prepare(`INSERT INTO interviews (student_id, mentor_id, slot_id, type)
                               VALUES (?,?,?,?)`).run(studentId, slot.mentor_id, slot.id, slot.type);
    db.prepare(`UPDATE slots SET status='booked' WHERE id=?`).run(slot.id);
    db.exec('COMMIT');

    const mentor = {
      id: slot.mentor_id,
      name: slot.mentor_name,
      email: slot.mentor_email,
      google_calendar_enabled: slot.mentor_cal,
      google_access_token: slot.mentor_token,
      google_refresh_token: slot.mentor_ref,
      google_token_expiry: slot.mentor_exp,
    };
    google.syncCalendarEvent({ student, mentor, slot, interviewId: insert.lastInsertRowid }).catch(() => {});
    emailService.sendBookingConfirmation({ student, mentor, slot, meetingLink: slot.location }).catch(() => {});

    logAudit(req, 'ADMIN_ALLOT_SLOT', { slot_id: slot.id, student_id: student.id, type: slot.type });
    flash(req, 'ok', `Slot successfully allotted to ${student.name} for ${h.fmtSlot(slot)}.`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    flash(req, 'err', 'Could not allot slot: ' + e.message);
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

router.post(['/interviews/:id/cancel', '/bookings/:id/cancel'], validateId('id'), async (req, res) => {
  const targetId = Number(req.params.id);
  let iv = db.prepare(`SELECT * FROM interviews WHERE id=?`).get(targetId);
  if (!iv) {
    iv = db.prepare(`SELECT * FROM interviews WHERE slot_id=? AND status<>'cancelled'`).get(targetId);
  }
  if (!iv) {
    flash(req, 'err', 'Booking not found.');
    return res.redirect(h.safeRedirectTarget(req, '/admin/interviews'));
  }
  if (iv.status === 'cancelled') {
    flash(req, 'err', 'This booking is already cancelled.');
    return res.redirect(h.safeRedirectTarget(req, '/admin/interviews'));
  }
  if (iv.status === 'completed') {
    flash(req, 'err', 'Completed interviews cannot be cancelled.');
    return res.redirect(h.safeRedirectTarget(req, '/admin/interviews'));
  }
  if (iv.attendance !== 'pending') {
    flash(req, 'err', 'Cannot cancel an interview once attendance has been recorded.');
    return res.redirect(h.safeRedirectTarget(req, '/admin/interviews'));
  }

  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`UPDATE interviews SET status='cancelled' WHERE id=?`).run(iv.id);
    db.prepare(`UPDATE slots SET status='open' WHERE id=? AND status='booked'`).run(iv.slot_id);
    db.exec('COMMIT');

    if (iv.google_event_id) {
      const student = db.prepare('SELECT id, name, email, google_calendar_enabled, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(iv.student_id);
      const mentor = db.prepare('SELECT id, name, email, google_calendar_enabled, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(iv.mentor_id);
      google.removeCalendarEvent({ eventId: iv.google_event_id, student, mentor }).catch(() => {});
    }
    const studentObj = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(iv.student_id);
    const mentorObj = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(iv.mentor_id);
    const slotObj = db.prepare('SELECT * FROM slots WHERE id=?').get(iv.slot_id);
    emailService.sendBookingCancellation({ student: studentObj, mentor: mentorObj, slot: slotObj }).catch(() => {});

    logAudit(req, 'ADMIN_CANCEL_BOOKING', { interview_id: iv.id, slot_id: iv.slot_id, student_id: iv.student_id, mentor_id: iv.mentor_id });

    flash(req, 'ok', 'Booking cancelled and the slot reopened.');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    flash(req, 'err', 'Could not cancel booking: ' + e.message);
  }
  res.redirect(h.safeRedirectTarget(req, '/admin/interviews'));
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
  const head = ['Roll No', 'Student', 'Email', 'Branch', 'Squad',
    ...RUBRIC.technical.criteria.map((c) => c.label), 'Technical Total',
    ...RUBRIC.hr.criteria.map((c) => c.label), 'HR Total',
    `Grand Total (/${GRAND_TOTAL})`, 'Percent', 'Technical Status', 'Technical Attendance', 'HR Status', 'HR Attendance'];
  const esc = (v) => {
    let str = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
    return `"${str.replace(/"/g, '""')}"`;
  };
  const lines = [head.map(esc).join(',')];
  for (const s of rows) {
    const t = s.technical, hr = s.hr;
    const techMarks = RUBRIC.technical.criteria.map((c) => (t && t.eval_id ? t[c.key] : ''));
    const hrMarks = RUBRIC.hr.criteria.map((c) => (hr && hr.eval_id ? hr[c.key] : ''));
    lines.push([
      s.student.roll_no, s.student.name, s.student.email, s.student.branch, s.student.squad,
      ...techMarks, s.techScore,
      ...hrMarks, s.hrScore,
      s.total, s.percent,
      t ? t.status : 'not booked', t ? t.attendance : '—',
      hr ? hr.status : 'not booked', hr ? hr.attendance : '—',
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="konfident-2025-results.csv"');
  res.send('\ufeff' + lines.join('\r\n'));
});

module.exports = router;
