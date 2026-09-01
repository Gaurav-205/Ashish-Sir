'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { Slot, Interview, User, Evaluation, StudentFeedback, AuditLog } = require('../models');
const q = require('../queries');
const h = require('../helpers');
const { requireRole } = require('../auth');
const { RUBRIC, GRAND_TOTAL } = require('../rubric');
const google = require('../services/googleService');
const emailService = require('../services/emailService');
const { validateId, createRateLimiter } = require('../middleware/security');
const { logAudit } = require('../middleware/auditLog');

const router = express.Router();
router.use(requireRole('admin'));

const actionLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 100,
  message: 'Too many administrative requests. Please wait a moment.',
});

const flash = (req, type, msg) => { req.session.flash = { type, msg }; };

/* ------------------------------ dashboard ------------------------------ */
router.get(['/', '/dashboard'], async (req, res) => {
  const stats = await q.adminStats();

  const bookedIvs = await Interview.find({ status: 'booked' })
    .populate('slot_id')
    .populate('student_id', 'name email')
    .populate('mentor_id', 'name email')
    .lean();

  const upcoming = bookedIvs
    .filter(iv => iv.slot_id)
    .map(iv => ({
      id: iv._id,
      type: iv.type,
      status: iv.status,
      slot_date: iv.slot_id.slot_date,
      start_time: iv.slot_id.start_time,
      end_time: iv.slot_id.end_time,
      location: iv.slot_id.location,
      student_name: iv.student_id ? iv.student_id.name : '',
      mentor_name: iv.mentor_id ? iv.mentor_id.name : '',
    }))
    .sort((a, b) => (a.slot_date + ' ' + a.start_time).localeCompare(b.slot_date + ' ' + b.start_time))
    .slice(0, 8);

  const completedIvs = await Interview.find({ status: 'completed' })
    .populate('slot_id')
    .populate('student_id', 'name email')
    .populate('mentor_id', 'name email')
    .lean();

  const pendingEval = [];
  for (const iv of completedIvs) {
    const hasEval = await Evaluation.exists({ interview_id: iv._id });
    if (!hasEval && iv.slot_id) {
      pendingEval.push({
        id: iv._id,
        type: iv.type,
        slot_date: iv.slot_id.slot_date,
        location: iv.slot_id.location,
        student_name: iv.student_id ? iv.student_id.name : '',
        mentor_name: iv.mentor_id ? iv.mentor_id.name : '',
      });
    }
  }

  const studentSummaries = await q.allStudentSummaries();
  const notBooked = studentSummaries
    .filter((s) => s.bookedCount < 2 && s.student.active)
    .sort((a, b) => a.bookedCount - b.bookedCount || a.student.name.localeCompare(b.student.name))
    .slice(0, 10)
    .map((s) => ({ ...s.student, booked: s.bookedCount }));

  res.render('admin/dashboard', { title: 'Admin dashboard', stats, upcoming, pendingEval: pendingEval.slice(0, 8), notBooked, studentSummaries, GRAND_TOTAL });
});

/* ------------------------------- students ------------------------------ */
router.get('/students', async (req, res) => {
  const summaries = await q.allStudentSummaries();
  res.render('admin/students', { title: 'Students', summaries, error: null });
});

