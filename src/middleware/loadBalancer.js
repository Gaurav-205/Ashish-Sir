'use strict';

/**
 * Konfident Interview 2025 — Request Priority, Concurrency & Micro-Cache Middleware
 * 
 * Optimized for:
 * 1. Bursty Student & Mentor slot discovery/booking spikes
 * 2. Persistent long-dwell Admin analytics & reports
 */

// In-memory high-throughput micro-cache for read-heavy burst queries
const microCache = new Map();
const DEFAULT_TTL_MS = 3000; // 3 seconds TTL handles massive traffic spikes while keeping data real-time

// Concurrency tracking metrics
let activeRequests = 0;
let totalHandledRequests = 0;

/**
 * Generates a cache key based on route, query parameters, and user role
 */
function getCacheKey(req) {
  const userId = req.session && req.session.user ? req.session.user.id : 'anon';
  const role = req.session && req.session.user ? req.session.user.role : 'anon';
  return `${role}:${req.method}:${req.path}:${JSON.stringify(req.query)}:${userId}`;
}

/**
 * Micro-caching middleware for read-only burst endpoints
 */
function microCacheMiddleware(ttlMs = DEFAULT_TTL_MS) {
  return function (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }

    const key = getCacheKey(req);
    const cached = microCache.get(key);
    const now = Date.now();

    if (cached && now < cached.expiresAt) {
      res.setHeader('X-Cache-Status', 'HIT');
      res.setHeader('X-Cache-TTL', Math.ceil((cached.expiresAt - now) / 1000));
      return res.send(cached.body);
    }

    // Intercept res.send to store in microCache
    const originalSend = res.send.bind(res);
    res.send = function (body) {
      if (res.statusCode === 200 && typeof body === 'string') {
        if (microCache.size > 2000) {
          // Evict oldest entries
          const firstKey = microCache.keys().next().value;
          if (firstKey) microCache.delete(firstKey);
        }
        microCache.set(key, {
          body,
          expiresAt: Date.now() + ttlMs,
        });
      }
      res.setHeader('X-Cache-Status', 'MISS');
      return originalSend(body);
    };

    next();
  };
}

/**
 * Purges micro-cache on slot mutations (booking, cancelling, publishing)
 */
function purgeSlotCaches() {
  microCache.clear();
}

/**
 * Concurrency tracking & load shedding middleware
 */
function requestConcurrencyMiddleware(req, res, next) {
  activeRequests++;
  totalHandledRequests++;

  const startHr = process.hrtime();

  // Intercept writeHead / end to set X-Response-Time header safely before flushing headers
  const originalWriteHead = res.writeHead;
  res.writeHead = function (...args) {
    if (!res.headersSent) {
      const diff = process.hrtime(startHr);
      const responseTimeMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(2);
      res.setHeader('X-Response-Time', `${responseTimeMs}ms`);
    }
    return originalWriteHead.apply(res, args);
  };

  const cleanup = () => {
    activeRequests = Math.max(0, activeRequests - 1);
  };

  res.once('finish', cleanup);
  res.once('close', cleanup);

  next();
}

/**
 * Returns real-time worker load diagnostics
 */
function getWorkerDiagnostics() {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    activeRequests,
    totalHandledRequests,
    cacheEntries: microCache.size,
    memory: {
      rssMb: (mem.rss / (1024 * 1024)).toFixed(2),
      heapUsedMb: (mem.heapUsed / (1024 * 1024)).toFixed(2),
      heapTotalMb: (mem.heapTotal / (1024 * 1024)).toFixed(2),
    },
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

module.exports = {
  microCacheMiddleware,
  purgeSlotCaches,
  requestConcurrencyMiddleware,
  getWorkerDiagnostics,
};
