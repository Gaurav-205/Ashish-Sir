'use strict';
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  password_hash: { type: String, required: true },
  role: { type: String, required: true, enum: ['student', 'mentor', 'admin', 'developer'], index: true },
  phone: { type: String, default: null, trim: true },
  roll_no: { type: String, default: null, trim: true, index: true },
  branch: { type: String, default: null, trim: true },
  squad: { type: String, default: null, trim: true },
  resume_url: { type: String, default: null, trim: true },
  can_technical: { type: Number, default: 0 },
  can_hr: { type: Number, default: 0 },
  active: { type: Number, default: 1, index: true },
  is_developer: { type: Number, default: 0 },
  google_id: { type: String, default: null, index: true },
  google_access_token: { type: String, default: null },
  google_refresh_token: { type: String, default: null },
  google_token_expiry: { type: Number, default: null },
  google_calendar_enabled: { type: Number, default: 1 },
  sessions_invalid_before: { type: Number, default: null },
  created_at: { type: Date, default: Date.now },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

userSchema.index({ role: 1, active: 1 });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
