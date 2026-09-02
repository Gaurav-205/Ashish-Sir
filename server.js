'use strict';
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch (_) {}
}
const path = require('path');
const cluster = require('cluster');
const os = require('os');
const app = require('./src/app');
const db = require('./src/db');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ENABLE_CLUSTER = process.env.ENABLE_CLUSTER === 'true' || process.env.NODE_ENV === 'production';
const WORKER_MEMORY_LIMIT_MB = parseInt(process.env.WORKER_MEMORY_LIMIT_MB || '512', 10);

let server;

// Set Round-Robin scheduling across worker processes on supported operating systems
if (cluster.isPrimary) {
  if (typeof cluster.SCHED_RR !== 'undefined') {
    cluster.schedulingPolicy = cluster.SCHED_RR;
  }
  cluster.setupPrimary({
    exec: path.resolve(__dirname, 'server.js'),
  });
}

if (!process.env.VERCEL) {
  if (ENABLE_CLUSTER && cluster.isPrimary) {
    const numCPUs = parseInt(process.env.WEB_CONCURRENCY || '', 10) || os.cpus().length || 2;
    console.log(`\n  ======================================================`);
    console.log(`  [Konfident Cluster Master] PID: ${process.pid}`);
    console.log(`  Scheduling Policy: Round-Robin (SCHED_RR)`);
    console.log(`  Forking ${numCPUs} Worker Processes across CPU Cores`);
    console.log(`  ======================================================\n`);

    const workerRestartTimes = new Map();

    for (let i = 0; i < numCPUs; i++) {
      spawnWorker();
    }

    function spawnWorker() {
      const worker = cluster.fork();
      worker.on('message', (msg) => {
        if (msg && msg.type === 'HEARTBEAT') {
          // Monitor memory threshold
          if (msg.memory && msg.memory.rssMb > WORKER_MEMORY_LIMIT_MB) {
            console.warn(`[Master] Worker ${worker.process.pid} exceeded memory limit (${msg.memory.rssMb}MB > ${WORKER_MEMORY_LIMIT_MB}MB). Gracefully recycling...`);
            recycleWorker(worker);
          }
        }
      });
      return worker;
    }

    function recycleWorker(oldWorker) {
      const newWorker = spawnWorker();
      newWorker.on('listening', () => {
        oldWorker.disconnect();
        setTimeout(() => {
          try { oldWorker.kill('SIGTERM'); } catch (_) {}
        }, 5000);
      });
    }

    cluster.on('exit', (worker, code, signal) => {
      console.log(`  [Master] Worker ${worker.process.pid} exited (code: ${code}, signal: ${signal}).`);
      
      const now = Date.now();
      const lastRestarts = (workerRestartTimes.get(worker.id) || []).filter(t => now - t < 30000);
      lastRestarts.push(now);
      workerRestartTimes.set(worker.id, lastRestarts);

      // Backoff if worker is crash-looping (> 5 restarts in 30s)
      if (lastRestarts.length > 5) {
        console.error(`  [Master] Worker crash-loop detected. Waiting 3s before respawning...`);
        setTimeout(() => spawnWorker(), 3000);
      } else {
        spawnWorker();
      }
    });

    // Zero-downtime rolling restart on SIGUSR2
    process.on('SIGUSR2', () => {
      console.log('  [Master] Received SIGUSR2. Performing zero-downtime rolling restart...');
      const currentWorkers = Object.values(cluster.workers || {});
      function restartNext(index) {
        if (index >= currentWorkers.length) return;
        const w = currentWorkers[index];
        if (!w) return restartNext(index + 1);
        recycleWorker(w);
        setTimeout(() => restartNext(index + 1), 2000);
      }
      restartNext(0);
    });

    // Master Graceful Shutdown
    function masterShutdown(signal) {
      console.log(`\n  [Master] Received ${signal}. Shutting down worker cluster...`);
      for (const id in cluster.workers) {
        try { cluster.workers[id].kill('SIGTERM'); } catch (_) {}
      }
      setTimeout(() => process.exit(0), 4000);
    }

    process.on('SIGTERM', () => masterShutdown('SIGTERM'));
    process.on('SIGINT', () => masterShutdown('SIGINT'));

  } else {
    // Worker / Single Process HTTP Server
    server = app.listen(PORT, () => {
      const roleLabel = cluster.isWorker ? `Worker #${cluster.worker.id}` : 'Single Instance';
      console.log(`  [Konfident Server] ${roleLabel} (PID: ${process.pid}) active at http://localhost:${PORT}`);
    });

    // Periodic Heartbeat to Master (every 10s)
    if (cluster.isWorker) {
      const heartbeatInterval = setInterval(() => {
        try {
          const mem = process.memoryUsage();
          if (process.send) {
            process.send({
              type: 'HEARTBEAT',
              pid: process.pid,
              workerId: cluster.worker.id,
              memory: {
                rssMb: Math.round(mem.rss / (1024 * 1024)),
                heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
              },
            });
          }
        } catch (_) {}
      }, 10000);
      heartbeatInterval.unref();
    }

    function gracefulShutdown(signal) {
      console.log(`\nReceived ${signal}. Shutting down worker gracefully (PID: ${process.pid})...`);
      if (server) {
        server.close(() => {
          try { if (typeof db.close === 'function') db.close(); } catch (_) {}
          process.exit(0);
        });
        setTimeout(() => process.exit(0), 5000).unref();
      } else {
        process.exit(0);
      }
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  }
}

module.exports = app;
