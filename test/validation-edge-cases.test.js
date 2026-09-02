'use strict';
const assert = require('assert');
const mongoose = require('mongoose');
const h = require('../src/helpers');
const { RUBRIC, GRAND_TOTAL, grade } = require('../src/rubric');
const { validateId, createRateLimiter } = require('../src/middleware/security');

console.log('=== Running Extended Validation & Edge-Cases Test Suite ===');

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

// ---- 1. Rubric & Score Calculation Boundaries ----
test('Rubric structure has valid criteria limits and matches GRAND_TOTAL', () => {
  assert.strictEqual(RUBRIC.technical.total, 30);
  assert.strictEqual(RUBRIC.hr.total, 20);
  assert.strictEqual(GRAND_TOTAL, 50);

  const techSum = RUBRIC.technical.criteria.reduce((s, c) => s + c.max, 0);
  assert.strictEqual(techSum, RUBRIC.technical.total);

  const hrSum = RUBRIC.hr.criteria.reduce((s, c) => s + c.max, 0);
  assert.strictEqual(hrSum, RUBRIC.hr.total);
});

test('Grade calculation maps percentages accurately to labels and style classes', () => {
  assert.strictEqual(grade(95).label, 'Outstanding');
  assert.strictEqual(grade(95).cls, 'g-a');
  assert.strictEqual(grade(85).label, 'Outstanding');
  assert.strictEqual(grade(75).label, 'Good');
  assert.strictEqual(grade(75).cls, 'g-b');
  assert.strictEqual(grade(60).label, 'Average');
  assert.strictEqual(grade(60).cls, 'g-c');
  assert.strictEqual(grade(45).label, 'Needs Work');
  assert.strictEqual(grade(45).cls, 'g-d');
  assert.strictEqual(grade(30).label, 'Poor');
  assert.strictEqual(grade(30).cls, 'g-e');
});

// ---- 2. Date & Time Arithmetic & Boundary Operations ----
test('addDays handles leap year boundaries and month wraps correctly', () => {
  // Leap year 2028
  assert.strictEqual(h.addDays('2028-02-28', 1), '2028-02-29');
  assert.strictEqual(h.addDays('2028-02-29', 1), '2028-03-01');
  // Non-leap year 2026
  assert.strictEqual(h.addDays('2026-02-28', 1), '2026-03-01');
  // Year transition
  assert.strictEqual(h.addDays('2025-12-31', 1), '2026-01-01');
  assert.strictEqual(h.addDays('2026-01-01', -1), '2025-12-31');
});

test('normalizeTime handles single-digit hours and minutes reliably', () => {
  assert.strictEqual(h.normalizeTime('8:5'), '08:05');
  assert.strictEqual(h.normalizeTime('00:00'), '00:00');
  assert.strictEqual(h.normalizeTime('23:59'), '23:59');
  assert.strictEqual(h.normalizeTime('invalid'), '');
  assert.strictEqual(h.normalizeTime(''), '');
});

test('fmtTime formats morning, noon, afternoon, and midnight', () => {
  assert.strictEqual(h.fmtTime('00:00'), '12:00 AM');
  assert.strictEqual(h.fmtTime('09:05'), '9:05 AM');
  assert.strictEqual(h.fmtTime('12:00'), '12:00 PM');
  assert.strictEqual(h.fmtTime('15:30'), '3:30 PM');
  assert.strictEqual(h.fmtTime('23:45'), '11:45 PM');
});

test('getWeekRange and getWeekKey calculate Monday-to-Sunday cycles in IST', () => {
  const range = h.getWeekRange('2026-09-02'); // Wednesday
  assert.strictEqual(range.start, '2026-08-31'); // Monday
  assert.strictEqual(range.end, '2026-09-06');   // Sunday
  assert.strictEqual(h.getWeekKey('2026-09-02'), '2026-08-31');
});

// ---- 3. Slot Overlap Logic Tests ----
test('Time range overlap detection identifies conflicts correctly', () => {
  function isOverlap(start1, end1, start2, end2) {
    return start1 < end2 && end1 > start2;
  }

  // Exact match -> conflict
  assert.strictEqual(isOverlap('09:00', '09:30', '09:00', '09:30'), true);
  // Partial overlap -> conflict
  assert.strictEqual(isOverlap('09:00', '09:30', '09:15', '09:45'), true);
  // Contained inside -> conflict
  assert.strictEqual(isOverlap('09:00', '10:00', '09:15', '09:45'), true);
  // Back-to-back adjacent -> NO conflict
  assert.strictEqual(isOverlap('09:00', '09:30', '09:30', '10:00'), false);
  // Disjoint -> NO conflict
  assert.strictEqual(isOverlap('09:00', '09:30', '10:00', '10:30'), false);
});

