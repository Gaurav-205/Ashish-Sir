'use strict';
const mongoose = require('mongoose');

const evaluationSchema = new mongoose.Schema({
  interview_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Interview', required: true, unique: true, index: true },
  mentor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  student_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  type: { type: String, enum: ['technical', 'hr'], default: 'technical', index: true },
  resume_marks: { type: Number, default: 0 },
  project_marks: { type: Number, default: 0 },
  dsa_marks: { type: Number, default: 0 },
  behaviour_marks: { type: Number, default: 0 },
  hr_perf_marks: { type: Number, default: 0 },
  total: { type: Number, required: true },
  feedback: { type: String, default: '' },
  submitted_at: { type: Date, default: Date.now },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

module.exports = mongoose.models.Evaluation || mongoose.model('Evaluation', evaluationSchema);
