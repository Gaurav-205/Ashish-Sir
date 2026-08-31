'use strict';
const db = require('./db');
const h = require('./helpers');
const { RUBRIC, GRAND_TOTAL } = require('./rubric');

const INTERVIEW_SELECT = `
  SELECT i.*, s.slot_date, s.start_time, s.end_time, s.mode, s.location,
         m.name AS mentor_name, m.email AS mentor_email,
         st.name AS student_name, st.email AS student_email, st.roll_no, st.branch, st.squad, st.resume_url,
         e.id AS eval_id, e.resume_marks, e.project_marks, e.dsa_marks,
         e.behaviour_marks, e.hr_perf_marks, e.total AS score, e.feedback, e.submitted_at,
         sf.id AS student_feedback_id, sf.satisfaction AS feedback_satisfaction,
         sf.structured AS feedback_structured, sf.hr_relevant AS feedback_hr_relevant,
         sf.feedback_text AS feedback_comments, sf.submitted_at AS feedback_submitted_at
    FROM interviews i
    JOIN slots s ON s.id = i.slot_id
    JOIN users m ON m.id = i.mentor_id
    JOIN users st ON st.id = i.student_id
    LEFT JOIN evaluations e ON e.interview_id = i.id
    LEFT JOIN student_feedbacks sf ON sf.interview_id = i.id
`;

function interviewsForStudent(studentId) {
  return db.prepare(`${INTERVIEW_SELECT} WHERE i.student_id = ? AND i.status <> 'cancelled'
                     ORDER BY s.slot_date, s.start_time`).all(studentId);
}
function interviewsForMentor(mentorId, status) {
  const extra = status ? ' AND i.status = ?' : '';
  const args = status ? [mentorId, status] : [mentorId];
  return db.prepare(`${INTERVIEW_SELECT} WHERE i.mentor_id = ?${extra}
                     ORDER BY s.slot_date, s.start_time`).all(...args);
}
function interviewById(id) {
  return db.prepare(`${INTERVIEW_SELECT} WHERE i.id = ?`).get(id);
}
function allInterviews(filters = {}) {
  const where = [];
  const args = [];
  if (filters.status) {
    where.push('i.status = ?');
    args.push(filters.status);
  } else {
    where.push("i.status <> 'cancelled'");
  }
  if (filters.type)       { where.push('i.type = ?');       args.push(filters.type); }
  if (filters.attendance) { where.push('i.attendance = ?'); args.push(filters.attendance); }
  if (filters.mentor)     { where.push('i.mentor_id = ?');  args.push(Number(filters.mentor)); }
  return db.prepare(`${INTERVIEW_SELECT} WHERE ${where.join(' AND ')}
                     ORDER BY s.slot_date DESC, s.start_time`).all(...args);
}

const USER_SAFE_COLS = `id, name, email, role, phone, roll_no, branch, squad, resume_url,
                        can_technical, can_hr, active, google_id, google_calendar_enabled, created_at`;

/** Per-student roll-up used by student dashboard, admin reports and exports. */
function studentSummary(studentId) {
  const student = db.prepare(`SELECT ${USER_SAFE_COLS} FROM users WHERE id = ?`).get(studentId);
  if (!student) return null;
  const history = db.prepare(`${INTERVIEW_SELECT} WHERE i.student_id = ? AND i.status <> 'cancelled'
                               ORDER BY s.slot_date DESC, s.start_time DESC`).all(studentId);
  const list = [...history].reverse();
  const byType = { technical: null, hr: null };
  for (const iv of list) {
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
    bookedCount: list.length,
    completedCount: list.filter((i) => i.status === 'completed').length,
    attendedCount: list.filter((i) => i.attendance === 'attended').length,
    absentCount: list.filter((i) => i.attendance === 'absent').length,
    evaluatedCount: list.filter((i) => i.eval_id != null).length,
    allBooked: !!(byType.technical && byType.hr),
    allEvaluated: done,
  };
}

