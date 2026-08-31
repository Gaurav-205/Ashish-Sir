'use strict';
const express = require('express');
const db = require('../db');
const q = require('../queries');
const h = require('../helpers');
const { requireRole } = require('../auth');
const { RUBRIC } = require('../rubric');
const { validateId } = require('../middleware/security');
const { logAudit } = require('../middleware/auditLog');

const router = express.Router();
const google = require('../services/googleService');
const emailService = require('../services/emailService');
router.use(requireRole('mentor'));

const flash = (req, type, msg) => { req.session.flash = { type, msg }; };

router.get('/', (req, res) => {
  const id = req.session.user.id;
  const mentor = db.prepare('SELECT id, name, email, role, phone, can_technical, can_hr, active FROM users WHERE id=?').get(id);
  const all = q.interviewsForMentor(id);
  const upcoming = all.filter((i) => i.status === 'booked');
  const completed = all.filter((i) => i.status === 'completed');
  const pending = completed.filter((i) => i.eval_id == null);
  const slots = db.prepare(`SELECT * FROM slots WHERE mentor_id=? AND status='open'
                            AND (slot_date || ' ' || start_time) > ?
                            ORDER BY slot_date, start_time`).all(id, h.nowMinute());
  res.render('mentor/dashboard', {
    title: 'My interviews',
    upcoming,
    completed,
    pending,
    slots,
    mentor,
    defaultDate: h.addDays(h.today(), 1),
    today: h.today(),
  });
});

