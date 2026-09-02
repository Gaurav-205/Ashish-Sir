'use strict';
require('dotenv').config();
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/konfident';
const assert = require('assert');
const { connectDb, mongoose, User, Slot, Interview, Evaluation } = require('../src/db');
const q = require('../src/queries');

console.log('=== Running MongoDB Queries & Aggregations Unit Tests ===');

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
  await require('./fixtures').ensureFixtures();

  await test('mentorsList() retrieves active mentors', async () => {
    const mentors = await q.mentorsList();
    assert.ok(Array.isArray(mentors));
    assert.ok(mentors.length > 0);
    assert.ok(mentors[0].name && mentors[0].email);
  });

  await test('adminStats() aggregates dashboard metrics accurately', async () => {
    const stats = await q.adminStats();
    assert.ok(typeof stats.students === 'number');
    assert.ok(typeof stats.mentors === 'number');
    assert.ok(typeof stats.slots === 'number');
    assert.ok(typeof stats.openSlots === 'number');
    assert.ok(typeof stats.booked === 'number');
    assert.ok(typeof stats.completed === 'number');
  });

  await test('allStudentSummaries() calculates cohort progress rollups', async () => {
    const summaries = await q.allStudentSummaries();
    assert.ok(Array.isArray(summaries));
    assert.ok(summaries.length > 0);
    const first = summaries[0];
    assert.ok(first.student && first.student.name);
    assert.ok(typeof first.profileComplete === 'boolean');
    assert.ok(Array.isArray(first.missingFields));
  });

  await test('studentSummary() retrieves single candidate dossier', async () => {
    const student = await User.findOne({ role: 'student', active: 1 });
    assert.ok(student, 'Student exists in database');
    const summary = await q.studentSummary(student._id);
    assert.ok(summary);
    assert.strictEqual(String(summary.student._id), String(student._id));
    assert.ok(typeof summary.profileComplete === 'boolean');
  });

  await test('interviewsForStudent() returns sorted array of student sessions', async () => {
    const student = await User.findOne({ role: 'student', active: 1 });
    assert.ok(student);
    const ivs = await q.interviewsForStudent(student._id);
    assert.ok(Array.isArray(ivs));
  });

  await test('interviewsForMentor() returns mentor sessions', async () => {
    const mentor = await User.findOne({ role: 'mentor', active: 1 });
    assert.ok(mentor);
    const ivs = await q.interviewsForMentor(mentor._id);
    assert.ok(Array.isArray(ivs));
  });

  await test('computeTotal() verifies criterion marks bounds correctly', async () => {
    const validTech = { resume_marks: 8, project_marks: 9, dsa_marks: 10 };
    assert.strictEqual(q.computeTotal('technical', validTech), 27);

    const validHr = { behaviour_marks: 8, hr_perf_marks: 9 };
    assert.strictEqual(q.computeTotal('hr', validHr), 17);

    // Out of bounds mark throws Error
    assert.throws(() => {
      q.computeTotal('technical', { resume_marks: 15, project_marks: 9, dsa_marks: 10 });
    }, /must be a whole number between 0 and 10/);

    assert.throws(() => {
      q.computeTotal('hr', { behaviour_marks: -1, hr_perf_marks: 9 });
    }, /must be a whole number between 0 and 10/);
  });

  await test('mentorsWithOpenSlots() groups available evaluators by type', async () => {
    const grouped = await q.mentorsWithOpenSlots();
    assert.ok(Array.isArray(grouped));
  });

  console.log(`\nQueries Tests Summary: ${pass} passed, ${fail} failed.\n`);
  await mongoose.disconnect();
  if (fail > 0) process.exit(1);
})();
