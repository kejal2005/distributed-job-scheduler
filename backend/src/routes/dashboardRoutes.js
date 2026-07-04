const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireAuthOrApiKey } = require('../middleware/auth');
const { query } = require('../config/db');

const router = express.Router({ mergeParams: true });
router.use(requireAuthOrApiKey);

router.get('/overview', asyncHandler(async (req, res) => {
  const projectId = req.params.projectId;
  const [statusCounts, queueCount, workerCount, throughput] = await Promise.all([
    query(
      `SELECT j.status, count(*)::int AS count
         FROM jobs j JOIN queues q ON q.id = j.queue_id
        WHERE q.project_id = $1 GROUP BY j.status`, [projectId]
    ),
    query('SELECT count(*)::int AS count FROM queues WHERE project_id = $1', [projectId]),
    query(`SELECT count(*)::int AS count FROM workers WHERE project_id = $1 AND status='online'`, [projectId]),
    query(
      `SELECT date_trunc('hour', completed_at) AS hour, count(*)::int AS completed
         FROM jobs j JOIN queues q ON q.id = j.queue_id
        WHERE q.project_id = $1 AND completed_at > now() - interval '24 hours'
        GROUP BY 1 ORDER BY 1`, [projectId]
    ),
  ]);
  res.json({
    statusCounts: statusCounts.rows,
    queueCount: queueCount.rows[0].count,
    onlineWorkers: workerCount.rows[0].count,
    throughputByHour: throughput.rows,
  });
}));

router.get('/health', asyncHandler(async (req, res) => {
  const projectId = req.params.projectId;
  const { rows } = await query(
    `SELECT q.id, q.name, q.is_paused,
        count(*) FILTER (WHERE j.status IN ('queued','scheduled')) AS pending,
        count(*) FILTER (WHERE j.status = 'running') AS running,
        count(*) FILTER (WHERE j.status = 'dead_letter') AS dead_letter,
        avg(EXTRACT(EPOCH FROM (j.completed_at - j.started_at))) FILTER (WHERE j.status='completed') AS avg_duration_seconds
     FROM queues q LEFT JOIN jobs j ON j.queue_id = q.id
     WHERE q.project_id = $1 GROUP BY q.id, q.name, q.is_paused`,
    [projectId]
  );
  res.json({ queueHealth: rows });
}));

module.exports = router;
