'use strict';
const { workerData } = require('worker_threads');
const { Pool } = require('pg');

const { sab, databaseUrl } = workerData;
const control = new Int32Array(sab, 0, 4); // [state, reqLen, resLen, errFlag]
const dataBuf = Buffer.from(sab, 16);

// State transitions:
// 0: Idle / Waiting for request
// 1: Request written by main thread -> Worker picks up
// 2: Response written by worker -> Main thread picks up
// 100: Worker initialized and ready
// -1: Worker shutting down

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

async function start() {
  try {
    await pool.query('SELECT 1');
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

      const res = await pool.query(sql, params);
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
      const errJson = Buffer.from(String(err && err.message ? err.message : err), 'utf8');
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
