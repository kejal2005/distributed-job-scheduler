const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: process.env.PGPORT || 5432,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'job_scheduler',
  max: 20,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // Idle client errors (e.g. connection dropped) should not crash the process
  console.error('Unexpected error on idle Postgres client', err);
});

/**
 * Run a query with automatic connection handling.
 */
function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run a callback inside a single transaction. The callback receives a
 * client that MUST be used for all queries in the transaction (not the
 * pool directly), so they share the same underlying connection.
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
