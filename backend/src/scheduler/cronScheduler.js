/**
 * Cron Scheduler Service
 * -----------------------
 * A lightweight standalone process (run alongside the API and workers)
 * that polls the `scheduled_jobs` table for templates whose `next_run_at`
 * has passed, spawns a concrete row in `jobs` for each one, and advances
 * `next_run_at` using the cron expression. Kept as its own process so a
 * slow scheduler tick never competes with worker polling for DB
 * connections, and so it can be scaled to exactly one replica (a leader
 * election / advisory lock would be the next step for HA -- see
 * docs/design-decisions.md).
 */
require('dotenv').config();
const cronParser = require('cron-parser');
const { query, withTransaction } = require('../config/db');

const TICK_INTERVAL_MS = Number(process.env.SCHEDULER_TICK_MS || 5000);

async function tick() {
  const { rows: due } = await query(
    `SELECT * FROM scheduled_jobs WHERE is_active = true AND next_run_at <= now() FOR UPDATE SKIP LOCKED`
  );

  for (const template of due) {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO jobs (queue_id, job_type, name, payload, retry_policy_id, status, run_at)
         VALUES ($1, 'recurring', $2, $3, $4, 'queued', now())`,
        [template.queue_id, template.name, template.payload_template, template.retry_policy_id]
      );

      const next = cronParser.parseExpression(template.cron_expression, {
        currentDate: new Date(),
        tz: template.timezone || 'UTC',
      }).next().toDate();

      await client.query(
        `UPDATE scheduled_jobs SET last_run_at = now(), next_run_at = $2 WHERE id = $1`,
        [template.id, next]
      );
    });
    console.log(`[scheduler] fired "${template.name}" -> new job queued`);
  }
}

console.log(`[scheduler] starting, tick interval ${TICK_INTERVAL_MS}ms`);
setInterval(() => {
  tick().catch((err) => console.error('[scheduler] tick error:', err));
}, TICK_INTERVAL_MS);
tick().catch((err) => console.error('[scheduler] initial tick error:', err));
