'use strict';
const mongoose = require('mongoose');

const passwordResetSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  token_hash: { type: String, required: true, unique: true, index: true },
  expires_at: { type: Date, required: true, index: { expires: 0 } },
  used_at: { type: Date, default: null },
  created_at: { type: Date, default: Date.now },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

module.exports = mongoose.models.PasswordReset || mongoose.model('PasswordReset', passwordResetSchema);
