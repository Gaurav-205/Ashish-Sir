'use strict';
const mongoose = require('mongoose');
const { User, Slot, Interview, Evaluation, StudentFeedback } = require('./models');
const h = require('./helpers');
const { RUBRIC, GRAND_TOTAL } = require('./rubric');

async function interviewsForStudent(studentId) {
  const ivs = await Interview.find({ student_id: studentId, status: { $ne: 'cancelled' } })
    .populate('slot_id')
    .populate('mentor_id', 'name email')
    .populate('student_id', 'name email roll_no branch squad resume_url')
    .lean();

  const results = [];
  for (const iv of ivs) {
    const evalDoc = await Evaluation.findOne({ interview_id: iv._id }).lean();
    const sfDoc = await StudentFeedback.findOne({ interview_id: iv._id }).lean();
    results.push(flattenInterview(iv, evalDoc, sfDoc));
  }

  return results.sort((a, b) => (a.slot_date + ' ' + a.start_time).localeCompare(b.slot_date + ' ' + b.start_time));
}

async function interviewsForMentor(mentorId, status = null) {
  const query = { mentor_id: mentorId };
  if (status) query.status = status;

  const ivs = await Interview.find(query)
    .populate('slot_id')
    .populate('mentor_id', 'name email')
    .populate('student_id', 'name email roll_no branch squad resume_url')
    .lean();

  const results = [];
  for (const iv of ivs) {
    const evalDoc = await Evaluation.findOne({ interview_id: iv._id }).lean();
    const sfDoc = await StudentFeedback.findOne({ interview_id: iv._id }).lean();
    results.push(flattenInterview(iv, evalDoc, sfDoc));
  }

  return results.sort((a, b) => (a.slot_date + ' ' + a.start_time).localeCompare(b.slot_date + ' ' + b.start_time));
}

async function interviewById(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const iv = await Interview.findById(id)
    .populate('slot_id')
    .populate('mentor_id', 'name email')
    .populate('student_id', 'name email roll_no branch squad resume_url')
    .lean();
  if (!iv) return null;

  const evalDoc = await Evaluation.findOne({ interview_id: iv._id }).lean();
  const sfDoc = await StudentFeedback.findOne({ interview_id: iv._id }).lean();
  return flattenInterview(iv, evalDoc, sfDoc);
}

async function allInterviews(filters = {}) {
  const query = {};
  if (filters.status) query.status = filters.status;
  else query.status = { $ne: 'cancelled' };

  if (filters.type) query.type = filters.type;
  if (filters.attendance) query.attendance = filters.attendance;
  if (filters.mentor) query.mentor_id = filters.mentor;

  const ivs = await Interview.find(query)
    .populate('slot_id')
    .populate('mentor_id', 'name email')
    .populate('student_id', 'name email roll_no branch squad resume_url')
    .lean();

  const results = [];
  for (const iv of ivs) {
    const evalDoc = await Evaluation.findOne({ interview_id: iv._id }).lean();
    const sfDoc = await StudentFeedback.findOne({ interview_id: iv._id }).lean();
    results.push(flattenInterview(iv, evalDoc, sfDoc));
  }

  return results.sort((a, b) => (b.slot_date + ' ' + b.start_time).localeCompare(a.slot_date + ' ' + a.start_time));
}

