'use strict';
const express = require('express');
const db = require('../db');
const q = require('../queries');
const h = require('../helpers');
const { requireRole } = require('../auth');
const { RUBRIC } = require('../rubric');

const router = express.Router();
router.use(requireRole('mentor'));

const flash = (req, type, msg) => { req.session.flash = { type, msg }; };

router.get('/', (req, res) => {
  const id = req.session.user.id;
  const all = q.interviewsForMentor(id);
  const upcoming = all.filter((i) => i.status === 'booked');
  const completed = all.filter((i) => i.status === 'completed');
  const pending = completed.filter((i) => i.eval_id == null);
  const slots = db.prepare(`SELECT * FROM slots WHERE mentor_id=? AND status='open'
                            AND datetime(slot_date || ' ' || start_time) > datetime('now','localtime')
                            ORDER BY slot_date, start_time`).all(id);
  res.render('mentor/dashboard', { title: 'My interviews', upcoming, completed, pending, slots });
});

router.get('/interview/:id', (req, res) => {
  const iv = q.interviewById(Number(req.params.id));
  if (!iv || iv.mentor_id !== req.session.user.id) {
    return res.status(403).render('error', {
      title: 'Not your interview',
      message: 'You can only view interviews that the admin assigned to you.',
    });
  }
  res.render('mentor/interview', { title: `${h.titleCase(iv.type)} — ${iv.student_name}`, iv, error: null, form: {} });
});

router.post('/interview/:id/attendance', (req, res) => {
  const iv = q.interviewById(Number(req.params.id));
  if (!iv || iv.mentor_id !== req.session.user.id) {
    return res.status(403).render('error', { title: 'Not your interview', message: 'Access denied.' });
  }
  const attendance = req.body.attendance === 'absent' ? 'absent' : 'attended';

  if (attendance === 'attended') {
    db.prepare(`UPDATE interviews SET attendance='attended', status='completed',
                completed_at=COALESCE(completed_at, datetime('now')),
                attendance_marked_at=datetime('now') WHERE id=?`).run(iv.id);
    flash(req, 'ok', 'Candidate marked as Attended. You can now score the interview.');
  } else {
    db.prepare(`UPDATE interviews SET attendance='absent',
                attendance_marked_at=datetime('now') WHERE id=?`).run(iv.id);
    flash(req, 'err', 'Candidate marked as Absent / No-Show.');
  }
  res.redirect('/mentor/interview/' + iv.id);
});

router.post('/interview/:id/complete', (req, res) => {
  const iv = q.interviewById(Number(req.params.id));
  if (!iv || iv.mentor_id !== req.session.user.id) {
    return res.status(403).render('error', { title: 'Not your interview', message: 'Access denied.' });
  }
  if (iv.status !== 'booked') flash(req, 'err', 'Only booked interviews can be marked as completed.');
  else {
    db.prepare(`UPDATE interviews SET attendance='attended', status='completed', completed_at=datetime('now'),
                attendance_marked_at=datetime('now') WHERE id=?`).run(iv.id);
    flash(req, 'ok', 'Marked as completed and attended. You can now submit the evaluation.');
  }
  res.redirect('/mentor/interview/' + iv.id);
});

router.post('/interview/:id/evaluate', (req, res) => {
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

  flash(req, 'ok', `Evaluation submitted — ${total}/${RUBRIC[iv.type].total}. The student can now see the result.`);
  res.redirect('/mentor');
});

module.exports = router;
