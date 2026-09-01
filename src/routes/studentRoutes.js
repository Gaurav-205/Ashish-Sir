'use strict';
const express = require('express');
const mongoose = require('mongoose');
const { Slot, Interview, User, StudentFeedback } = require('../models');
const q = require('../queries');
const h = require('../helpers');
const { requireRole } = require('../auth');
const google = require('../services/googleService');
const emailService = require('../services/emailService');
const { validateId, createRateLimiter } = require('../middleware/security');
const { logAudit } = require('../middleware/auditLog');

const router = express.Router();
router.use(requireRole('student'));

const actionLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30,
  message: 'Too many requests. Please wait a moment before trying again.',
});

const flash = (req, type, msg) => { req.session.flash = { type, msg }; };

function safeRedirectTarget(req, fallback = '/student') {
  const ref = req.headers.referer || req.headers.referrer;
  if (!ref) return fallback;
  try {
    if (h.isSafeLocalPath(ref)) return ref;
    const parsed = new URL(ref);
    const host = req.get('host');
    if (parsed.host === host) {
      const local = parsed.pathname + parsed.search;
      if (h.isSafeLocalPath(local)) return local;
    }
  } catch (_) {}
  return fallback;
}

router.get(['/', '/dashboard'], async (req, res) => {
  const s = await q.studentSummary(req.session.user.id, req._resolvedUser);
  if (!s || !s.student) {
    return req.session.destroy(() => res.redirect('/login'));
  }

  const now = h.nowMinute();
  const openSlots = await Slot.find({ status: 'open' }).lean();
  const upcomingOpen = openSlots.filter(sl => (sl.slot_date + ' ' + sl.start_time) > now);

  const open = {
    technical: upcomingOpen.filter(sl => sl.type === 'technical').length,
    hr: upcomingOpen.filter(sl => sl.type === 'hr').length,
  };

  res.render('student/dashboard', { title: 'My interviews', s, open });
});

router.get('/mentors', async (req, res) => {
  const s = await q.studentSummary(req.session.user.id, req._resolvedUser);
  if (!s || !s.student) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  const mentors = await q.mentorsWithOpenSlots();
  res.render('student/mentors', { title: 'Mentors directory', mentors, s });
});

router.get('/slots', async (req, res) => {
  const type = req.query.type === 'hr' ? 'hr' : 'technical';
  const mentorId = req.query.mentor ? req.query.mentor : null;
  const s = await q.studentSummary(req.session.user.id, req._resolvedUser);
  if (!s || !s.student) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  const already = type === 'hr' ? s.hr : s.technical;

  const now = h.nowMinute();
  const query = {
    type,
    status: 'open',
    mentor_id: { $ne: req.session.user.id },
  };
  if (mentorId) {
    query.mentor_id = mentorId;
  }

  const rawSlots = await Slot.find(query).populate('mentor_id', 'name email active').lean();
  const slots = rawSlots
    .filter(sl => sl.mentor_id && sl.mentor_id.active && (sl.slot_date + ' ' + sl.start_time) > now)
    .map(sl => ({
      ...sl,
      id: sl._id,
      mentor_name: sl.mentor_id.name,
      mentor_email: sl.mentor_id.email,
    }))
    .sort((a, b) => (a.slot_date + ' ' + a.start_time).localeCompare(b.slot_date + ' ' + b.start_time));

  const byDate = [];
  for (const slot of slots) {
    let g = byDate.find((x) => x.date === slot.slot_date);
    if (!g) { g = { date: slot.slot_date, slots: [] }; byDate.push(g); }
    g.slots.push(slot);
  }

  const limitCheck = await h.checkWeeklyInterviewLimit(null, req.session.user.id, type, h.today());
  const allMentors = await q.mentorsList();
  const filteredMentors = allMentors.filter(m => type === 'hr' ? m.can_hr : m.can_technical);

  res.render('student/slots', {
    title: `Book ${h.titleCase(type)} mock interview`,
    type,
    byDate,
    already,
    s,
    mentors: filteredMentors,
    selectedMentor: mentorId,
    mentorFilter: mentorId,
    limitCheck,
    isComplete: h.isStudentProfileComplete(s.student),
    missingFields: h.getMissingStudentProfileFields(s.student),
  });
});

