const express = require('express');
const { asyncHandler, ApiError } = require('../middleware/errorHandler');
const { requireAuthOrApiKey } = require('../middleware/auth');
const { query } = require('../config/db');
const { broadcast } = require('../utils/wsHub');

const router = express.Router({ mergeParams: true });
router.use(requireAuthOrApiKey);

router.post('/register', asyncHandler(async (req, res) => {
  const { hostname, pid, queues, concurrency } = req.body;
  const { rows } = await query(
    `INSERT INTO workers (project_id, hostname, pid, queues, concurrency)
     VALUES ($1,$2,$3,$4,COALESCE($5,5)) RETURNING *`,
    [req.params.projectId, hostname, pid, queues || [], concurrency]
  );
  broadcast({ type: 'worker.registered', worker: rows[0] });
  res.status(201).json({ worker: rows[0] });
}));

router.post('/:workerId/heartbeat', asyncHandler(async (req, res) => {
  const { activeJobs, cpuPercent, memoryMb } = req.body;
  await query(
    `INSERT INTO worker_heartbeats (worker_id, active_jobs, cpu_percent, memory_mb) VALUES ($1,$2,$3,$4)`,
    [req.params.workerId, activeJobs || 0, cpuPercent, memoryMb]
  );
  const { rows } = await query(
    `UPDATE workers SET last_seen_at = now(), status = 'online' WHERE id = $1 RETURNING *`,
    [req.params.workerId]
  );
  if (!rows[0]) throw new ApiError(404, 'Worker not found');
  res.json({ worker: rows[0] });
}));

router.post('/:workerId/drain', asyncHandler(async (req, res) => {
  const { rows } = await query(`UPDATE workers SET status = 'draining' WHERE id = $1 RETURNING *`, [req.params.workerId]);
  broadcast({ type: 'worker.draining', worker: rows[0] });
  res.json({ worker: rows[0] });
}));

router.post('/:workerId/offline', asyncHandler(async (req, res) => {
  const { rows } = await query(`UPDATE workers SET status = 'offline' WHERE id = $1 RETURNING *`, [req.params.workerId]);
  broadcast({ type: 'worker.offline', worker: rows[0] });
  res.json({ worker: rows[0] });
}));

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT w.*,
        (SELECT count(*) FROM jobs j WHERE j.claimed_by_worker_id = w.id AND j.status='running') AS active_job_count
     FROM workers w WHERE w.project_id = $1 ORDER BY w.started_at DESC`,
    [req.params.projectId]
  );
  res.json({ workers: rows });
}));

module.exports = router;
