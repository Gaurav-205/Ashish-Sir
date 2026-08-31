'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const mongoose = require('mongoose');
const { User, Setting } = require('../src/models');

const DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/konfident';

async function migrate() {
  console.log('=== Starting PostgreSQL -> MongoDB Migration ===');
  console.log('Target MongoDB URI:', MONGODB_URI.replace(/\/\/.*@/, '//***:***@'));

  // 1. Connect to MongoDB
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  console.log('✓ Connected to MongoDB');

  // 2. Connect to PostgreSQL
  if (!DATABASE_URL) {
    console.log('No PostgreSQL DATABASE_URL found. Initializing empty MongoDB schema.');
    process.exit(0);
  }

  const cleanPgUrl = DATABASE_URL.replace(/([?&])sslmode=(require|prefer|verify-ca)/gi, '$1sslmode=verify-full');
  const pgPool = new Pool({
    connectionString: cleanPgUrl,
    ssl: { rejectUnauthorized: false },
  });

  const pgClient = await pgPool.connect();
  console.log('✓ Connected to PostgreSQL');

  try {
    // 3. Fetch all users from PostgreSQL
    const res = await pgClient.query('SELECT * FROM users ORDER BY id ASC');
    const pgUsers = res.rows;
    console.log(`Found ${pgUsers.length} users in PostgreSQL`);

    let migrated = 0;
    for (const u of pgUsers) {
      const email = String(u.email || '').toLowerCase().trim();
      const existing = await User.findOne({ email });

      const userData = {
        name: u.name,
        email,
        password_hash: u.password_hash,
        role: u.role,
        phone: u.phone || null,
        roll_no: u.roll_no || null,
        branch: u.branch || null,
        squad: u.squad || null,
        resume_url: u.resume_url || null,
        can_technical: Number(u.can_technical) || 0,
        can_hr: Number(u.can_hr) || 0,
        active: u.active !== undefined ? Number(u.active) : 1,
        is_developer: Number(u.is_developer) || 0,
        google_id: u.google_id || null,
        google_access_token: u.google_access_token || null,
        google_refresh_token: u.google_refresh_token || null,
        google_token_expiry: u.google_token_expiry ? Number(u.google_token_expiry) : null,
        google_calendar_enabled: u.google_calendar_enabled !== undefined ? Number(u.google_calendar_enabled) : 1,
        sessions_invalid_before: u.sessions_invalid_before ? Number(u.sessions_invalid_before) : null,
      };

      if (existing) {
        await User.updateOne({ _id: existing._id }, { $set: userData });
      } else {
        await User.create(userData);
      }
      migrated++;
    }

    const totalMongoUsers = await User.countDocuments();
    console.log(`✓ Migration Complete! Migrated ${migrated} accounts. Total in MongoDB: ${totalMongoUsers}`);
  } catch (err) {
    console.error('Migration Error:', err);
  } finally {
    pgClient.release();
    await pgPool.end();
    await mongoose.disconnect();
    console.log('=== Done ===');
  }
}

migrate();
