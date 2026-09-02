/**
 * Konfident Interview 2025 — PM2 Cluster & Process Manager Configuration
 *
 * Provides enterprise-grade clustering, auto-restart on memory limits,
 * zero-downtime reloads, and centralized log rotation.
 */
module.exports = {
  apps: [
    {
      name: 'konfident-interview',
      script: './server.js',
      instances: 'max', // Scale to all available CPU cores
      exec_mode: 'cluster', // Cluster mode with internal load balancing
      max_memory_restart: '512M', // Auto-restart worker if memory exceeds 512MB
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        ENABLE_CLUSTER: 'false', // Let PM2 handle worker clustering
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        ENABLE_CLUSTER: 'false',
      },
      watch: false,
      autorestart: true,
      restart_delay: 2000,
      exp_backoff_restart_delay: 100,
      listen_timeout: 10000,
      kill_timeout: 5000,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
