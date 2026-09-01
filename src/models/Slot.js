'use strict';
const mongoose = require('mongoose');

const slotSchema = new mongoose.Schema({
  mentor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, required: true, enum: ['technical', 'hr'], index: true },
  slot_date: { type: String, required: true, index: true }, // Format: YYYY-MM-DD
  start_time: { type: String, required: true },            // Format: HH:MM
  end_time: { type: String, required: true },              // Format: HH:MM
  mode: { type: String, default: 'Online' },
  location: { type: String, default: 'Google Meet' },
  status: { type: String, default: 'open', enum: ['open', 'booked', 'cancelled'], index: true },
  google_event_id: { type: String, default: null },
  created_at: { type: Date, default: Date.now },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

slotSchema.index({ status: 1, type: 1, slot_date: 1, start_time: 1 });
slotSchema.index({ mentor_id: 1, status: 1, slot_date: 1 });
slotSchema.index({ mentor_id: 1, slot_date: 1, start_time: 1, end_time: 1 });

function normalizeTimeStr(hm) {
  if (!hm) return hm;
  const match = String(hm).trim().match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/);
  if (!match) return hm;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

slotSchema.pre('validate', function () {
  if (this.start_time) this.start_time = normalizeTimeStr(this.start_time);
  if (this.end_time) this.end_time = normalizeTimeStr(this.end_time);
});

slotSchema.pre('insertMany', function (docs) {
  if (Array.isArray(docs)) {
    docs.forEach(doc => {
      if (doc.start_time) doc.start_time = normalizeTimeStr(doc.start_time);
      if (doc.end_time) doc.end_time = normalizeTimeStr(doc.end_time);
    });
  }
});

module.exports = mongoose.models.Slot || mongoose.model('Slot', slotSchema);
