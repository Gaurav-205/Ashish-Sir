'use strict';
const express = require('express');
const db = require('../db');
const q = require('../queries');
const h = require('../helpers');
const { requireRole } = require('../auth');

const router = express.Router();
const google = require('../services/googleService');
router.use(requireRole('student'));

const flash = (req, type, msg) => { req.session.flash = { type, msg }; };

router.get('/', (req, res) => {
  const s = q.studentSummary(req.session.user.id);
  const openCounts = db.prepare(`
    SELECT type, COUNT(*) c FROM slots
     WHERE status='open' AND datetime(slot_date || ' ' || start_time) > datetime('now','localtime')
     GROUP BY type`).all();
  const open = { technical: 0, hr: 0 };
  for (const r of openCounts) open[r.type] = r.c;
  res.render('student/dashboard', { title: 'My interviews', s, open });
});

router.get('/mentors', (req, res) => {
  const s = q.studentSummary(req.session.user.id);
  const mentors = q.mentorsWithOpenSlots();
  res.render('student/mentors', { title: 'Mentors directory', mentors, s });
});

router.get('/slots', (req, res) => {
  const type = req.query.type === 'hr' ? 'hr' : 'technical';
  const mentorId = req.query.mentor ? Number(req.query.mentor) : null;
  const s = q.studentSummary(req.session.user.id);
  const already = type === 'hr' ? s.hr : s.technical;

  const where = [
    's.type = ?',
    "s.status = 'open'",
    'm.active = 1',
    "datetime(s.slot_date || ' ' || s.start_time) > datetime('now','localtime')",
  ];
  const args = [type];
  if (mentorId) {
    where.push('s.mentor_id = ?');
    args.push(mentorId);
  }

  const slots = db.prepare(`
    SELECT s.*, m.name AS mentor_name, m.email AS mentor_email, m.phone AS mentor_phone
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
  const already = type === 'hr' ? s.hr : s.technical;

  const where = [
    's.type = ?',
    "s.status = 'open'",
    'm.active = 1',
    "datetime(s.slot_date || ' ' || s.start_time) > datetime('now','localtime')",
  ];
  const args = [type];
  if (mentorId) {
    where.push('s.mentor_id = ?');
    args.push(mentorId);
  }

  const slots = db.prepare(`
    SELECT s.*, m.name AS mentor_name, m.email AS mentor_email, m.phone AS mentor_phone
      FROM slots s JOIN users m ON m.id = s.mentor_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.slot_date, s.start_time`).all(...args);

  const formattedSlots = slots.map(sl => ({
    ...sl,
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

    const existing = db.prepare(`SELECT * FROM interviews
                                 WHERE student_id=? AND type=? AND status<>'cancelled'`).get(studentId, slot.type);
    if (existing) throw new Error(`You have already booked your ${h.titleCase(slot.type)} interview.`);

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

    // Asynchronously sync to Google Calendar if enabled
    const student = db.prepare('SELECT * FROM users WHERE id=?').get(studentId);
    const mentor = db.prepare('SELECT * FROM users WHERE id=?').get(slot.mentor_id);
    google.syncCalendarEvent({ student, mentor, slot, interviewId: insert.lastInsertRowid }).catch(() => {});

    flash(req, 'ok', `${h.titleCase(slot.type)} interview booked for ${h.fmtSlot(slot)}.`);
    return res.redirect('/student');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    flash(req, 'err', e.message);
    return res.redirect('/student/slots?type=' + (req.body.type || 'technical'));
  }
});

router.post('/cancel/:id', async (req, res) => {
  const iv = db.prepare(`SELECT * FROM interviews WHERE id=? AND student_id=?`)
    .get(Number(req.params.id), req.session.user.id);
  if (!iv) {
    flash(req, 'err', 'Booking not found.');
  } else if (iv.status !== 'booked') {
    flash(req, 'err', 'Only upcoming interviews can be cancelled.');
  } else {
    const slot = db.prepare(`SELECT * FROM slots WHERE id=?`).get(iv.slot_id);
    if (slot && h.isPast(slot)) {
      flash(req, 'err', 'Past slots cannot be cancelled.');
    } else {
      try {
        db.exec('BEGIN IMMEDIATE');
        db.prepare(`UPDATE interviews SET status='cancelled' WHERE id=?`).run(iv.id);
        db.prepare(`UPDATE slots SET status='open' WHERE id=?`).run(iv.slot_id);
        db.exec('COMMIT');

        // Remove Google Calendar event if synced
        if (iv.google_event_id) {
          const student = db.prepare('SELECT * FROM users WHERE id=?').get(iv.student_id);
          const mentor = db.prepare('SELECT * FROM users WHERE id=?').get(iv.mentor_id);
          google.removeCalendarEvent({ eventId: iv.google_event_id, student, mentor }).catch(() => {});
        }

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
  res.render('student/results', { title: 'My results', s });
});

module.exports = router;