router.post('/students', actionLimiter, async (req, res) => {
  const { name, email, password, roll_no, branch, squad, phone, resume_url } = req.body;
  try {
    const cleanName = String(name || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPw = String(password || '');

    if (!cleanName || cleanName.length < 2) throw new Error('Candidate name must be at least 2 characters.');
    if (!h.isValidEmail(cleanEmail)) throw new Error('Please enter a valid email address.');
    if (h.validatePassword(cleanPw)) throw new Error('Initial ' + h.validatePassword(cleanPw).toLowerCase());

    const cleanPhone = (phone && phone.trim()) ? phone.trim() : null;
    if (cleanPhone && !h.isValidPhone(cleanPhone)) {
      throw new Error('Please enter a valid contact phone number.');
    }

    const cleanResume = (resume_url && resume_url.trim()) ? resume_url.trim() : null;
    if (cleanResume && !h.isValidUrl(cleanResume)) {
      throw new Error('Resume link must be a valid URL starting with http:// or https://');
    }

    const existing = await User.findOne({ email: cleanEmail });
    if (existing) throw new Error('That email is already registered.');

    await User.create({
      name: cleanName,
      email: cleanEmail,
      password_hash: bcrypt.hashSync(cleanPw, 10),
      role: 'student',
      roll_no: roll_no ? String(roll_no).trim() : null,
      branch: branch ? String(branch).trim() : null,
      squad: squad ? String(squad).trim() : null,
      phone: cleanPhone,
      resume_url: cleanResume,
    });

    logAudit(req, 'ADMIN_CREATE_STUDENT', { email: cleanEmail });
    flash(req, 'ok', `Candidate ${cleanName} registered successfully.`);
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/admin/students');
});

router.post('/students/:id/update', validateId('id'), async (req, res) => {
  const { name, roll_no, branch, squad, phone, resume_url, active } = req.body;
  const cleanName = String(name || '').trim();
  if (!cleanName || cleanName.length < 2) {
    flash(req, 'err', 'Candidate name must be at least 2 characters.');
    return res.redirect('/admin/students/' + req.params.id);
  }

  const cleanPhone = (phone && phone.trim()) ? phone.trim() : null;
  if (cleanPhone && !h.isValidPhone(cleanPhone)) {
    flash(req, 'err', 'Please enter a valid contact phone number.');
    return res.redirect('/admin/students/' + req.params.id);
  }

  const cleanResume = (resume_url && resume_url.trim()) ? resume_url.trim() : null;
  if (cleanResume && !h.isValidUrl(cleanResume)) {
    flash(req, 'err', 'Resume link must be a valid URL starting with http:// or https://');
    return res.redirect('/admin/students/' + req.params.id);
  }

  const isActive = active ? 1 : 0;
  await User.findOneAndUpdate(
    { _id: req.params.id, role: 'student' },
    { $set: { name: cleanName, roll_no, branch, squad, phone: cleanPhone, resume_url: cleanResume, active: isActive } }
  );

  logAudit(req, 'ADMIN_UPDATE_STUDENT', { student_id: req.params.id });
  flash(req, 'ok', 'Student details updated successfully.');
  res.redirect('/admin/students/' + req.params.id);
});

router.get('/students/:id', validateId('id'), async (req, res) => {
  const s = await q.studentSummary(req.params.id);
  if (!s || !s.student) {
    flash(req, 'err', 'Candidate profile not found.');
    return res.redirect('/admin/students');
  }
  res.render('admin/student-detail', { title: s.student.name, s, GRAND_TOTAL });
});

/* ------------------------------- mentors ------------------------------- */
router.get('/mentors', async (req, res) => {
  const mentors = await q.mentorsWithOpenSlots();

  // Enrich each mentor with the counts the roster table shows.
  const [slotAgg, ivAgg] = await Promise.all([
    Slot.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: '$mentor_id', count: { $sum: 1 } } },
    ]),
    Interview.aggregate([
      { $group: { _id: { mentor_id: '$mentor_id', status: '$status' }, count: { $sum: 1 } } },
    ]),
  ]);
  const slotMap = new Map(slotAgg.map((r) => [String(r._id), r.count]));
  const upcomingMap = new Map();
  const doneMap = new Map();
  for (const r of ivAgg) {
    const key = String(r._id.mentor_id);
    if (r._id.status === 'booked') upcomingMap.set(key, (upcomingMap.get(key) || 0) + r.count);
    if (r._id.status === 'completed') doneMap.set(key, (doneMap.get(key) || 0) + r.count);
  }

  const enriched = mentors.map((m) => {
    const key = String(m._id || m.id);
    return {
      ...m,
      slot_count: slotMap.get(key) || 0,
      upcoming: upcomingMap.get(key) || 0,
      done: doneMap.get(key) || 0,
    };
  });

  res.render('admin/mentors', { title: 'Mentors', mentors: enriched, error: null });
});

