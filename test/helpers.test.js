'use strict';
const assert = require('assert');
const h = require('../src/helpers');

console.log('=== Running Helpers Unit Tests ===');

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    fail++;
    console.error(`  \x1b[31m✗\x1b[0m ${name}:`, err.message);
  }
}

// 1. Date & Time operations
test('today() returns YYYY-MM-DD format', () => {
  const t = h.today();
  assert.match(t, /^\d{4}-\d{2}-\d{2}$/);
});

test('nowMinute() returns YYYY-MM-DD HH:MM format', () => {
  const nm = h.nowMinute();
  assert.match(nm, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('addDays() adds and subtracts correctly', () => {
  assert.strictEqual(h.addDays('2026-08-31', 1), '2026-09-01');
  assert.strictEqual(h.addDays('2026-09-01', -1), '2026-08-31');
  assert.strictEqual(h.addDays('2026-12-31', 1), '2027-01-01');
});

test('normalizeTime() formats standard and 12-hour strings', () => {
  assert.strictEqual(h.normalizeTime('9:00'), '09:00');
  assert.strictEqual(h.normalizeTime('09:30'), '09:30');
  assert.strictEqual(h.normalizeTime('14:45'), '14:45');
});

test('fmtDate(), fmtTime(), and fmtSlot() format correctly', () => {
  const formatted = h.fmtDate('2026-09-01');
  assert.ok(formatted.includes('Sep') || formatted.includes('1'));

  const timeStr = h.fmtTime('09:00');
  assert.strictEqual(timeStr, '9:00 AM');

  const slotStr = h.fmtSlot({ slot_date: '2026-09-01', start_time: '09:00', end_time: '09:45' });
  assert.ok(slotStr.includes('9:00 AM'));
  assert.ok(slotStr.includes('9:45 AM'));
});

// 2. Profile validation
test('isStudentProfileComplete() checks required fields', () => {
  const complete = {
    name: 'Aisha Sharma',
    phone: '+919876543210',
    squad: '116',
    branch: 'CSE',
    resume_url: 'https://drive.google.com/resume.pdf',
  };
  assert.strictEqual(h.isStudentProfileComplete(complete), true);

  const incomplete = {
    name: 'Aisha Sharma',
    role: 'student',
    phone: '',
    squad: '',
    branch: 'CSE',
    resume_url: '',
  };
  assert.strictEqual(h.isStudentProfileComplete(incomplete), false);
  const missing = h.getMissingStudentProfileFields(incomplete);
  assert.ok(missing.includes('Phone number'));
  assert.ok(missing.includes('Squad'));
  assert.ok(missing.includes('Resume link'));
});

// 3. Meeting link generation
test('generateMeetingLink() generates valid meet URLs', () => {
  const link = h.generateMeetingLink('09:00');
  assert.match(link, /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
});

// 4. Utility string helpers
test('titleCase() capitalizes words correctly', () => {
  assert.strictEqual(h.titleCase('technical'), 'Technical');
  assert.strictEqual(h.titleCase('hr'), 'HR');
  assert.strictEqual(h.titleCase('john doe'), 'John doe');
});

test('linkify() converts URLs to anchor tags', () => {
  const text = 'Join at https://meet.google.com/abc-defg-hij for interview';
  const html = h.linkify(text);
  assert.ok(html.includes('<a href="https://meet.google.com/abc-defg-hij"'));
});

test('isValidEmail() validates email formats', () => {
  assert.strictEqual(h.isValidEmail('test@konfident.in'), true);
  assert.strictEqual(h.isValidEmail('not-an-email'), false);
  assert.strictEqual(h.isValidEmail(''), false);
});

test('isValidUrl() validates URL formats', () => {
  assert.strictEqual(h.isValidUrl('https://example.com'), true);
  assert.strictEqual(h.isValidUrl('http://localhost:3000'), true);
  assert.strictEqual(h.isValidUrl('not-a-url'), false);
});

console.log(`\nHelpers Tests Summary: ${pass} passed, ${fail} failed.\n`);
if (fail > 0) process.exit(1);