router.post('/slots', (req, res) => {
  const mentorId = req.session.user.id;
  try {
    const { type, slot_date, end_date, repeat_days, exclude_weekends, start_time, duration, count, mode, location } = req.body;
    const mentor = db.prepare(`SELECT id, name, email, role, phone, can_technical, can_hr, active, is_developer FROM users WHERE id=?`).get(mentorId);
    if (!mentor) throw new Error('Mentor account not found.');
    const isDev = Boolean(res.locals.isDeveloper || mentor.is_developer || (mentor.email && mentor.email.toLowerCase() === 'gauravkhandelwal205@gmail.com') || mentor.role === 'developer');
    if (!isDev && mentor.role !== 'mentor') throw new Error('Mentor account not found.');
    if (type !== 'technical' && type !== 'hr') throw new Error('Invalid interview domain. Must be technical or hr.');
    const canTech = Boolean(mentor.can_technical && mentor.can_technical !== '0' && mentor.can_technical !== 0);
    const canHr = Boolean(mentor.can_hr && mentor.can_hr !== '0' && mentor.can_hr !== 0);
    if (type === 'technical' && !canTech && !isDev) throw new Error('Your profile is not enabled for Technical interviews.');
    if (type === 'hr' && !canHr && !isDev) throw new Error('Your profile is not enabled for HR interviews.');
    
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
        `).get(mentorId, targetDate, e_time, s_time);

        if (overlap) {
          skipped++;
          continue;
        }

        const loc = (location && location.trim()) ? location.trim() : h.generateMeetingLink(type);
        try {
          const resIns = ins.run(mentorId, type, targetDate, s_time, e_time, mode || 'Online', loc);
          made++;
          const newSlot = {
            id: resIns.lastInsertRowid,
            mentor_id: mentorId,
            type,
            slot_date: targetDate,
            start_time: s_time,
            end_time: e_time,
            mode: mode || 'Online',
            location: loc,
          };
          google.createSlotCalendarEvent({ mentor, slot: newSlot }).catch(() => {});
        } catch (e) {
          if (String(e.message).includes('UNIQUE') || String(e.message).includes('duplicate key')) skipped++; else throw e;
        }
      }
    }
    logAudit(req, 'MENTOR_CREATE_SLOTS', { type, count: made, days: dates.length });
    flash(req, made ? 'ok' : 'err',
      `${made} slot(s) published across ${dates.length} day(s)${skipped ? ` (${skipped} skipped due to existing overlap)` : ''}.`);
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/mentor');
});

router.get('/interview/:id', validateId('id'), (req, res) => {
  const iv = q.interviewById(Number(req.params.id));
  if (!iv || (iv.mentor_id !== req.session.user.id && !res.locals.isDeveloper)) {
    return res.status(403).render('error', {
      title: 'Not your interview',
      message: 'You can only view interviews that the admin assigned to you.',
    });
  }
  res.render('mentor/interview', { title: `${h.titleCase(iv.type)} — ${iv.student_name}`, iv, error: null, form: {} });
});

router.post('/interview/:id/attendance', validateId('id'), (req, res) => {
  const iv = q.interviewById(Number(req.params.id));
  if (!iv || (iv.mentor_id !== req.session.user.id && !res.locals.isDeveloper)) {
    return res.status(403).render('error', { title: 'Not your interview', message: 'Access denied.' });
  }
  if (iv.status === 'cancelled') {
    flash(req, 'err', 'Cannot alter attendance for a cancelled interview.');
    return res.redirect('/mentor/interview/' + iv.id);
  }
  if (iv.eval_id) {
    flash(req, 'err', 'Cannot alter attendance after an evaluation has already been submitted.');
    return res.redirect('/mentor/interview/' + iv.id);
  }
  const attendance = req.body.attendance === 'absent' ? 'absent' : 'attended';

  if (attendance === 'attended') {
    const now = h.nowStamp();
    db.prepare(`UPDATE interviews SET attendance='attended', status='completed',
                completed_at=COALESCE(completed_at, ?),
                attendance_marked_at=? WHERE id=?`).run(now, now, iv.id);
    logAudit(req, 'MENTOR_MARK_ATTENDANCE', { interview_id: iv.id, attendance: 'attended' });
    flash(req, 'ok', 'Candidate marked as Attended. You can now score the interview.');
  } else {
    const now = h.nowStamp();
    db.prepare(`UPDATE interviews SET attendance='absent', status='completed',
                completed_at=COALESCE(completed_at, ?),
                attendance_marked_at=? WHERE id=?`).run(now, now, iv.id);
    logAudit(req, 'MENTOR_MARK_ATTENDANCE', { interview_id: iv.id, attendance: 'absent' });
    flash(req, 'err', 'Candidate marked as Absent / No-Show.');
  }
  res.redirect('/mentor/interview/' + iv.id);
});

router.post('/interview/:id/complete', validateId('id'), (req, res) => {
  const iv = q.interviewById(Number(req.params.id));
  if (!iv || (iv.mentor_id !== req.session.user.id && !res.locals.isDeveloper)) {
    return res.status(403).render('error', { title: 'Not your interview', message: 'Access denied.' });
  }
  if (iv.status === 'cancelled') {
    flash(req, 'err', 'Cannot complete a cancelled interview.');
    return res.redirect('/mentor/interview/' + iv.id);
  }
  if (iv.eval_id) {
    flash(req, 'err', 'Interview has already been completed and evaluated.');
    return res.redirect('/mentor/interview/' + iv.id);
  }
  if (iv.status !== 'booked') flash(req, 'err', 'Only booked interviews can be marked as completed.');
  else {
    const now = h.nowStamp();
    db.prepare(`UPDATE interviews SET attendance='attended', status='completed', completed_at=?,
                attendance_marked_at=? WHERE id=?`).run(now, now, iv.id);
    logAudit(req, 'MENTOR_COMPLETE_INTERVIEW', { interview_id: iv.id });
    flash(req, 'ok', 'Marked as completed and attended. You can now submit the evaluation.');
  }
  res.redirect('/mentor/interview/' + iv.id);
});

router.post('/interview/:id/evaluate', validateId('id'), (req, res) => {
  const iv = q.interviewById(Number(req.params.id));
  if (!iv || (iv.mentor_id !== req.session.user.id && !res.locals.isDeveloper)) {
    return res.status(403).render('error', { title: 'Not your interview', message: 'Access denied.' });
  }
  const rerender = (error) => res.status(400).render('mentor/interview', {
    title: 'Evaluate', iv, error, form: req.body,
  });

  if (iv.status === 'cancelled') return rerender('Cannot submit scores for a cancelled interview.');
  if (iv.attendance === 'absent') return rerender('Cannot submit scores for an absent candidate. Mark attendance as attended first.');
  if (iv.status !== 'completed') return rerender('Mark candidate as attended and completed before submitting scores.');
  if (iv.eval_id) return rerender('An evaluation has already been submitted for this interview.');

  let total;
  try { total = q.computeTotal(iv.type, req.body); }
  catch (e) { return rerender(e.message); }

  const keys = RUBRIC[iv.type].criteria.map((c) => c.key);
  const val = (k) => (keys.includes(k) ? Number(req.body[k]) : null);
  try {
    db.prepare(`INSERT INTO evaluations
        (interview_id, mentor_id, resume_marks, project_marks, dsa_marks,
         behaviour_marks, hr_perf_marks, total, feedback)
        VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(iv.id, req.session.user.id, val('resume_marks'), val('project_marks'), val('dsa_marks'),
           val('behaviour_marks'), val('hr_perf_marks'), total, String(req.body.feedback || '').trim() || null);
  } catch (e) {
    if (e.message.includes('UNIQUE') || e.message.includes('duplicate key')) {
      return rerender('An evaluation has already been submitted for this interview.');
    }
    return rerender('Could not save evaluation: ' + e.message);
  }

  logAudit(req, 'MENTOR_SUBMIT_EVALUATION', { interview_id: iv.id, score: total });
  flash(req, 'ok', `Evaluation submitted — ${total}/${RUBRIC[iv.type].total}. The student can now see the result.`);
  res.redirect('/mentor');
});