router.post('/mentors', actionLimiter, async (req, res) => {
  const { name, email, password, phone, can_technical, can_hr } = req.body;
  try {
    const cleanName = String(name || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPw = String(password || '');

    if (!cleanName || cleanName.length < 2) throw new Error('Mentor name must be at least 2 characters.');
    if (!h.isValidEmail(cleanEmail)) throw new Error('Please enter a valid email address.');
    if (h.validatePassword(cleanPw)) throw new Error('Initial ' + h.validatePassword(cleanPw).toLowerCase());

    const cleanPhone = (phone && phone.trim()) ? phone.trim() : null;
    if (cleanPhone && !h.isValidPhone(cleanPhone)) {
      throw new Error('Please enter a valid contact phone number.');
    }

    const techFlag = can_technical ? 1 : 0;
    const hrFlag = can_hr ? 1 : 0;
    if (!techFlag && !hrFlag) throw new Error('Mentor must be enabled for Technical, HR, or both.');

    const existing = await User.findOne({ email: cleanEmail });
    if (existing) throw new Error('That email is already registered.');

    await User.create({
      name: cleanName,
      email: cleanEmail,
      password_hash: bcrypt.hashSync(cleanPw, 10),
      role: 'mentor',
      phone: cleanPhone,
      can_technical: techFlag,
      can_hr: hrFlag,
    });

    logAudit(req, 'ADMIN_CREATE_MENTOR', { email: cleanEmail });
    flash(req, 'ok', `Evaluator ${cleanName} registered successfully.`);
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/admin/mentors');
});

router.post('/mentors/:id/update', validateId('id'), async (req, res) => {
  const { name, phone, can_technical, can_hr, active } = req.body;
  const cleanName = String(name || '').trim();
  if (!cleanName || cleanName.length < 2) {
    flash(req, 'err', 'Mentor name must be at least 2 characters.');
    return res.redirect('/admin/mentors');
  }

  const cleanPhone = (phone && phone.trim()) ? phone.trim() : null;
  if (cleanPhone && !h.isValidPhone(cleanPhone)) {
    flash(req, 'err', 'Please enter a valid contact phone number.');
    return res.redirect('/admin/mentors');
  }

  const techFlag = can_technical ? 1 : 0;
  const hrFlag = can_hr ? 1 : 0;
  const isActive = active ? 1 : 0;

  await User.findByIdAndUpdate(req.params.id, {
    $set: { name: cleanName, phone: cleanPhone, can_technical: techFlag, can_hr: hrFlag, active: isActive },
  });

  logAudit(req, 'ADMIN_UPDATE_MENTOR', { mentor_id: req.params.id });
  flash(req, 'ok', 'Evaluator updated successfully.');
  res.redirect('/admin/mentors');
});

/**
 * Admin-initiated password reset for a mentor or student. The admin must
 * confirm with their own password; the target's other sessions are dropped.
 */
async function adminResetUserPassword(req, res, role, redirectTo) {
  const targetId = req.params.id;
  const adminPassword = String(req.body.admin_password || '');
  const newPassword = String(req.body.password || '');

  const fail = (msg) => { flash(req, 'err', msg); res.redirect(redirectTo(targetId)); };

  const admin = await User.findById(req.session.user.id).lean();
  if (!admin || !bcrypt.compareSync(adminPassword, admin.password_hash || '')) {
    logAudit(req, 'ADMIN_PASSWORD_RESET_DENIED', { target_id: targetId, role });
    return fail('Your admin password is incorrect. Password was not reset.');
  }

  const pwError = h.validatePassword(newPassword);
  if (pwError) return fail(pwError);

  const target = await User.findOne({ _id: targetId, role });
  if (!target) return fail(`${role === 'student' ? 'Candidate' : 'Evaluator'} account not found.`);

  target.password_hash = bcrypt.hashSync(newPassword, 10);
  target.sessions_invalid_before = Date.now();
  await target.save();

  logAudit(req, 'ADMIN_RESET_USER_PASSWORD', { target_id: targetId, role }, req.session.user.id);
  flash(req, 'ok', `Password reset for ${target.name}. They must sign in again with the new password.`);
  res.redirect(redirectTo(targetId));
}

router.post('/mentors/:id/reset-password', validateId('id'), (req, res) =>
  adminResetUserPassword(req, res, 'mentor', () => '/admin/mentors'));

router.post('/students/:id/reset-password', validateId('id'), (req, res) =>
  adminResetUserPassword(req, res, 'student', (id) => '/admin/students/' + id));

/* -------------------------------- slots -------------------------------- */
router.get('/slots', async (req, res) => {
  const when = req.query.when || 'upcoming';
  const filterDate = req.query.date || '';
  const mentorFilter = req.query.mentor || '';
  const typeFilter = req.query.type || '';
  const statusFilter = req.query.status || '';
  const page = Math.max(1, parseInt(req.query.page || 1, 10));
  const limit = 50;

  const now = h.nowMinute();
  const query = {};

  if (when === 'upcoming') {
    query.slot_date = { $gte: h.today() };
    if (!statusFilter) query.status = { $ne: 'cancelled' };
  } else if (when === 'past') {
    query.$or = [
      { slot_date: { $lt: h.today() } },
      { status: 'cancelled' },
    ];
  }

  if (filterDate) query.slot_date = filterDate;
  if (mentorFilter) query.mentor_id = mentorFilter;
  if (typeFilter) query.type = typeFilter;
  if (statusFilter) query.status = statusFilter;

  const totalCount = await Slot.countDocuments(query);
  const rawSlots = await Slot.find(query)
    .populate('mentor_id', 'name email')
    .sort({ slot_date: -1, start_time: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const bookedSlotIds = rawSlots.filter(s => s.status === 'booked').map(s => s._id);
  const interviews = bookedSlotIds.length ? await Interview.find({ slot_id: { $in: bookedSlotIds }, status: 'booked' })
    .populate('student_id', 'name email')
    .lean() : [];
  const ivMap = new Map(interviews.map(i => [String(i.slot_id), i]));

  const slots = rawSlots.map(sl => {
    const iv = ivMap.get(String(sl._id));
    return {
      ...sl,
      id: sl._id,
      mentor_name: sl.mentor_id ? sl.mentor_id.name : '',
      mentor_email: sl.mentor_id ? sl.mentor_id.email : '',
      student_name: iv && iv.student_id ? iv.student_id.name : '',
      student_email: iv && iv.student_id ? iv.student_id.email : '',
      student_id: iv && iv.student_id ? iv.student_id._id : null,
      interview_id: iv ? iv._id : null,
      attendance: iv ? iv.attendance : null,
    };
  });

  const allMentors = await q.mentorsList();
  const technicalMentors = allMentors.filter(m => m.can_technical);
  const hrMentors = allMentors.filter(m => m.can_hr);
  const rawStudents = await User.find({ role: 'student', active: 1 }).sort({ name: 1 }).lean();
  const students = rawStudents.map(st => ({ ...st, id: st._id }));

  const params = new URLSearchParams();
  if (when) params.set('when', when);
  if (filterDate) params.set('date', filterDate);
  if (mentorFilter) params.set('mentor', mentorFilter);
  if (typeFilter) params.set('type', typeFilter);
  if (statusFilter) params.set('status', statusFilter);
  const baseQuery = params.toString();

  res.render('admin/slots', {
    title: 'Slots management',
    slots,
    total: totalCount,
    totalCount,
    pageCount: Math.ceil(totalCount / limit) || 1,
    baseQuery,
    mentors: allMentors,
    techMentors: technicalMentors,
    hrMentors,
    technicalMentors,
    students,
    filter: {
      when,
      date: filterDate,
      mentor: mentorFilter,
      type: typeFilter,
      status: statusFilter,
    },
    mentorFilter,
    typeFilter,
    page,
    totalPages: Math.ceil(totalCount / limit) || 1,
    defaultDate: h.addDays(h.today(), 1),
    today: h.today(),
  });
});

router.post('/slots', actionLimiter, async (req, res) => {
  try {
    const { mentor_id, type, slot_date, end_date, repeat_days, exclude_weekends, start_time, duration, count, mode, location } = req.body;
    const mentor = await User.findById(mentor_id).lean();
    if (!mentor) throw new Error('Selected mentor account not found.');
    mentor.id = mentor._id;

    if (type !== 'technical' && type !== 'hr') throw new Error('Invalid interview domain.');
    if (type === 'technical' && !mentor.can_technical) throw new Error('This mentor is not enabled for Technical interviews.');
    if (type === 'hr' && !mentor.can_hr) throw new Error('This mentor is not enabled for HR interviews.');

    const selectedList = (req.body.selected_dates ? String(req.body.selected_dates).split(',') : [])
      .map(d => d.trim())
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const cleanDate = String(slot_date || (selectedList.length ? selectedList[0] : '')).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate) && !selectedList.length) throw new Error('Pick a valid starting date.');
    const cleanStart = h.normalizeTime(start_time);
    if (!cleanStart) throw new Error('Pick a valid start time.');

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
    if (!dates.length) throw new Error('No valid dates selected.');

    const durMin = parseInt(duration || 45, 10);
    const numSlots = parseInt(count || 1, 10);
    const cleanMode = mode === 'Offline' ? 'Offline' : 'Online';
    const customLoc = String(location || '').trim();

    const minDate = dates[0];
    const maxDate = dates[dates.length - 1];

    const existingSlots = await Slot.find({
      mentor_id: mentor._id,
      status: { $ne: 'cancelled' },
      slot_date: { $gte: minDate, $lte: maxDate },
    }).lean();

    let createdTotal = 0;
    const slotsToInsert = [];

    for (const d of dates) {
      let [hPart, mPart] = cleanStart.split(':').map(Number);
      for (let i = 0; i < numSlots; i++) {
        const startH = String(hPart).padStart(2, '0');
        const startM = String(mPart).padStart(2, '0');
        const curStart = `${startH}:${startM}`;
        
        let totalEndMin = hPart * 60 + mPart + durMin;
        if (totalEndMin > 24 * 60) totalEndMin = 24 * 60 - 1;
        const endH = String(Math.floor(totalEndMin / 60)).padStart(2, '0');
        const endM = String(totalEndMin % 60).padStart(2, '0');
        const curEnd = `${endH}:${endM}`;

        const isOverlap = existingSlots.some(s => s.slot_date === d && curStart < s.end_time && curEnd > s.start_time) ||
                          slotsToInsert.some(s => s.slot_date === d && curStart < s.end_time && curEnd > s.start_time);

        if (!isOverlap) {
          const slotLoc = customLoc || (cleanMode === 'Online' ? h.generateMeetingLink(curStart) : 'Room 101');
          slotsToInsert.push({
            mentor_id: mentor._id,
            type,
            slot_date: d,
            start_time: curStart,
            end_time: curEnd,
            mode: cleanMode,
            location: slotLoc,
            status: 'open',
          });
        }

        let nextStartMin = hPart * 60 + mPart + durMin;
        hPart = Math.floor(nextStartMin / 60);
        mPart = nextStartMin % 60;
        if (hPart >= 24) break;
      }
    }

    if (slotsToInsert.length > 0) {
      const inserted = await Slot.insertMany(slotsToInsert);
      createdTotal = inserted.length;

      for (const sl of inserted) {
        google.createSlotCalendarEvent({
          mentor,
          slot: {
            id: sl._id,
            type: sl.type,
            slot_date: sl.slot_date,
            start_time: sl.start_time,
            end_time: sl.end_time,
            mode: sl.mode,
            location: sl.location,
          },
        }).catch((err) => console.error('Background slot calendar creation failed:', err));
      }
    }

    logAudit(req, 'ADMIN_CREATE_SLOTS', { mentor_id: mentor._id, type, created_slots: createdTotal });
    flash(req, 'ok', `Published ${createdTotal} slot(s) for ${mentor.name}.`);
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/admin/slots');
});

router.post('/slots/:id/allot', validateId('id'), async (req, res) => {
  const slotId = req.params.id;
  const studentId = req.body.student_id;
  try {
    const slot = await Slot.findById(slotId);
    if (!slot || slot.status !== 'open') throw new Error('Slot is not available for allotment.');

    const student = await User.findById(studentId);
    if (!student || student.role !== 'student') throw new Error('Student account not found.');

    slot.status = 'booked';
    await slot.save();

    const iv = await Interview.create({
      slot_id: slot._id,
      student_id: student._id,
      mentor_id: slot.mentor_id,
      type: slot.type,
      status: 'booked',
      attendance: 'pending',
    });

    const mentor = await User.findById(slot.mentor_id).lean();

    google.syncCalendarEvent({
      student,
      mentor,
      slot,
      interviewId: iv._id,
    }).catch(() => {});

    emailService.sendBookingConfirmation({
      student,
      mentor,
      slot,
      interview: iv,
    }).catch(() => {});

    logAudit(req, 'ADMIN_ALLOT_SLOT', { slot_id: slot._id, student_id: student._id });
    flash(req, 'ok', `Slot successfully allotted to ${student.name}.`);
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/admin/slots');
});

router.post('/slots/:id/reschedule', validateId('id'), async (req, res) => {
  const slotId = req.params.id;
  try {
    const slot = await Slot.findById(slotId);
    if (!slot) throw new Error('Slot not found.');

    const { slot_date, start_time, end_time, mentor_id, mode } = req.body;
    if (slot_date) slot.slot_date = String(slot_date).trim();
    if (start_time) slot.start_time = h.normalizeTime(start_time) || slot.start_time;
    if (end_time) slot.end_time = h.normalizeTime(end_time) || slot.end_time;
    if (mentor_id && require('mongoose').Types.ObjectId.isValid(mentor_id)) {
      slot.mentor_id = mentor_id;
    }
    if (mode) slot.mode = mode;

    await slot.save();
    logAudit(req, 'ADMIN_RESCHEDULE_SLOT', { slot_id: slot._id });
    flash(req, 'ok', 'Slot rescheduled successfully.');
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/admin/slots');
});

router.post('/slots/:id/release', validateId('id'), async (req, res) => {
  const slotId = req.params.id;
  try {
    await Slot.findByIdAndUpdate(slotId, { $set: { status: 'open' } });
    await Interview.updateMany({ slot_id: slotId, status: 'booked' }, { $set: { status: 'cancelled' } });
    logAudit(req, 'ADMIN_RELEASE_SLOT', { slot_id: slotId });
    flash(req, 'ok', 'Booking released. Slot is now open.');
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/admin/slots');
});

router.post('/slots/:id/cancel', validateId('id'), async (req, res) => {
  const slotId = req.params.id;
  try {
    await Slot.findByIdAndUpdate(slotId, { $set: { status: 'cancelled' } });
    await Interview.updateMany({ slot_id: slotId, status: 'booked' }, { $set: { status: 'cancelled' } });
    logAudit(req, 'ADMIN_CANCEL_SLOT', { slot_id: slotId });
    flash(req, 'ok', 'Slot cancelled.');
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/admin/slots');
});

router.post('/slots/:id/reopen', validateId('id'), async (req, res) => {
  const slotId = req.params.id;
  try {
    await Slot.findByIdAndUpdate(slotId, { $set: { status: 'open' } });
    logAudit(req, 'ADMIN_REOPEN_SLOT', { slot_id: slotId });
    flash(req, 'ok', 'Slot reopened.');
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/admin/slots');
});

router.post('/slots/:id/delete', validateId('id'), async (req, res) => {
  const slotId = req.params.id;
  try {
    const slot = await Slot.findById(slotId).lean();
    if (!slot) throw new Error('Slot not found.');
    if (slot.status === 'booked') throw new Error('Cannot delete a booked slot. Cancel it instead.');

    await Slot.findByIdAndDelete(slot._id);
    logAudit(req, 'ADMIN_DELETE_SLOT', { slot_id: slotId });
    flash(req, 'ok', 'Slot permanently removed.');
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/admin/slots');
});

router.post('/slots/delete-all', async (req, res) => {
  try {
    await Slot.deleteMany({});
    await Interview.deleteMany({});
    logAudit(req, 'ADMIN_DELETE_ALL_SLOTS');
    flash(req, 'ok', 'All slots have been deleted.');
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/admin/slots');
});

/* ------------------------------ interviews ----------------------------- */
router.get('/interviews', async (req, res) => {
  const filters = {};
  if (req.query.status) filters.status = req.query.status;
  if (req.query.type) filters.type = req.query.type;
  if (req.query.attendance) filters.attendance = req.query.attendance;
  if (req.query.mentor) filters.mentor = req.query.mentor;

  const list = await q.allInterviews(filters);
  const mentors = await q.mentorsList();

  res.render('admin/interviews', {
    title: 'Interviews roster',
    interviews: list,
    list,
    mentors,
    filters: req.query,
  });
});

/**
 * Cancel a single booked interview from the admin side and reopen its slot so
 * another candidate can take it.
 */
router.post('/interviews/:id/cancel', validateId('id'), async (req, res) => {
  const ivId = req.params.id;
  try {
    const iv = await Interview.findById(ivId).populate('slot_id').populate('student_id').populate('mentor_id');
    if (!iv) throw new Error('Interview not found.');
    if (iv.status !== 'booked') throw new Error('Only an upcoming (booked) interview can be cancelled here.');

    const slot = iv.slot_id;
    iv.status = 'cancelled';
    await iv.save();
    if (slot && slot.status === 'booked') {
      slot.status = 'open';
      await slot.save();
    }

    if (iv.google_event_id) {
      google.removeCalendarEvent({
        eventId: iv.google_event_id,
        student: iv.student_id,
        mentor: iv.mentor_id,
      }).catch(() => {});
    }
    emailService.sendCancellationNotice({
      student: iv.student_id,
      mentor: iv.mentor_id,
      slot,
      interview: iv,
      cancelledBy: 'administrator',
    }).catch(() => {});

    logAudit(req, 'ADMIN_CANCEL_INTERVIEW', { interview_id: ivId, slot_id: slot ? slot._id : null });
    flash(req, 'ok', 'Booking cancelled. The slot has been reopened for booking.');
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect(h.safeRedirectTarget(req, '/admin/interviews'));
});

/* -------------------------------- audit -------------------------------- */
router.get('/audit', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || 1, 10));
  const limit = 50;

  const totalCount = await AuditLog.countDocuments();
  const rawLogs = await AuditLog.find()
    .populate('user_id', 'name email')
    .sort({ created_at: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const logs = rawLogs.map(l => ({
    ...l,
    id: l._id,
    user_name: l.user_id ? l.user_id.name : null,
    user_email: l.user_id ? l.user_id.email : null,
  }));

  res.render('admin/audit', {
    title: 'Security & audit log',
    logs,
    page,
    totalPages: Math.ceil(totalCount / limit) || 1,
    totalCount,
  });
});

/* ------------------------------- reports ------------------------------- */
router.get('/reports', async (req, res) => {
  const summaries = await q.allStudentSummaries();
  const stats = await q.adminStats();

  const evaluated = summaries.filter((s) => s.allEvaluated);
  const doneCount = evaluated.length;

  const totalScores = evaluated.map((s) => s.total);
  const avg = totalScores.length ? totalScores.reduce((a, b) => a + b, 0) / totalScores.length : null;

  const techScores = evaluated.map((s) => s.techScore).filter((v) => v != null);
  const avgTech = techScores.length ? techScores.reduce((a, b) => a + b, 0) / techScores.length : null;

  const hrScores = evaluated.map((s) => s.hrScore).filter((v) => v != null);
  const avgHr = hrScores.length ? hrScores.reduce((a, b) => a + b, 0) / hrScores.length : null;

  res.render('admin/reports', {
    title: 'Cohort score sheet & reports',
    summaries,
    doneCount,
    avg,
    avgTech,
    avgHr,
    stats,
    RUBRIC,
    GRAND_TOTAL,
  });
});

router.get('/reports.csv', async (req, res) => {
  const summaries = await q.allStudentSummaries();
  const rows = [];

  const headers = [
    'Roll No', 'Student Name', 'Email', 'Branch', 'Squad',
    ...RUBRIC.technical.criteria.map(c => `Tech: ${c.label}`),
    'Tech Total',
    ...RUBRIC.hr.criteria.map(c => `HR: ${c.label}`),
    'HR Total',
    'Grand Total', 'Percentage', 'Status',
  ];
  rows.push(headers.join(','));

  for (const s of summaries) {
    const st = s.student;
    const tech = s.technical || {};
    const hr = s.hr || {};

    const techMarks = RUBRIC.technical.criteria.map(c => tech[c.key] != null ? tech[c.key] : '');
    const hrMarks = RUBRIC.hr.criteria.map(c => hr[c.key] != null ? hr[c.key] : '');

    const row = [
      `"${st.roll_no || ''}"`,
      `"${st.name}"`,
      `"${st.email}"`,
      `"${st.branch || ''}"`,
      `"${st.squad || ''}"`,
      ...techMarks,
      s.techScore != null ? s.techScore : '',
      ...hrMarks,
      s.hrScore != null ? s.hrScore : '',
      s.total != null ? s.total : '',
      s.percent != null ? `${s.percent}%` : '',
      s.allEvaluated ? 'Completed' : 'Pending',
    ];
    rows.push(row.join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cohort_reports.csv"');
  res.send('\uFEFF' + rows.join('\n'));
});

module.exports = router;
