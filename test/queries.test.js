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

  await test('mentorsWithOpenSlots() groups available evaluators by type', async () => {
    const grouped = await q.mentorsWithOpenSlots();
    assert.ok(Array.isArray(grouped));
  });

  console.log(`\nQueries Tests Summary: ${pass} passed, ${fail} failed.\n`);
  await mongoose.disconnect();
  if (fail > 0) process.exit(1);
})();
