'use strict';
const { AuditLog } = require('../models');

/**
 * Persists security and administrative events to the audit_logs collection in MongoDB.
 */
function logAudit(req, action, details = null, userIdOverride = null) {
  try {
    const userId = userIdOverride !== null ? userIdOverride : (req && req.session && req.session.user ? (req.session.user.id || req.session.user._id) : null);
    const ip = req ? (req.ip || (req.connection && req.connection.remoteAddress) || '127.0.0.1') : '127.0.0.1';
    const detailStr = typeof details === 'object' && details !== null ? JSON.stringify(details) : (details ? String(details) : null);

    AuditLog.create({
      user_id: userId || null,
      action,
      details: detailStr,
      ip,
    }).catch((err) => {
      console.warn('AuditLog async save warning:', err.message);
    });
  } catch (err) {
    console.error('Audit logging failed:', err);
  }
}

module.exports = { logAudit };