router.post('/book', actionLimiter, async (req, res) => {
  const slotId = req.body.slot_id;
  const studentId = req.session.user.id;
  const student = await User.findById(studentId).lean();

  if (!student) return res.redirect('/login');

  if (!h.isStudentProfileComplete(student)) {
    const missing = h.getMissingStudentProfileFields(student);
    flash(req, 'err', `Profile Incomplete: Please fill out your ${missing.join(', ')} before booking.`);
    return res.redirect('/profile');
  }

  const slot = await Slot.findById(slotId).lean();
  if (!slot) {
    flash(req, 'err', 'Selected slot was not found.');
    return res.redirect('/student');
  }

  if (slot.status !== 'open') {
    flash(req, 'err', 'That slot was just taken by another student. Please pick another.');
    return res.redirect(`/student/slots?type=${slot.type}`);
  }

  if ((slot.slot_date + ' ' + slot.start_time) <= h.nowMinute()) {
    flash(req, 'err', 'Cannot book a slot in the past.');
    return res.redirect(`/student/slots?type=${slot.type}`);
  }

  const limitCheck = await h.checkWeeklyInterviewLimit(null, studentId, slot.type, slot.slot_date);
  if (limitCheck.reached) {
    flash(req, 'err', `Weekly limit reached: You have already booked ${limitCheck.count} of ${limitCheck.maxAllowed} allowed ${slot.type} interview(s) for this week.`);
    return res.redirect('/student');
  }

  // Atomic claim: only one concurrent booker flips an open slot to booked.
  const updatedSlot = await Slot.findOneAndUpdate(
    { _id: slot._id, status: 'open' },
    { $set: { status: 'booked' } },
    { returnDocument: 'after' }
  );

  if (!updatedSlot) {
    flash(req, 'err', 'That slot was just taken by another student. Please pick another.');
    return res.redirect(`/student/slots?type=${slot.type}`);
  }

  const newIv = await Interview.create({
    slot_id: slot._id,
    student_id: student._id,
    mentor_id: slot.mentor_id,
    type: slot.type,
    status: 'booked',
    attendance: 'pending',
  });

  const mentor = await User.findById(slot.mentor_id).lean();

  // Trigger Google Meet / Calendar Sync
  google.syncCalendarEvent({
    student,
    mentor,
    slot,
    interviewId: newIv._id,
  }).catch((err) => console.error('Background Google calendar sync failed:', err));

  emailService.sendBookingConfirmation({
    student,
    mentor,
    slot,
    interview: newIv,
  }).catch((err) => console.error('Booking notification email failed:', err));

  logAudit(req, 'STUDENT_BOOK_SLOT', { slot_id: slot._id, interview_id: newIv._id, type: slot.type }, student._id);
  flash(req, 'ok', `Booked ${h.titleCase(slot.type)} interview with ${mentor ? mentor.name : 'Mentor'} on ${h.fmtDate(slot.slot_date)} at ${h.fmtTime(slot.start_time)}.`);
  res.redirect('/student');
});

async function cancelBooking(req, res) {
  const ivId = req.params.id || req.body.interview_id;
  const studentId = req.session.user.id;

  if (ivId && !mongoose.Types.ObjectId.isValid(ivId)) {
    flash(req, 'err', 'Active booking not found.');
    return res.redirect('/student');
  }

  const iv = await Interview.findOne({ _id: ivId, student_id: studentId, status: 'booked' }).populate('slot_id').populate('mentor_id').lean();
  if (!iv) {
    flash(req, 'err', 'Active booking not found.');
    return res.redirect('/student');
  }

  const slot = iv.slot_id;
  if (!slot) {
    flash(req, 'err', 'Associated slot not found.');
    return res.redirect('/student');
  }

  if ((slot.slot_date + ' ' + slot.start_time) <= h.nowMinute()) {
    flash(req, 'err', 'Cannot cancel a slot that has already started or passed.');
    return res.redirect('/student');
  }

  await Interview.findByIdAndUpdate(iv._id, { $set: { status: 'cancelled' } });
  await Slot.findByIdAndUpdate(slot._id, { $set: { status: 'open' } });

  const student = await User.findById(studentId).lean();
  const mentor = iv.mentor_id;

  if (iv.google_event_id) {
    google.removeCalendarEvent({
      eventId: iv.google_event_id,
      student,
      mentor,
    }).catch((err) => console.error('Background calendar event removal failed:', err));
  }

  emailService.sendCancellationNotice({
    student,
    mentor,
    slot,
    interview: iv,
    cancelledBy: 'student',
  }).catch((err) => console.error('Cancellation notice email failed:', err));

  logAudit(req, 'STUDENT_CANCEL_BOOKING', { interview_id: iv._id, slot_id: slot._id }, studentId);
  flash(req, 'ok', 'Booking cancelled. The slot has been released back for other students.');
  res.redirect('/student');
}

// The dashboard posts to /student/cancel/:id; keep the body-param form too.
router.post('/cancel', actionLimiter, cancelBooking);
router.post('/cancel/:id', actionLimiter, validateId('id'), cancelBooking);

