'use strict';
const express = require('express');
const { Slot, Interview, User, Evaluation, StudentFeedback } = require('../models');
const q = require('../queries');
const h = require('../helpers');
const { requireRole, isUserDeveloper, isDualRoleUser } = require('../auth');
const { RUBRIC } = require('../rubric');
const { validateId } = require('../middleware/security');
const { logAudit } = require('../middleware/auditLog');
const google = require('../services/googleService');
const emailService = require('../services/emailService');

const router = express.Router();
router.use(requireRole('mentor'));

const flash = (req, type, msg) => { req.session.flash = { type, msg }; };

router.get(['/', '/dashboard'], async (req, res) => {
  const id = req.session.user.id;
  const mentor = req._resolvedUser || await User.findById(id).lean();
  if (mentor) mentor.id = mentor._id;

  const all = await q.interviewsForMentor(id);
  const upcoming = all.filter((i) => i.status === 'booked');
  const completed = all.filter((i) => i.status === 'completed');
  const pending = completed.filter((i) => i.eval_id == null);

  const now = h.nowMinute();
  const rawSlots = await Slot.find({ mentor_id: id, status: 'open' }).lean();
  const slots = rawSlots
    .filter(sl => (sl.slot_date + ' ' + sl.start_time) > now)
    .map(sl => ({ ...sl, id: sl._id }))
    .sort((a, b) => (a.slot_date + ' ' + a.start_time).localeCompare(b.slot_date + ' ' + b.start_time));

  if (mentor && (mentor.google_access_token || mentor.google_calendar_enabled)) {
    google.syncUpcomingMentorSlots(mentor).catch(() => {});
  }

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

router.post('/slots', async (req, res) => {
  const mentorId = req.session.user.id;
  try {
    const { type, slot_date, end_date, repeat_days, exclude_weekends, start_time, duration, count, mode, location } = req.body;
    const mentor = await User.findById(mentorId).lean();
    if (!mentor) throw new Error('Mentor account not found.');
    mentor.id = mentor._id;

    const isDev = Boolean(res.locals.isDeveloper || isUserDeveloper(mentor));
    const isDual = isDualRoleUser(mentor);
    if (!isDev && mentor.role !== 'mentor' && !isDual) throw new Error('Mentor account not found.');
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
      const dur = parseInt(duration, 10);
      if (Number.isNaN(dur) || dur < 15 || dur > 180) throw new Error('Duration must be between 15 and 180 minutes.');
    }
    const durMin = parseInt(duration || 45, 10);
    const numSlots = parseInt(count || 1, 10);
    if (Number.isNaN(numSlots) || numSlots < 1 || numSlots > 16) throw new Error('Count must be between 1 and 16 slots per day.');

    const cleanMode = mode === 'Offline' ? 'Offline' : 'Online';
    let cleanLoc = String(location || '').trim();
    if (!cleanLoc) {
      cleanLoc = cleanMode === 'Online' ? h.generateMeetingLink(cleanStart) : 'Room 101';
    }

    const minDate = dates[0];
    const maxDate = dates[dates.length - 1];

    const existingSlots = await Slot.find({
      mentor_id: mentorId,
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
          slotsToInsert.push({
            mentor_id: mentorId,
            type,
            slot_date: d,
            start_time: curStart,
            end_time: curEnd,
            mode: cleanMode,
            location: cleanLoc,
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

    logAudit(req, 'MENTOR_CREATE_SLOTS', { type, dates_count: dates.length, created_slots: createdTotal }, mentorId);
    flash(req, 'ok', `Published ${createdTotal} slot(s) across ${dates.length} day(s).`);
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/mentor');
});

router.post('/slots/:id/edit', validateId('id'), async (req, res) => {
  const mentorId = req.session.user.id;
  const slotId = req.params.id;
  try {
    const slot = await Slot.findOne({ _id: slotId, mentor_id: mentorId }).lean();
    if (!slot) throw new Error('Slot not found.');
    if (slot.status !== 'open') throw new Error('Only open slots can be edited.');

    const { slot_date, start_time, duration, mode, location } = req.body;
    const cleanDate = String(slot_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) throw new Error('Invalid date.');
    const cleanStart = h.normalizeTime(start_time);
    if (!cleanStart) throw new Error('Invalid start time.');

    const durMin = parseInt(duration || 45, 10);
    if (Number.isNaN(durMin) || durMin < 15 || durMin > 180) throw new Error('Duration must be between 15 and 180 minutes.');

    let [hPart, mPart] = cleanStart.split(':').map(Number);
    let totalEndMin = hPart * 60 + mPart + durMin;
    if (totalEndMin > 24 * 60) totalEndMin = 24 * 60 - 1;
    const endH = String(Math.floor(totalEndMin / 60)).padStart(2, '0');
    const endM = String(totalEndMin % 60).padStart(2, '0');
    const cleanEnd = `${endH}:${endM}`;

    const overlap = await Slot.findOne({
      _id: { $ne: slot._id },
      mentor_id: mentorId,
      slot_date: cleanDate,
      status: { $ne: 'cancelled' },
      start_time: { $lt: cleanEnd },
      end_time: { $gt: cleanStart },
    }).lean();

    if (overlap) throw new Error(`Overlaps with an existing slot (${overlap.start_time} - ${overlap.end_time}).`);

    const cleanMode = mode === 'Offline' ? 'Offline' : 'Online';
    const cleanLoc = String(location || slot.location || (cleanMode === 'Online' ? h.generateMeetingLink(cleanStart) : 'Room 101')).trim();

    await Slot.findByIdAndUpdate(slot._id, {
      $set: {
        slot_date: cleanDate,
        start_time: cleanStart,
        end_time: cleanEnd,
        mode: cleanMode,
        location: cleanLoc,
      },
    });

    logAudit(req, 'MENTOR_EDIT_SLOT', { slot_id: slot._id, slot_date: cleanDate, start_time: cleanStart }, mentorId);
    flash(req, 'ok', 'Slot updated successfully.');
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/mentor');
});

router.post('/slots/:id/cancel', validateId('id'), async (req, res) => {
  const mentorId = req.session.user.id;
  const slotId = req.params.id;
  try {
    const slot = await Slot.findOne({ _id: slotId, mentor_id: mentorId }).lean();
    if (!slot) throw new Error('Slot not found.');

    await Slot.findByIdAndUpdate(slot._id, { $set: { status: 'cancelled' } });
    await Interview.updateMany({ slot_id: slot._id, status: 'booked' }, { $set: { status: 'cancelled' } });

    logAudit(req, 'MENTOR_CANCEL_SLOT', { slot_id: slot._id }, mentorId);
    flash(req, 'ok', 'Slot cancelled.');
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/mentor');
});

router.post('/slots/:id/delete', validateId('id'), async (req, res) => {
  const mentorId = req.session.user.id;
  const slotId = req.params.id;
  try {
    const slot = await Slot.findOne({ _id: slotId, mentor_id: mentorId }).lean();
    if (!slot) throw new Error('Slot not found.');
    if (slot.status === 'booked') throw new Error('Cannot permanently delete a booked slot. Cancel it instead.');

    await Slot.findByIdAndDelete(slot._id);
    logAudit(req, 'MENTOR_DELETE_SLOT', { slot_id: slotId }, mentorId);
    flash(req, 'ok', 'Slot permanently removed.');
  } catch (e) {
    flash(req, 'err', e.message);
  }
  res.redirect('/mentor');
});

router.get('/interview/:id', validateId('id'), async (req, res) => {
  const iv = await q.interviewById(req.params.id);
  if (!iv || (String(iv.mentor_id) !== String(req.session.user.id) && !res.locals.isDeveloper)) {
    flash(req, 'err', 'Interview not found.');
    return res.redirect('/mentor');
  }

  const mentor = await User.findById(iv.mentor_id).lean();
  if (mentor) mentor.id = mentor._id;

  const rubric = RUBRIC[iv.type];
  res.render('mentor/interview', {
    title: `${h.titleCase(iv.type)} interview · ${iv.student_name}`,
    iv,
    rubric,
    mentor,
  });
});

router.post('/interview/:id/attendance', validateId('id'), async (req, res) => {
  const ivId = req.params.id;
  const mentorId = req.session.user.id;

  const iv = await Interview.findById(ivId).populate('slot_id').lean();
  if (!iv || (String(iv.mentor_id) !== String(mentorId) && !res.locals.isDeveloper)) {
    flash(req, 'err', 'Interview not found.');
    return res.redirect('/mentor');
  }

  const attendance = req.body.attendance === 'absent' ? 'absent' : 'attended';
  await Interview.findByIdAndUpdate(iv._id, { $set: { attendance } });

  logAudit(req, 'MENTOR_UPDATE_ATTENDANCE', { interview_id: iv._id, attendance }, mentorId);
  flash(req, 'ok', `Attendance updated to ${attendance}.`);
  res.redirect(`/mentor/interview/${iv._id}`);
});

router.post('/interview/:id/evaluate', validateId('id'), async (req, res) => {
  const ivId = req.params.id;
  const mentorId = req.session.user.id;

  const iv = await Interview.findById(ivId).lean();
  if (!iv || (String(iv.mentor_id) !== String(mentorId) && !res.locals.isDeveloper)) {
    flash(req, 'err', 'Interview not found.');
    return res.redirect('/mentor');
  }

  try {
    const total = q.computeTotal(iv.type, req.body);
    const feedback = String(req.body.feedback || '').trim();

    const evalData = {
      interview_id: iv._id,
      mentor_id: mentorId,
      student_id: iv.student_id ? (iv.student_id._id || iv.student_id) : null,
      type: iv.type,
      resume_marks: iv.type === 'technical' ? Number(req.body.resume_marks ?? req.body.resume ?? 0) : 0,
      project_marks: iv.type === 'technical' ? Number(req.body.project_marks ?? req.body.project ?? 0) : 0,
      dsa_marks: iv.type === 'technical' ? Number(req.body.dsa_marks ?? req.body.dsa ?? 0) : 0,
      behaviour_marks: Number(req.body.behaviour_marks ?? req.body.behaviour ?? 0),
      hr_perf_marks: iv.type === 'hr' ? Number(req.body.hr_perf_marks ?? req.body.hr_perf ?? 0) : 0,
      total,
      feedback,
      submitted_at: new Date(),
    };

    const existingEval = await Evaluation.findOne({ interview_id: iv._id });
    if (existingEval) {
      await Evaluation.findByIdAndUpdate(existingEval._id, { $set: evalData });
    } else {
      await Evaluation.create(evalData);
    }

    await Interview.findByIdAndUpdate(iv._id, {
      $set: { status: 'completed', attendance: 'attended' },
    });

    logAudit(req, 'MENTOR_SUBMIT_EVALUATION', { interview_id: iv._id, total }, mentorId);
    flash(req, 'ok', 'Evaluation submitted successfully.');
    res.redirect(`/mentor/interview/${iv._id}`);
  } catch (e) {
    flash(req, 'err', e.message);
    res.redirect(`/mentor/interview/${iv._id}`);
  }
});

module.exports = router;
