'use strict';
/**
 * End-to-end test: boots the real server against a throwaway database,
 * then drives it over HTTP exactly as a browser would (cookies, forms, redirects).
 * Run with:  npm test
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const TMP = path.join(__dirname, '..', 'data', 'test.db');
for (const f of [TMP, TMP + '-wal', TMP + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
process.env.DB_PATH = TMP;
process.env.NODE_ENV = 'test';

execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'seed.js')],
  { env: { ...process.env, DB_PATH: TMP }, stdio: 'ignore' });

const db = require('../src/db');
const app = require('../src/app');
const h = require('../src/helpers');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗ ' + msg + '\x1b[0m'); } };
const section = (s) => console.log('\n\x1b[1m' + s + '\x1b[0m');

let base;
const jars = {};
async function req(who, method, url, form) {
  const opts = { method, redirect: 'manual', headers: {} };
  if (jars[who]) opts.headers.cookie = jars[who];
  if (form) {
    opts.headers['content-type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(form).toString();
  }
  const res = await fetch(base + url, opts);
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) jars[who] = set.map((c) => c.split(';')[0]).join('; ');
  const body = await res.text();
  return { status: res.status, location: res.headers.get('location'), headers: res.headers, body };
}
const get = (w, u) => req(w, 'GET', u);
const post = (w, u, f) => req(w, 'POST', u, f);
const login = async (who, email) => {
  const r = await post(who, '/login', { email, password: 'pass123' });
  return r;
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;

  section('Security & HTTP headers');
  const homeResp = await get('anon', '/login');
  ok(homeResp.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options is nosniff');
  ok(homeResp.headers.get('x-frame-options') === 'SAMEORIGIN', 'X-Frame-Options is SAMEORIGIN');
  ok(homeResp.headers.get('content-security-policy') != null, 'Content-Security-Policy is set');

  // Verify CSRF Protection is active outside 'test' environment
  process.env.NODE_ENV = 'development';
  const csrfBlockResp = await post('csrf_victim', '/login', { email: 'student@konfident.in', password: 'password' });
  ok(csrfBlockResp.status === 403, 'POST request without CSRF token is blocked with 403');
  process.env.NODE_ENV = 'test';

  section('Authentication & access control');
  ok((await post('x', '/login', { email: 'admin@konfident.in', password: 'wrong' })).status === 401,
     'wrong password is rejected');
  ok((await get('anon', '/admin')).location === '/login', 'anonymous user is redirected to login');

  // test role-aware redirect when a student logs in after an admin page was requested
  await get('anon_admin_attempt', '/admin/reports');
  const studentLoginAttempt = await post('anon_admin_attempt', '/login', { email: 'isha.agrawal.s.116@kalvium.community', password: 'pass123' });
  ok(studentLoginAttempt.location === '/student', 'student logging in after accessing admin URL is redirected to student dashboard');

  ok((await login('admin', 'utkarsha.kasar@kalvium.com')).location === '/admin', 'admin signs in');
  ok((await login('mentor', 'manav.verma@kalvium.com')).location === '/mentor', 'mentor signs in');
  ok((await login('hrmentor', 'muskan.srivastava@kalvium.com')).location === '/mentor', 'HR mentor signs in');
  ok((await login('student', 'isha.agrawal.s.116@kalvium.community')).location === '/student', 'student signs in');

  ok((await get('student', '/admin')).status === 403, 'student cannot open the admin module');
  ok((await get('student', '/mentor')).status === 403, 'student cannot open the mentor module');
  ok((await get('mentor', '/admin/reports')).status === 403, 'mentor cannot open admin reports');
  ok((await get('admin', '/student')).status === 403, 'admin cannot open the student module');

  const auditCount = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c;
  ok(auditCount > 0, 'security events are recorded in audit_logs table');
  const failedAudit = db.prepare("SELECT * FROM audit_logs WHERE action='AUTH_LOGIN_FAILED'").get();
  ok(!!failedAudit, 'failed login is recorded in audit_logs');
  const loginAudit = db.prepare("SELECT * FROM audit_logs WHERE action='AUTH_LOGIN_SUCCESS'").all();
  ok(loginAudit.length >= 4, 'successful logins are recorded in audit_logs with user metadata');

  section('Admin — creating mentors, students and slots');
  await post('admin', '/admin/mentors', {
    name: 'Test Mentor', email: 'test.mentor@konfident.in', password: 'pass123', can_technical: '1', can_hr: '1' });
  const tm = db.prepare(`SELECT * FROM users WHERE email='test.mentor@konfident.in'`).get();
  ok(!!tm && tm.role === 'mentor', 'admin adds a mentor');

  const dup = await post('admin', '/admin/mentors', {
    name: 'Dup', email: 'test.mentor@konfident.in', password: 'pass123', can_technical: '1' });
  ok(db.prepare(`SELECT COUNT(*) c FROM users WHERE email='test.mentor@konfident.in'`).get().c === 1,
     'duplicate email is rejected');

  await post('admin', '/admin/students', {
    name: 'Test Student', email: 'test.student@student.in', password: 'pass123', roll_no: 'KON2025099', branch: 'CSE' });
  const ts = db.prepare(`SELECT * FROM users WHERE email='test.student@student.in'`).get();
  ok(!!ts && ts.role === 'student', 'admin adds a student');

  const date = h.addDays(h.today(), 3);
  await post('admin', '/admin/slots', {
    type: 'technical', mentor_id: String(tm.id), slot_date: date, start_time: '09:00',
    duration: '30', count: '3', mode: 'Online', location: 'https://meet.test' });
  const made = db.prepare(`SELECT * FROM slots WHERE mentor_id=? AND type='technical' ORDER BY start_time`).all(tm.id);
  ok(made.length === 3, 'admin creates 3 back-to-back technical slots');
  ok(made[0].start_time === '09:00' && made[0].end_time === '09:30' && made[1].start_time === '09:30',
     'generated slot times are contiguous');

  await post('admin', '/admin/slots', {
    type: 'hr', mentor_id: String(tm.id), slot_date: date, start_time: '15:00', duration: '30', count: '2' });
  ok(db.prepare(`SELECT COUNT(*) c FROM slots WHERE mentor_id=? AND type='hr'`).get(tm.id).c === 2,
     'admin creates HR slots');

  const techOnly = db.prepare(`SELECT * FROM users WHERE email='arjun.mentor@konfident.in'`).get();
  const before = db.prepare(`SELECT COUNT(*) c FROM slots WHERE mentor_id=? AND type='hr'`).get(techOnly.id).c;
  await post('admin', '/admin/slots', {
    type: 'hr', mentor_id: String(techOnly.id), slot_date: date, start_time: '16:00', duration: '30', count: '1' });
  ok(db.prepare(`SELECT COUNT(*) c FROM slots WHERE mentor_id=? AND type='hr'`).get(techOnly.id).c === before,
     'a Technical-only mentor cannot be given HR slots');

  await post('admin', '/admin/slots', {
    type: 'technical', mentor_id: String(tm.id), slot_date: date, start_time: '09:15', duration: '30', count: '1' });
  ok(db.prepare(`SELECT COUNT(*) c FROM slots WHERE mentor_id=? AND slot_date=? AND start_time='09:15'`).get(tm.id, date).c === 0,
     'overlapping slots are rejected during creation');

  section('Student — booking rules');
  await login('newstudent', 'test.student@student.in');
  const slotA = made[0], slotB = made[1];

  await post('newstudent', '/student/book', { slot_id: String(slotA.id), type: 'technical' });
  const iv = db.prepare(`SELECT * FROM interviews WHERE student_id=? AND type='technical'`).get(ts.id);
  ok(!!iv, 'student books a technical slot');
  ok(db.prepare('SELECT status FROM slots WHERE id=?').get(slotA.id).status === 'booked',
     'the slot is marked booked');
  ok(iv.mentor_id === tm.id, 'the mentor is taken from the slot (student never picks one)');

  // second student tries the same slot
  await login('student2', 'aditya.talikoti.s.116@kalvium.community');
  const v = db.prepare(`SELECT * FROM users WHERE email='aditya.talikoti.s.116@kalvium.community'`).get();
  await post('student2', '/student/book', { slot_id: String(slotA.id), type: 'technical' });
  ok(db.prepare(`SELECT COUNT(*) c FROM interviews WHERE slot_id=? AND status<>'cancelled'`).get(slotA.id).c === 1,
     'a slot cannot be booked by two students');

  await post('newstudent', '/student/book', { slot_id: String(slotB.id), type: 'technical' });
  ok(db.prepare(`SELECT COUNT(*) c FROM interviews WHERE student_id=? AND type='technical' AND status<>'cancelled'`)
       .get(ts.id).c === 1, 'a student cannot book two technical interviews');

  const past = db.prepare(`SELECT * FROM slots WHERE status='open' AND type='technical' AND slot_date < ? LIMIT 1`)
    .get(h.today());
  if (past) {
    await post('student2', '/student/book', { slot_id: String(past.id), type: 'technical' });
    ok(db.prepare(`SELECT status FROM slots WHERE id=?`).get(past.id).status === 'open',
       'past slots cannot be booked');
  }

  const hrSlot = db.prepare(`SELECT * FROM slots WHERE mentor_id=? AND type='hr' ORDER BY start_time LIMIT 1`).get(tm.id);
  await post('newstudent', '/student/book', { slot_id: String(hrSlot.id), type: 'hr' });
  ok(db.prepare(`SELECT COUNT(*) c FROM interviews WHERE student_id=? AND status<>'cancelled'`).get(ts.id).c === 2,
     'student books the HR interview too (1 technical + 1 HR)');

  // Mentors directory and mentor-filtered slot booking
  const mentorsDir = await get('newstudent', '/student/mentors');
  ok(mentorsDir.status === 200 && mentorsDir.body.includes('Test Mentor'), 'student can view the mentors directory');
  const filteredSlots = await get('newstudent', `/student/slots?type=technical&mentor=${tm.id}`);
  ok(filteredSlots.status === 200, 'student can filter slots by specific mentor');

  // Auto-fetch slots JSON API
  const apiSlots = await get('newstudent', `/student/api/slots/available?type=technical`);
  ok(apiSlots.status === 200, 'platform auto-fetches available slots via API');
  const apiData = JSON.parse(apiSlots.body);
  ok(apiData.ok === true && Array.isArray(apiData.slots) && apiData.already !== undefined,
     'auto-fetch API returns structured available slots payload');

  const dash = await get('newstudent', '/student');
  ok(dash.body.includes('Test Mentor'), 'student dashboard shows the assigned mentor');
  ok(dash.body.includes('2 of 2 booked'), 'student dashboard shows booking progress');

  section('Mentor — conducting and scoring');
  await login('testmentor', 'test.mentor@konfident.in');
  const techIv = db.prepare(`SELECT * FROM interviews WHERE student_id=? AND type='technical'`).get(ts.id);

  const other = db.prepare(`SELECT i.id FROM interviews i WHERE i.mentor_id <> ? LIMIT 1`).get(tm.id);
  ok((await get('testmentor', '/mentor/interview/' + other.id)).status === 403,
     'a mentor cannot open an interview assigned to someone else');
  ok((await post('testmentor', '/mentor/interview/' + other.id + '/evaluate',
      { resume_marks: '9', project_marks: '9', dsa_marks: '9' })).status === 403,
     'a mentor cannot score an interview assigned to someone else');

  // Attendance tracking: test marking absent then attended
  await post('testmentor', '/mentor/interview/' + techIv.id + '/attendance', { attendance: 'absent' });
  ok(db.prepare('SELECT attendance FROM interviews WHERE id=?').get(techIv.id).attendance === 'absent',
     'mentor marks candidate absent');

  const absentScoreAttempt = await post('testmentor', '/mentor/interview/' + techIv.id + '/evaluate',
    { resume_marks: '8', project_marks: '8', dsa_marks: '8' });
  ok(absentScoreAttempt.status === 400, 'scoring is refused when candidate is marked absent');

  // Mark candidate attended (present)
  await post('testmentor', '/mentor/interview/' + techIv.id + '/attendance', { attendance: 'attended' });
  ok(db.prepare('SELECT attendance, status FROM interviews WHERE id=?').get(techIv.id).attendance === 'attended'
     && db.prepare('SELECT status FROM interviews WHERE id=?').get(techIv.id).status === 'completed',
     'mentor marks candidate attended and interview completes');

  const bad = await post('testmentor', '/mentor/interview/' + techIv.id + '/evaluate',
    { resume_marks: '12', project_marks: '5', dsa_marks: '5' });
  ok(bad.status === 400 && !db.prepare('SELECT * FROM evaluations WHERE interview_id=?').get(techIv.id),
     'marks above the category maximum are rejected');

  await post('testmentor', '/mentor/interview/' + techIv.id + '/evaluate',
    { resume_marks: '9', project_marks: '8', dsa_marks: '7', feedback: 'Solid fundamentals.' });
  const ev = db.prepare('SELECT * FROM evaluations WHERE interview_id=?').get(techIv.id);
  ok(ev && ev.total === 24, 'technical evaluation stored with total 24/30');

  await post('testmentor', '/mentor/interview/' + techIv.id + '/evaluate',
    { resume_marks: '10', project_marks: '10', dsa_marks: '10' });
  ok(db.prepare('SELECT COUNT(*) c FROM evaluations WHERE interview_id=?').get(techIv.id).c === 1,
     'an interview cannot be evaluated twice');

  const hrIv = db.prepare(`SELECT * FROM interviews WHERE student_id=? AND type='hr'`).get(ts.id);
  await post('testmentor', '/mentor/interview/' + hrIv.id + '/complete');
  await post('testmentor', '/mentor/interview/' + hrIv.id + '/evaluate',
    { behaviour_marks: '8', hr_perf_marks: '9', feedback: 'Confident communicator.' });
  ok(db.prepare('SELECT total FROM evaluations WHERE interview_id=?').get(hrIv.id).total === 17,
     'HR evaluation stored with total 17/20');

  section('Student results');
  const results = await get('newstudent', '/student/results');
  ok(results.body.includes('>24<') || results.body.includes('24<small'), 'results page shows the technical score');
  ok(results.body.includes('41'), 'results page shows the overall total of 41/50');
  ok(results.body.includes('Solid fundamentals.'), 'results page shows mentor feedback');

  const q = require('../src/queries');
  const sum = q.studentSummary(ts.id);
  ok(sum.techScore === 24 && sum.hrScore === 17 && sum.total === 41 && sum.percent === 82,
     'summary maths: 24 + 17 = 41/50 (82%)');

  section('Student Mentor Feedback');
  // Attempt feedback without hr_relevant on HR interview
  const badHrFb = await post('newstudent', '/student/feedback/' + hrIv.id, {
    satisfaction: '5',
    structured: '1'
    // missing hr_relevant
  });
  ok(badHrFb.status === 302, 'HR interview feedback missing hr_relevant redirects back');
  ok(!db.prepare('SELECT * FROM student_feedbacks WHERE interview_id=?').get(hrIv.id),
     'HR interview feedback without hr_relevant is refused');

  // Submit valid feedback for HR interview
  await post('newstudent', '/student/feedback/' + hrIv.id, {
    satisfaction: '5',
    structured: '1',
    hr_relevant: '1',
    feedback_text: 'Great HR interview session!'
  });
  const hrFbRow = db.prepare('SELECT * FROM student_feedbacks WHERE interview_id=?').get(hrIv.id);
  ok(hrFbRow && hrFbRow.satisfaction === 5 && hrFbRow.structured === 1 && hrFbRow.hr_relevant === 1,
     'student submits valid feedback for HR interview');

  // Submit valid feedback for Technical interview
  await post('newstudent', '/student/feedback/' + techIv.id, {
    satisfaction: '4',
    structured: '1',
    feedback_text: 'Very good technical discussion.'
  });
  const techFbRow = db.prepare('SELECT * FROM student_feedbacks WHERE interview_id=?').get(techIv.id);
  ok(techFbRow && techFbRow.satisfaction === 4 && techFbRow.structured === 1 && techFbRow.hr_relevant === null,
     'student submits valid feedback for Technical interview (hr_relevant is null)');

  // Update existing feedback
  await post('newstudent', '/student/feedback/' + techIv.id, {
    satisfaction: '5',
    structured: '1',
    feedback_text: 'Updated: Excellent technical session!'
  });
  const updatedTechFbRow = db.prepare('SELECT * FROM student_feedbacks WHERE interview_id=?').get(techIv.id);
  ok(updatedTechFbRow && updatedTechFbRow.satisfaction === 5 && updatedTechFbRow.feedback_text.includes('Updated'),
     'student can update existing mentor feedback');

  section('Admin — monitoring, rescheduling and reports');
  const rep = await get('admin', '/admin/reports');
  ok(rep.body.includes('Test Student') && rep.body.includes('41'), 'report shows the student total');
  const csv = await get('admin', '/admin/reports.csv');
  ok(csv.body.split('\n')[0].includes('Grand Total (/50)'), 'CSV export has the right header');
  ok(csv.body.includes('KON2025099') && csv.body.includes('"41"'), 'CSV export contains the student result');

  ok((await get('admin', '/admin/interviews?type=hr')).body.includes('HR'), 'admin can filter interviews by type');
  ok((await get('admin', '/admin/students/' + ts.id)).body.includes('Test Student'), 'admin can open a student record');

  // admin updates student details
  const updateRes = await post('admin', '/admin/students/' + ts.id + '/update', {
    name: 'Test Student Updated', roll_no: 'KON2025099', branch: 'CSE', active: '1'
  });
  ok(updateRes.location === '/admin/students/' + ts.id, 'admin updating student details redirects back to student detail view');

  // reschedule an upcoming booking
  await login('student3', 'digvijay.patil.s.116@kalvium.community');
  const nik = db.prepare(`SELECT * FROM users WHERE email='digvijay.patil.s.116@kalvium.community'`).get();
  const upcoming = db.prepare(`SELECT s.* FROM slots s JOIN interviews i ON i.slot_id=s.id
                               WHERE i.student_id=? AND i.status='booked' LIMIT 1`).get(nik.id);
  if (upcoming) {
    const newDate = h.addDays(upcoming.slot_date, 1);
    await post('admin', '/admin/slots/' + upcoming.id + '/reschedule', {
      slot_date: newDate, start_time: '17:00', end_time: '17:30',
      mentor_id: String(upcoming.mentor_id), mode: 'Offline', location: 'Room 204' });
    const moved = db.prepare('SELECT * FROM slots WHERE id=?').get(upcoming.id);
    ok(moved.slot_date === newDate && moved.start_time === '17:00', 'admin reschedules a booked slot');
    ok((await get('student3', '/student')).body.includes('Room 204'),
       'the student sees the rescheduled details');
  }

  // release a booking
  const rel = db.prepare(`SELECT s.id FROM slots s JOIN interviews i ON i.slot_id=s.id
                          WHERE i.status='booked' LIMIT 1`).get();
  await post('admin', '/admin/slots/' + rel.id + '/release');
  ok(db.prepare('SELECT status FROM slots WHERE id=?').get(rel.id).status === 'open'
     && db.prepare(`SELECT COUNT(*) c FROM interviews WHERE slot_id=? AND status<>'cancelled'`).get(rel.id).c === 0,
     'admin releases a booking and the slot reopens');

  // Admin directly allots an open slot to a student
  const studentToAllot = db.prepare(`SELECT u.* FROM users u WHERE u.role='student'
                                     AND (SELECT COUNT(*) FROM interviews i WHERE i.student_id=u.id AND i.type='technical' AND i.status<>'cancelled') = 0
                                     LIMIT 1`).get();
  if (studentToAllot) {
    const allotSlot = db.prepare(`SELECT * FROM slots WHERE status='open' AND type='technical'
                                  AND datetime(slot_date || ' ' || start_time) > datetime('now','localtime') LIMIT 1`).get();
    if (allotSlot) {
      await post('admin', '/admin/slots/' + allotSlot.id + '/allot', { student_id: String(studentToAllot.id) });
      ok(db.prepare('SELECT status FROM slots WHERE id=?').get(allotSlot.id).status === 'booked'
         && db.prepare(`SELECT student_id FROM interviews WHERE slot_id=? AND status<>'cancelled'`).get(allotSlot.id).student_id === studentToAllot.id,
         'admin can allot an open slot directly to a student');

      // Duplicate allotment of same type to same student is rejected
      const anotherOpen = db.prepare(`SELECT * FROM slots WHERE status='open' AND type='technical'
                                      AND datetime(slot_date || ' ' || start_time) > datetime('now','localtime') LIMIT 1`).get();
      if (anotherOpen) {
        await post('admin', '/admin/slots/' + anotherOpen.id + '/allot', { student_id: String(studentToAllot.id) });
        ok(db.prepare('SELECT status FROM slots WHERE id=?').get(anotherOpen.id).status === 'open',
           'duplicate allotment of same interview type to student is rejected');
      }
    }
  }

  // completed interviews are protected against cancel and reschedule
  const doneSlot = db.prepare(`SELECT s.id FROM slots s JOIN interviews i ON i.slot_id=s.id
                               WHERE i.status='completed' LIMIT 1`).get();
  await post('admin', '/admin/slots/' + doneSlot.id + '/cancel');
  ok(db.prepare('SELECT status FROM slots WHERE id=?').get(doneSlot.id).status !== 'cancelled',
     'a completed interview cannot be cancelled');

  const beforeResched = db.prepare('SELECT * FROM slots WHERE id=?').get(doneSlot.id);
  await post('admin', '/admin/slots/' + doneSlot.id + '/reschedule', {
    slot_date: h.addDays(beforeResched.slot_date, 2), start_time: '10:00', end_time: '10:30',
    mentor_id: String(beforeResched.mentor_id)
  });
  const afterResched = db.prepare('SELECT * FROM slots WHERE id=?').get(doneSlot.id);
  ok(afterResched.slot_date === beforeResched.slot_date, 'a completed interview cannot be rescheduled');

  section('Student cancel & rebook');
  const cIv = db.prepare(`SELECT i.*, u.email FROM interviews i
                          JOIN users u ON u.id = i.student_id
                          JOIN slots s ON s.id = i.slot_id
                          WHERE i.status='booked'
                            AND datetime(s.slot_date || ' ' || s.start_time) > datetime('now','localtime','+1 hour')
                          ORDER BY i.id LIMIT 1`).get();
  ok(!!cIv, 'there is an upcoming booking to cancel');
  await login('canceller', cIv.email);
  await post('canceller', '/student/cancel/' + cIv.id);
  ok(db.prepare('SELECT status FROM interviews WHERE id=?').get(cIv.id).status === 'cancelled'
     && db.prepare('SELECT status FROM slots WHERE id=?').get(cIv.slot_id).status === 'open',
     'student cancels a booking and the slot reopens');
  await post('canceller', '/student/book', { slot_id: String(cIv.slot_id), type: cIv.type });
  ok(db.prepare(`SELECT COUNT(*) c FROM interviews WHERE student_id=? AND type=? AND status<>'cancelled'`)
       .get(cIv.student_id, cIv.type).c === 1, 'student rebooks the same slot afterwards');

  const foreign = db.prepare(`SELECT * FROM interviews WHERE student_id<>? AND status='booked' LIMIT 1`)
    .get(cIv.student_id);
  ok(!!foreign, "another student's booking exists");
  await post('canceller', '/student/cancel/' + foreign.id);
  ok(db.prepare('SELECT status FROM interviews WHERE id=?').get(foreign.id).status === 'booked',
     "a student cannot cancel another student's booking");

  // a student cannot cancel a past booking
  await post('admin', '/admin/students', {
    name: 'Past Cancel Student', email: 'pastcancel.student@student.in', password: 'pass123', roll_no: 'KON2025199', branch: 'CSE' });
  const pcs = db.prepare(`SELECT * FROM users WHERE email='pastcancel.student@student.in'`).get();

  const pastDate = h.addDays(h.today(), -3);
  db.prepare(`INSERT INTO slots (mentor_id, type, slot_date, start_time, end_time, status)
              VALUES (?, 'technical', ?, '08:00', '08:30', 'booked')`)
    .run(tm.id, pastDate);
  const pSlot = db.prepare(`SELECT * FROM slots WHERE mentor_id=? AND slot_date=? AND start_time='08:00'`).get(tm.id, pastDate);
  db.prepare(`INSERT INTO interviews (student_id, mentor_id, slot_id, type, status)
              VALUES (?, ?, ?, 'technical', 'booked')`)
    .run(pcs.id, tm.id, pSlot.id);
  const pIv = db.prepare(`SELECT * FROM interviews WHERE slot_id=?`).get(pSlot.id);

  await login('pastcanceller', 'pastcancel.student@student.in');
  await post('pastcanceller', '/student/cancel/' + pIv.id);
  ok(db.prepare('SELECT status FROM interviews WHERE id=?').get(pIv.id).status === 'booked',
     'student cannot cancel a past booking');

  section('Google OAuth & Calendar Integration');
  const google = require('../src/services/googleService');
  const sessionAuth = require('../src/middleware/sessionAuth');
  ok(typeof google.isConfigured === 'function', 'googleService exports isConfigured check');
  ok(typeof google.syncCalendarEvent === 'function', 'googleService exports syncCalendarEvent');

  const gLogin = await get('anon', '/auth/google');
  ok(gLogin.status === 200 || gLogin.status === 302, 'GET /auth/google handles request cleanly');

  // Verify diagnostic endpoint for production URLs
  const debugResp = await get('anon', '/auth/google/debug');
  ok(debugResp.status === 200, 'GET /auth/google/debug returns 200 OK');
  const debugJson = JSON.parse(debugResp.body);
  ok(debugJson.status === 'ok' && !!debugJson.environment.currentOrigin && !!debugJson.googleCloudConsoleInstructions,
     'debug endpoint provides complete Google Cloud Console setup guidance');

  // Verify dynamic redirect URI resolver
  const mockReq = {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'custom.konfident.edu' },
    protocol: 'http',
  };
  const dynamicUri = google.getRedirectUri(mockReq);
  ok(dynamicUri.startsWith('https://custom.konfident.edu'), 'dynamic redirect URI derives from request host and proto');

  // Verify stateless signed cookie rehydration across serverless instances
  const testUser = db.prepare("SELECT * FROM users WHERE role='student' LIMIT 1").get();
  const signedToken = sessionAuth.signToken({ id: testUser.id, role: testUser.role, ts: Date.now() });
  const serverlessJar = `konfident_auth=${signedToken}`;
  const statelessResp = await req('stateless_student', 'GET', '/student', null);
  // Initially anon redirects to login
  ok(statelessResp.status === 302 && statelessResp.location === '/login', 'anonymous request is redirected');
  // With konfident_auth signed cookie, session is rehydrated automatically without in-memory store
  jars['stateless_student'] = serverlessJar;
  const rehydratedResp = await req('stateless_student', 'GET', '/student', null);
  ok(rehydratedResp.status === 200 && rehydratedResp.body.includes('Hello,'),
     'stateless backup cookie rehydrates session across serverless instances');

  const prof = await get('newstudent', '/profile');
  ok(prof.body.includes('Google Account') && prof.body.includes('Calendar Integration'),
     'profile page renders Google Account & Calendar Integration card');

  // Test logged-in student dashboard access
  const gmockStudentPage = await get('student', '/student');
  ok(gmockStudentPage.status === 200 && gmockStudentPage.body.includes('Hello,'),
     'Registered student can access dashboard');

  // Test profile details update
  await post('newstudent', '/profile/update', {
    name: 'New Student Updated',
    phone: '+91 99999 88888',
    branch: 'CSE AI/ML',
    resume_url: 'https://example.com/resume.pdf',
  });
  const updatedStudent = db.prepare('SELECT * FROM users WHERE id=?').get(ts.id);
  ok(updatedStudent.name === 'New Student Updated' && updatedStudent.branch === 'CSE AI/ML'
     && updatedStudent.resume_url === 'https://example.com/resume.pdf',
     'student can update profile details (name, phone, branch, resume link)');

  section('Every page renders');
  const pages = [
    ['admin', '/admin'], ['admin', '/admin/students'], ['admin', '/admin/mentors'],
    ['admin', '/admin/slots'], ['admin', '/admin/interviews'], ['admin', '/admin/reports'],
    ['admin', '/profile'],
    ['newstudent', '/student'], ['newstudent', '/student/mentors'],
    ['newstudent', '/student/slots?type=technical'],
    ['newstudent', '/student/slots?type=hr'], ['newstudent', '/student/results'],
    ['testmentor', '/mentor'], ['testmentor', '/mentor/interview/' + techIv.id],
  ];
  for (const [who, url] of pages) {
    const r = await get(who, url);
    ok(r.status === 200 && !/Something went wrong/.test(r.body), `GET ${url} → 200`);
  }
  section('Concurrency & Atomic Transactions');
  // Create an open slot for concurrency race test
  const raceDate = h.addDays(h.today(), 5);
  db.prepare(`INSERT INTO slots (mentor_id, type, slot_date, start_time, end_time, mode, location, status)
              VALUES (?, 'technical', ?, '11:00', '11:30', 'Online', 'https://meet.test/race', 'open')`)
    .run(tm.id, raceDate);
  const raceSlot = db.prepare(`SELECT * FROM slots WHERE mentor_id=? AND slot_date=? AND start_time='11:00'`).get(tm.id, raceDate);

  // Register 3 fresh students for the race test
  for (let i = 1; i <= 3; i++) {
    await post('admin', '/admin/students', {
      name: `Racer ${i}`, email: `racer${i}@student.in`, password: 'pass123', roll_no: `KONRACE0${i}`, branch: 'CSE'
    });
    await login(`racer${i}`, `racer${i}@student.in`);
  }

  // Trigger 3 concurrent booking requests simultaneously using Promise.all
  const raceResults = await Promise.all([
    post('racer1', '/student/book', { slot_id: String(raceSlot.id), type: 'technical' }),
    post('racer2', '/student/book', { slot_id: String(raceSlot.id), type: 'technical' }),
    post('racer3', '/student/book', { slot_id: String(raceSlot.id), type: 'technical' }),
  ]);

  const raceBookings = db.prepare(`SELECT COUNT(*) c FROM interviews WHERE slot_id=? AND status<>'cancelled'`).get(raceSlot.id).c;
  ok(raceBookings === 1, 'atomic transaction prevents double booking under concurrent requests');
  const finalSlotStatus = db.prepare('SELECT status FROM slots WHERE id=?').get(raceSlot.id).status;
  ok(finalSlotStatus === 'booked', 'concurrent race leaves slot in booked state with single owner');

  section('Input Validation & Boundary Testing');
  // Register a dedicated candidate for boundary evaluations
  await post('admin', '/admin/students', {
    name: 'Boundary Candidate', email: 'boundary.candidate@student.in', password: 'pass123', roll_no: 'KONBND01', branch: 'IT'
  });
  const bc = db.prepare(`SELECT * FROM users WHERE email='boundary.candidate@student.in'`).get();
  await login('bndstudent', 'boundary.candidate@student.in');

  // Create slot, book, and mark attended
  db.prepare(`INSERT INTO slots (mentor_id, type, slot_date, start_time, end_time, mode, location, status)
              VALUES (?, 'technical', ?, '12:00', '12:30', 'Online', 'https://meet.test/bnd', 'open')`)
    .run(tm.id, raceDate);
  const bndSlot = db.prepare(`SELECT * FROM slots WHERE mentor_id=? AND slot_date=? AND start_time='12:00'`).get(tm.id, raceDate);
  await post('bndstudent', '/student/book', { slot_id: String(bndSlot.id), type: 'technical' });
  const bndIv = db.prepare(`SELECT * FROM interviews WHERE slot_id=?`).get(bndSlot.id);
  await post('testmentor', '/mentor/interview/' + bndIv.id + '/attendance', { attendance: 'attended' });

  // Negative marks rejected
  const negMarks = await post('testmentor', '/mentor/interview/' + bndIv.id + '/evaluate',
    { resume_marks: '-2', project_marks: '8', dsa_marks: '8' });
  ok(negMarks.status === 400 && !db.prepare('SELECT * FROM evaluations WHERE interview_id=?').get(bndIv.id),
     'negative marks are rejected');

  // Non-numeric marks rejected
  const nonNumMarks = await post('testmentor', '/mentor/interview/' + bndIv.id + '/evaluate',
    { resume_marks: 'abc', project_marks: '8', dsa_marks: '8' });
  ok(nonNumMarks.status === 400 && !db.prepare('SELECT * FROM evaluations WHERE interview_id=?').get(bndIv.id),
     'non-numeric marks are rejected');

  // Boundary marks (0/10 and 10/10) accepted cleanly
  const boundarySubmit = await post('testmentor', '/mentor/interview/' + bndIv.id + '/evaluate',
    { resume_marks: '0', project_marks: '10', dsa_marks: '10', feedback: 'Extreme boundaries handled cleanly.' });
  ok(boundarySubmit.status === 302, 'boundary marks (0 and max) are accepted');

  section('Mentor Slot Creation');
  await login('mentor', 'arjun.mentor@konfident.in');
  const arjunMentor = db.prepare("SELECT * FROM users WHERE email='arjun.mentor@konfident.in'").get();
  const futureDate = h.addDays(h.today(), 5);
  const mentorSlotRes = await post('mentor', '/mentor/slots', {
    type: 'technical',
    slot_date: futureDate,
    start_time: '14:00',
    duration: '30',
    count: '2',
    mode: 'Online',
    location: 'https://calendar.google.com/calendar/u/0/appointments/schedules/AcZssZ1ZEbSjw7ves5IQuLwdkuEzfQ4_7k4Wn7DKxEm2yx8qrSYL-S5Th1vtbYuIBQxzU4zU_DLYJBC6',
  });
  ok(mentorSlotRes.status === 302, 'mentor can create interview slots');
  const createdMentorSlots = db.prepare(`SELECT * FROM slots WHERE mentor_id=? AND slot_date=? ORDER BY start_time`).all(arjunMentor.id, futureDate);
  ok(createdMentorSlots.length === 2, 'created 2 contiguous slots for mentor');
  ok(createdMentorSlots[0] && createdMentorSlots[0].location.includes('calendar.google.com'), 'slot stores Google Calendar appointment link');
  const bndEval = db.prepare('SELECT * FROM evaluations WHERE interview_id=?').get(bndIv.id);
  ok(bndEval && bndEval.resume_marks === 0 && bndEval.total === 20, 'boundary evaluation stored with correct zero and max sum');

  section('Security & Edge Cases');
  // Unauthenticated API request rejected
  const unauthApi = await get('anon_api', '/student/api/slots/available?type=technical');
  ok(unauthApi.status === 302 && unauthApi.location === '/login', 'unauthenticated call to /student/api/slots/available redirects to login');

  // Deactivated user is logged out immediately
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(bc.id);
  const deactivatedAttempt = await get('bndstudent', '/student');
  ok(deactivatedAttempt.status === 302 && deactivatedAttempt.location === '/login',
     'deactivated user is immediately logged out and redirected to login');
  db.prepare('UPDATE users SET active=1 WHERE id=?').run(bc.id);

  // Profile update with whitespace-only name rejected
  const blankNameUpdate = await post('newstudent', '/profile/update', { name: '   ', branch: 'CSE' });
  ok(blankNameUpdate.status === 400, 'blank or whitespace-only name update is rejected');

  // Password change validation
  const wrongOldPass = await post('newstudent', '/profile/password', {
    current: 'wrongpass', next1: 'newpass123', next2: 'newpass123'
  });
  ok(wrongOldPass.body.includes('Current password is incorrect'), 'password update with incorrect current password is rejected');

  const shortPass = await post('newstudent', '/profile/password', {
    current: 'pass123', next1: '123', next2: '123'
  });
  ok(shortPass.body.includes('at least 6 characters'), 'password update with short password is rejected');

  const mismatchPass = await post('newstudent', '/profile/password', {
    current: 'pass123', next1: 'newpass123', next2: 'mismatch456'
  });
  ok(mismatchPass.body.includes('passwords do not match'), 'password update with mismatched confirmation is rejected');

  const validPass = await post('newstudent', '/profile/password', {
    current: 'pass123', next1: 'newpass123', next2: 'newpass123'
  });
  ok(validPass.body.includes('Password updated'), 'valid password update succeeds');

  // Verify login with new password and reset back
  const newPassLogin = await post('newstudent', '/login', { email: 'test.student@student.in', password: 'newpass123' });
  ok(newPassLogin.location === '/student', 'student can log in with newly updated password');
  await post('newstudent', '/profile/password', {
    current: 'newpass123', next1: 'pass123', next2: 'pass123'
  });

  // Duplicate student email registration rejected
  await post('admin', '/admin/students', {
    name: 'Dup Student', email: 'test.student@student.in', password: 'pass123', roll_no: 'KON99999', branch: 'CSE'
  });
  const studentsPageAfterDup = await get('admin', '/admin/students');
  ok(studentsPageAfterDup.body.includes('already registered'), 'admin registering duplicate student email is rejected');

  // Admin filter checks
  const bookedFilter = await get('admin', '/admin/interviews?status=booked');
  ok(bookedFilter.status === 200 && bookedFilter.body.includes('Booked'), 'admin can filter interviews by booked status');
  const completedFilter = await get('admin', '/admin/interviews?status=completed');
  ok(completedFilter.status === 200 && completedFilter.body.includes('Completed'), 'admin can filter interviews by completed status');

  const healthRes = await get('anon', '/health');
  ok(healthRes.status === 200 && JSON.parse(healthRes.body).status === 'healthy', 'GET /health returns healthy status');
  ok((await get('admin', '/no-such-page')).status === 404, 'unknown URL returns 404');

  section('Bugfix & Security Regression Tests');
  // 1. Resume URL XSS validation
  const xssResumeUpdate = await post('newstudent', '/profile/update', {
    name: 'Test Student Updated', resume_url: 'javascript:alert(document.cookie)'
  });
  ok(xssResumeUpdate.status === 400 && xssResumeUpdate.body.includes('Resume link must be a valid URL'),
     'javascript: protocol in resume_url is rejected');

  // Admin student creation with invalid resume URL
  await post('admin', '/admin/students', {
    name: 'Bad Resume Student', email: 'badresume@student.in', password: 'pass123', resume_url: 'javascript:alert(1)'
  });
  const studentsAfterBadResume = await get('admin', '/admin/students');
  ok(studentsAfterBadResume.body.includes('Resume link must be a valid URL'),
     'admin creating student with invalid resume link is rejected');

  // 2. Profile password reset preserves squad on re-render
  db.prepare("UPDATE users SET squad='116' WHERE id=?").run(ts.id);
  const passResetReRender = await post('newstudent', '/profile/password', {
    current: 'wrongpass', next1: 'pass123456', next2: 'pass123456'
  });
  ok(passResetReRender.body.includes('value="116"'),
     'password reset re-render preserves student squad in form');

  // 3. Absent candidate feedback is blocked
  // Create an interview marked absent
  const absentSlot = db.prepare(`INSERT INTO slots (mentor_id, type, slot_date, start_time, end_time, status)
                                 VALUES (?, 'technical', ?, '09:00', '09:30', 'booked')`)
                       .run(tm.id, h.today());
  const absentIv = db.prepare(`INSERT INTO interviews (student_id, mentor_id, slot_id, type, status, attendance)
                               VALUES (?, ?, ?, 'technical', 'completed', 'absent')`)
                     .run(pcs.id, tm.id, absentSlot.lastInsertRowid);
  
  await login('pastcanceller', 'pastcancel.student@student.in');
  const absentFeedbackAttempt = await post('pastcanceller', '/student/feedback/' + absentIv.lastInsertRowid, {
    satisfaction: '5', structured: '1'
  });
  ok(!db.prepare('SELECT id FROM student_feedbacks WHERE interview_id=?').get(absentIv.lastInsertRowid),
     'feedback submission is rejected for absent interviews');

  const absentResults = await get('pastcanceller', '/student/results');
  ok(absentResults.body.includes('Candidate marked absent / no-show') &&
     !absentResults.body.includes('Evaluation in progress by mentor'),
     'results page clearly indicates candidate absent and suppresses evaluation in progress');

  server.close();
  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
