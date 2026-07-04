const express = require('express');
const cronParser = require('cron-parser');
const { z } = require('zod');
const { asyncHandler, ApiError } = require('../middleware/errorHandler');
const { validate } = require('../utils/validation');
const { requireAuthOrApiKey } = require('../middleware/auth');
const { query } = require('../config/db');

const router = express.Router({ mergeParams: true });
router.use(requireAuthOrApiKey);

const createScheduledJobSchema = z.object({
  name: z.string().min(1),
  cronExpression: z.string().min(1),
  timezone: z.string().optional(),
  payloadTemplate: z.record(z.any()).optional(),
  retryPolicyId: z.string().uuid().optional(),
});

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM scheduled_jobs WHERE queue_id = $1 ORDER BY created_at', [req.params.queueId]);
  res.json({ scheduledJobs: rows });
}));

router.post('/', validate(createScheduledJobSchema), asyncHandler(async (req, res) => {
  const { name, cronExpression, timezone, payloadTemplate, retryPolicyId } = req.validated;
  let nextRunAt;
  try {
    nextRunAt = cronParser.parseExpression(cronExpression, { currentDate: new Date(), tz: timezone || 'UTC' }).next().toDate();
  } catch (err) {
    throw new ApiError(400, `Invalid cron expression: ${err.message}`);
  }
  const { rows } = await query(
    `INSERT INTO scheduled_jobs (queue_id, name, cron_expression, timezone, payload_template, retry_policy_id, next_run_at)
     VALUES ($1,$2,$3,COALESCE($4,'UTC'),COALESCE($5,'{}'::jsonb),$6,$7) RETURNING *`,
    [req.params.queueId, name, cronExpression, timezone, payloadTemplate, retryPolicyId, nextRunAt]
  );
  res.status(201).json({ scheduledJob: rows[0] });
}));

router.patch('/:scheduledJobId/pause', asyncHandler(async (req, res) => {
  const { rows } = await query('UPDATE scheduled_jobs SET is_active = false WHERE id = $1 RETURNING *', [req.params.scheduledJobId]);
  res.json({ scheduledJob: rows[0] });
}));

router.patch('/:scheduledJobId/resume', asyncHandler(async (req, res) => {
  const { rows } = await query('UPDATE scheduled_jobs SET is_active = true WHERE id = $1 RETURNING *', [req.params.scheduledJobId]);
  res.json({ scheduledJob: rows[0] });
}));

module.exports = router;
