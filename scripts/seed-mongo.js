'use strict';
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { User, Slot } = require('../src/models');
const h = require('../src/helpers');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/konfident';

async function seed() {
  console.log('=== Seeding MongoDB for Konfident Platform ===');
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

  // 2. Fetch all active mentors
  const mentors = await User.find({
    $or: [{ role: 'mentor' }, { can_technical: 1 }, { can_hr: 1 }],
    active: 1,
  });

  console.log(`Found ${mentors.length} active mentors/evaluators`);

  // 3. Generate fresh upcoming slots for next 4 days
  const tomorrow = h.addDays(h.today(), 1);
  const dates = [tomorrow, h.addDays(tomorrow, 1), h.addDays(tomorrow, 2), h.addDays(tomorrow, 3)];
  const times = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'];

  let slotsCreated = 0;
  for (const m of mentors) {
    const types = [];
    if (m.can_technical || m.role === 'mentor') types.push('technical');
    if (m.can_hr) types.push('hr');

    for (const t of types) {
      for (const d of dates) {
        for (const start of times) {
          const [hPart, mPart] = start.split(':').map(Number);
          const endMin = hPart * 60 + mPart + 45;
          const endH = String(Math.floor(endMin / 60)).padStart(2, '0');
          const endM = String(endMin % 60).padStart(2, '0');
          const end = `${endH}:${endM}`;

          const exists = await Slot.findOne({
            mentor_id: m._id,
            slot_date: d,
            start_time: start,
          });

          if (!exists) {
            await Slot.create({
              mentor_id: m._id,
              type: t,
              slot_date: d,
              start_time: start,
              end_time: end,
              mode: 'Online',
              location: h.generateMeetingLink(start),
              status: 'open',
            });
            slotsCreated++;
          }
        }
      }
    }
  }

  console.log(`✓ Seeded ${slotsCreated} upcoming slots across evaluators`);
  console.log('=== Seeding Complete ===');
  await mongoose.disconnect();
}

seed().catch(err => {
  console.error('Seeding failed:', err.message);
  process.exit(1);
});
