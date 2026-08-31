'use strict';
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch (_) {}
}
const app = require('./src/app');
const db = require('./src/db');
const cluster = require('cluster');
const os = require('os');
const PORT = process.env.PORT || 3000;

let server;
if (!process.env.VERCEL) {
  if (process.env.NODE_ENV === 'production' && cluster.isPrimary) {
    const numCPUs = os.cpus().length;
    console.log(`\n  [Konfident Interview 2025] Master ${process.pid} is running`);
    console.log(`  Forking for ${numCPUs} CPUs...\n`);

    for (let i = 0; i < numCPUs; i++) {
      cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
      console.log(`  Worker ${worker.process.pid} died. Restarting...`);
      cluster.fork();
    });
  } else {
    server = app.listen(PORT, () => {
      if (!cluster.isWorker || cluster.worker.id === 1) {
        console.log(`\n  [Konfident Interview 2025] running at http://localhost:${PORT}`);
        console.log(`  Environment: ${process.env.NODE_ENV || 'development'} | PID: ${process.pid}\n`);
      }
    });

    function gracefulShutdown(signal) {
      console.log(`\nReceived ${signal}. Shutting down gracefully (PID: ${process.pid})...`);
      if (server) {
        server.close(() => {
          if (!cluster.isWorker || cluster.worker.id === 1) {
            console.log('HTTP server closed. Closing database connection...');
          }
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
}

module.exports = app;