// ---- 4. Student Profile Completeness Diagnostic ----
test('getMissingStudentProfileFields accurately pinpoints every missing requirement', () => {
  const emptyStudent = { role: 'student', name: '', phone: '', squad: '', branch: '', resume_url: '' };
  const missing = h.getMissingStudentProfileFields(emptyStudent);
  assert.strictEqual(missing.length, 5);
  assert.ok(missing.includes('Full name'));
  assert.ok(missing.includes('Phone number'));
  assert.ok(missing.includes('Squad'));
  assert.ok(missing.includes('Branch / Specialization'));
  assert.ok(missing.includes('Resume link'));

  const partial = { role: 'student', name: 'Student 1', phone: '+919876543210', squad: '116', branch: '', resume_url: 'https://resume.com' };
  const partialMissing = h.getMissingStudentProfileFields(partial);
  assert.strictEqual(partialMissing.length, 1);
  assert.strictEqual(partialMissing[0], 'Branch / Specialization');
});

test('validatePassword enforces minimum password length', () => {
  assert.strictEqual(h.validatePassword('12345'), 'Password must be at least 6 characters.');
  assert.strictEqual(h.validatePassword(''), 'Password must be at least 6 characters.');
  assert.strictEqual(h.validatePassword(null), 'Password must be at least 6 characters.');
  assert.strictEqual(h.validatePassword('123456'), null);
  assert.strictEqual(h.validatePassword('securePass123!'), null);
});

// ---- 5. Security & Parameter Validation ----
test('validateId middleware accepts valid Mongo ObjectIds and rejects malicious strings', () => {
  const validObjectId = new mongoose.Types.ObjectId().toString();
  const validator = validateId('id');

  let passed = false;
  let errorStatus = null;

  // Valid ID
  validator({ params: { id: validObjectId } }, { status: (s) => ({ render: () => { errorStatus = s; } }) }, () => {
    passed = true;
  });
  assert.strictEqual(passed, true);

  // Invalid injection string
  passed = false;
  validator({
    params: { id: "'; DROP TABLE users; --" },
    accepts: () => true
  }, {
    status: (s) => {
      errorStatus = s;
      return { render: () => {} };
    }
  }, () => {
    passed = true;
  });
  assert.strictEqual(passed, false);
  assert.strictEqual(errorStatus, 400);
});

test('isValidEmail catches invalid formats and ReDoS attack patterns safely', () => {
  assert.strictEqual(h.isValidEmail('user@domain.com'), true);
  assert.strictEqual(h.isValidEmail('first.last+tag@sub.domain.org'), true);
  assert.strictEqual(h.isValidEmail('plainaddress'), false);
  assert.strictEqual(h.isValidEmail('@missingusername.com'), false);
  assert.strictEqual(h.isValidEmail('user@.com'), false);
  assert.strictEqual(h.isValidEmail(''), false);
  assert.strictEqual(h.isValidEmail(null), false);
});

test('isValidUrl accepts HTTP/HTTPS and rejects javascript: or ftp: schemes', () => {
  assert.strictEqual(h.isValidUrl('https://meet.google.com/abc-defg-hij'), true);
  assert.strictEqual(h.isValidUrl('http://localhost:3000'), true);
  assert.strictEqual(h.isValidUrl('javascript:alert(1)'), false);
  assert.strictEqual(h.isValidUrl('ftp://files.example.com'), false);
  assert.strictEqual(h.isValidUrl('not-a-url'), false);
});

test('isSafeLocalPath guards against open redirect attacks', () => {
  assert.strictEqual(h.isSafeLocalPath('/student'), true);
  assert.strictEqual(h.isSafeLocalPath('/admin/slots?type=technical'), true);
  assert.strictEqual(h.isSafeLocalPath('https://attacker.com/evil'), false);
  assert.strictEqual(h.isSafeLocalPath('//attacker.com/evil'), false);
  assert.strictEqual(h.isSafeLocalPath('/\\evil.com'), false);
});

test('escapeHtml prevents XSS injection strings in generated HTML', () => {
  const safe = h.escapeHtml('<script>alert("xss")</script>');
  assert.strictEqual(safe, '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.strictEqual(h.escapeHtml(null), '');
});

// ---- 6. Rate Limiter Edge Cases ----
test('createRateLimiter produces functioning limiter and tracks request counts', () => {
  const limiter = createRateLimiter({ max: 2, windowMs: 1000 });
  const req = { ip: '127.0.0.1', headers: {}, accepts: () => false };
  const res = {
    setHeader: () => {},
    status: (s) => ({ json: (d) => ({ status: s, data: d }) })
  };

  let nextCalled = 0;
  limiter(req, res, () => { nextCalled++; });
  limiter(req, res, () => { nextCalled++; });
  assert.strictEqual(nextCalled, 2);

  // Third request exceeds rate limit
  let blocked = false;
  const blockRes = {
    setHeader: () => {},
    status: (s) => ({
      json: (d) => { blocked = true; assert.strictEqual(s, 429); }
    })
  };
  limiter(req, blockRes, () => { nextCalled++; });
  assert.strictEqual(blocked, true);
  assert.strictEqual(nextCalled, 2);
});

console.log(`\nValidation & Edge-Cases Tests Summary: ${pass} passed, ${fail} failed.\n`);
if (fail > 0) process.exit(1);
