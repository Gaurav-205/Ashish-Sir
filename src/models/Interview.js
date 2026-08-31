'use strict';
const mongoose = require('mongoose');

const interviewSchema = new mongoose.Schema({
  slot_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Slot', required: true, index: true },
  student_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  mentor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, required: true, enum: ['technical', 'hr'], index: true },
  status: { type: String, default: 'booked', enum: ['booked', 'completed', 'cancelled'], index: true },
  attendance: { type: String, default: 'pending', enum: ['pending', 'attended', 'absent'], index: true },
  google_event_id: { type: String, default: null },
  created_at: { type: Date, default: Date.now },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

interviewSchema.index({ student_id: 1, type: 1, status: 1 });
interviewSchema.index({ mentor_id: 1, status: 1 });
interviewSchema.index({ slot_id: 1, status: 1 });

module.exports = mongoose.models.Interview || mongoose.model('Interview', interviewSchema);
