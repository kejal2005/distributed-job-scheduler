const { query, withTransaction } = require('../config/db');

/**
 * Atomically claim up to `limit` eligible jobs from a queue for a given
 * worker. Uses SELECT ... FOR UPDATE SKIP LOCKED so that N workers can
 * poll the same queue concurrently without ever claiming the same row
 * twice and without blocking on each other's row locks.
 *
 * The queue row itself is locked for the duration of the transaction
 * (SELECT ... FOR UPDATE, no SKIP LOCKED) so that pause-state and
 * concurrency_limit checks are read-and-acted-on atomically -- without
 * this, two concurrent claims could each read "2 of 5 slots used" and
 * both proceed, together exceeding the limit. This serializes claims
 * *per queue* (a queue is a low-contention granularity: one exclusive
 * lock held only for the few milliseconds of the claim query), while
 * claims against different queues remain fully concurrent.
 *
 * Eligible = status in ('queued','scheduled') AND run_at <= now()
 *            AND all dependencies (if any) are completed.
 */
async function claimJobs({ queueId, workerId, limit = 1 }) {
  return withTransaction(async (client) => {
    const { rows: queueRows } = await client.query(
      `SELECT * FROM queues WHERE id = $1 FOR UPDATE`,
      [queueId]
    );
    const queue = queueRows[0];
    if (!queue) return [];
    if (queue.is_paused) return [];

    const { rows: runningRows } = await client.query(
      `SELECT count(*)::int AS count FROM jobs WHERE queue_id = $1 AND status IN ('claimed','running')`,
      [queueId]
    );
    const available = Math.max(0, queue.concurrency_limit - runningRows[0].count);
    const effectiveLimit = Math.min(limit, available);
    if (effectiveLimit <= 0) return [];

    const { rows: candidates } = await client.query(
      `SELECT j.id
         FROM jobs j
        WHERE j.queue_id = $1
          AND j.status IN ('queued', 'scheduled')
          AND j.run_at <= now()
          AND NOT EXISTS (
                SELECT 1 FROM job_dependencies d
                JOIN jobs dep ON dep.id = d.depends_on_job_id
               WHERE d.job_id = j.id AND dep.status <> 'completed'
              )
        ORDER BY j.priority DESC, j.run_at ASC, j.created_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [queueId, effectiveLimit]
    );

    if (candidates.length === 0) return [];

    const ids = candidates.map((r) => r.id);
    const { rows: claimed } = await client.query(
      `UPDATE jobs
          SET status = 'claimed',
              claimed_by_worker_id = $1,
              claimed_at = now(),
              attempt_count = attempt_count + 1
        WHERE id = ANY($2::uuid[])
        RETURNING *`,
      [workerId, ids]
    );
    return claimed;
  });
}

async function markRunning(jobId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE jobs SET status = 'running', started_at = now()
        WHERE id = $1 AND status = 'claimed' RETURNING *`,
      [jobId]
    );
    const job = rows[0];
    if (job) {
      await client.query(
        `INSERT INTO job_executions (job_id, worker_id, attempt_number, started_at)
         VALUES ($1,$2,$3, now())
         ON CONFLICT (job_id, attempt_number) DO NOTHING`,
        [job.id, job.claimed_by_worker_id, job.attempt_count]
      );
    }
    return job; // undefined if the job wasn't in 'claimed' state (e.g. already resolved)
  });
}

async function markCompleted(jobId) {
  const { rows } = await query(
    `UPDATE jobs SET status = 'completed', completed_at = now() WHERE id = $1 RETURNING *`,
    [jobId]
  );
  return rows[0];
}

/**
 * Mark a failed attempt. Decides, based on the job's retry policy and
 * attempt_count, whether to reschedule (with backoff) or move to the DLQ.
 * Returns { outcome: 'retry'|'dead_letter', job }.
 */