function flattenInterview(iv, evalDoc = null, sfDoc = null) {
  const slot = iv.slot_id || {};
  const mentor = iv.mentor_id || {};
  const student = iv.student_id || {};

  return {
    ...iv,
    id: iv._id,
    slot_id: slot._id || iv.slot_id,
    mentor_id: mentor._id || iv.mentor_id,
    student_id: student._id || iv.student_id,
    slot_date: slot.slot_date || '',
    start_time: slot.start_time || '',
    end_time: slot.end_time || '',
    mode: slot.mode || 'Online',
    location: slot.location || 'Google Meet',
    mentor_name: mentor.name || '',
    mentor_email: mentor.email || '',
    student_name: student.name || '',
    student_email: student.email || '',
    roll_no: student.roll_no || '',
    branch: student.branch || '',
    squad: student.squad || '',
    resume_url: student.resume_url || '',
    eval_id: evalDoc ? evalDoc._id : null,
    resume_marks: evalDoc ? evalDoc.resume_marks : null,
    project_marks: evalDoc ? evalDoc.project_marks : null,
    dsa_marks: evalDoc ? evalDoc.dsa_marks : null,
    behaviour_marks: evalDoc ? evalDoc.behaviour_marks : null,
    hr_perf_marks: evalDoc ? evalDoc.hr_perf_marks : null,
    score: evalDoc ? evalDoc.total : null,
    feedback: evalDoc ? evalDoc.feedback : null,
    submitted_at: evalDoc ? evalDoc.submitted_at : null,
    student_feedback_id: sfDoc ? sfDoc._id : null,
    feedback_satisfaction: sfDoc ? sfDoc.satisfaction : null,
    feedback_structured: sfDoc ? sfDoc.structured : null,
    feedback_hr_relevant: sfDoc ? sfDoc.hr_relevant : null,
    feedback_comments: sfDoc ? sfDoc.feedback_text : null,
    feedback_submitted_at: sfDoc ? sfDoc.submitted_at : null,
  };
}

/** Per-student roll-up used by student dashboard, admin reports and exports. */
async function studentSummary(studentId, existingStudent = null) {
  const student = existingStudent || await User.findById(studentId).lean();
  if (!student) return null;
  student.id = student._id;

  const history = await interviewsForStudent(student._id);
  const currentWeek = h.getWeekRange();

  const currentWeekIvs = history.filter((iv) => iv.slot_date >= currentWeek.start && iv.slot_date <= currentWeek.end);
  const byType = { technical: null, hr: null };

  for (const iv of currentWeekIvs) {
    if (!byType[iv.type] || (byType[iv.type].eval_id == null && iv.eval_id != null)) {
      byType[iv.type] = iv;
    }
  }

  for (const t of ['technical', 'hr']) {
    if (!byType[t]) {
      const latest = history.find((iv) => iv.type === t);
      if (latest) byType[t] = latest;
    }
  }

  const scored = (iv) => (iv && iv.status === 'completed' && iv.eval_id != null);
  const techScore = scored(byType.technical) ? byType.technical.score : null;
  const hrScore   = scored(byType.hr)        ? byType.hr.score        : null;
  const done = techScore != null && hrScore != null;
  const total = done ? techScore + hrScore : null;

  return {
    student,
    technical: byType.technical,
    hr: byType.hr,
    history,
    currentWeek,
    techScore, hrScore, total,
    percent: done ? Math.round((total / GRAND_TOTAL) * 1000) / 10 : null,
    bookedCount: history.length,
    completedCount: history.filter((i) => i.status === 'completed').length,
    attendedCount: history.filter((i) => i.attendance === 'attended').length,
    absentCount: history.filter((i) => i.attendance === 'absent').length,
    evaluatedCount: history.filter((i) => i.eval_id != null).length,
    allBooked: !!(byType.technical && byType.hr),
    allEvaluated: done,
    profileComplete: h.isStudentProfileComplete(student),
    missingFields: h.getMissingStudentProfileFields(student),
  };
}

