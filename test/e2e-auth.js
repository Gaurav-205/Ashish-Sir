'use strict';
require('dotenv').config();
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/konfident';

const mongoose = require('mongoose');
const app = require('../src/app');
const { User, Slot, Interview } = require('../src/models');
const { generateCsrfToken } = require('../src/middleware/security');
const h = require('../src/helpers');
const { ensureFixtures } = require('./fixtures');

console.log('=== Running Auth & User-Lifecycle E2E Suite ===');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \x1b[32m✓\x1b[0m ' + m)) : (fail++, console.log('  \x1b[31m✗ ' + m + '\x1b[0m')); };
const section = (s) => console.log('\n\x1b[1m' + s + '\x1b[0m');

let base;
const jar = {}, uid = {};

async function req(who, method, path, form) {
  const headers = {};
  if (jar[who]) headers.cookie = jar[who];
  let body;
  if (form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams({ _csrf: generateCsrfToken(uid[who] || null), ...form }).toString();
  }
  const res = await fetch(base + path, { method, headers, body, redirect: 'manual' });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) {
    const cur = (jar[who] ? jar[who].split('; ') : []).reduce((a, c) => { const [k, v] = c.split('='); a[k] = v; return a; }, {});
    for (const c of sc) { const [p] = c.split(';'); const [k, v] = p.split('='); cur[k] = v; }
    jar[who] = Object.entries(cur).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  return { status: res.status, loc: res.headers.get('location'), body: await res.text() };
}
const get = (w, p) => req(w, 'GET', p);
const post = (w, p, f) => req(w, 'POST', p, f || {});
async function login(who, email, password = 'pass123') {
  delete uid[who]; delete jar[who];
  await get(who, '/login');
  const r = await post(who, '/login', { email, password });
  const me = await User.findOne({ email: email.toLowerCase() }).lean();
  if (me) uid[who] = String(me._id);
  return r;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  const fx = await ensureFixtures();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;

  const admin = fx.admin, mentor = fx.techMentor, student = fx.students[0];
  const twoDays = h.addDays(h.today(), 2);

  section('1. Password authentication');
  ok((await login('admin', admin.email)).loc === '/admin', 'admin password login redirects to /admin');
  ok((await login('mentor', mentor.email)).loc === '/mentor', 'mentor password login redirects to /mentor');
  ok((await login('student', student.email)).loc === '/student', 'student password login redirects to /student');
  ok((await post('anon', '/login', { email: admin.email, password: 'nope' })).status === 401, 'wrong password -> 401');
  ok((await get('anon', '/admin')).loc === '/login', 'unauthenticated /admin -> /login');

  section('2. Dashboard booking + cancel routes (/student/cancel/:id)');
  const slot = await Slot.findOne({ type: 'technical', status: 'open', slot_date: { $gte: twoDays } }).sort({ slot_date: 1, start_time: 1 }).lean();
  ok((await post('student', '/student/book', { slot_id: String(slot._id) })).loc === '/student', 'book slot -> /student');
  const iv = await Interview.findOne({ slot_id: slot._id, student_id: student._id, status: 'booked' });
  ok(!!iv, 'interview created & booked');
  ok((await post('student', '/student/cancel/' + iv._id, {})).status === 302, 'cancel via /student/cancel/:id -> 302');
  ok((await Interview.findById(iv._id)).status === 'cancelled', 'interview cancelled');
  ok((await Slot.findById(slot._id)).status === 'open', 'slot reopened');

  section('3. Admin interview cancel + password reset');
  await post('student', '/student/book', { slot_id: String(slot._id) });
  const iv2 = await Interview.findOne({ slot_id: slot._id, student_id: student._id, status: 'booked' });
  ok((await post('admin', '/admin/interviews/' + iv2._id + '/cancel', {})).status === 302, 'admin cancels interview -> 302');
  ok((await Interview.findById(iv2._id)).status === 'cancelled', 'admin-cancelled interview');
  ok((await Slot.findById(slot._id)).status === 'open', 'slot reopened by admin cancel');

  ok((await post('admin', '/admin/students/' + student._id + '/reset-password', { admin_password: 'pass123', password: 'temp12345' })).status === 302, 'admin resets student password -> 302');
  ok((await login('student', student.email, 'temp12345')).loc === '/student', 'student signs in with admin-set password');
  ok((await post('admin', '/admin/students/' + student._id + '/reset-password', { admin_password: 'WRONG', password: 'x' })).status === 302, 'wrong admin password still 302 (flashes error)');
  ok(!(await login('z', student.email, 'x').then((r) => r.loc === '/student')), 'rejected reset did not change the password');
  await post('admin', '/admin/students/' + student._id + '/reset-password', { admin_password: 'pass123', password: 'pass123' });

  section('4. Profile update + self password change (session preserved)');
  await login('student', student.email);
  ok((await post('student', '/profile/update', { name: student.name, phone: '+91 90000 00000', squad: student.squad, branch: 'CSE', resume_url: student.resume_url })).status === 302, 'profile update -> 302');
  const pc = await post('student', '/profile/password', { current_password: 'WRONG', new_password: 'brandnew1', confirm_password: 'brandnew1' });
  ok(pc.status === 302, 'wrong current password -> 302 (flash error)');
  ok((await get('student', '/student')).status === 200, 'still signed in after failed change');
  ok((await post('student', '/profile/password', { current_password: 'pass123', new_password: 'brandnew1', confirm_password: 'brandnew1' })).status === 302, 'valid password change -> 302');
  ok((await get('student', '/student')).status === 200, 'session preserved after own password change');
  await post('student', '/profile/password', { current_password: 'brandnew1', new_password: 'pass123', confirm_password: 'pass123' });

  section('5. Forgot / reset password lifecycle');
  const fp = await post('anon', '/forgot-password', { email: student.email });
  ok(fp.status === 200 && fp.body.includes('/reset-password/'), 'forgot-password surfaces a reset link in test mode');
  const token = (fp.body.match(/\/reset-password\/([A-Za-z0-9_-]+)/) || [])[1];
  ok(!!token, 'reset token extracted');
  ok((await get('anon', '/reset-password/' + token)).status === 200, 'reset-password page renders');
  ok((await post('anon', '/reset-password/' + token, { next1: 'abc', next2: 'abc' })).status === 400, 'too-short password rejected');
  ok((await post('anon', '/reset-password/' + token, { next1: 'newpw12345', next2: 'different' })).status === 400, 'mismatched passwords rejected');
  ok((await post('anon', '/reset-password/' + token, { next1: 'newpw12345', next2: 'newpw12345' })).loc === '/login', 'valid reset -> /login');
  ok((await login('r', student.email, 'newpw12345')).loc === '/student', 'login works with the reset password');
  ok((await get('anon', '/reset-password/' + token)).status === 400, 'used reset token cannot be replayed');
  await post('admin', '/admin/students/' + student._id + '/reset-password', { admin_password: 'pass123', password: 'pass123' });

  section('6. Logout clears access');
  await login('student', student.email);
  ok((await get('student', '/student')).status === 200, 'authenticated before logout');
  const lo = await post('student', '/logout', {});
  ok(lo.status === 302 && lo.loc === '/login', 'logout -> /login');
  ok((await get('student', '/student')).loc === '/login', 'protected route blocked after logout');

  // Cleanup any residue on the shared slot.
  await Slot.updateOne({ _id: slot._id }, { status: 'open' });
  await Interview.deleteMany({ slot_id: slot._id });

  console.log(`\n=== Auth & Lifecycle E2E: ${pass} passed, ${fail} failed ===\n`);
  server.close();
  await mongoose.disconnect();
  // The connect-mongo session store keeps its own MongoClient open; exit explicitly.
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
