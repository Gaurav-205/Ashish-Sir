'use strict';
const express = require('express');
const db = require('../db');
const q = require('../queries');
const h = require('../helpers');
const { requireRole } = require('../auth');

const router = express.Router();
const google = require('../services/googleService');
const emailService = require('../services/emailService');
const { validateId } = require('../middleware/security');
const { logAudit } = require('../middleware/auditLog');
router.use(requireRole('student'));

const flash = (req, type, msg) => { req.session.flash = { type, msg }; };

function safeRedirectTarget(req, fallback = '/student') {
  const ref = req.headers.referer || req.headers.referrer;
  if (!ref) return fallback;
  try {
    if (ref.startsWith('/') && !ref.startsWith('//')) {
      return ref;
    }
    const parsed = new URL(ref);
    const host = req.get('host');
    if (parsed.host === host) {
      return parsed.pathname + parsed.search;
    }
  } catch (_) {}
  return fallback;
}

router.get('/', (req, res) => {
  const s = q.studentSummary(req.session.user.id);
  if (!s || !s.student) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  const openCounts = db.prepare(`
    SELECT type, COUNT(*) c FROM slots
     WHERE status='open' AND (slot_date || ' ' || start_time) > ?
     GROUP BY type`).all(h.nowMinute());
  const open = { technical: 0, hr: 0 };
  for (const r of openCounts) open[r.type] = Number(r.c) || 0;
  res.render('student/dashboard', { title: 'My interviews', s, open });
});

router.get('/mentors', (req, res) => {
  const s = q.studentSummary(req.session.user.id);
  if (!s || !s.student) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  const mentors = q.mentorsWithOpenSlots();
  res.render('student/mentors', { title: 'Mentors directory', mentors, s });
});

router.get('/slots', (req, res) => {
  const type = req.query.type === 'hr' ? 'hr' : 'technical';
  const mentorId = req.query.mentor ? Number(req.query.mentor) : null;
  const s = q.studentSummary(req.session.user.id);
  if (!s || !s.student) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  const already = type === 'hr' ? s.hr : s.technical;

  const where = [
    's.type = ?',
    "s.status = 'open'",
    'm.active = 1',
    "(s.slot_date || ' ' || s.start_time) > ?",
  ];
  const args = [type, h.nowMinute()];
  if (mentorId) {
    where.push('s.mentor_id = ?');
    args.push(mentorId);
  }

  const slots = db.prepare(`
    SELECT s.*, m.name AS mentor_name, m.email AS mentor_email
      FROM slots s JOIN users m ON m.id = s.mentor_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.slot_date, s.start_time`).all(...args);

  // Group by date for scannability
  const byDate = [];
  for (const slot of slots) {
    let g = byDate.find((x) => x.date === slot.slot_date);
    if (!g) { g = { date: slot.slot_date, slots: [] }; byDate.push(g); }
    g.slots.push(slot);
  }

  const mentors = q.mentorsList(type);
  res.render('student/slots', {
    title: `Book ${h.titleCase(type)} interview`,
    type,
    byDate,
    already,
    s,
    mentors,
    selectedMentor: mentorId,
  });
});

router.get('/api/slots/available', (req, res) => {
  const type = req.query.type === 'hr' ? 'hr' : 'technical';
  const mentorId = req.query.mentor ? Number(req.query.mentor) : null;
  const s = q.studentSummary(req.session.user.id);
  if (!s || !s.student) {
    return res.status(401).json({ ok: false, error: 'Your session is no longer valid. Please sign in again.' });
  }
  const already = type === 'hr' ? s.hr : s.technical;

  const where = [
    's.type = ?',
    "s.status = 'open'",
    'm.active = 1',
    "(s.slot_date || ' ' || s.start_time) > ?",
  ];
  const args = [type, h.nowMinute()];
  if (mentorId) {
    where.push('s.mentor_id = ?');
    args.push(mentorId);
  }

  const slots = db.prepare(`
    SELECT s.*, m.name AS mentor_name, m.email AS mentor_email
      FROM slots s JOIN users m ON m.id = s.mentor_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.slot_date, s.start_time`).all(...args);

  const formattedSlots = slots.map(sl => ({
    id: sl.id,
    type: sl.type,
    slot_date: sl.slot_date,
    start_time: sl.start_time,
    end_time: sl.end_time,
    mode: sl.mode,
    mentor_name: sl.mentor_name,
    dateFormatted: h.fmtDate(sl.slot_date),
    timeFormatted: `${h.fmtTime(sl.start_time)} – ${h.fmtTime(sl.end_time)}`,
    slotFormatted: h.fmtSlot(sl),
  }));

  const byDate = [];
  for (const slot of formattedSlots) {
    let g = byDate.find((x) => x.date === slot.slot_date);
    if (!g) { g = { date: slot.slot_date, dateFormatted: slot.dateFormatted, slots: [] }; byDate.push(g); }
    g.slots.push(slot);
  }

  res.json({
    ok: true,
    type,
    already: already ? { id: already.id, status: already.status, mentor_name: already.mentor_name, slotFormatted: h.fmtSlot(already) } : null,
    count: slots.length,
    earliest: formattedSlots[0] || null,
    byDate,
    slots: formattedSlots,
    fetchedAt: new Date().toISOString(),
  });
});

