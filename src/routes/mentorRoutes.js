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
                            AND datetime(slot_date || ' ' || start_time) > datetime('now','localtime')
                            ORDER BY slot_date, start_time`).all(id);
  res.render('mentor/dashboard', {
    title: 'My interviews',
    upcoming,
    completed,
    pending,
    slots,
    mentor,
    defaultDate: h.addDays(h.today(), 1),
  });
});

router.post('/slots', (req, res) => {
  const mentorId = req.session.user.id;
  const { type, slot_date, start_time, duration, count, mode, location } = req.body;
  try {
    const mentor = db.prepare(`SELECT id, name, email, role, phone, can_technical, can_hr, active FROM users WHERE id=? AND role='mentor'`).get(mentorId);
    if (!mentor) throw new Error('Mentor account not found.');
    if (type !== 'technical' && type !== 'hr') throw new Error('Invalid interview domain. Must be technical or hr.');
    if (type === 'technical' && !mentor.can_technical) throw new Error('Your profile is not enabled for Technical interviews.');
    if (type === 'hr' && !mentor.can_hr) throw new Error('Your profile is not enabled for HR interviews.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slot_date)) throw new Error('Pick a valid date.');
    if (!/^\d{2}:\d{2}$/.test(start_time)) throw new Error('Pick a valid start time.');

    if (duration !== undefined && duration !== null && String(duration).trim() !== '') {
      const minsVal = Number(duration);
      if (isNaN(minsVal) || minsVal <= 0) throw new Error('Duration must be a positive number.');
    }
    const mins = Number(duration) || 30;
    const n = Math.min(Math.max(Number(count) || 1, 1), 20);
    const [sh, sm] = start_time.split(':').map(Number);
    let made = 0, skipped = 0;
    const ins = db.prepare(`INSERT INTO slots (mentor_id,type,slot_date,start_time,end_time,mode,location)
                            VALUES (?,?,?,?,?,?,?)`);
    const loc = (location && location.trim()) ? location.trim() : h.generateMeetingLink(type);
    if (/<[^>]+>/.test(loc)) throw new Error('Location cannot contain HTML tags.');

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
      `).get(mentorId, slot_date, e_time, s_time);

      if (overlap) {
        skipped++;
        continue;
      }

      try {
        ins.run(mentorId, type, slot_date, s_time, e_time, mode || 'Online', loc);
        made++;
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) skipped++; else throw e;
      }
    }
    logAudit(req, 'MENTOR_CREATE_SLOTS', { type, count: made });
    flash(req, made ? 'ok' : 'err',
      `${made} slot(s) published for your profile${skipped ? `, ${skipped} skipped (overlapping slot)` : ''}.`);
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/mentor');
});

router.get('/interview/:id', validateId('id'), (req, res) => {
  const iv = q.interviewById(Number(req.params.id));
  if (!iv || iv.mentor_id !== req.session.user.id) {
    return res.status(403).render('error', {
      title: 'Not your interview',
      message: 'You can only view interviews that the admin assigned to you.',
    });
  }
  res.render('mentor/interview', { title: `${h.titleCase(iv.type)} — ${iv.student_name}`, iv, error: null, form: {} });
});

router.post('/interview/:id/attendance', validateId('id'), (req, res) => {
  const iv = q.interviewById(Number(req.params.id));
  if (!iv || iv.mentor_id !== req.session.user.id) {
    return res.status(403).render('error', { title: 'Not your interview', message: 'Access denied.' });
  }
  if (iv.eval_id) {
    flash(req, 'err', 'Cannot alter attendance after an evaluation has already been submitted.');
    return res.redirect('/mentor/interview/' + iv.id);
  }
  const attendance = req.body.attendance === 'absent' ? 'absent' : 'attended';

  if (attendance === 'attended') {
    db.prepare(`UPDATE interviews SET attendance='attended', status='completed',
                completed_at=COALESCE(completed_at, datetime('now')),
                attendance_marked_at=datetime('now') WHERE id=?`).run(iv.id);
    logAudit(req, 'MENTOR_MARK_ATTENDANCE', { interview_id: iv.id, attendance: 'attended' });
    flash(req, 'ok', 'Candidate marked as Attended. You can now score the interview.');
  } else {
    db.prepare(`UPDATE interviews SET attendance='absent', status='completed',
                completed_at=COALESCE(completed_at, datetime('now')),
                attendance_marked_at=datetime('now') WHERE id=?`).run(iv.id);
    logAudit(req, 'MENTOR_MARK_ATTENDANCE', { interview_id: iv.id, attendance: 'absent' });
    flash(req, 'err', 'Candidate marked as Absent / No-Show.');
  }
  res.redirect('/mentor/interview/' + iv.id);
});

router.post('/interview/:id/complete', validateId('id'), (req, res) => {
  const iv = q.interviewById(Number(req.params.id));
  if (!iv || iv.mentor_id !== req.session.user.id) {
    return res.status(403).render('error', { title: 'Not your interview', message: 'Access denied.' });
  }
  if (iv.eval_id) {
    flash(req, 'err', 'Interview has already been completed and evaluated.');
    return res.redirect('/mentor/interview/' + iv.id);
  }
  if (iv.status !== 'booked') flash(req, 'err', 'Only booked interviews can be marked as completed.');
  else {
    db.prepare(`UPDATE interviews SET attendance='attended', status='completed', completed_at=datetime('now'),
                attendance_marked_at=datetime('now') WHERE id=?`).run(iv.id);
    logAudit(req, 'MENTOR_COMPLETE_INTERVIEW', { interview_id: iv.id });
    flash(req, 'ok', 'Marked as completed and attended. You can now submit the evaluation.');
  }
  res.redirect('/mentor/interview/' + iv.id);
});

router.post('/interview/:id/evaluate', validateId('id'), (req, res) => {
  const iv = q.interviewById(Number(req.params.id));
  if (!iv || iv.mentor_id !== req.session.user.id) {
    return res.status(403).render('error', { title: 'Not your interview', message: 'Access denied.' });
  }
  const rerender = (error) => res.status(400).render('mentor/interview', {
    title: 'Evaluate', iv, error, form: req.body,
  });

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
    if (e.message.includes('UNIQUE')) {
      return rerender('An evaluation has already been submitted for this interview.');
    }
    return rerender('Could not save evaluation: ' + e.message);
  }

  logAudit(req, 'MENTOR_SUBMIT_EVALUATION', { interview_id: iv.id, score: total });
  flash(req, 'ok', `Evaluation submitted — ${total}/${RUBRIC[iv.type].total}. The student can now see the result.`);
  res.redirect('/mentor');
});

module.exports = router;
