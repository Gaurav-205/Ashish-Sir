'use strict';
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { User } = require('../src/models');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/konfident';

async function seedUsersOnly() {
  console.log('=== Seeding MongoDB: Users Only (Zero Slots) ===');
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  console.log('✓ Connected to MongoDB');

  const pwHash = bcrypt.hashSync('pass123', 10);

  // 1. Ensure Root Admin
  let admin = await User.findOne({ role: 'admin' });
  if (!admin) {
    admin = await User.create({
      name: process.env.ADMIN_NAME || 'Head Administrator',
      email: (process.env.ADMIN_EMAIL || 'admin@konfident.edu').toLowerCase().trim(),
      password_hash: pwHash,
      role: 'admin',
      can_technical: 1,
      can_hr: 1,
      active: 1,
    });
    console.log('✓ Provisioned Root Admin:', admin.email);
  }

  const userCount = await User.countDocuments();
  console.log(`✓ Total Users in MongoDB: ${userCount}`);
  console.log('✓ No slots or mock records created. Database is ready for custom slot creation.');
  console.log('=== Seeding Complete ===');
  await mongoose.disconnect();
}

seedUsersOnly().catch(err => {
  console.error('Seeding failed:', err.message);
  process.exit(1);
});
