'use strict';
require('dotenv').config();
const path = require('path');
const ejs = require('ejs');
const helpers = require('../src/helpers');
const { RUBRIC, GRAND_TOTAL, grade } = require('../src/rubric');

console.log('=== Running View Template Render Tests ===');

const viewsDir = path.join(__dirname, '..', 'views');

const mockLocals = {
  h: helpers,
  RUBRIC,
  GRAND_TOTAL,
  grade,
  user: { id: 'mock-1', name: 'Test Administrator', email: 'admin@test.com', role: 'admin' },
  path: '/admin',
  title: 'Test Page',
  csrfToken: 'test-token',
  flash: null,
  isDeveloper: true,
  isDualRole: false,
  activeRole: 'admin',
};

const templatesToTest = [
  { file: 'admin/dashboard.ejs', data: { stats: { students: 10, mentors: 5, slots: 20, openSlots: 10, booked: 5, completed: 5, attended: 4, absent: 1, evaluated: 5, fullyBooked: 3 }, upcoming: [], pendingEval: [], notBooked: [], studentSummaries: [] } },
  { file: 'admin/students.ejs', data: { summaries: [] } },
  { file: 'admin/student-detail.ejs', data: { s: { student: { id: '1', name: 'Test Student', email: 's@test.com', roll_no: 'R1', branch: 'CSE', active: 1 }, technical: null, hr: null, allEvaluated: false } } },
  { file: 'admin/mentors.ejs', data: { mentors: [] } },
  { file: 'admin/slots.ejs', data: { slots: [], total: 0, totalCount: 0, pageCount: 1, baseQuery: '', mentors: [], techMentors: [], hrMentors: [], technicalMentors: [], students: [], filter: { when: 'upcoming', date: '', mentor: '', type: '', status: '' }, mentorFilter: '', typeFilter: '', page: 1, totalPages: 1, defaultDate: '2026-09-01', today: '2026-08-31' } },
  { file: 'admin/interviews.ejs', data: { interviews: [], list: [], mentors: [], filters: {} } },
  { file: 'admin/reports.ejs', data: { summaries: [], doneCount: 0, avg: null, avgTech: null, avgHr: null, stats: { attended: 0 } } },
  { file: 'admin/audit.ejs', data: { logs: [], page: 1, totalPages: 1, totalCount: 0 } },
  { file: 'mentor/dashboard.ejs', data: { upcoming: [], completed: [], pending: [], slots: [], mentor: { id: '1', name: 'Test Mentor', email: 'm@test.com', can_technical: 1, can_hr: 1 }, defaultDate: '2026-09-01', today: '2026-08-31' } },
  { file: 'mentor/interview.ejs', data: { iv: { id: '1', type: 'technical', student_name: 'Test Student', student_email: 's@test.com', mode: 'Online', status: 'completed', attendance: 'attended', eval_id: null, slot_date: '2026-09-01', start_time: '09:00', end_time: '09:45' }, rubric: RUBRIC.technical, mentor: { id: '1', name: 'M' }, error: null, form: {} } },
  { file: 'student/dashboard.ejs', data: { s: { student: { name: 'Test Student', email: 's@test.com', squad: '116' }, currentWeek: { label: 'This Week' }, allEvaluated: false, profileComplete: true, allBooked: false, bookedCount: 0, attendedCount: 0, completedCount: 0, evaluatedCount: 0, technical: null, hr: null, missingFields: [] }, open: { technical: 5, hr: 5 } } },
  { file: 'student/mentors.ejs', data: { mentors: [], s: { student: { name: 'Test Student' } } } },
  { file: 'student/slots.ejs', data: { type: 'technical', byDate: [], already: null, s: { student: { name: 'Test Student' }, profileComplete: true, missingFields: [] }, mentors: [], selectedMentor: null, mentorFilter: null, limitCheck: { reached: false, count: 0, maxAllowed: 3, week: { label: 'This Week' } }, isComplete: true, missingFields: [] } },
  { file: 'student/results.ejs', data: { s: { student: { name: 'Test Student', roll_no: '101', branch: 'CSE' }, technical: null, hr: null, history: [], allEvaluated: false, currentWeek: { label: 'This Week' } } } },
  { file: 'landing.ejs', data: {} },
  { file: 'login.ejs', data: { error: null, email: '', googleConfigured: true } },
  { file: 'forgot-password.ejs', data: { sent: false, error: null, email: '', resetUrl: null } },
  { file: 'reset-password.ejs', data: { token: 'abc', error: null, email: 's@test.com' } },
  { file: 'profile.ejs', data: { me: { id: '1', name: 'Test User', email: 'test@test.com', role: 'admin' }, error: null, ok: null, googleConfigured: true } },
  { file: 'error.ejs', data: { message: 'Something' } },
];

let failed = 0;
(async () => {
  for (const t of templatesToTest) {
    const filePath = path.join(viewsDir, t.file);
    try {
      await ejs.renderFile(filePath, { ...mockLocals, ...t.data }, { root: viewsDir });
      console.log(`  \x1b[32m✓\x1b[0m ${t.file}`);
    } catch (err) {
      failed++;
      console.error(`  \x1b[31m✗\x1b[0m ${t.file}: ${err.message}`);
    }
  }
  console.log(`\nView Tests Summary: ${templatesToTest.length - failed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
})();