async function submitFeedback(req, res) {
  const ivId = req.params.id;
  const studentId = req.session.user.id;

  const iv = await Interview.findOne({ _id: ivId, student_id: studentId }).lean();
  if (!iv) {
    flash(req, 'err', 'Interview not found.');
    return res.redirect('/student');
  }

  const satisfaction = Number(req.body.satisfaction);
  const structured = Number(req.body.structured);
  const hr_relevant = req.body.hr_relevant ? Number(req.body.hr_relevant) : null;
  const feedback_text = String(req.body.feedback_text || '').trim() || null;

  if (!Number.isInteger(satisfaction) || satisfaction < 1 || satisfaction > 5) {
    flash(req, 'err', 'Please provide a valid satisfaction rating (1 to 5 stars).');
    return res.redirect('/student');
  }

  if (structured !== 0 && structured !== 1) {
    flash(req, 'err', 'Please answer whether the interview was structured.');
    return res.redirect('/student');
  }

  const existing = await StudentFeedback.findOne({ interview_id: iv._id }).lean();
  if (existing) {
    await StudentFeedback.findByIdAndUpdate(existing._id, {
      $set: { satisfaction, structured, hr_relevant, feedback_text, submitted_at: new Date() },
    });
  } else {
    await StudentFeedback.create({
      interview_id: iv._id,
      student_id: studentId,
      mentor_id: iv.mentor_id,
      satisfaction,
      structured,
      hr_relevant,
      feedback_text,
    });
  }

  logAudit(req, 'STUDENT_SUBMIT_FEEDBACK', { interview_id: iv._id, satisfaction }, studentId);
  flash(req, 'ok', 'Thank you for submitting your feedback!');
  res.redirect('/student');
}

// Templates post to /student/feedback/:id; /student/interview/:id/feedback kept for the API/tests.
router.post('/interview/:id/feedback', actionLimiter, validateId('id'), submitFeedback);
router.post('/feedback/:id', actionLimiter, validateId('id'), submitFeedback);

/**
 * JSON feed backing the live auto-refresh on the slot picker
 * (public/js/student-slots.js). Returns grouped upcoming open slots for the
 * given type plus the single earliest one and the student's booking gates.
 */
router.get('/api/slots/available', async (req, res) => {
  const type = req.query.type === 'hr' ? 'hr' : 'technical';
  const mentorId = req.query.mentor && mongoose.Types.ObjectId.isValid(req.query.mentor) ? req.query.mentor : null;
  const studentId = req.session.user.id;

  const student = req._resolvedUser || await User.findById(studentId).lean();
  const now = h.nowMinute();

  const query = { type, status: 'open', mentor_id: { $ne: studentId } };
  if (mentorId) query.mentor_id = mentorId;

  const rawSlots = await Slot.find(query).populate('mentor_id', 'name email active').lean();
  const slots = rawSlots
    .filter((sl) => sl.mentor_id && sl.mentor_id.active && (sl.slot_date + ' ' + sl.start_time) > now)
    .map((sl) => ({
      id: String(sl._id),
      slot_date: sl.slot_date,
      start_time: sl.start_time,
      end_time: sl.end_time,
      mode: sl.mode,
      mentor_name: sl.mentor_id.name,
      timeFormatted: `${h.fmtTime(sl.start_time)} – ${h.fmtTime(sl.end_time)}`,
    }))
    .sort((a, b) => (a.slot_date + ' ' + a.start_time).localeCompare(b.slot_date + ' ' + b.start_time));

  const byDate = [];
  for (const sl of slots) {
    let g = byDate.find((x) => x.date === sl.slot_date);
    if (!g) { g = { date: sl.slot_date, dateFormatted: h.fmtDate(sl.slot_date), slots: [] }; byDate.push(g); }
    g.slots.push(sl);
  }

  const limitCheck = await h.checkWeeklyInterviewLimit(null, studentId, type, h.today());
  const earliest = slots[0]
    ? { ...slots[0], slotFormatted: `${h.fmtDate(slots[0].slot_date)} · ${slots[0].timeFormatted}` }
    : null;

  res.json({
    byDate,
    earliest,
    profileComplete: h.isStudentProfileComplete(student),
    limitReached: limitCheck.reached,
    weeklyCount: limitCheck.count,
    maxAllowed: limitCheck.maxAllowed,
  });
});

router.get('/results', async (req, res) => {
  const s = await q.studentSummary(req.session.user.id, req._resolvedUser);
  if (!s || !s.student) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  const { RUBRIC, GRAND_TOTAL } = require('../rubric');
  res.render('student/results', {
    title: 'My performance & scorecard',
    s,
    RUBRIC,
    GRAND_TOTAL,
  });
});

module.exports = router;
