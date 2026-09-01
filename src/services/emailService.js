'use strict';
const { AuditLog } = require('../models');
const h = require('../helpers');

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (_) {}

function isSmtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!nodemailer || !isSmtpConfigured()) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function logEmailAudit(toEmail, subject, details = {}) {
  // Fire-and-forget: a notification-log failure must never break a booking flow.
  AuditLog.create({
    action: 'EMAIL_NOTIFICATION_SENT',
    details: JSON.stringify({ to: toEmail, subject, ...details }),
  }).catch(() => {});
}

/**
 * Sends booking confirmation emails to both student and mentor.
 */
async function sendBookingConfirmation({ student, mentor, slot, meetingLink }) {
  if (!student || !mentor || !slot) return { ok: false, error: 'Missing required booking details.' };

  const link = meetingLink || slot.location || 'Online';
  const domain = h.titleCase(slot.type);
  const formattedDate = h.fmtDate(slot.slot_date);
  const formattedTime = `${h.fmtTime(slot.start_time)} – ${h.fmtTime(slot.end_time)} (IST)`;

  const studentSubject = `Confirmed: ${domain} Mock Interview with ${mentor.name}`;
  const studentBody = [
    `Hello ${student.name},`,
    '',
    `Your ${domain} mock interview has been successfully scheduled!`,
    '',
    `--- Session Details ---`,
    `Domain: ${domain}`,
    `Date: ${formattedDate}`,
    `Time: ${formattedTime}`,
    `Mentor: ${mentor.name} (${mentor.email})`,
    `Meeting Link: ${link}`,
    '',
    `Please join the Google Meet link 5 minutes prior to your scheduled start time.`,
    '',
    `Best regards,`,
    `Konfident Interview Team`,
  ].join('\n');

  const mentorSubject = `New Booking: ${domain} Mock Interview with ${student.name}`;
  const mentorBody = [
    `Hello ${mentor.name},`,
    '',
    `A student has booked a slot on your calendar!`,
    '',
    `--- Candidate & Session Details ---`,
    `Student: ${student.name} (${student.email})`,
    `Domain: ${domain}`,
    `Date: ${formattedDate}`,
    `Time: ${formattedTime}`,
    `Meeting Link: ${link}`,
    '',
    `Best regards,`,
    `Konfident Interview Team`,
  ].join('\n');

  const transporter = getTransporter();
  const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_USER || 'no-reply@konfident.kalvium.community';

  const recipients = [
    { to: student.email, name: student.name, subject: studentSubject, text: studentBody },
    { to: mentor.email, name: mentor.name, subject: mentorSubject, text: mentorBody },
  ];

  for (const r of recipients) {
    if (transporter) {
      try {
        await transporter.sendMail({
          from: fromAddress,
          to: r.to,
          subject: r.subject,
          text: r.text,
        });
      } catch (err) {
        console.error(`[emailService] Failed to send email to ${r.to}:`, err.message);
      }
    } else {
      console.log(`[emailService] Dispatched notification to ${r.to}: "${r.subject}" | Link: ${link}`);
    }
    logEmailAudit(r.to, r.subject, { slot_id: slot.id, type: slot.type, link });
  }

  return { ok: true };
}

/**
 * Sends a cancellation notification email to the student and mentor.
 * Accepts an optional `interview` / `cancelledBy` for context; both are logged.
 */
async function sendCancellationNotice({ student, mentor, slot, cancelledBy }) {
  if (!student || !mentor || !slot) return { ok: false };

  const domain = h.titleCase(slot.type);
  const formattedDate = h.fmtDate(slot.slot_date);
  const formattedTime = `${h.fmtTime(slot.start_time)} – ${h.fmtTime(slot.end_time)} (IST)`;

  const subject = `Cancelled: ${domain} Mock Interview (${formattedDate})`;
  const body = [
    `This is a notification that the ${domain} mock interview scheduled for ${formattedDate} at ${formattedTime} has been cancelled${cancelledBy ? ` by the ${cancelledBy}` : ''}.`,
    '',
    `Student: ${student.name} (${student.email})`,
    `Mentor: ${mentor.name} (${mentor.email})`,
    '',
    `Konfident Interview Team`,
  ].join('\n');

  const transporter = getTransporter();
  const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_USER || 'no-reply@konfident.kalvium.community';

  for (const person of [student, mentor]) {
    if (transporter) {
      try {
        await transporter.sendMail({ from: fromAddress, to: person.email, subject, text: body });
      } catch (err) {
        console.error(`[emailService] Failed to send cancellation email to ${person.email}:`, err.message);
      }
    } else {
      console.log(`[emailService] Dispatched cancellation email to ${person.email}: "${subject}"`);
    }
    logEmailAudit(person.email, subject, { slot_id: slot.id });
  }

  return { ok: true };
}

module.exports = {
  isSmtpConfigured,
  sendBookingConfirmation,
  sendCancellationNotice,
  // Backwards-compatible alias.
  sendBookingCancellation: sendCancellationNotice,
};
