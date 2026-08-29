'use strict';
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch (_) {}
}
const app = require('./src/app');
const db = require('./src/db');
const PORT = process.env.PORT || 3000;

let server;
if (!process.env.VERCEL) {
  server = app.listen(PORT, () => {
    console.log(`\n  [Konfident Interview 2025] running at http://localhost:${PORT}`);
    console.log(`  Environment: ${process.env.NODE_ENV || 'development'} | PID: ${process.pid}\n`);
  });

  function gracefulShutdown(signal) {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    if (server) {
      server.close(() => {
        console.log('HTTP server closed. Closing database connection...');
        try { if (typeof db.close === 'function') db.close(); } catch (_) {}
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = app;
