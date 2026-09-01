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
// ---------------------------------------------------------------------------
// Time handling.
// The whole product runs on a single institutional timezone (IST). Every
// "now" comparison — in SQL and in JS — goes through these helpers so the
// database and the application can never disagree about what "past" means,
// regardless of the timezone the server process happens to run in.
// ---------------------------------------------------------------------------
const TZ_OFFSET_MS = 5.5 * 60 * 60 * 1000; // Asia/Kolkata, no DST

/** Current instant in IST as 'YYYY-MM-DD HH:MM:SS'. */
function nowStamp() {
  return new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}
/** Current instant in IST as 'YYYY-MM-DD HH:MM' — matches `slot_date || ' ' || start_time`. */
function nowMinute() {
  return nowStamp().slice(0, 16);
}
/** Today's date in IST as 'YYYY-MM-DD'. */
function today() {
  return nowStamp().slice(0, 10);
}
/** Current time in IST as 'HH:MM'. */
function nowTime() {
  return nowStamp().slice(11, 16);
}
/** Normalizes any time string ('9:00', '09:00', '09:00:00') to standard 'HH:MM'. Returns '' if invalid. */
function normalizeTime(hm) {
  if (!hm) return '';
  const trimmed = String(hm).trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/);
  if (!match) return '';
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
/** Renders a stored timestamp for humans. Accepts a Date, an ISO string, or a
 *  plain 'YYYY-MM-DD HH:MM:SS' string, and always displays it in IST. */
