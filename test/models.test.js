'use strict';
require('dotenv').config();
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/konfident';
const assert = require('assert');
const { connectDb, mongoose, User, Slot, Interview, Evaluation, StudentFeedback, AuditLog, PasswordReset, Setting } = require('../src/db');

console.log('=== Running MongoDB Models Unit Tests ===');

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    fail++;
    console.error(`  \x1b[31m✗\x1b[0m ${name}:`, err.message);
  }
}

(async () => {
  await connectDb();

  await test('User model schema requirements and defaults', async () => {
    const userDoc = new User({
      name: 'Schema Test User',
      email: 'schema.test@konfident.edu',
      password_hash: 'hash123',
      role: 'student',
    });
    assert.strictEqual(userDoc.active, 1);
    assert.strictEqual(userDoc.can_technical, 0);
    assert.strictEqual(userDoc.can_hr, 0);
    assert.strictEqual(userDoc.sessions_invalid_before, null);
  });

  await test('Slot model schema defaults and statuses', async () => {
    const slotDoc = new Slot({
      mentor_id: new mongoose.Types.ObjectId(),
      type: 'technical',
      slot_date: '2026-09-05',
      start_time: '10:00',
      end_time: '10:45',
    });
    assert.strictEqual(slotDoc.mode, 'Online');
    assert.strictEqual(slotDoc.status, 'open');
  });

  await test('Interview model schema defaults and references', async () => {
    const ivDoc = new Interview({
      slot_id: new mongoose.Types.ObjectId(),
      student_id: new mongoose.Types.ObjectId(),
      mentor_id: new mongoose.Types.ObjectId(),
      type: 'technical',
    });
    assert.strictEqual(ivDoc.status, 'booked');
    assert.strictEqual(ivDoc.attendance, 'pending');
  });

  await test('Evaluation model schema calculation', async () => {
    const evalDoc = new Evaluation({
      interview_id: new mongoose.Types.ObjectId(),
      student_id: new mongoose.Types.ObjectId(),
      mentor_id: new mongoose.Types.ObjectId(),
      type: 'technical',
      resume_marks: 4,
      project_marks: 8,
      dsa_marks: 12,
      total: 24,
      feedback: 'Solid performance in data structures and systems design.',
    });
    assert.strictEqual(evalDoc.total, 24);
    assert.ok(evalDoc.submitted_at instanceof Date);
  });

  await test('AuditLog model timestamps and actions', async () => {
    const logDoc = new AuditLog({
      action: 'TEST_ACTION',
      user_id: new mongoose.Types.ObjectId(),
      ip: '127.0.0.1',
      details: { test: true },
    });
    assert.strictEqual(logDoc.action, 'TEST_ACTION');
    assert.ok(logDoc.created_at instanceof Date);
  });

  console.log(`\nModels Tests Summary: ${pass} passed, ${fail} failed.\n`);
  await mongoose.disconnect();
  if (fail > 0) process.exit(1);
})();