async function markFailedAndResolve(jobId, errorMessage) {
  return withTransaction(async (client) => {
    const { rows: jobRows } = await client.query(
      `SELECT * FROM jobs WHERE id = $1 FOR UPDATE`,
      [jobId]
    );
    const jobRow = jobRows[0];
    if (!jobRow) throw new Error(`Job ${jobId} not found`);

    const job = jobRow;
    if (!['claimed', 'running'].includes(job.status)) {
      // Already resolved (completed/dead_letter/cancelled) by a prior call -- no-op.
      // This guards against duplicate fail signals racing a timeout handler, etc.
      return { outcome: 'noop', job };
    }
    let policy = {};
    if (jobRow.retry_policy_id) {
      const { rows: policyRows } = await client.query(
        `SELECT strategy, max_attempts, base_delay_seconds, max_delay_seconds, multiplier
           FROM retry_policies WHERE id = $1`,
        [jobRow.retry_policy_id]
      );
      policy = policyRows[0] || {};
    }
    Object.assign(job, policy);

    const maxAttempts = job.max_attempts_override ?? job.max_attempts ?? 3;
    const strategy = job.strategy || 'fixed';
    const baseDelay = job.base_delay_seconds ?? 10;
    const maxDelay = job.max_delay_seconds ?? 3600;
    const multiplier = Number(job.multiplier ?? 2);

    if (job.attempt_count >= maxAttempts) {
      // Permanent failure -> Dead Letter Queue
      await client.query(
        `UPDATE jobs SET status = 'dead_letter', last_error = $2 WHERE id = $1`,
        [jobId, errorMessage]
      );
      await client.query(
        `INSERT INTO dead_letter_queue (job_id, queue_id, payload_snapshot, failure_reason, attempt_count)
         VALUES ($1, $2, $3, $4, $5)`,
        [jobId, job.queue_id, job.payload, errorMessage, job.attempt_count]
      );
      const { rows } = await client.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
      return { outcome: 'dead_letter', job: rows[0] };
    }

    const delaySeconds = computeBackoff(strategy, baseDelay, maxDelay, multiplier, job.attempt_count);
    const { rows } = await client.query(
      `UPDATE jobs
          SET status = 'queued',
              run_at = now() + ($2 || ' seconds')::interval,
              last_error = $3,
              claimed_by_worker_id = NULL,
              claimed_at = NULL
        WHERE id = $1
        RETURNING *`,
      [jobId, delaySeconds, errorMessage]
    );
    return { outcome: 'retry', job: rows[0], delaySeconds };
  });
}

function computeBackoff(strategy, baseDelay, maxDelay, multiplier, attemptCount) {
  let delay;
  switch (strategy) {
    case 'fixed':
      delay = baseDelay;
      break;
    case 'linear':
      delay = baseDelay * attemptCount;
      break;
    case 'exponential':
      delay = baseDelay * Math.pow(multiplier, attemptCount - 1);
      break;
    default:
      delay = baseDelay;
  }
  return Math.min(Math.round(delay), maxDelay);
}

async function findById(id) {
  const { rows } = await query('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0];
}

async function listByQueue(queueId, { status, limit = 50, offset = 0 } = {}) {
  const clauses = ['queue_id = $1'];
  const params = [queueId];
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT * FROM jobs WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function create(jobData) {
  const {
    queueId, jobType, name, payload, priority, runAt, cronExpression,
    timezone, idempotencyKey, retryPolicyId, maxAttemptsOverride, timeoutSeconds, batchId,
  } = jobData;
  const { rows } = await query(
    `INSERT INTO jobs (queue_id, job_type, name, payload, priority, run_at, cron_expression,
                        timezone, idempotency_key, retry_policy_id, max_attempts_override,
                        timeout_seconds, batch_id, status)
     VALUES ($1,$2,$3,$4,COALESCE($5,0),COALESCE($6, now()),$7,COALESCE($8,'UTC'),$9,$10,$11,
             COALESCE($12,300),$13, (CASE WHEN COALESCE($6, now()) > now() THEN 'scheduled' ELSE 'queued' END)::job_status)
     ON CONFLICT (queue_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [queueId, jobType, name, payload || {}, priority, runAt, cronExpression, timezone,
      idempotencyKey, retryPolicyId, maxAttemptsOverride, timeoutSeconds, batchId]
  );
  return rows[0]; // undefined if idempotency key collided
}

async function cancel(jobId) {
  const { rows } = await query(
    `UPDATE jobs SET status = 'cancelled' WHERE id = $1 AND status IN ('queued','scheduled') RETURNING *`,
    [jobId]
  );
  return rows[0];
}

module.exports = {
  claimJobs, markRunning, markCompleted, markFailedAndResolve,
  findById, listByQueue, create, cancel, computeBackoff,
};
