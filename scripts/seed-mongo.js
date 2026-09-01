'use strict';
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { connectDb, mongoose, User } = require('../src/db');

async function seedUsersOnly() {
  console.log('=== Seeding MongoDB: Users & Mentors Cohort ===');
  await connectDb();
  console.log('✓ Connected to MongoDB');

  const pwHash = bcrypt.hashSync('pass123', 10);

  // 1. Ensure Root Admin
  let admin = await User.findOne({ email: (process.env.ADMIN_EMAIL || 'utkarsha.kasar@kalvium.com').toLowerCase().trim() });
  if (!admin) {
    admin = await User.create({
      name: process.env.ADMIN_NAME || 'Utkarsha Kasar',
      email: (process.env.ADMIN_EMAIL || 'utkarsha.kasar@kalvium.com').toLowerCase().trim(),
      password_hash: pwHash,
      role: 'admin',
      can_technical: 1,
      can_hr: 1,
      active: 1,
    });
    console.log('✓ Provisioned Root Admin:', admin.email);
  }

  // 2. Provision Default Mentors
  const mentors = [
    { name: 'Manav Verma', email: 'manav.verma@kalvium.com', can_t: 1, can_hr: 1 },
    { name: 'Muskan Srivastava', email: 'muskan.srivastava@kalvium.com', can_t: 0, can_hr: 1 },
    { name: 'Ritu Soni', email: 'ritu.soni@kalvium.com', can_t: 1, can_hr: 0 },
    { name: 'Shikhar Agarwal', email: 'shikhar.agarwal@kalvium.com', can_t: 1, can_hr: 0 },
  ];

  for (const m of mentors) {
    let exists = await User.findOne({ email: m.email });
    if (!exists) {
      await User.create({
        name: m.name,
        email: m.email,
        password_hash: pwHash,
        role: 'mentor',
        can_technical: m.can_t,
        can_hr: m.can_hr,
        active: 1,
      });
      console.log('✓ Provisioned Mentor:', m.email);
    }
  }

  // 3. Provision Default Students
  const students = [
    { name: 'Isha Agrawal', email: 'isha.agrawal.s.116@kalvium.community', squad: '116', roll_no: 'KAL116001' },
    { name: 'Aditya Talikoti', email: 'aditya.talikoti.s.116@kalvium.community', squad: '116', roll_no: 'KAL116002' },
    { name: 'Digvijay Patil', email: 'digvijay.patil.s.116@kalvium.community', squad: '116', roll_no: 'KAL116003' },
  ];

  for (const s of students) {
    let exists = await User.findOne({ email: s.email });
    if (!exists) {
      await User.create({
        name: s.name,
        email: s.email,
        password_hash: pwHash,
        role: 'student',
        squad: s.squad,
        roll_no: s.roll_no,
        branch: 'CSE',
        phone: '+91 98765 43210',
        resume_url: 'https://drive.google.com/resume.pdf',
        active: 1,
      });
      console.log('✓ Provisioned Student:', s.email);
    }
  }

  const userCount = await User.countDocuments();
  console.log(`✓ Total Users in MongoDB: ${userCount}`);
  console.log('=== Seeding Complete ===');
  await mongoose.disconnect();
}

seedUsersOnly().catch(err => {
  console.error('Seeding failed:', err.message);
  process.exit(1);
});
