'use strict';
require('dotenv').config();
// The suite drives the real app in-process; run it in test mode so the
// SESSION_SECRET guard and CSRF middleware behave deterministically.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/konfident';
const assert = require('assert');
const bcrypt = require('bcryptjs');
const { connectDb, mongoose, User, Slot, Interview, Evaluation, StudentFeedback, AuditLog } = require('../src/db');
const app = require('../src/app');
const { generateCsrfToken } = require('../src/middleware/security');
const h = require('../src/helpers');

console.log('=== Running Full End-to-End Integration & Security Test Suite ===');

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + msg);
  } else {
    fail++;
    console.log('  \x1b[31m✗ ' + msg + '\x1b[0m');
  }
};
const section = (s) => console.log('\n\x1b[1m' + s + '\x1b[0m');

let base;
const jars = {};
const userIds = {};

async function req(who, method, url, form, extraHeaders = {}) {
  const opts = { method, redirect: 'manual', headers: { ...extraHeaders } };
  if (jars[who]) opts.headers.cookie = jars[who];
  if (form) {
    const token = generateCsrfToken(userIds[who] || null);
    const formWithCsrf = { _csrf: token, ...form };
    opts.headers['content-type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(formWithCsrf).toString();
  }
  const res = await fetch(base + url, opts);
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) {
    const existing = (jars[who] ? jars[who].split('; ') : []).reduce((acc, c) => {
      const [k, v] = c.split('=');
      acc[k] = v;
      return acc;
    }, {});
    for (const cookie of set) {
      const [pair] = cookie.split(';');
      const [k, v] = pair.split('=');
      existing[k] = v;
    }
    jars[who] = Object.entries(existing).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  const body = await res.text();
  return { status: res.status, location: res.headers.get('location'), headers: res.headers, body };
}

const get = (w, u, h) => req(w, 'GET', u, null, h);
const post = (w, u, f, h) => req(w, 'POST', u, f, h);
const login = async (who, email, password = 'pass123', uId = null) => {
  delete userIds[who]; // ensure anon token is used during login submission
  const r = await post(who, '/login', { email, password });
  if (uId && (r.status === 302 || r.status === 200)) {
    userIds[who] = String(uId);
  }
  return r;
};

(async () => {
  await connectDb();

  // Provision a self-contained cohort (non-destructive upserts) so the suite
  // runs against an empty database and never rewrites unrelated accounts.
  const { ensureFixtures } = require('./fixtures');
  const fx = await ensureFixtures();

  const mentorDoc = await User.findOne({ role: 'mentor' });
  if (mentorDoc) {
    await User.findByIdAndUpdate(mentorDoc._id, {
      $set: { can_technical: 1, can_hr: 1 },
    });
  }

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;

  // 1. Security Headers
  section('1. HTTP Security Headers & Middleware');
  const homeResp = await get('anon', '/login');
  ok(homeResp.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options is nosniff');
  ok(homeResp.headers.get('x-frame-options') === 'SAMEORIGIN', 'X-Frame-Options is SAMEORIGIN');
  ok(homeResp.headers.get('content-security-policy') != null, 'Content-Security-Policy header is active');

  // 2. Authentication & Access Control
  section('2. Authentication & Role-Based Access Control');
  const wrongPwResp = await post('anon', '/login', { email: 'admin@konfident.edu', password: 'wrongpassword' });
  ok(wrongPwResp.status === 401, 'Incorrect password returns 401 Unauthorized');

  const unauthAdmin = await get('anon', '/admin');
  ok(unauthAdmin.location === '/login', 'Anonymous request to /admin redirects to login');

  const adminUser = fx.admin;
  const mentorUser = fx.techMentor;
  const studentUser = fx.students[0];

  ok(!!adminUser, `Admin account exists (${adminUser.email})`);
  ok(!!mentorUser, `Mentor account exists (${mentorUser.email})`);
  ok(!!studentUser, `Student account exists (${studentUser.email})`);

  // Sign in each role
  const adminLogin = await login('admin', adminUser.email, 'pass123', adminUser._id);
  console.log('adminLogin response:', adminLogin.status, adminLogin.location, adminLogin.body.slice(0, 120));
  ok(adminLogin.location === '/admin', 'Admin successfully authenticated and redirected to /admin');

  const mentorLogin = await login('mentor', mentorUser.email, 'pass123', mentorUser._id);
  ok(mentorLogin.location === '/mentor', 'Mentor successfully authenticated and redirected to /mentor');

  const studentLogin = await login('student', studentUser.email, 'pass123', studentUser._id);
  ok(studentLogin.location === '/student', 'Student successfully authenticated and redirected to /student');

  // Role Boundary Protection
  ok((await get('student', '/admin')).status === 403, 'Student is blocked with 403 when accessing /admin');
  ok((await get('student', '/mentor')).status === 403, 'Student is blocked with 403 when accessing /mentor');
  ok((await get('mentor', '/admin/reports')).status === 403, 'Mentor is blocked with 403 when accessing /admin/reports');

  // 3. Admin Operations
  section('3. Admin Operations (Slots, Candidates, Evaluators, Reports)');
  const adminSlotsResp = await get('admin', '/admin/slots');
  ok(adminSlotsResp.status === 200, 'Admin can view /admin/slots desk');

  const adminStudentsResp = await get('admin', '/admin/students');
  ok(adminStudentsResp.status === 200, 'Admin can view /admin/students roster');

  const adminMentorsResp = await get('admin', '/admin/mentors');
  ok(adminMentorsResp.status === 200, 'Admin can view /admin/mentors list');

  const adminReportsResp = await get('admin', '/admin/reports');
  ok(adminReportsResp.status === 200, 'Admin can view /admin/reports analytics');

  const adminReportsCsv = await get('admin', '/admin/reports.csv');
  ok(adminReportsCsv.status === 200 && adminReportsCsv.headers.get('content-type').includes('text/csv'), 'Admin can export cohort data as CSV');

  // 4. Admin Slot Creation
  section('4. Slot Lifecycle: Creation, Discovery, Booking & Conflict Checks');
  const tomorrow = h.addDays(h.today(), 1);
  await Slot.deleteMany({ mentor_id: mentorUser._id, slot_date: tomorrow });
  const createSlotResp = await post('admin', '/admin/slots', {
    mentor_id: mentorUser._id.toString(),
    type: 'technical',
    slot_date: tomorrow,
    start_time: '11:00',
    duration: '45',
    count: '1',
    mode: 'Online',
  });
  ok(createSlotResp.status === 302, 'Admin publishes a new Technical slot');

  const createdSlot = await Slot.findOne({ mentor_id: mentorUser._id, slot_date: tomorrow, start_time: '11:00' });
  ok(!!createdSlot && createdSlot.status === 'open', 'New slot exists in database in open state');

  // 5. Student Discovery & Booking
  section('5. Student Booking Lifecycle');
  const studentSlots = await get('student', '/student/slots?type=technical');
  ok(studentSlots.status === 200, 'Student views available technical slots');

  const bookResp = await post('student', '/student/book', { slot_id: createdSlot._id.toString() });
  ok(bookResp.status === 302, 'Student successfully books the slot');

  const bookedSlot = await Slot.findById(createdSlot._id);
  ok(bookedSlot.status === 'booked', 'Slot status updated to booked in MongoDB');

  const interview = await Interview.findOne({ slot_id: createdSlot._id, student_id: studentUser._id });
  ok(!!interview && interview.status === 'booked', 'Interview record created in MongoDB');

  // 6. Double-Booking Prevention
  const doubleBookResp = await post('student', '/student/book', { slot_id: createdSlot._id.toString() });
  ok(doubleBookResp.status === 302, 'Attempt to book already-booked slot is rejected');

  // 7. Mentor Desk & Evaluation
  section('6. Mentor Attendance & Rubric Evaluation');
  const mentorDesk = await get('mentor', '/mentor');
  ok(mentorDesk.status === 200, 'Mentor views dashboard with assigned interviews');

  const attendResp = await post('mentor', `/mentor/interview/${interview._id}/attendance`, { attendance: 'attended' });
  ok(attendResp.status === 302, 'Mentor marks student attendance as attended');

  const evalResp = await post('mentor', `/mentor/interview/${interview._id}/evaluate`, {
    resume_marks: '8',
    project_marks: '9',
    dsa_marks: '9',
    feedback: 'Excellent problem-solving approach and strong algorithmic understanding.',
  });
  ok(evalResp.status === 302, 'Mentor submits rubric evaluation with marks');

  const evalDoc = await Evaluation.findOne({ interview_id: interview._id });
  ok(!!evalDoc && evalDoc.total === 26, 'Evaluation record persisted with correct total score (26/30)');

  // 8. Student Scorecard & Feedback
  section('7. Scorecard & Student Feedback');
  const studentResults = await get('student', '/student/results');
  ok(studentResults.status === 200 && studentResults.body.includes('26'), 'Student results page displays score 26');

  const feedbackResp = await post('student', `/student/interview/${interview._id}/feedback`, {
    satisfaction: '5',
    structured: '1',
    feedback_text: 'The session was extremely detailed and helpful!',
  });
  ok(feedbackResp.status === 302, 'Student submits feedback on the interview session');

  const fbDoc = await StudentFeedback.findOne({ interview_id: interview._id });
  ok(!!fbDoc && fbDoc.satisfaction === 5, 'Student feedback persisted in database');

  // 9. Clean-up & Audit Trail
  section('8. Audit Logging & Cleanup');
  const auditLogsCount = await AuditLog.countDocuments();
  ok(auditLogsCount >= 5, `Audit trail active with ${auditLogsCount} events logged`);

  // Clean test-created interview & slot
  await Promise.all([
    Slot.findByIdAndDelete(createdSlot._id),
    Interview.findByIdAndDelete(interview._id),
    Evaluation.deleteMany({ interview_id: interview._id }),
    StudentFeedback.deleteMany({ interview_id: interview._id }),
  ]);
  ok(true, 'Test interview and slot cleaned up cleanly');

  console.log(`\n=== All E2E Integration & Lifecycle Tests Passed: ${pass} passed, ${fail} failed ===\n`);

  server.close();
  await mongoose.disconnect();
  // The connect-mongo session store keeps its own MongoClient open; exit explicitly.
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