function allStudentSummaries() {
  const students = db.prepare(`SELECT ${USER_SAFE_COLS} FROM users WHERE role = 'student' ORDER BY name`).all();
  
  const allIvs = db.prepare(`${INTERVIEW_SELECT} WHERE i.status <> 'cancelled'`).all();

  const ivsByStudent = {};
  for (const iv of allIvs) {
    if (!ivsByStudent[iv.student_id]) {
      ivsByStudent[iv.student_id] = [];
    }
    ivsByStudent[iv.student_id].push(iv);
  }

  return students.map((student) => {
    const list = ivsByStudent[student.id] || [];
    const sortedList = [...list].sort((a, b) => {
      const da = a.slot_date + ' ' + a.start_time;
      const dbStr = b.slot_date + ' ' + b.start_time;
      return da.localeCompare(dbStr);
    });
    const history = [...list].sort((a, b) => {
      const da = a.slot_date + ' ' + a.start_time;
      const dbStr = b.slot_date + ' ' + b.start_time;
      return dbStr.localeCompare(da);
    });

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
    };
  });
}

function adminStats() {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role='student') AS students,
      (SELECT COUNT(*) FROM users WHERE role='mentor') AS mentors,
      (SELECT COUNT(*) FROM slots WHERE status<>'cancelled') AS slots,
      (SELECT COUNT(*) FROM slots WHERE status='open') AS open_slots,
      (SELECT COUNT(*) FROM interviews WHERE status='booked') AS booked,
      (SELECT COUNT(*) FROM interviews WHERE status='completed') AS completed,
      (SELECT COUNT(*) FROM interviews WHERE attendance='attended') AS attended,
      (SELECT COUNT(*) FROM interviews WHERE attendance='absent') AS absent,
      (SELECT COUNT(*) FROM evaluations) AS evaluated,
      (SELECT COUNT(*) FROM (
        SELECT student_id FROM interviews WHERE status<>'cancelled'
        GROUP BY student_id HAVING COUNT(DISTINCT type) = 2
      ) AS fb) AS fully_booked
  `).get();
  return {
    students: Number(row ? row.students : 0) || 0,
    mentors:  Number(row ? row.mentors : 0) || 0,
    slots:    Number(row ? row.slots : 0) || 0,
    openSlots: Number(row ? row.open_slots : 0) || 0,
    booked:   Number(row ? row.booked : 0) || 0,
    completed: Number(row ? row.completed : 0) || 0,
    attended:  Number(row ? row.attended : 0) || 0,
    absent:    Number(row ? row.absent : 0) || 0,
    evaluated: Number(row ? row.evaluated : 0) || 0,
    fullyBooked: Number(row ? row.fully_booked : 0) || 0,
  };
}

function mentorsList(type) {
  const col = type === 'hr' ? 'can_hr' : 'can_technical';
  const extra = type ? ` AND ${col} = 1` : ' AND (can_technical=1 OR can_hr=1)';
  return db.prepare(`SELECT ${USER_SAFE_COLS} FROM users WHERE (role='mentor' OR can_technical=1 OR can_hr=1) AND active=1${extra} ORDER BY name`).all();
}

function mentorsWithOpenSlots() {
  const now = h.nowMinute();
  return db.prepare(`
    SELECT m.id, m.name, m.email, m.can_technical, m.can_hr, m.active,
      COUNT(CASE WHEN s.status = 'open' AND s.type = 'technical' AND (s.slot_date || ' ' || s.start_time) > ? THEN 1 END) AS tech_open_slots,
      COUNT(CASE WHEN s.status = 'open' AND s.type = 'hr' AND (s.slot_date || ' ' || s.start_time) > ? THEN 1 END) AS hr_open_slots,
      COUNT(CASE WHEN s.status = 'open' AND (s.slot_date || ' ' || s.start_time) > ? THEN 1 END) AS total_open_slots
    FROM users m
    LEFT JOIN slots s ON s.mentor_id = m.id
    WHERE (m.role = 'mentor' OR m.can_technical = 1 OR m.can_hr = 1) AND m.active = 1
    GROUP BY m.id, m.name, m.email, m.can_technical, m.can_hr, m.active
    ORDER BY m.name
  `).all(now, now, now).map((m) => ({
    ...m,
    tech_open_slots: Number(m.tech_open_slots) || 0,
    hr_open_slots: Number(m.hr_open_slots) || 0,
    total_open_slots: Number(m.total_open_slots) || 0,
  }));
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
  interviewsForStudent, interviewsForMentor, interviewById, allInterviews,
  studentSummary, allStudentSummaries, adminStats, mentorsList, mentorsWithOpenSlots, computeTotal,
};
