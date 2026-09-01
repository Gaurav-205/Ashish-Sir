'use strict';
require('dotenv').config();
const { connectDb, mongoose, User, Slot, Interview, Evaluation, StudentFeedback, AuditLog, PasswordReset } = require('../src/db');

async function resetDb() {
  console.log('=== Resetting MongoDB (Clearing Operational Records) ===');
  await connectDb();
  console.log('✓ Connected to MongoDB Atlas');

  const [deletedSlots, deletedInterviews, deletedEvals, deletedFeedback] = await Promise.all([
    Slot.deleteMany({}),
    Interview.deleteMany({}),
    Evaluation.deleteMany({}),
    StudentFeedback.deleteMany({}),
    AuditLog.deleteMany({}),
    PasswordReset.deleteMany({}),
  ]);

  const userCount = await User.countDocuments();
  const slotCount = await Slot.countDocuments();

  console.log(`✓ Deleted ${deletedSlots.deletedCount} slots`);
  console.log(`✓ Deleted ${deletedInterviews.deletedCount} interviews`);
  console.log(`✓ Deleted ${deletedEvals.deletedCount} evaluations`);
  console.log(`✓ Deleted ${deletedFeedback.deletedCount} feedbacks`);
  console.log(`✓ Users Preserved: ${userCount}`);
  console.log(`✓ Remaining Slots in DB: ${slotCount}`);
  console.log('=== Database Reset Complete ===');

  await mongoose.disconnect();
}

resetDb().catch(err => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});