router.post('/book', async (req, res) => {
  const slotId = Number(req.body.slot_id);
  const studentId = req.session.user.id;
  try {
    db.exec('BEGIN IMMEDIATE');
    const slot = db.prepare(`SELECT s.*, m.active AS mentor_active FROM slots s
                             JOIN users m ON m.id = s.mentor_id WHERE s.id = ?`).get(slotId);
    if (!slot) throw new Error('That slot no longer exists.');
    if (slot.status !== 'open') throw new Error('Sorry — someone just booked that slot. Please pick another.');
    if (!slot.mentor_active) throw new Error('That mentor is no longer available. Please pick another slot.');
    if (h.isPast(slot)) throw new Error('That slot is in the past.');

    const slotWeek = h.getWeekRange(slot.slot_date);
    const existing = db.prepare(`
      SELECT i.*, s2.slot_date FROM interviews i
      JOIN slots s2 ON s2.id = i.slot_id
      WHERE i.student_id = ? AND i.type = ? AND i.status <> 'cancelled'
        AND s2.slot_date >= ? AND s2.slot_date <= ?
    `).get(studentId, slot.type, slotWeek.start, slotWeek.end);
    if (existing) throw new Error(`You have already booked your ${h.titleCase(slot.type)} interview for this weekly cycle (${slotWeek.label}).`);

    // no clashing booking at the same date/time for this student
    const clash = db.prepare(`
      SELECT 1 FROM interviews i JOIN slots s2 ON s2.id = i.slot_id
       WHERE i.student_id = ? AND i.status <> 'cancelled'
         AND s2.slot_date = ? AND s2.start_time < ? AND s2.end_time > ?`)
      .get(studentId, slot.slot_date, slot.end_time, slot.start_time);
    if (clash) throw new Error('You already have another interview at that time.');

    const insert = db.prepare(`INSERT INTO interviews (student_id, mentor_id, slot_id, type)
                               VALUES (?,?,?,?)`).run(studentId, slot.mentor_id, slot.id, slot.type);
    db.prepare(`UPDATE slots SET status='booked' WHERE id=?`).run(slot.id);
    db.exec('COMMIT');

    // Asynchronously sync to Google Calendar and dispatch confirmation email
    const student = db.prepare('SELECT id, name, email, google_calendar_enabled, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(studentId);
    const mentor = db.prepare('SELECT id, name, email, google_calendar_enabled, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(slot.mentor_id);
    google.syncCalendarEvent({ student, mentor, slot, interviewId: insert.lastInsertRowid }).catch(() => {});
    emailService.sendBookingConfirmation({ student, mentor, slot, meetingLink: slot.location }).catch(() => {});

    logAudit(req, 'STUDENT_BOOK_SLOT', { slot_id: slot.id, type: slot.type });

    flash(req, 'ok', `${h.titleCase(slot.type)} interview booked for ${h.fmtSlot(slot)}.`);
    return res.redirect('/student');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    flash(req, 'err', e.message);
    const redirectType = req.body.type === 'hr' ? 'hr' : 'technical';
    return res.redirect('/student/slots?type=' + redirectType);
  }
});

router.post('/cancel/:id', validateId('id'), async (req, res) => {
  const iv = db.prepare(`SELECT * FROM interviews WHERE id=? AND student_id=?`)
    .get(Number(req.params.id), req.session.user.id);
  if (!iv) {
    flash(req, 'err', 'Booking not found.');
  } else if (iv.status !== 'booked') {
    flash(req, 'err', 'Only upcoming interviews can be cancelled.');
  } else if (iv.attendance !== 'pending') {
    flash(req, 'err', 'Cannot cancel an interview once attendance has been recorded.');
  } else {
    const slot = db.prepare(`SELECT * FROM slots WHERE id=?`).get(iv.slot_id);
    if (slot && h.isPast(slot)) {
      flash(req, 'err', 'Past slots cannot be cancelled.');
    } else {
      try {
        db.exec('BEGIN IMMEDIATE');
        db.prepare(`UPDATE interviews SET status='cancelled' WHERE id=?`).run(iv.id);
        db.prepare(`UPDATE slots SET status='open' WHERE id=? AND status='booked'`).run(iv.slot_id);
        db.exec('COMMIT');

        // Remove Google Calendar event if synced and notify
        if (iv.google_event_id) {
          const student = db.prepare('SELECT id, name, email, google_calendar_enabled, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(iv.student_id);
          const mentor = db.prepare('SELECT id, name, email, google_calendar_enabled, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(iv.mentor_id);
          google.removeCalendarEvent({ eventId: iv.google_event_id, student, mentor }).catch(() => {});
        }
        const studentObj = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(iv.student_id);
        const mentorObj = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(iv.mentor_id);
        emailService.sendBookingCancellation({ student: studentObj, mentor: mentorObj, slot }).catch(() => {});

        logAudit(req, 'STUDENT_CANCEL_SLOT', { interview_id: iv.id, slot_id: iv.slot_id });

        flash(req, 'ok', 'Booking cancelled. You can book another slot.');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        flash(req, 'err', 'Could not cancel booking: ' + e.message);
      }
    }
  }
  res.redirect('/student');
});

router.get('/results', (req, res) => {
  const s = q.studentSummary(req.session.user.id);
  if (!s || !s.student) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  res.render('student/results', { title: 'My results', s });
});

router.post('/feedback/:interviewId', validateId('interviewId'), (req, res) => {
  const interviewId = Number(req.params.interviewId);
  const studentId = req.session.user.id;
  const iv = db.prepare(`SELECT i.*, s.type FROM interviews i JOIN slots s ON s.id = i.slot_id WHERE i.id = ? AND i.student_id = ?`).get(interviewId, studentId);
  if (!iv) {
    flash(req, 'err', 'Interview not found.');
    return res.redirect('/student');
  }
  if (iv.attendance === 'absent' || (iv.status !== 'completed' && iv.attendance !== 'attended')) {
    flash(req, 'err', 'Feedback can only be submitted for attended interviews.');
    return res.redirect(safeRedirectTarget(req, '/student'));
  }

  const satisfaction = Number(req.body.satisfaction);
  if (!Number.isInteger(satisfaction) || satisfaction < 1 || satisfaction > 5) {
    flash(req, 'err', 'Please select an overall satisfaction rating from 1 to 5.');
    return res.redirect(safeRedirectTarget(req, '/student/results'));
  }

  const structured = Number(req.body.structured);
  if (structured !== 0 && structured !== 1) {
    flash(req, 'err', 'Please answer whether the interview felt structured and well organized.');
    return res.redirect(safeRedirectTarget(req, '/student/results'));
  }

  let hr_relevant = null;
  if (iv.type === 'hr') {
    hr_relevant = Number(req.body.hr_relevant);
    if (hr_relevant !== 0 && hr_relevant !== 1) {
      flash(req, 'err', 'Please answer whether the HR questions were relevant to placement/job preparation.');
      return res.redirect(safeRedirectTarget(req, '/student/results'));
    }
  }

  const feedbackText = String(req.body.feedback_text || '').trim() || null;

  try {
    const existing = db.prepare('SELECT id FROM student_feedbacks WHERE interview_id = ?').get(interviewId);
    if (existing) {
      db.prepare(`UPDATE student_feedbacks SET satisfaction=?, structured=?, hr_relevant=?, feedback_text=?, submitted_at=? WHERE interview_id=?`)
        .run(satisfaction, structured, hr_relevant, feedbackText, h.nowStamp(), interviewId);
    } else {
      db.prepare(`INSERT INTO student_feedbacks (interview_id, student_id, mentor_id, satisfaction, structured, hr_relevant, feedback_text) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(interviewId, studentId, iv.mentor_id, satisfaction, structured, hr_relevant, feedbackText);
    }
    logAudit(req, 'STUDENT_SUBMIT_FEEDBACK', { interview_id: interviewId, mentor_id: iv.mentor_id });
    flash(req, 'ok', 'Thank you! Your feedback for the mentor has been submitted.');
  } catch (err) {
    console.error('Error saving student feedback:', err);
    flash(req, 'err', 'Could not save feedback: ' + err.message);
  }

  return res.redirect(safeRedirectTarget(req, '/student/results'));
});

module.exports = router;

