'use strict';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtDate(ymd) {
  if (!ymd) return '—';
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!y) return ymd;
  const dt = new Date(Date.UTC(y, m - 1, d));
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return `${days[dt.getUTCDay()]}, ${d} ${MONTHS[m - 1]} ${y}`;
}
function fmtTime(hm) {
  if (!hm) return '';
  const [h, m] = String(hm).split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`;
}
function fmtSlot(s) {
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
  return s === 'hr' ? 'HR' : s.charAt(0).toUpperCase() + s.slice(1);
}
function isPast(slot) {
  const now = new Date();
  const end = new Date(`${slot.slot_date}T${slot.end_time}:00`);
  return end < now;
}
module.exports = { fmtDate, fmtTime, fmtSlot, today, addDays, titleCase, isPast };
