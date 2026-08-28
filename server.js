'use strict';
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch (_) {}
}
const app = require('./src/app');
const db = require('./src/db');
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`\n  [Konfident Interview 2025] running at http://localhost:${PORT}`);
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'} | PID: ${process.pid}\n`);
});

// Graceful shutdown handling for container and process orchestrators
function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed. Closing SQLite database connection...');
    try {
      db.close();
      console.log('Database connection closed cleanly.');
    } catch (e) {
      console.error('Error closing database:', e);
    }
    process.exit(0);
  });

  // Force close after 10 seconds if hanging
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
