'use strict';
const mongoose = require('mongoose');

const studentFeedbackSchema = new mongoose.Schema({
  interview_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Interview', required: true, unique: true, index: true },
  student_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  mentor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  satisfaction: { type: Number, required: true, min: 1, max: 5 },
  structured: { type: Number, required: true, enum: [0, 1] },
  hr_relevant: { type: Number, enum: [0, 1], default: null },
  feedback_text: { type: String, default: null },
  submitted_at: { type: Date, default: Date.now },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

module.exports = mongoose.models.StudentFeedback || mongoose.model('StudentFeedback', studentFeedbackSchema);
