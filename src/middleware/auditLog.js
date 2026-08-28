'use strict';
const db = require('../db');

/**
 * Persists security and administrative events to the audit_logs table.
 *
 * @param {import('express').Request} req - Express request object.
 * @param {string} action - Event type identifier (e.g., 'AUTH_LOGIN', 'SLOT_RESCHEDULE').
 * @param {object|string|null} [details] - Metadata or payload details.
 * @param {number|null} [userIdOverride] - Explicit user ID when session is not yet populated.
 */
function logAudit(req, action, details = null, userIdOverride = null) {
  try {
    const userId = userIdOverride !== null ? userIdOverride : (req.session && req.session.user ? req.session.user.id : null);
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || '127.0.0.1';
    const detailStr = typeof details === 'object' && details !== null ? JSON.stringify(details) : (details ? String(details) : null);

    db.prepare(`
      INSERT INTO audit_logs (user_id, action, details, ip)
      VALUES (?, ?, ?, ?)
    `).run(userId, action, detailStr, ip);
  } catch (err) {
    console.error('Audit logging failed:', err);
  }
}

module.exports = { logAudit };