function fmtStamp(stamp) {
  if (!stamp) return '—';
  // Date instances and ISO strings: shift into IST, then format.
  if (stamp instanceof Date || (typeof stamp === 'string' && /T\d{2}:\d{2}/.test(stamp))) {
    const d = new Date(stamp);
    if (isNaN(d.getTime())) return '—';
    const ist = new Date(d.getTime() + TZ_OFFSET_MS).toISOString();
    return `${fmtDate(ist.slice(0, 10))} · ${fmtTime(ist.slice(11, 16))}`;
  }
  const str = String(stamp).replace('T', ' ');
  const date = str.slice(0, 10);
  const time = str.slice(11, 16);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return str;
  return time ? `${fmtDate(date)} · ${fmtTime(time)}` : fmtDate(date);
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

/**
 * True when a slot's start time is already in the past (IST).
 * Compares plain 'YYYY-MM-DD HH:MM' strings so it matches the SQL filters
 * byte-for-byte and never depends on the host timezone.
 */
function isPast(slot) {
  if (!slot || !slot.slot_date) return false;
  const startsAt = `${slot.slot_date} ${slot.start_time || '00:00'}`.slice(0, 16);
  return startsAt <= nowMinute();
}

/**
 * True when a DB error is a unique-constraint / duplicate-key violation.
 * Works across drivers: node:sqlite says "UNIQUE constraint failed",
 * Postgres says "duplicate key value violates unique constraint" and carries
 * SQLSTATE 23505 (surfaced by pgWorker as a "[23505] " message prefix).
 */
function isUniqueViolation(err) {
  const msg = String((err && err.message) || err || '');
  return /unique constraint|duplicate key|\b23505\b|\b11000\b/i.test(msg) || (err && err.code === 11000);
}

function generateMeetingLink(type = 'interview') {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const randLetters = (len) => {
    const bytes = crypto.randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i++) {
      out += letters[bytes[i] % letters.length];
    }
    return out;
  };
  const meetCode = `${randLetters(3)}-${randLetters(4)}-${randLetters(3)}`;
  return `https://meet.google.com/${meetCode}`;
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

/** A path is only safe to redirect to if it is a single-slash-rooted local
 *  path with no scheme, no authority, no backslashes (browsers fold `\`→`/`,
 *  so `/\evil.com` is an open redirect) and no control characters. */
function isSafeLocalPath(p) {
  return typeof p === 'string'
    && /^\/[^/\\]/.test(p)
    && !/[\x00-\x1f\x7f]/.test(p)   // eslint-disable-line no-control-regex
    && !p.includes('\\');
}

function safeRedirectTarget(req, fallback = '/') {
  const ref = req.headers.referer || req.headers.referrer;
  if (!ref) return fallback;
  try {
    if (isSafeLocalPath(ref)) {
      return ref;
    }
    const parsed = new URL(ref);
    const host = req.get('host');
    if (parsed.host === host) {
      const local = parsed.pathname + parsed.search;
      if (isSafeLocalPath(local)) return local;
    }
  } catch (_) {}
  return fallback;
}

/** Returns start (Mon) and end (Sun) of the week for any date in IST. */
function getWeekRange(dateStr) {
  const dStr = dateStr || today();
  const dt = new Date(dStr + 'T00:00:00Z');
  const day = dt.getUTCDay(); // 0 = Sun, 1 = Mon ...
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const monday = new Date(dt);
  monday.setUTCDate(dt.getUTCDate() + diffToMon);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const start = monday.toISOString().slice(0, 10);
  const end = sunday.toISOString().slice(0, 10);
  const label = `${monday.getUTCDate()} ${MONTHS[monday.getUTCMonth()]} – ${sunday.getUTCDate()} ${MONTHS[sunday.getUTCMonth()]} ${sunday.getUTCFullYear()}`;
  return { start, end, label };
}

/** Returns the weekly cycle key ('YYYY-Www') based on Monday date. */
function getWeekKey(dateStr) {
  return getWeekRange(dateStr).start;
}

/** Checks if a student profile has all required details completed (name, phone, squad, branch, resume_url). */
function isStudentProfileComplete(user) {
  if (!user || user.role !== 'student') return true;
  const name = String(user.name || '').trim();
  const phone = String(user.phone || '').trim();
  const squad = String(user.squad || '').trim();
  const branch = String(user.branch || '').trim();
  const resume_url = String(user.resume_url || '').trim();

  return Boolean(
    name &&
    phone &&
    squad &&
    branch &&
    resume_url &&
    /^https?:\/\//i.test(resume_url)
  );
}

// Single source of truth for the password floor (was duplicated across 6 call
// sites with three different messages). Raising this is a one-line change here —
// note it also requires updating the fixtures in test/e2e.js and the
// `minlength` attributes in the password form templates.
const MIN_PASSWORD_LENGTH = 6;

/** Returns null when the password is acceptable, or an error string. */
function validatePassword(pw) {
  const s = String(pw == null ? '' : pw);
  if (s.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

/** Returns a list of missing profile field names for a student. */
function getMissingStudentProfileFields(user) {
  if (!user || user.role !== 'student') return [];
  const missing = [];
  if (!String(user.name || '').trim()) missing.push('Full name');
  if (!String(user.phone || '').trim()) missing.push('Phone number');
  if (!String(user.squad || '').trim()) missing.push('Squad');
  if (!String(user.branch || '').trim()) missing.push('Branch / Specialization');
  const resume = String(user.resume_url || '').trim();
  if (!resume || !/^https?:\/\//i.test(resume)) missing.push('Resume link');
  return missing;
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim();
  return trimmed.length <= 150 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

function isValidUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  return trimmed.length <= 500 && /^https?:\/\/[^\s<>"']+$/i.test(trimmed);
}

function isValidPhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const trimmed = phone.trim();
  return trimmed.length <= 25 && /^[+]?[\d\s\-().]{7,25}$/.test(trimmed);
}

function isValidDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return false;
  const trimmed = dateStr.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false;
  const [y, m, d] = trimmed.split('-').map(Number);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidTime(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return false;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(timeStr.trim());
}

async function checkWeeklyInterviewLimit(dbOrModels, studentId, type, slotDate) {
  const week = getWeekRange(slotDate || today());
  const maxAllowed = type === 'technical' ? 3 : 1;
  const { Interview } = require('./models');

  const ivs = await Interview.find({
    student_id: studentId,
    type,
    status: { $ne: 'cancelled' },
  }).populate('slot_id').lean();

  const count = ivs.filter(iv => iv.slot_id && iv.slot_id.slot_date >= week.start && iv.slot_id.slot_date <= week.end).length;

  return {
    reached: count >= maxAllowed,
    count,
    maxAllowed,
    week,
  };
}

module.exports = {
  fmtDate, fmtTime, fmtSlot, fmtStamp, today, nowTime, nowStamp, nowMinute, addDays,
  normalizeTime, titleCase, isPast, linkify, escapeHtml, generateMeetingLink, isUniqueViolation,
  safeRedirectTarget, isSafeLocalPath, MIN_PASSWORD_LENGTH, validatePassword,
  getWeekRange, getWeekKey, isStudentProfileComplete, getMissingStudentProfileFields,
  isValidEmail, isValidUrl, isValidPhone, isValidDate, isValidTime,
  checkWeeklyInterviewLimit,
};