async function allStudentSummaries() {
  const students = await User.find({ role: 'student' }).sort({ name: 1 }).lean();
  const allIvs = await allInterviews();

  const ivsByStudent = {};
  for (const iv of allIvs) {
    const sId = String(iv.student_id);
    if (!ivsByStudent[sId]) ivsByStudent[sId] = [];
    ivsByStudent[sId].push(iv);
  }

  return students.map((student) => {
    student.id = student._id;
    const list = ivsByStudent[String(student._id)] || [];
    const sortedList = [...list].sort((a, b) => (a.slot_date + ' ' + a.start_time).localeCompare(b.slot_date + ' ' + b.start_time));
    const history = [...list].sort((a, b) => (b.slot_date + ' ' + b.start_time).localeCompare(a.slot_date + ' ' + a.start_time));

    const byType = { technical: null, hr: null };
    for (const iv of sortedList) {
      if (!byType[iv.type]) {
        byType[iv.type] = iv;
      } else if (iv.eval_id != null) {
        byType[iv.type] = iv;
      } else if (byType[iv.type].eval_id == null && iv.attendance === 'attended') {
        byType[iv.type] = iv;
      } else if (byType[iv.type].eval_id == null && byType[iv.type].attendance !== 'attended') {
        byType[iv.type] = iv;
      }
    }

    const scored = (iv) => (iv && iv.status === 'completed' && iv.eval_id != null);
    const techScore = scored(byType.technical) ? byType.technical.score : null;
    const hrScore   = scored(byType.hr)        ? byType.hr.score        : null;
    const done = techScore != null && hrScore != null;
    const total = done ? techScore + hrScore : null;

    return {
      student,
      technical: byType.technical,
      hr: byType.hr,
      history,
      techScore, hrScore, total,
      percent: done ? Math.round((total / GRAND_TOTAL) * 1000) / 10 : null,
      bookedCount: sortedList.length,
      completedCount: sortedList.filter((i) => i.status === 'completed').length,
      attendedCount: sortedList.filter((i) => i.attendance === 'attended').length,
      absentCount: sortedList.filter((i) => i.attendance === 'absent').length,
      evaluatedCount: sortedList.filter((i) => i.eval_id != null).length,
      allBooked: !!(byType.technical && byType.hr),
      allEvaluated: done,
      profileComplete: h.isStudentProfileComplete(student),
      missingFields: h.getMissingStudentProfileFields(student),
    };
  });
}

async function adminStats() {
  const [students, mentors, slots, openSlots, booked, completed, attended, absent, evaluated, fullyBookedAgg] = await Promise.all([
    User.countDocuments({ role: 'student' }),
    User.countDocuments({ role: 'mentor' }),
    Slot.countDocuments({ status: { $ne: 'cancelled' } }),
    Slot.countDocuments({ status: 'open' }),
    Interview.countDocuments({ status: 'booked' }),
    Interview.countDocuments({ status: 'completed' }),
    Interview.countDocuments({ attendance: 'attended' }),
    Interview.countDocuments({ attendance: 'absent' }),
    Evaluation.countDocuments(),
    Interview.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: '$student_id', types: { $addToSet: '$type' } } },
      { $match: { 'types.1': { $exists: true } } },
      { $count: 'count' },
    ]),
  ]);

  const fullyBooked = (fullyBookedAgg && fullyBookedAgg[0]) ? fullyBookedAgg[0].count : 0;

  return {
    students,
    mentors,
    slots,
    openSlots,
    booked,
    completed,
    attended,
    absent,
    evaluated,
    fullyBooked,
  };
}

async function mentorsList(type) {
  const query = {
    $or: [{ role: 'mentor' }, { can_technical: 1 }, { can_hr: 1 }],
    active: 1,
  };
  if (type === 'hr') query.can_hr = 1;
  else if (type === 'technical') query.can_technical = 1;

  const list = await User.find(query).sort({ name: 1 }).lean();
  return list.map(m => ({ ...m, id: m._id }));
}

async function mentorsWithOpenSlots() {
  const now = h.nowMinute();
  const mentors = await mentorsList();
  const openSlots = await Slot.find({
    status: 'open',
  }).lean();

  const upcomingOpen = openSlots.filter(s => (s.slot_date + ' ' + s.start_time) > now);

  return mentors.map((m) => {
    const mSlots = upcomingOpen.filter(s => String(s.mentor_id) === String(m._id));
    const techSlots = mSlots.filter(s => s.type === 'technical');
    const hrSlots = mSlots.filter(s => s.type === 'hr');
    return {
      ...m,
      id: m._id,
      tech_open_slots: techSlots.length,
      hr_open_slots: hrSlots.length,
      total_open_slots: mSlots.length,
    };
  });
}

function computeTotal(type, body) {
  let total = 0;
  for (const c of RUBRIC[type].criteria) {
    const v = Number(body[c.key]);
    if (!Number.isInteger(v) || v < 0 || v > c.max) {
      throw new Error(`${c.label} must be a whole number between 0 and ${c.max}.`);
    }
    total += v;
  }
  return total;
}

module.exports = {
  interviewsForStudent,
  interviewsForMentor,
  interviewById,
  allInterviews,
  studentSummary,
  allStudentSummaries,
  adminStats,
  mentorsList,
  mentorsWithOpenSlots,
  computeTotal,
};
