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

  section('Authentication & access control');
  ok((await post('x', '/login', { email: 'admin@konfident.in', password: 'wrong' })).status === 401,
     'wrong password is rejected');
  ok((await get('anon', '/admin')).location === '/login', 'anonymous user is redirected to login');

  // test role-aware redirect when a student logs in after an admin page was requested
  await get('anon_admin_attempt', '/admin/reports');
  const studentLoginAttempt = await post('anon_admin_attempt', '/login', { email: 'harsh@student.in', password: 'pass123' });
  ok(studentLoginAttempt.location === '/student', 'student logging in after accessing admin URL is redirected to student dashboard');

  ok((await login('admin', 'admin@konfident.in')).location === '/admin', 'admin signs in');
  ok((await login('mentor', 'arjun.mentor@konfident.in')).location === '/mentor', 'mentor signs in');
  ok((await login('hrmentor', 'sneha.mentor@konfident.in')).location === '/mentor', 'HR mentor signs in');
  ok((await login('student', 'harsh@student.in')).location === '/student', 'student signs in');

  ok((await get('student', '/admin')).status === 403, 'student cannot open the admin module');
  ok((await get('student', '/mentor')).status === 403, 'student cannot open the mentor module');
  ok((await get('mentor', '/admin/reports')).status === 403, 'mentor cannot open admin reports');
  ok((await get('admin', '/student')).status === 403, 'admin cannot open the student module');

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
  await login('student2', 'vikram@student.in');
  const v = db.prepare(`SELECT * FROM users WHERE email='vikram@student.in'`).get();
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
  await login('student3', 'nikita@student.in');
  const nik = db.prepare(`SELECT * FROM users WHERE email='nikita@student.in'`).get();
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
  ok(typeof google.isConfigured === 'function', 'googleService exports isConfigured check');
  ok(typeof google.syncCalendarEvent === 'function', 'googleService exports syncCalendarEvent');

  const gLogin = await get('anon', '/auth/google');
  ok(gLogin.status === 200 || gLogin.status === 302, 'GET /auth/google handles request cleanly');

  const prof = await get('newstudent', '/profile');
  ok(prof.body.includes('Google Account') && prof.body.includes('Calendar Integration'),
     'profile page renders Google Account & Calendar Integration card');

  // Test profile calendar toggle
  await post('newstudent', '/profile/google/toggle-calendar');
  const studentAfterToggle = db.prepare('SELECT google_calendar_enabled FROM users WHERE id=?').get(ts.id);
  ok(studentAfterToggle.google_calendar_enabled === 0, 'student can toggle calendar sync preference');
  await post('newstudent', '/profile/google/toggle-calendar');

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
  ok((await get('admin', '/no-such-page')).status === 404, 'unknown URL returns 404');

  server.close();
  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
