const express = require('express');
const { asyncHandler, ApiError } = require('../middleware/errorHandler');
const { validate, createQueueSchema, updateQueueSchema } = require('../utils/validation');
const { requireAuthOrApiKey } = require('../middleware/auth');
const queueRepo = require('../repositories/queueRepository');
const jobRepo = require('../repositories/jobRepository');
const { resolveProjectId } = require('../utils/projectContext');

const router = express.Router({ mergeParams: true });

router.use(requireAuthOrApiKey);

// GET /projects/:projectId/queues
router.get('/', asyncHandler(async (req, res) => {
  const projectId = await resolveProjectId(req);
  const queues = await queueRepo.listQueuesByProject(projectId);
  res.json({ queues });
}));

router.post('/', validate(createQueueSchema), asyncHandler(async (req, res) => {
  const projectId = await resolveProjectId(req);
  const queue = await queueRepo.createQueue({ projectId, ...req.validated });
  res.status(201).json({ queue });
}));

router.get('/:queueId', asyncHandler(async (req, res) => {
  const queue = await queueRepo.findQueueById(req.params.queueId);
  if (!queue) throw new ApiError(404, 'Queue not found');
  res.json({ queue });
}));

router.patch('/:queueId', validate(updateQueueSchema), asyncHandler(async (req, res) => {
  const queue = await queueRepo.updateQueue(req.params.queueId, req.validated);
  res.json({ queue });
}));

router.post('/:queueId/pause', asyncHandler(async (req, res) => {
  const queue = await queueRepo.setPaused(req.params.queueId, true);
  res.json({ queue });
}));

router.post('/:queueId/resume', asyncHandler(async (req, res) => {
  const queue = await queueRepo.setPaused(req.params.queueId, false);
  res.json({ queue });
}));

router.get('/:queueId/stats', asyncHandler(async (req, res) => {
  const stats = await queueRepo.queueStats(req.params.queueId);
  res.json({ stats });
}));

// Internal endpoint used by worker processes to atomically claim jobs.
// Pause state and concurrency_limit are enforced atomically inside
// jobRepo.claimJobs itself (see that function's docstring) -- this route
// deliberately does NOT pre-check those things, since a separate
// check-then-act here would itself be a race condition under concurrent
// worker polling.
router.post('/:queueId/claim', asyncHandler(async (req, res) => {
  const { workerId, limit } = req.body;
  const jobs = await jobRepo.claimJobs({ queueId: req.params.queueId, workerId, limit: limit || 1 });
  res.json({ jobs });
}));

router.post('/:queueId/jobs/:jobId/start', asyncHandler(async (req, res) => {
  const job = await jobRepo.markRunning(req.params.jobId);
  res.json({ job });
}));

router.post('/:queueId/jobs/:jobId/complete', asyncHandler(async (req, res) => {
  const { query } = require('../config/db');
  const job = await jobRepo.markCompleted(req.params.jobId);
  await query(
    `UPDATE job_executions SET finished_at = now(), result = 'success',
            duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
      WHERE job_id = $1 AND finished_at IS NULL`,
    [req.params.jobId]
  );
  res.json({ job });
}));

router.post('/:queueId/jobs/:jobId/fail', asyncHandler(async (req, res) => {
  const { errorMessage } = req.body;
  const { query } = require('../config/db');
  await query(
    `UPDATE job_executions SET finished_at = now(), result = 'failure', error_message = $2,
            duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
      WHERE job_id = $1 AND finished_at IS NULL`,
    [req.params.jobId, errorMessage]
  );
  const result = await jobRepo.markFailedAndResolve(req.params.jobId, errorMessage);
  res.json(result);
}));

module.exports = router;
