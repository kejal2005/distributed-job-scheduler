const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireAuthOrApiKey } = require('../middleware/auth');
const { query } = require('../config/db');

const router = express.Router({ mergeParams: true });
router.use(requireAuthOrApiKey);

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT dlq.*, j.name AS job_name, q.name AS queue_name
       FROM dead_letter_queue dlq
       JOIN jobs j ON j.id = dlq.job_id
       JOIN queues q ON q.id = dlq.queue_id
      WHERE q.project_id = $1
      ORDER BY dlq.moved_at DESC LIMIT 100`,
    [req.params.projectId]
  );
  res.json({ deadLetters: rows });
}));

module.exports = router;