/* ------------------------------ slots management ----------------------- */
router.post(['/slots/:id/edit', '/slots/:id/reschedule'], validateId('id'), async (req, res) => {
  const slotId = Number(req.params.id);
  const slot = db.prepare('SELECT * FROM slots WHERE id=?').get(slotId);
  if (!slot) {
    flash(req, 'err', 'Slot not found.');
    return res.redirect('/mentor');
  }
  if (slot.mentor_id !== req.session.user.id && !res.locals.isDeveloper) {
    flash(req, 'err', 'Access denied.');
    return res.redirect('/mentor');
  }
  if (slot.status === 'cancelled') {
    flash(req, 'err', 'Cancelled slots cannot be edited.');
    return res.redirect('/mentor');
  }

  const iv = db.prepare("SELECT * FROM interviews WHERE slot_id=? AND status<>'cancelled'").get(slotId);
  if (iv && iv.status === 'completed') {
    flash(req, 'err', 'This session is already completed — it cannot be rescheduled.');
    return res.redirect('/mentor');
  }

  const { slot_date, start_time, end_time, mode, location } = req.body;
  try {
    const cleanDate = String(slot_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) throw new Error('Pick a valid date.');
    const cleanStart = h.normalizeTime(start_time);
    const cleanEnd = h.normalizeTime(end_time);
    if (!cleanStart) throw new Error('Pick a valid start time.');
    if (!cleanEnd) throw new Error('Pick a valid end time.');
    if (cleanStart >= cleanEnd) throw new Error('Start time must be before end time.');

    const overlap = db.prepare(`
      SELECT 1 FROM slots
       WHERE mentor_id = ? AND slot_date = ? AND status <> 'cancelled' AND id <> ?
         AND start_time < ? AND end_time > ?
    `).get(slot.mentor_id, cleanDate, slotId, cleanEnd, cleanStart);
    if (overlap) throw new Error('You already have another slot at that time.');

    const loc = (location && location.trim()) ? location.trim() : (slot.location || h.generateMeetingLink(slot.type));

    db.prepare(`UPDATE slots SET slot_date=?, start_time=?, end_time=?, mode=?, location=? WHERE id=?`)
      .run(cleanDate, cleanStart, cleanEnd, mode || 'Online', loc, slotId);

    if (iv) {
      const student = db.prepare('SELECT id, name, email, google_calendar_enabled, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(iv.student_id);
      const mentor = db.prepare('SELECT id, name, email, google_calendar_enabled, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(slot.mentor_id);
      if (iv.google_event_id) {
        google.syncCalendarEvent({
          eventId: iv.google_event_id,
          student,
          mentor,
          slot: { slot_date, start_time, end_time, mode: mode || 'Online', location: loc, type: slot.type }
        }).catch(() => {});
      }
      emailService.sendBookingConfirmation({
        student,
        mentor,
        slot: { slot_date, start_time, end_time, mode: mode || 'Online', location: loc, type: slot.type },
        meetingLink: loc
      }).catch(() => {});
    }

    logAudit(req, 'MENTOR_EDIT_SLOT', { slot_id: slotId, slot_date, start_time, end_time });
    flash(req, 'ok', iv ? 'Interview session rescheduled and candidate notified.' : 'Slot updated successfully.');
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/mentor');
});

router.post('/slots/:id/cancel', validateId('id'), async (req, res) => {
  const slotId = Number(req.params.id);
  const slot = db.prepare('SELECT * FROM slots WHERE id=?').get(slotId);
  if (!slot) {
    flash(req, 'err', 'Slot not found.');
    return res.redirect('/mentor');
  }
  if (slot.mentor_id !== req.session.user.id && !res.locals.isDeveloper) {
    flash(req, 'err', 'Access denied.');
    return res.redirect('/mentor');
  }
  if (slot.status === 'cancelled') {
    flash(req, 'err', 'Slot is already cancelled.');
    return res.redirect('/mentor');
  }

  const iv = db.prepare("SELECT * FROM interviews WHERE slot_id=? AND status<>'cancelled'").get(slotId);
  if (iv && iv.status === 'completed') {
    flash(req, 'err', 'This session is already completed — it cannot be cancelled.');
    return res.redirect('/mentor');
  }
  if (iv && iv.attendance !== 'pending') {
    flash(req, 'err', 'Cannot cancel an interview once attendance has been recorded.');
    return res.redirect('/mentor');
  }

  try {
    db.exec('BEGIN IMMEDIATE');
    if (iv) db.prepare("UPDATE interviews SET status='cancelled' WHERE id=?").run(iv.id);
    db.prepare("UPDATE slots SET status='cancelled' WHERE id=?").run(slotId);
    db.exec('COMMIT');

    const calEventId = (iv && iv.google_event_id) || slot.google_event_id;
    if (calEventId) {
      const student = iv ? db.prepare('SELECT id, name, email, google_calendar_enabled, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(iv.student_id) : null;
      const mentor = db.prepare('SELECT id, name, email, google_calendar_enabled, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(slot.mentor_id);
      google.removeCalendarEvent({ eventId: calEventId, student, mentor }).catch(() => {});
    }

    if (iv) {
      const studentObj = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(iv.student_id);
      const mentorObj = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(slot.mentor_id);
      emailService.sendBookingCancellation({ student: studentObj, mentor: mentorObj, slot }).catch(() => {});
    }

    logAudit(req, 'MENTOR_CANCEL_SLOT', { slot_id: slotId, interview_id: iv ? iv.id : null });
    flash(req, 'ok', iv ? 'Interview session cancelled and candidate notified.' : 'Slot cancelled successfully.');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    flash(req, 'err', 'Could not cancel slot: ' + e.message);
  }
  res.redirect('/mentor');
});

router.post('/slots/:id/delete', validateId('id'), async (req, res) => {
  const slotId = Number(req.params.id);
  const mentorId = req.session.user.id;
  const isDev = Boolean(res.locals.isDeveloper);

  const slot = db.prepare('SELECT * FROM slots WHERE id=?').get(slotId);
  if (!slot || (slot.mentor_id !== mentorId && !isDev)) {
    flash(req, 'err', 'Slot not found or access denied.');
    return res.redirect('/mentor');
  }

  const iv = db.prepare("SELECT * FROM interviews WHERE slot_id=? AND status<>'cancelled'").get(slotId);
  if (iv && (iv.status === 'completed' || iv.eval_id)) {
    flash(req, 'err', 'Completed interviews with evaluations cannot be deleted.');
    return res.redirect('/mentor');
  }

  try {
    db.exec('BEGIN IMMEDIATE');
    if (iv) {
      const calEventId = iv.google_event_id || slot.google_event_id;
      if (calEventId) {
        const student = db.prepare('SELECT id, name, email, google_calendar_enabled, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(iv.student_id);
        const mentor = db.prepare('SELECT id, name, email, google_calendar_enabled, google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=?').get(slot.mentor_id);
        google.removeCalendarEvent({ eventId: calEventId, student, mentor }).catch(() => {});
      }
      const studentObj = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(iv.student_id);
      const mentorObj = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(slot.mentor_id);
      emailService.sendBookingCancellation({ student: studentObj, mentor: mentorObj, slot }).catch(() => {});
    }

    db.prepare('DELETE FROM interviews WHERE slot_id=?').run(slotId);
    db.prepare('DELETE FROM slots WHERE id=?').run(slotId);
    db.exec('COMMIT');

    logAudit(req, 'MENTOR_DELETE_SLOT', { slot_id: slotId });
    flash(req, 'ok', 'Slot permanently deleted.');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    flash(req, 'err', 'Could not delete slot: ' + e.message);
  }
  res.redirect('/mentor');
});

module.exports = router;
