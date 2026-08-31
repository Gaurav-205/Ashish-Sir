'use strict';
const { workerData } = require('worker_threads');
const { Pool } = require('pg');

const { sab, databaseUrl } = workerData;
const control = new Int32Array(sab, 0, 4); // [state, reqLen, resLen, errFlag]
const dataBuf = Buffer.from(sab, 16);

const cleanDbUrl = databaseUrl ? databaseUrl.replace(/([?&])sslmode=(require|prefer|verify-ca)/gi, '$1sslmode=verify-full') : databaseUrl;

const pool = new Pool({
  connectionString: cleanDbUrl,
  ssl: { rejectUnauthorized: false },
  max: 4,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// An error on an idle pooled connection is emitted on the pool itself; without
// a listener node crashes the worker process. We reconnect lazily instead.
pool.on('error', (err) => {
  console.warn('PG Worker pool error (will reconnect):', err && err.message);
});

/*
 * IMPORTANT — every query in this worker runs on ONE pinned connection.
 *
 * The bridge is fully serialised: the main thread blocks on Atomics.wait until
 * each query returns, so exactly one statement is ever in flight. Pinning a
 * single client is therefore safe AND it is the only way `BEGIN … COMMIT`
 * blocks issued as separate calls from src/routes/* can behave as real
 * transactions. Using `pool.query()` (a fresh connection per statement) left
 * `BEGIN` stranded on one pooled connection "idle in transaction"; its writes
 * were then rolled back when that connection was reaped — bookings and slot
 * edits silently reverted themselves minutes later.
 */
let client = null;

async function ensureClient() {
  if (client) return client;
  const c = await pool.connect();
  // A connection-level failure (server restart, network drop) makes the client
  // unusable. Drop it so the next query transparently reconnects.
  c.on('error', () => {
    if (client === c) client = null;
    try { c.release(true); } catch (_) {}
  });
  client = c;
  return client;
}

function isConnectionError(err) {
  if (!err) return false;
  const code = String(err.code || '');
  return (
    code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT' ||
    code === '57P01' || code === '57P02' || code === '57P03' ||
    code.startsWith('08') ||
    /Connection terminated|server closed the connection|Client has encountered a connection error/i.test(String(err.message || ''))
  );
}

async function runQuery(sql, params) {
  await ensureClient();

  // Self-heal a leaked transaction: if a previous request left this connection
  // mid-transaction (or in a failed-transaction state), clear it before opening
  // a new one. Harmless when there is nothing to roll back.
  const head = String(sql).trimStart().slice(0, 6).toUpperCase();
  if (head === 'BEGIN') {
    try { await client.query('ROLLBACK'); } catch (_) {}
  }

  // A bare string uses the simple query protocol, which allows multi-statement
  // batches (the seeder). Passing an (even empty) params array forces the
  // extended protocol, which rejects them — so only pass params when present.
  return (Array.isArray(params) && params.length)
    ? client.query(sql, params)
    : client.query(sql);
}

async function start() {
  try {
    await ensureClient();
    await client.query('SELECT 1');
  } catch (e) {
    console.error('PG Worker connection error:', e.message);
  }

  Atomics.store(control, 0, 100);
  Atomics.notify(control, 0, 1);

  while (true) {
    while (Atomics.load(control, 0) !== 1) {
      Atomics.wait(control, 0, 0);
    }

    const reqLen = Atomics.load(control, 1);
    try {
      const reqStr = dataBuf.toString('utf8', 0, reqLen);
      const { sql, params } = JSON.parse(reqStr);

      let res;
      try {
        res = await runQuery(sql, params);
      } catch (err) {
        if (isConnectionError(err)) {
          // Drop the dead connection and retry once on a fresh one.
          try { if (client) client.release(true); } catch (_) {}
          client = null;
          res = await runQuery(sql, params);
        } else {
          throw err;
        }
      }

      const rows = Array.isArray(res)
        ? (res.length ? (res[res.length - 1].rows || []) : [])
        : (res.rows || []);
      const resJson = Buffer.from(JSON.stringify(rows), 'utf8');

      if (resJson.length > dataBuf.length) {
        throw new Error(`Query result too large (${resJson.length} bytes exceeds buffer ${dataBuf.length})`);
      }

      dataBuf.set(resJson);
      Atomics.store(control, 2, resJson.length);
      Atomics.store(control, 3, 0); // success
    } catch (err) {
      // Surface the Postgres error code alongside the message so callers can
      // reliably classify failures (e.g. 23505 = unique_violation) regardless
      // of wording differences between drivers.
      const code = err && err.code ? `[${err.code}] ` : '';
      const errJson = Buffer.from(code + String(err && err.message ? err.message : err), 'utf8');
      dataBuf.set(errJson);
      Atomics.store(control, 2, errJson.length);
      Atomics.store(control, 3, 1); // error
    }

    Atomics.store(control, 0, 2); // response ready
    Atomics.notify(control, 0, 1);
  }
}

start().catch((err) => {
  console.error('PG Worker fatal error:', err);
});
