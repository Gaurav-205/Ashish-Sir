'use strict';
const crypto = require('crypto');
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtDate(ymd) {
  if (!ymd) return '—';
  const parts = String(ymd).split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return ymd;
  const [y, m, d] = parts;
  if (!y || !m || !d) return ymd;
  const dt = new Date(Date.UTC(y, m - 1, d));
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return `${days[dt.getUTCDay()]}, ${d} ${MONTHS[m - 1]} ${y}`;
}
function fmtTime(hm) {
  if (!hm) return '';
  const parts = String(hm).split(':').map(Number);
  if (parts.length < 2 || parts.some(isNaN)) return hm;
  const [h, m] = parts;
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`;
}
function fmtSlot(s) {
  if (!s) return '—';
  return `${fmtDate(s.slot_date)} · ${fmtTime(s.start_time)} – ${fmtTime(s.end_time)}`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function titleCase(s) {
  if (!s) return '';
  return s.toLowerCase() === 'hr' ? 'HR' : s.charAt(0).toUpperCase() + s.slice(1);
}
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isPast(slot) {
  if (!slot || !slot.slot_date) return false;
  const now = new Date();
  const timeStr = slot.start_time || '00:00';
  const start = new Date(`${slot.slot_date}T${timeStr}:00`);
  return !isNaN(start.getTime()) && start <= now;
}

function generateMeetingLink(type = 'interview') {
  const cleanType = String(type).toLowerCase().replace(/[^a-z0-9]/g, '');
  const prefix = cleanType ? cleanType.charAt(0).toUpperCase() + cleanType.slice(1) : 'Interview';
  const id = crypto.randomBytes(4).toString('hex');
  const time = Date.now().toString(36);
  return `https://meet.jit.si/Konfident-${prefix}-${time}-${id}`;
}

function linkify(str) {
  if (!str) return '';
  const safe = escapeHtml(str);
  const urlRegex = /(https?:\/\/[^\s<&"']+)/g;
  return safe.replace(urlRegex, (url) => {
    let label = `${url} ↗`;
    if (url.includes('calendar.google.com') || url.includes('appointments/schedules')) {
      label = 'Google Calendar Appointment ↗';
    } else if (url.includes('meet.google.com')) {
      label = 'Google Meet ↗';
    } else if (url.includes('meet.jit.si') || url.includes('meet.konfident')) {
      label = 'Join Video Meeting ↗';
    } else if (url.includes('zoom.us')) {
      label = 'Zoom Meeting ↗';
    }
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="meet-link">${label}</a>`;
  });
}
module.exports = { fmtDate, fmtTime, fmtSlot, today, addDays, titleCase, isPast, linkify, escapeHtml, generateMeetingLink };
