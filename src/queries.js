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
  if (filters.type)   { where.push('i.type = ?');   args.push(filters.type); }
  if (filters.status) { where.push('i.status = ?'); args.push(filters.status); }
  if (filters.mentor) { where.push('i.mentor_id = ?'); args.push(Number(filters.mentor)); }
  return db.prepare(`${INTERVIEW_SELECT} WHERE ${where.join(' AND ')}
                     ORDER BY s.slot_date DESC, s.start_time`).all(...args);
}

/** Per-student roll-up used by student dashboard, admin reports and exports. */
function studentSummary(studentId) {
  const student = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'student'`).get(studentId);
  if (!student) return null;
  const list = interviewsForStudent(studentId);
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
    techScore, hrScore, total,
    percent: done ? Math.round((total / GRAND_TOTAL) * 1000) / 10 : null,
    bookedCount: list.length,
    completedCount: list.filter((i) => i.status === 'completed').length,
    evaluatedCount: list.filter((i) => i.eval_id != null).length,
    allBooked: !!(byType.technical && byType.hr),
    allEvaluated: done,
  };
}

function allStudentSummaries() {
  return db.prepare(`SELECT id FROM users WHERE role = 'student' ORDER BY name`)
    .all().map((r) => studentSummary(r.id));
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
    evaluated: one(`SELECT COUNT(*) c FROM evaluations`),
    fullyBooked: one(`SELECT COUNT(*) c FROM (
        SELECT student_id FROM interviews WHERE status<>'cancelled'
        GROUP BY student_id HAVING COUNT(DISTINCT type) = 2)`),
  };
}

function mentorsList(type) {
  const col = type === 'hr' ? 'can_hr' : 'can_technical';
  const extra = type ? ` AND ${col} = 1` : '';
  return db.prepare(`SELECT * FROM users WHERE role='mentor' AND active=1${extra} ORDER BY name`).all();
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
  studentSummary, allStudentSummaries, adminStats, mentorsList, computeTotal,
};
