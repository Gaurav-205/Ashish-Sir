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
async function req(who, method, url, form, extraHeaders = {}) {
  const opts = { method, redirect: 'manual', headers: { ...extraHeaders } };
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
const get = (w, u, h) => req(w, 'GET', u, null, h);
const post = (w, u, f, h) => req(w, 'POST', u, f, h);
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

  // Admin creates and permanently deletes a slot
  await post('admin', '/admin/slots', {
    type: 'hr', mentor_id: String(tm.id), slot_date: date, start_time: '18:00', duration: '30', count: '1' });
  const admMadeSlot = db.prepare(`SELECT * FROM slots WHERE mentor_id=? AND start_time='18:00'`).get(tm.id);
  ok(!!admMadeSlot, 'admin creates slot for deletion test');
  const admDelRes = await post('admin', `/admin/slots/${admMadeSlot.id}/delete`, {});
  ok(admDelRes.status === 302, 'admin deletes slot successfully');
  ok(!db.prepare('SELECT * FROM slots WHERE id=?').get(admMadeSlot.id), 'admin slot is removed from db');

  section('Student — booking rules');
  await login('newstudent', 'test.student@student.in');
  const slotA = made[0], slotB = made[1];

  // Verify booking is blocked when profile is incomplete (missing phone, squad, resume_url)
  const incompleteBookingAttempt = await post('newstudent', '/student/book', { slot_id: String(slotA.id), type: 'technical' });
  ok(incompleteBookingAttempt.location === '/profile' || incompleteBookingAttempt.location === 'http://127.0.0.1:' + server.address().port + '/profile',
     'incomplete student profile booking is blocked and redirected to profile');
  ok(db.prepare(`SELECT COUNT(*) c FROM interviews WHERE student_id=?`).get(ts.id).c === 0,
     'no interview booking created when profile is incomplete');

  // Complete profile details
  await post('newstudent', '/profile/update', {
    name: 'Test Student', phone: '+91 98765 43210', squad: '116', branch: 'CSE', resume_url: 'https://drive.google.com/test-resume'
  });
  const updatedTs = db.prepare(`SELECT * FROM users WHERE email='test.student@student.in'`).get();
  ok(!!updatedTs.phone && !!updatedTs.squad && !!updatedTs.resume_url, 'student profile details updated successfully');

  await post('newstudent', '/student/book', { slot_id: String(slotA.id), type: 'technical' });
  const iv = db.prepare(`SELECT * FROM interviews WHERE student_id=? AND type='technical'`).get(ts.id);
  ok(!!iv, 'student books a technical slot after completing profile');
  ok(db.prepare('SELECT status FROM slots WHERE id=?').get(slotA.id).status === 'booked',
     'the slot is marked booked');
  ok(iv.mentor_id === tm.id, 'the mentor is taken from the slot (student never picks one)');

  // second student tries the same slot (ensure student2 has complete profile)
  await login('student2', 'aditya.talikoti.s.116@kalvium.community');
  await post('student2', '/profile/update', {
    name: 'Aditya Talikoti', phone: '+91 98765 43210', squad: '116', branch: 'CSE', resume_url: 'https://drive.google.com/aditya-resume'
  });
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
                                  AND (slot_date || ' ' || start_time) > ? LIMIT 1`).get(h.nowMinute());
    if (allotSlot) {
      await post('admin', '/admin/slots/' + allotSlot.id + '/allot', { student_id: String(studentToAllot.id) });
      ok(db.prepare('SELECT status FROM slots WHERE id=?').get(allotSlot.id).status === 'booked'
         && db.prepare(`SELECT student_id FROM interviews WHERE slot_id=? AND status<>'cancelled'`).get(allotSlot.id).student_id === studentToAllot.id,
         'admin can allot an open slot directly to a student');

      // Duplicate allotment of same type to same student is rejected
      const anotherOpen = db.prepare(`SELECT * FROM slots WHERE status='open' AND type='technical'
                                      AND (slot_date || ' ' || start_time) > ? LIMIT 1`).get(h.nowMinute());
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
                            AND (s.slot_date || ' ' || s.start_time) > ?
                          ORDER BY i.id LIMIT 1`)
                          .get(new Date(Date.now() + 5.5 * 3600000 + 3600000).toISOString().slice(0, 16).replace('T', ' '));
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

  section('Admin cancel booking');
  const adminIv = db.prepare(`SELECT i.*, u.email FROM interviews i
                              JOIN users u ON u.id = i.student_id
                              JOIN slots s ON s.id = i.slot_id
                              WHERE i.status='booked'
                                AND (s.slot_date || ' ' || s.start_time) > ?
                              ORDER BY i.id DESC LIMIT 1`)
                              .get(new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 16).replace('T', ' '));
  ok(!!adminIv, 'there is an upcoming booking for admin to cancel');

  // Non-admin cannot call admin cancel
  const unauthCancel = await post('canceller', '/admin/interviews/' + adminIv.id + '/cancel');
  ok(unauthCancel.status === 302 || unauthCancel.status === 403, 'student cannot call admin booking cancel');

  // Admin cancels booking
  await post('admin', '/admin/interviews/' + adminIv.id + '/cancel');
  ok(db.prepare('SELECT status FROM interviews WHERE id=?').get(adminIv.id).status === 'cancelled'
     && db.prepare('SELECT status FROM slots WHERE id=?').get(adminIv.slot_id).status === 'open',
     'admin cancels a booking and the slot reopens');

  // Audit log recorded
  const adminCancelAudit = db.prepare(`SELECT * FROM audit_logs WHERE action='ADMIN_CANCEL_BOOKING' AND details LIKE ?`)
    .get(`%"interview_id":${adminIv.id}%`);
  ok(!!adminCancelAudit, 'admin booking cancellation is recorded in audit logs');

  // Completed interview cannot be cancelled by admin
  const doneIv = db.prepare('SELECT id, status FROM interviews WHERE slot_id=?').get(doneSlot.id);
  await post('admin', '/admin/interviews/' + doneIv.id + '/cancel');
  ok(db.prepare('SELECT status FROM interviews WHERE id=?').get(doneIv.id).status === 'completed',
     'admin cannot cancel a completed interview');

  // Admin cancel booking alias /admin/bookings/:id/cancel
  const testStudent = db.prepare(`SELECT * FROM users WHERE role='student' AND active=1 LIMIT 1`).get();
  const openSlotForAdmin = db.prepare(`SELECT * FROM slots WHERE status='open' LIMIT 1`).get();
  db.prepare(`UPDATE slots SET status='booked' WHERE id=?`).run(openSlotForAdmin.id);
  const newIvRes = db.prepare(`INSERT INTO interviews (student_id, mentor_id, slot_id, type, status) VALUES (?, ?, ?, ?, 'booked')`)
    .run(testStudent.id, openSlotForAdmin.mentor_id, openSlotForAdmin.id, openSlotForAdmin.type);
  await post('admin', '/admin/bookings/' + newIvRes.lastInsertRowid + '/cancel');
  ok(db.prepare('SELECT status FROM interviews WHERE id=?').get(newIvRes.lastInsertRowid).status === 'cancelled'
     && db.prepare('SELECT status FROM slots WHERE id=?').get(openSlotForAdmin.id).status === 'open',
     'admin cancels a booking via /admin/bookings/:id/cancel alias');

  // UI check
  const adminInterviewsPage = await get('admin', '/admin/interviews');
  ok(adminInterviewsPage.body.includes('Cancel booking'), 'admin interviews table includes Cancel booking action');

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
      name: `Racer ${i}`, email: `racer${i}@student.in`, password: 'pass123', roll_no: `KONRACE0${i}`, branch: 'CSE',
      squad: '116', phone: '+91 98765 43210', resume_url: `https://drive.google.com/racer${i}`
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
    name: 'Boundary Candidate', email: 'boundary.candidate@student.in', password: 'pass123', roll_no: 'KONBND01', branch: 'IT',
    squad: '115', phone: '+91 98765 43210', resume_url: 'https://drive.google.com/bnd'
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

  // 4. Client-side script attaches fetchLatestSlots to window to avoid ReferenceError
  const studentSlotsScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'student-slots.js'), 'utf8');
  ok(studentSlotsScript.includes('window.fetchLatestSlots = fetchLatestSlots;'),
     'public/js/student-slots.js attaches fetchLatestSlots to window to prevent ReferenceError');

  // 5. Open redirect prevention in student feedback
  const openRedirectAttempt = await post('newstudent', '/student/feedback/' + techIv.id, {
    satisfaction: '5', structured: '1', feedback_text: 'Open redirect test'
  }, { referer: 'https://evil.attacker.com/phishing' });
  ok(openRedirectAttempt.location !== 'https://evil.attacker.com/phishing' && openRedirectAttempt.location.startsWith('/student'),
     'feedback submission prevents open redirect attacks when malicious referer header is provided');

  // 6. Mentor cannot change attendance on an interview that has already been evaluated
  await post('testmentor', '/mentor/interview/' + techIv.id + '/attendance', { attendance: 'absent' });
  ok(db.prepare('SELECT attendance FROM interviews WHERE id=?').get(techIv.id).attendance === 'attended',
     'mentor cannot change attendance to absent on an interview that has already been evaluated');

  // 7. Invalid slot types rejected cleanly without DB crashes
  await post('admin', '/admin/slots', {
    type: 'invalid_type', mentor_id: String(tm.id), slot_date: date, start_time: '18:00', count: '1'
  });
  ok(db.prepare(`SELECT COUNT(*) c FROM slots WHERE type='invalid_type'`).get().c === 0,
     'admin creating slot with invalid type is rejected cleanly');

  await post('testmentor', '/mentor/slots', {
    type: 'invalid_type', slot_date: date, start_time: '18:00', count: '1'
  });
  ok(db.prepare(`SELECT COUNT(*) c FROM slots WHERE type='invalid_type'`).get().c === 0,
     'mentor creating slot with invalid type is rejected cleanly');

  // 8. Student cancel never reopens admin-cancelled slot
  const cancelTestDate = h.addDays(h.today(), 6);
  const ctSlot = db.prepare(`INSERT INTO slots (mentor_id, type, slot_date, start_time, end_time, mode, location, status)
                             VALUES (?, 'technical', ?, '16:00', '16:30', 'Online', 'https://meet.test/ct', 'booked')`)
                   .run(tm.id, cancelTestDate);
  const ctIv = db.prepare(`INSERT INTO interviews (student_id, mentor_id, slot_id, type, status)
                           VALUES (?, ?, ?, 'technical', 'booked')`)
                 .run(pcs.id, tm.id, ctSlot.lastInsertRowid);
  db.prepare(`UPDATE slots SET status='cancelled' WHERE id=?`).run(ctSlot.lastInsertRowid);
  await post('pastcanceller', '/student/cancel/' + ctIv.lastInsertRowid);
  ok(db.prepare('SELECT status FROM slots WHERE id=?').get(ctSlot.lastInsertRowid).status === 'cancelled',
     'student cancelling booking never reopens an admin-cancelled slot');

  // 9. Postgres SQL converter translates BEGIN IMMEDIATE and date functions
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');
  const convertSqlMatch = dbSrc.match(/function convertSql\(sql\) \{([\s\S]*?)\n\}/);
  if (convertSqlMatch) {
    const testConvertSql = new Function('sql', convertSqlMatch[1]);
    const convertedBegin = testConvertSql('BEGIN IMMEDIATE');
    ok(convertedBegin.includes('BEGIN') && !convertedBegin.includes('IMMEDIATE'),
       'convertSql transforms BEGIN IMMEDIATE to BEGIN for Postgres');
    const convertedDate = testConvertSql("SELECT * FROM slots WHERE s.slot_date >= date('now','localtime')");
    ok(convertedDate.includes('::date)::text'),
       'convertSql transforms date(now) to IST date text for Postgres');
    const convertedDatetimeComp = testConvertSql("SELECT * FROM slots WHERE datetime(slot_date || ' ' || start_time) > datetime('now','localtime')");
    ok(convertedDatetimeComp.includes('::timestamp') && convertedDatetimeComp.includes("AT TIME ZONE 'Asia/Kolkata'"),
       'convertSql transforms datetime comparison to timezone-aware timestamp comparison for Postgres');
  }

  // 10. Audit logging verification across mentor operations and admin user actions
  const mentorAuditSlot = db.prepare("SELECT * FROM audit_logs WHERE action='MENTOR_CREATE_SLOTS'").get();
  ok(!!mentorAuditSlot, 'mentor slot creation is recorded in audit_logs');
  const mentorAuditAtt = db.prepare("SELECT * FROM audit_logs WHERE action='MENTOR_MARK_ATTENDANCE'").get();
  ok(!!mentorAuditAtt, 'mentor attendance recording is recorded in audit_logs');
  const mentorAuditEval = db.prepare("SELECT * FROM audit_logs WHERE action='MENTOR_SUBMIT_EVALUATION'").get();
  ok(!!mentorAuditEval, 'mentor evaluation submission is recorded in audit_logs');
  const adminAuditStudent = db.prepare("SELECT * FROM audit_logs WHERE action='ADMIN_CREATE_STUDENT'").get();
  ok(!!adminAuditStudent, 'admin student registration is recorded in audit_logs');


  /* ======================================================================
   * Timezone consistency
   * The SQL filters and the JavaScript helpers must agree on "past",
   * whatever timezone the server process runs in.
   * ==================================================================== */
  section('Timezone consistency (IST everywhere)');
  {
    const future = db.prepare(`SELECT * FROM slots WHERE (slot_date || ' ' || start_time) > ? LIMIT 1`)
      .get(h.nowMinute());
    const past = db.prepare(`SELECT * FROM slots WHERE (slot_date || ' ' || start_time) < ? LIMIT 1`)
      .get(h.nowMinute());
    ok(!future || h.isPast(future) === false, 'a slot the SQL filter calls upcoming is not "past" to the helpers');
    ok(!past || h.isPast(past) === true, 'a slot the SQL filter calls past is "past" to the helpers too');
    ok(h.nowMinute().length === 16 && h.today() === h.nowMinute().slice(0, 10), 'IST now/today helpers agree');
    ok(h.isPast({ slot_date: '2099-01-01', start_time: '10:00' }) === false, 'a far-future slot is never past');
    ok(h.isPast({ slot_date: '2000-01-01', start_time: '10:00' }) === true, 'a far-past slot is always past');
  }

  /* ======================================================================
   * Password recovery
   * ==================================================================== */
  section('Password recovery (forgot / reset)');
  {
    const RESET_EMAIL = 'reset.candidate@student.in';
    await post('admin', '/admin/students', {
      name: 'Reset Candidate', email: RESET_EMAIL, password: 'pass123', roll_no: 'KON2025300', branch: 'CSE',
    });
    ok(!!db.prepare('SELECT id FROM users WHERE email=?').get(RESET_EMAIL), 'a candidate exists to recover');

    const formPage = await get('anon', '/forgot-password');
    ok(formPage.status === 200 && formPage.body.includes('Forgot your password?'), 'GET /forgot-password renders');
    ok((await get('anon', '/login')).body.includes('/forgot-password'), 'the login page links to password recovery');

    const unknown = await post('anon', '/forgot-password', { email: 'no.such.person@nowhere.test' });
    ok(unknown.status === 200 && !/\/reset-password\//.test(unknown.body),
       'an unknown address does not reveal that the account is missing');

    const requested = await post('anon', '/forgot-password', { email: RESET_EMAIL });
    const token = (requested.body.match(/\/reset-password\/([A-Za-z0-9_-]+)/) || [])[1];
    ok(!!token, 'a reset token is issued for a real account');
    ok(db.prepare('SELECT COUNT(*) c FROM password_resets WHERE user_id=(SELECT id FROM users WHERE email=?)')
         .get(RESET_EMAIL).c === 1, 'exactly one outstanding reset row is stored');
    ok(!db.prepare('SELECT token_hash FROM password_resets ORDER BY id DESC LIMIT 1').get().token_hash.includes(token),
       'the raw token is never stored, only its hash');

    ok((await get('anon', '/reset-password/' + token)).body.includes('Choose a new password'), 'the reset form renders');
    ok((await get('anon', '/reset-password/not-a-real-token')).status === 400, 'a bogus token is refused');

    ok((await post('anon', '/reset-password/' + token, { next1: 'abc', next2: 'abc' })).status === 400,
       'a too-short new password is refused');
    ok((await post('anon', '/reset-password/' + token, { next1: 'longenough1', next2: 'different1' })).status === 400,
       'mismatched confirmation is refused');

    const done = await post('anon', '/reset-password/' + token, { next1: 'recovered123', next2: 'recovered123' });
    ok(done.location === '/login', 'a valid reset redirects to the login page');
    ok((await post('old_pw', '/login', { email: RESET_EMAIL, password: 'pass123' })).status === 401,
       'the previous password stops working');
    ok((await post('new_pw', '/login', { email: RESET_EMAIL, password: 'recovered123' })).location === '/student',
       'the new password signs the candidate in');
    ok((await get('anon', '/reset-password/' + token)).status === 400, 'a used reset token cannot be replayed');

    // A second request must invalidate the first outstanding link.
    const first = await post('anon', '/forgot-password', { email: RESET_EMAIL });
    const firstToken = (first.body.match(/\/reset-password\/([A-Za-z0-9_-]+)/) || [])[1];
    await post('anon', '/forgot-password', { email: RESET_EMAIL });
    ok((await get('anon', '/reset-password/' + firstToken)).status === 400,
       'requesting a new link invalidates the previous one');

    ok(!!db.prepare("SELECT id FROM audit_logs WHERE action='AUTH_PASSWORD_RESET_COMPLETED'").get(),
       'a completed reset is written to the audit log');
  }

  /* ======================================================================
   * Regressions
   * ==================================================================== */
  section('Regression guards');
  {
    // View locals used to be registered *after* csrfProtection, so every CSRF
    // rejection crashed while rendering the error page.
    process.env.NODE_ENV = 'development';
    const csrfReject = await post('csrf_probe', '/login', { email: 'x@y.z', password: 'nope' });
    process.env.NODE_ENV = 'test';
    ok(csrfReject.status === 403, 'a missing CSRF token yields 403, not 500', 'status=' + csrfReject.status);
    ok(/CSRF/i.test(csrfReject.body), 'the CSRF error page actually renders its message');

    // Signed-in pages must not be stored by the browser cache.
    const dash = await get('student', '/student');
    ok(/no-store/.test(dash.headers.get('cache-control') || ''),
       'authenticated pages are sent with Cache-Control: no-store');

    // Non-HTML clients get JSON, not a redirect to an HTML login page.
    const apiUnauth = await get('nobody', '/student/api/slots/available?type=technical', { accept: 'application/json' });
    ok(apiUnauth.status === 401, 'an unauthenticated JSON API call returns 401', 'status=' + apiUnauth.status);

    // Deactivated accounts lose the signed backup cookie too, not just the session.
    const victim = db.prepare("SELECT id, email FROM users WHERE role='student' AND active=1 ORDER BY id LIMIT 1").get();
    await post('deact', '/login', { email: victim.email, password: 'pass123' });
    db.prepare('UPDATE users SET active=0 WHERE id=?').run(victim.id);
    const afterDeactivate = await get('deact', '/student');
    ok(afterDeactivate.location === '/login', 'a deactivated user is bounced to login');
    const clearing = (afterDeactivate.headers.getSetCookie ? afterDeactivate.headers.getSetCookie() : []).join(';');
    ok(/konfident_auth=;/.test(clearing), 'the signed backup cookie is cleared on deactivation, not just the session');
    db.prepare('UPDATE users SET active=1 WHERE id=?').run(victim.id);

    // The mentor list query binds an IST "now" three times; a mismatch would throw.
    const mentorsOpen = q.mentorsWithOpenSlots();
    ok(Array.isArray(mentorsOpen) && mentorsOpen.every((m) => typeof m.total_open_slots === 'number'),
       'mentorsWithOpenSlots returns open-slot counts for every evaluator');
    ok(mentorsOpen.every((m) => m.total_open_slots >= m.tech_open_slots && m.total_open_slots >= m.hr_open_slots),
       'per-domain open-slot counts never exceed the total');

    // Admin slot listing is paginated.
    const slotsPage = await get('admin', '/admin/slots');
    ok(slotsPage.status === 200 && slotsPage.body.includes('openSlotManageModal') && slotsPage.body.includes('manageSlotModal'),
       'the admin slot list renders manage controls');
    ok(/Page 1 of/.test(slotsPage.body) || db.prepare('SELECT COUNT(*) c FROM slots').get().c <= 50,
       'the admin slot list paginates once there are more than 50 slots');
  }


  section('CSV export safety');
  {
    await post('admin', '/admin/students', {
      name: '=cmd|\' /C calc\'!A1', email: 'csv.injection@student.in', password: 'pass123',
      roll_no: '@SUM(1+1)', branch: '+1234', squad: '-500',
    });
    const exported = await get('admin', '/admin/reports.csv');
    ok(exported.status === 200, 'CSV export still returns 200 with hostile values');
    ok(!/^"=cmd/m.test(exported.body) && exported.body.includes(`"'=cmd`),
       'a formula-looking name is neutralised with a leading apostrophe');
    ok(exported.body.includes(`"'@SUM(1+1)"`), 'a formula-looking roll number is neutralised');
    ok(exported.body.includes(`"'+1234"`) && exported.body.includes(`"'-500"`),
       'leading + and - are neutralised too');
    // fetch() strips the BOM while decoding, so check the raw bytes.
    const rawCsv = Buffer.from(await (await fetch(base + '/admin/reports.csv', { headers: { cookie: jars.admin } })).arrayBuffer());
    ok(rawCsv[0] === 0xef && rawCsv[1] === 0xbb && rawCsv[2] === 0xbf,
       'the export carries a UTF-8 BOM so Excel reads accented names correctly');
    ok(/charset=utf-8/i.test(exported.headers.get('content-type') || ''), 'the export declares its charset');
  }

  section('Google Meet, Meeting Link Privacy & Email Confirmation');
  {
    // 1. Google Meet link format
    const sampleLink = h.generateMeetingLink('technical');
    ok(/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(sampleLink),
       'generateMeetingLink produces a valid Google Meet URL');

    // 2. Meeting link privacy: unbooked slots API does not leak location
    const availRes = await get('newstudent', '/student/api/slots/available?type=technical');
    const availData = JSON.parse(availRes.body);
    ok(availData.ok === true && Array.isArray(availData.slots), 'slots API returns open slots list');
    const hasExposedLink = availData.slots.some(s => s.location || s.locationFormatted);
    ok(!hasExposedLink, 'meeting link is not exposed in unbooked slots API');

    // 3. Email notifications dispatched and recorded in audit log
    const emailAudit = db.prepare("SELECT * FROM audit_logs WHERE action='EMAIL_NOTIFICATION_SENT'").all();
    ok(emailAudit.length > 0, 'booking confirmation emails are recorded in audit log');

    // 4. googleService exports createSlotCalendarEvent
    const google = require('../src/services/googleService');
    ok(typeof google.createSlotCalendarEvent === 'function', 'googleService exports createSlotCalendarEvent');
  }

  section('Developer Role & Dynamic Role Switching');
  {
    // Ensure Gaurav Khandelwal is present and marked as developer
    const devUser = db.prepare(`SELECT * FROM users WHERE lower(email) = 'gauravkhandelwal205@gmail.com'`).get();
    ok(!!devUser, 'gauravkhandelwal205@gmail.com account exists');
    ok(devUser.is_developer === 1, 'gauravkhandelwal205@gmail.com is marked as developer in db');
    ok(devUser.can_technical === 0 && devUser.can_hr === 0, 'gauravkhandelwal205@gmail.com is not an evaluator / mentor');

    // Login as developer
    await login('devuser', 'gauravkhandelwal205@gmail.com', 'pass123');

    // 1. Developer can access everything across roles
    const adminPage = await get('devuser', '/admin');
    ok(adminPage.status === 200 && adminPage.body.includes('Admin dashboard'), 'developer can access /admin');

    const mentorPage = await get('devuser', '/mentor');
    ok(mentorPage.status === 200 && mentorPage.body.includes('My interviews'), 'developer can access /mentor');

    const studentPage = await get('devuser', '/student');
    ok(studentPage.status === 200 && studentPage.body.includes('My interviews'), 'developer can access /student');

    // 2. Role switcher UI is removed from topbar, showing clean DEV pill
    ok(!adminPage.body.includes('dev-role-switcher') && !adminPage.body.includes('/dev/switch-role'),
       'developer view does not render role switcher control in navigation');
    ok(adminPage.body.includes('pill role-pill') && adminPage.body.includes('>DEV<'),
       'developer view renders clean DEV pill in navigation');
  }

  section('Mentor Slot Editing & Cancellation');
  {
    // Mentor publishes a test slot
    const createSlotRes = await post('mentor', '/mentor/slots', {
      type: 'technical',
      slot_date: '2026-09-25',
      start_time: '14:00',
      duration: '30',
      count: '1',
      mode: 'Online',
      location: 'https://meet.google.com/test-edit-cancel',
    });
    ok(createSlotRes.status === 302, 'mentor creates slot successfully');

    const createdSlot = db.prepare(`
      SELECT * FROM slots WHERE slot_date = '2026-09-25' AND start_time = '14:00' AND status = 'open'
    `).get();
    ok(!!createdSlot, 'created slot is present in database');

    // 1. Mentor edits / reschedules the slot
    const editRes = await post('mentor', `/mentor/slots/${createdSlot.id}/edit`, {
      slot_date: '2026-09-26',
      start_time: '15:00',
      end_time: '15:30',
      mode: 'Online',
      location: 'https://meet.google.com/rescheduled-link',
    });
    ok(editRes.status === 302, 'mentor edits slot successfully');
    const updatedSlot = db.prepare('SELECT * FROM slots WHERE id=?').get(createdSlot.id);
    ok(updatedSlot.slot_date === '2026-09-26' && updatedSlot.start_time === '15:00', 'slot updated with new date and time');

    // 2. Mentor cancels the open slot
    const cancelRes = await post('mentor', `/mentor/slots/${createdSlot.id}/cancel`, {});
    ok(cancelRes.status === 302, 'mentor cancels open slot successfully');
    const cancelledSlot = db.prepare('SELECT * FROM slots WHERE id=?').get(createdSlot.id);
    ok(cancelledSlot.status === 'cancelled', 'slot status is set to cancelled');

    // 3. Mentor permanently deletes the slot
    const deleteRes = await post('mentor', `/mentor/slots/${createdSlot.id}/delete`, {});
    ok(deleteRes.status === 302, 'mentor deletes slot permanently');
    const deletedSlot = db.prepare('SELECT * FROM slots WHERE id=?').get(createdSlot.id);
    ok(!deletedSlot, 'slot is removed from database after deletion');

    // 4. Mentor creates multi-day recurring slots (e.g. 9:00 - 10:00, 2 slots per day across 3 days)
    const multiDayRes = await post('mentor', '/mentor/slots', {
      type: 'technical',
      slot_date: '2026-10-05',
      repeat_days: '3',
      exclude_weekends: '1',
      start_time: '09:00',
      duration: '30',
      count: '2',
      mode: 'Online',
    });
    ok(multiDayRes.status === 302, 'mentor creates multi-day slots successfully');
    const multiDaySlots = db.prepare(`
      SELECT count(*) as c FROM slots
       WHERE mentor_id = (SELECT id FROM users WHERE email = 'arjun.mentor@konfident.in')
         AND slot_date IN ('2026-10-05', '2026-10-06', '2026-10-07')
         AND start_time IN ('09:00', '09:30')
    `).get();
    ok(Number(multiDaySlots.c) === 6, 'multi-day slot creation produced exactly 6 slots across 3 days (2 per day)');

    // Test explicit multi-date selection via selected_dates parameter
    const explicitDatesRes = await post('mentor', '/mentor/slots', {
      type: 'technical',
      selected_dates: '2026-10-12,2026-10-14,2026-10-16',
      start_time: '11:00',
      duration: '30',
      count: '1',
      mode: 'Online',
    });
    ok(explicitDatesRes.status === 302, 'mentor creates slots on explicit multi-dates');
    const explicitCount = db.prepare(`
      SELECT count(*) as c FROM slots
       WHERE mentor_id = (SELECT id FROM users WHERE email = 'arjun.mentor@konfident.in')
         AND slot_date IN ('2026-10-12', '2026-10-14', '2026-10-16')
         AND start_time = '11:00'
    `).get();
    ok(Number(explicitCount.c) === 3, 'explicit multi-date selection created 3 slots across chosen dates');
  }

  section('Arvind Admin Account & Administrative Superpowers');
  {
    // 1. Check arvind account existence and role
    const arvindUser = db.prepare(`SELECT * FROM users WHERE email = 'arvind@kalvium.com'`).get();
    ok(!!arvindUser && arvindUser.role === 'admin', 'arvind@kalvium.com is provisioned as administrator');

    // 2. Arvind signs in
    const arvindLogin = await login('arvind', 'arvind@kalvium.com');
    ok(arvindLogin.status === 302 && arvindLogin.location === '/admin', 'arvind@kalvium.com logs into admin successfully');

    // 3. Access admin sections
    const arvindDash = await get('arvind', '/admin');
    ok(arvindDash.status === 200 && arvindDash.body.includes('Admin dashboard'), 'arvind can view admin dashboard');
    const arvindStudents = await get('arvind', '/admin/students');
    ok(arvindStudents.status === 200, 'arvind can view students directory');

    // 4. Arvind creates a slot on behalf of a mentor
    const targetMentor = db.prepare(`SELECT id FROM users WHERE role = 'mentor' AND can_technical = 1 LIMIT 1`).get();
    const createSlotAdmin = await post('arvind', '/admin/slots', {
      mentor_id: targetMentor.id,
      type: 'technical',
      slot_date: '2026-10-01',
      start_time: '11:00',
      duration: '30',
      count: '1',
      mode: 'Online',
      location: 'https://meet.google.com/arvind-admin-room',
    });
    ok(createSlotAdmin.status === 302, 'arvind creates slot on behalf of mentor');
    const adminCreatedSlot = db.prepare(`SELECT * FROM slots WHERE slot_date = '2026-10-01' AND start_time = '11:00'`).get();
    ok(!!adminCreatedSlot && adminCreatedSlot.status === 'open', 'admin-created slot is active and open');
  }

  section('Complete Student Journey: Discovery, Booking, Meet UI, Results & Attendance');
  {
    // 1. Create a dedicated candidate and mentor for full lifecycle testing
    await post('admin', '/admin/students', {
      name: 'Priya Sharma',
      email: 'priya.sharma@student.in',
      password: 'pass123',
      roll_no: 'PS-101',
      branch: 'CSE',
      squad: 'Alpha',
      phone: '+91 98765 43210',
      resume_url: 'https://drive.google.com/priya-resume',
    });
    const studentUser = db.prepare(`SELECT * FROM users WHERE email = 'priya.sharma@student.in'`).get();
    ok(!!studentUser, 'test candidate registered');

    await post('admin', '/admin/mentors', {
      name: 'Lifecycle Mentor',
      email: 'lifecycle.mentor@konfident.in',
      password: 'pass123',
      can_technical: '1',
      can_hr: '1',
    });
    const mentorUser = db.prepare(`SELECT * FROM users WHERE email = 'lifecycle.mentor@konfident.in'`).get();
    ok(!!mentorUser, 'test lifecycle mentor registered');

    // Log in mentor first
    await login('lifecycle_mentor', 'lifecycle.mentor@konfident.in');

    // Mentor creates a slot for tomorrow
    const mSlotRes = await post('lifecycle_mentor', '/mentor/slots', {
      type: 'technical',
      slot_date: '2026-09-15',
      start_time: '10:00',
      duration: '30',
      count: '1',
      mode: 'Online',
      location: 'https://meet.google.com/lifecycle-meet-link',
    });
    const bookedSlot = db.prepare(`SELECT * FROM slots WHERE mentor_id = ? AND slot_date = '2026-09-15'`).get(mentorUser.id);
    ok(!!bookedSlot, 'mentor slot created for booking');

    // 2. Candidate logs in and views mentors and slots
    await login('priya', 'priya.sharma@student.in');
    const mentorsPage = await get('priya', '/student/mentors');
    ok(mentorsPage.status === 200 && mentorsPage.body.includes('Lifecycle Mentor'), 'student can view mentor profiles');

    const slotsPage = await get('priya', '/student/slots?type=technical');
    ok(slotsPage.status === 200, 'student can browse available technical slots');

    // 3. Candidate books the slot
    const bookRes = await post('priya', '/student/book', { slot_id: bookedSlot.id });
    ok(bookRes.status === 302 && bookRes.location === '/student', 'student books technical slot successfully');

    const interview = db.prepare(`SELECT * FROM interviews WHERE slot_id = ?`).get(bookedSlot.id);
    ok(!!interview && interview.status === 'booked', 'interview created with status booked');

    // 4. Candidate dashboard shows single Join Google Meet button and live countdown badge
    const dashPage = await get('priya', '/student');
    ok(dashPage.body.includes('Join Google Meet') && dashPage.body.includes('lifecycle-meet-link'),
       'student dashboard shows single Join Google Meet button');
    ok(dashPage.body.includes('countdown-badge') && dashPage.body.includes('countdown-label'),
       'student dashboard displays live interview countdown badge');
    ok(!dashPage.body.includes('Start Instant Google Meet'),
       'student dashboard removes duplicate instant meet button');

    // 5. Candidate cancels the booking
    const cancelBookingRes = await post('priya', `/student/cancel/${interview.id}`, {});
    ok(cancelBookingRes.status === 302, 'student can cancel booked interview');
    const slotAfterCancel = db.prepare(`SELECT * FROM slots WHERE id = ?`).get(bookedSlot.id);
    ok(slotAfterCancel.status === 'open', 'cancelling booking returns slot to open state');

    // 6. Re-book the slot for evaluation test
    await post('priya', '/student/book', { slot_id: bookedSlot.id });
    const rebookedInterview = db.prepare(`SELECT * FROM interviews WHERE slot_id = ? AND status = 'booked'`).get(bookedSlot.id);
    ok(!!rebookedInterview, 'candidate re-booked slot for evaluation flow');

    // 7. Mentor desk: view candidate and record attendance & evaluation
    await login('lifecycle_m_session', 'lifecycle.mentor@konfident.in');
    const deskPage = await get('lifecycle_m_session', `/mentor/interview/${rebookedInterview.id}`);
    ok(deskPage.status === 200 && deskPage.body.includes('Priya Sharma'), 'mentor opens interview desk for candidate');

    // Mentor records attendance as attended
    await post('lifecycle_m_session', `/mentor/interview/${rebookedInterview.id}/attendance`, { attendance: 'attended' });
    const ivAttended = db.prepare(`SELECT * FROM interviews WHERE id = ?`).get(rebookedInterview.id);
    ok(ivAttended.attendance === 'attended', 'mentor marks student as attended (present)');

    // Mentor submits evaluation
    const evalRes = await post('lifecycle_m_session', `/mentor/interview/${rebookedInterview.id}/evaluate`, {
      resume_marks: '8',
      project_marks: '9',
      dsa_marks: '9',
      feedback: 'Excellent problem solving skills and strong algorithmic intuition.',
    });
    ok(evalRes.status === 302, 'mentor submits rubric evaluation');

    const evalRow = db.prepare(`SELECT * FROM evaluations WHERE interview_id = ?`).get(rebookedInterview.id);
    ok(!!evalRow && evalRow.total === 26, 'evaluation stored with correct total score');

    // 8. Candidate checks results
    const resultsPage = await get('priya', '/student/results');
    ok(resultsPage.status === 200 && resultsPage.body.includes('Marked Present (Attended)'),
       'student results page displays marked present');
    ok(resultsPage.body.includes('26'), 'student results page displays score total');
    ok(resultsPage.body.includes('Excellent problem solving'), 'student results page displays mentor feedback');
  }

  section('Passed Slot Attendance Status Display');
  {
    // Test passed slot with attendance pending
    const pastSlot = db.prepare(`
      INSERT INTO slots (mentor_id, type, slot_date, start_time, end_time, mode, location, status)
      VALUES ((SELECT id FROM users WHERE role='mentor' LIMIT 1), 'hr', '2020-01-01', '09:00', '09:30', 'Online', 'https://meet.google.com/past-pending', 'booked')
      RETURNING id
    `).get();

    const pastStudent = db.prepare(`SELECT id FROM users WHERE role='student' LIMIT 1`).get();
    const pastInterview = db.prepare(`
      INSERT INTO interviews (student_id, mentor_id, slot_id, type, status, attendance)
      VALUES (?, (SELECT id FROM users WHERE role='mentor' LIMIT 1), ?, 'hr', 'booked', 'pending')
      RETURNING id
    `).get(pastStudent.id, pastSlot.id);

    // Admin interviews view shows "Slot Passed · Pending"
    const adminIvsPage = await get('admin', '/admin/interviews');
    ok(adminIvsPage.body.includes('Slot Passed · Pending'), 'admin interviews table shows Slot Passed · Pending');

    // Mark as absent
    db.prepare(`UPDATE interviews SET attendance = 'absent' WHERE id = ?`).run(pastInterview.id);
    const adminIvsAbsent = await get('admin', '/admin/interviews');
    ok(adminIvsAbsent.body.includes('Absent'), 'admin interviews table shows Absent');

    // Mark as attended
    db.prepare(`UPDATE interviews SET attendance = 'attended' WHERE id = ?`).run(pastInterview.id);
    const adminIvsAttended = await get('admin', '/admin/interviews');
    ok(adminIvsAttended.body.includes('Attended (Present)'), 'admin interviews table shows Attended (Present)');
  }

  section('Performance & Consolidated Query Verification');
  {
    const q = require('../src/queries');
    const stats = q.adminStats();
    ok(typeof stats.students === 'number' && stats.students > 0, 'adminStats returns valid student count');
    ok(typeof stats.mentors === 'number' && stats.mentors > 0, 'adminStats returns valid mentor count');
    ok(typeof stats.slots === 'number', 'adminStats returns valid slots count');
    ok(typeof stats.fullyBooked === 'number', 'adminStats returns valid fullyBooked count');

    const mentorsList = q.mentorsWithOpenSlots();
    ok(Array.isArray(mentorsList) && mentorsList.length > 0, 'mentorsWithOpenSlots returns mentor array');
    ok(typeof mentorsList[0].total_open_slots === 'number', 'mentorsWithOpenSlots calculates total_open_slots correctly');

    const summaries = q.allStudentSummaries();
    ok(Array.isArray(summaries) && summaries.length > 0, 'allStudentSummaries generates complete student summaries');
  }

  server.close();
  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
