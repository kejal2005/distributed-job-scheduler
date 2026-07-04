const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { asyncHandler, ApiError } = require('../middleware/errorHandler');
const { validate, createJobSchema, batchJobSchema } = require('../utils/validation');
const { requireAuthOrApiKey } = require('../middleware/auth');
const jobRepo = require('../repositories/jobRepository');
const { query } = require('../config/db');
const { broadcast } = require('../utils/wsHub');

const router = express.Router({ mergeParams: true });
router.use(requireAuthOrApiKey);

function computeRunAt(validated) {
  if (validated.runAt) return validated.runAt;
  if (validated.delaySeconds) return new Date(Date.now() + validated.delaySeconds * 1000).toISOString();
  return null; // immediate -> defaults to now() in SQL
}

router.get('/', asyncHandler(async (req, res) => {
  const { status, limit, offset } = req.query;
  const jobs = await jobRepo.listByQueue(req.params.queueId, {
    status, limit: limit ? Number(limit) : 50, offset: offset ? Number(offset) : 0,
  });
  res.json({ jobs });
}));

router.post('/', validate(createJobSchema), asyncHandler(async (req, res) => {
  const v = req.validated;
  const job = await jobRepo.create({
    queueId: req.params.queueId,
    jobType: v.jobType,
    name: v.name,
    payload: v.payload,
    priority: v.priority,
    runAt: computeRunAt(v),
    cronExpression: v.cronExpression,
    timezone: v.timezone,
    idempotencyKey: v.idempotencyKey,
    retryPolicyId: v.retryPolicyId,
    maxAttemptsOverride: v.maxAttemptsOverride,
    timeoutSeconds: v.timeoutSeconds,
  });
  if (!job) throw new ApiError(409, 'A job with this idempotency key already exists on this queue');

  if (v.dependsOn && v.dependsOn.length > 0) {
    const values = v.dependsOn.map((depId) => `('${job.id}', '${depId}')`).join(',');
    await query(`INSERT INTO job_dependencies (job_id, depends_on_job_id) VALUES ${values}`);
  }
  broadcast({ type: 'job.created', job });
  res.status(201).json({ job });
}));

// Batch job creation - all jobs share a batch_id for grouped tracking
router.post('/batch', validate(batchJobSchema), asyncHandler(async (req, res) => {
  const batchId = uuidv4();
  const created = [];
  for (const v of req.validated.jobs) {
    const job = await jobRepo.create({
      queueId: req.params.queueId,
      jobType: 'batch',
      name: v.name,
      payload: v.payload,
      priority: v.priority,
      runAt: computeRunAt(v),
      idempotencyKey: v.idempotencyKey,
      retryPolicyId: v.retryPolicyId,
      maxAttemptsOverride: v.maxAttemptsOverride,
      timeoutSeconds: v.timeoutSeconds,
      batchId,
    });
    if (job) created.push(job);
  }
  broadcast({ type: 'batch.created', batchId, count: created.length });
  res.status(201).json({ batchId, jobs: created });
}));

router.get('/:jobId', asyncHandler(async (req, res) => {
  const job = await jobRepo.findById(req.params.jobId);
  if (!job) throw new ApiError(404, 'Job not found');
  res.json({ job });
}));

router.post('/:jobId/cancel', asyncHandler(async (req, res) => {
  const job = await jobRepo.cancel(req.params.jobId);
  if (!job) throw new ApiError(409, 'Job cannot be cancelled in its current state');
  broadcast({ type: 'job.cancelled', job });
  res.json({ job });
}));

// Retry a job that's sitting in the Dead Letter Queue
router.post('/:jobId/replay', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE jobs SET status='queued', attempt_count=0, run_at=now(), claimed_by_worker_id=NULL, last_error=NULL
     WHERE id = $1 AND status = 'dead_letter' RETURNING *`,
    [req.params.jobId]
  );
  if (!rows[0]) throw new ApiError(409, 'Job is not in the dead letter queue');
  await query(
    `UPDATE dead_letter_queue SET replayed_at = now(), replayed_by = $2 WHERE job_id = $1 AND replayed_at IS NULL`,
    [req.params.jobId, req.user ? req.user.id : null]
  );
  broadcast({ type: 'job.replayed', job: rows[0] });
  res.json({ job: rows[0] });
}));

router.get('/:jobId/executions', asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM job_executions WHERE job_id = $1 ORDER BY attempt_number DESC', [req.params.jobId]
  );
  res.json({ executions: rows });
}));

router.get('/:jobId/logs', asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM job_logs WHERE job_id = $1 ORDER BY logged_at ASC', [req.params.jobId]
  );
  res.json({ logs: rows });
}));

module.exports = router;
