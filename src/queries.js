'use strict';
const db = require('./db');
const { RUBRIC, GRAND_TOTAL } = require('./rubric');

const INTERVIEW_SELECT = `
  SELECT i.*, s.slot_date, s.start_time, s.end_time, s.mode, s.location,
         m.name AS mentor_name, m.email AS mentor_email,
         st.name AS student_name, st.email AS student_email, st.roll_no, st.branch, st.resume_url,
         e.id AS eval_id, e.resume_marks, e.project_marks, e.dsa_marks,
         e.behaviour_marks, e.hr_perf_marks, e.total AS score, e.feedback, e.submitted_at
    FROM interviews i
    JOIN slots s ON s.id = i.slot_id
    JOIN users m ON m.id = i.mentor_id
    JOIN users st ON st.id = i.student_id
    LEFT JOIN evaluations e ON e.interview_id = i.id
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
  const where = ["i.status <> 'cancelled'"];
  const args = [];
  if (filters.type)       { where.push('i.type = ?');       args.push(filters.type); }
  if (filters.status)     { where.push('i.status = ?');     args.push(filters.status); }
  if (filters.attendance) { where.push('i.attendance = ?'); args.push(filters.attendance); }
  if (filters.mentor)     { where.push('i.mentor_id = ?');  args.push(Number(filters.mentor)); }
  return db.prepare(`${INTERVIEW_SELECT} WHERE ${where.join(' AND ')}
                     ORDER BY s.slot_date DESC, s.start_time`).all(...args);
}

const USER_SAFE_COLS = `id, name, email, role, phone, roll_no, branch, resume_url,
                        can_technical, can_hr, active, google_id, google_calendar_enabled, created_at`;

/** Per-student roll-up used by student dashboard, admin reports and exports. */
function studentSummary(studentId) {
  const student = db.prepare(`SELECT ${USER_SAFE_COLS} FROM users WHERE id = ? AND role = 'student'`).get(studentId);
  if (!student) return null;
  const list = interviewsForStudent(studentId);
  const history = db.prepare(`${INTERVIEW_SELECT} WHERE i.student_id = ? AND i.status <> 'cancelled'
                               ORDER BY s.slot_date DESC, s.start_time DESC`).all(studentId);
  const byType = { technical: null, hr: null };
  for (const iv of list) byType[iv.type] = iv;

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
  
  const allIvs = db.prepare(`
    SELECT i.*, s.slot_date, s.start_time, s.end_time, s.mode, s.location,
           m.name AS mentor_name, m.email AS mentor_email,
           st.name AS student_name, st.email AS student_email, st.roll_no, st.branch, st.resume_url,
           e.id AS eval_id, e.resume_marks, e.project_marks, e.dsa_marks,
           e.behaviour_marks, e.hr_perf_marks, e.total AS score, e.feedback, e.submitted_at
      FROM interviews i
      JOIN slots s ON s.id = i.slot_id
      JOIN users m ON m.id = i.mentor_id
      JOIN users st ON st.id = i.student_id
      LEFT JOIN evaluations e ON e.interview_id = i.id
     WHERE i.status <> 'cancelled'
  `).all();

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
      byType[iv.type] = iv;
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
  const one = (sql, ...a) => db.prepare(sql).get(...a).c;
  return {
    students: one(`SELECT COUNT(*) c FROM users WHERE role='student'`),
    mentors:  one(`SELECT COUNT(*) c FROM users WHERE role='mentor'`),
    slots:    one(`SELECT COUNT(*) c FROM slots WHERE status<>'cancelled'`),
    openSlots: one(`SELECT COUNT(*) c FROM slots WHERE status='open'`),
    booked:   one(`SELECT COUNT(*) c FROM interviews WHERE status='booked'`),
    completed: one(`SELECT COUNT(*) c FROM interviews WHERE status='completed'`),
    attended:  one(`SELECT COUNT(*) c FROM interviews WHERE attendance='attended'`),
    absent:    one(`SELECT COUNT(*) c FROM interviews WHERE attendance='absent'`),
    evaluated: one(`SELECT COUNT(*) c FROM evaluations`),
    fullyBooked: one(`SELECT COUNT(*) c FROM (
        SELECT student_id FROM interviews WHERE status<>'cancelled'
        GROUP BY student_id HAVING COUNT(DISTINCT type) = 2)`),
  };
}

function mentorsList(type) {
  const col = type === 'hr' ? 'can_hr' : 'can_technical';
  const extra = type ? ` AND ${col} = 1` : '';
  return db.prepare(`SELECT ${USER_SAFE_COLS} FROM users WHERE role='mentor' AND active=1${extra} ORDER BY name`).all();
}

function mentorsWithOpenSlots() {
  return db.prepare(`
    SELECT m.id, m.name, m.email, m.phone, m.can_technical, m.can_hr, m.active,
      (SELECT COUNT(*) FROM slots s
        WHERE s.mentor_id = m.id AND s.status = 'open' AND s.type = 'technical'
          AND datetime(s.slot_date || ' ' || s.start_time) > datetime('now','localtime')) AS tech_open_slots,
      (SELECT COUNT(*) FROM slots s
        WHERE s.mentor_id = m.id AND s.status = 'open' AND s.type = 'hr'
          AND datetime(s.slot_date || ' ' || s.start_time) > datetime('now','localtime')) AS hr_open_slots,
      (SELECT COUNT(*) FROM slots s
        WHERE s.mentor_id = m.id AND s.status = 'open'
          AND datetime(s.slot_date || ' ' || s.start_time) > datetime('now','localtime')) AS total_open_slots
     FROM users m
    WHERE m.role = 'mentor' AND m.active = 1
    ORDER BY m.name
  `).all();
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
