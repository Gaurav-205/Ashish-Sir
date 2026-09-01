'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const models = require('./models');
const dns = require('dns');

try {
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (_) {}

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/konfident';
const LOCAL_MONGODB_URI = 'mongodb://127.0.0.1:27017/konfident';

let connectionPromise = null;

async function connectDb() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }
  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    try {
      const conn = await mongoose.connect(MONGODB_URI, {
        serverSelectionTimeoutMS: 4000,
        autoIndex: true,
      });
      console.log(`[db] MongoDB connected successfully to ${conn.connection.host || 'cluster'}`);
      return conn.connection;
    } catch (err) {
      if (MONGODB_URI !== LOCAL_MONGODB_URI) {
        try {
          console.warn(`[db] Remote MongoDB connection failed (${err.message}). Falling back to local MongoDB at ${LOCAL_MONGODB_URI}...`);
          await mongoose.disconnect().catch(() => {});
          const conn = await mongoose.connect(LOCAL_MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
            autoIndex: true,
          });
          console.log(`[db] MongoDB connected successfully to local fallback database: ${conn.connection.host || 'localhost'}`);
          return conn.connection;
        } catch (localErr) {
          console.error('[db] Both remote and local MongoDB connection fallbacks failed:', localErr.message);
          connectionPromise = null;
          throw err;
        }
      }
      connectionPromise = null;
      console.error('[db] MongoDB connection error:', err.message);
      throw err;
    }
  })();

  return connectionPromise;
}

// Auto-connect on import
connectDb().catch((err) => {
  console.warn('[db] initial connection warning (will retry on query):', err.message);
});

module.exports = {
  mongoose,
  connectDb,
  ...models,
  isPostgres: false,
  driver: 'mongodb',
};
