'use strict';
/**
 * Non-destructive test fixtures. Upserts a minimal working cohort (one admin,
 * a technical mentor, an HR mentor, three fully-profiled students) plus a
 * handful of future open slots, so the integration and query suites have
 * something to run against without wiping an existing database.
 */
const bcrypt = require('bcryptjs');
const { User, Slot } = require('../src/models');
const h = require('../src/helpers');

const PW = bcrypt.hashSync('pass123', 10);

async function upsertUser(doc) {
  const existing = await User.findOne({ email: doc.email.toLowerCase() });
  if (existing) {
    Object.assign(existing, doc, { email: doc.email.toLowerCase(), password_hash: PW, active: 1 });
    await existing.save();
    return existing;
  }
  return User.create({ ...doc, email: doc.email.toLowerCase(), password_hash: PW, active: 1 });
}

async function ensureFixtures() {
  const admin = await upsertUser({ name: 'Test Admin', email: 'test.admin@konfident.edu', role: 'admin' });
  const techMentor = await upsertUser({ name: 'Test Tech Mentor', email: 'test.tech@konfident.edu', role: 'mentor', can_technical: 1, can_hr: 0 });
  const hrMentor = await upsertUser({ name: 'Test HR Mentor', email: 'test.hr@konfident.edu', role: 'mentor', can_technical: 0, can_hr: 1 });

  const students = [];
  for (let i = 1; i <= 3; i++) {
    students.push(await upsertUser({
      name: `Test Student ${i}`,
      email: `test.student${i}@konfident.edu`,
      role: 'student',
      roll_no: `TST00${i}`,
      squad: i % 2 ? '116' : '115',
      branch: 'CSE',
      phone: '+91 98765 43210',
      resume_url: `https://drive.google.com/file/d/TST00${i}/view`,
    }));
  }

  // A few future open slots for each mentor (idempotent by mentor+date+time).
  const addMin = (t, m) => {
    const [hh, mm] = t.split(':').map(Number);
    const tot = hh * 60 + mm + m;
    return `${String(Math.floor(tot / 60)).padStart(2, '0')}:${String(tot % 60).padStart(2, '0')}`;
  };
  const times = ['09:00', '10:00', '11:00'];
  for (let d = 2; d <= 4; d++) {
    const date = h.addDays(h.today(), d);
    for (const [mentor, type] of [[techMentor, 'technical'], [hrMentor, 'hr']]) {
      for (const t of times) {
        await Slot.updateOne(
          { mentor_id: mentor._id, slot_date: date, start_time: t },
          { $setOnInsert: { mentor_id: mentor._id, type, slot_date: date, start_time: t, end_time: addMin(t, 45), mode: 'Online', location: h.generateMeetingLink(type), status: 'open' } },
          { upsert: true }
        );
      }
    }
  }

  return { admin, techMentor, hrMentor, students };
}

module.exports = { ensureFixtures };
