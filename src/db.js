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

function applyDnsFallback() {
  try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
  } catch (_) {}
}

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/konfident';

let isConnected = false;

async function connectDb() {
  if (isConnected && mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }
  
  try {
    const conn = await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      autoIndex: true,
    });
    isConnected = true;
    console.log(`[db] MongoDB connected successfully to ${conn.connection.host || 'cluster'}`);
    return conn.connection;
  } catch (err) {
    const isDnsErr = err.code === 'ESERVFAIL' || err.code === 'EAI_AGAIN' || err.code === 'ETIMEOUT' || err.code === 'ENOTFOUND' ||
                     err.syscall === 'querySrv' || (err.message && (err.message.includes('querySrv') || err.message.includes('getaddrinfo') || err.message.includes('Could not connect to any servers')));
    if (isDnsErr) {
      try {
        applyDnsFallback();
        const conn = await mongoose.connect(MONGODB_URI, {
          serverSelectionTimeoutMS: 15000,
          autoIndex: true,
        });
        isConnected = true;
        console.log(`[db] MongoDB connected successfully via DNS fallback to ${conn.connection.host || 'cluster'}`);
        return conn.connection;
      } catch (dnsErr) {
        console.error('[db] MongoDB connection error after DNS fallback:', dnsErr.message);
        throw dnsErr;
      }
    }
    console.error('[db] MongoDB connection error:', err.message);
    throw err;
  }
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
