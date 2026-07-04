const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { validate, createRetryPolicySchema } = require('../utils/validation');
const { requireAuthOrApiKey } = require('../middleware/auth');
const queueRepo = require('../repositories/queueRepository');
const { resolveProjectId } = require('../utils/projectContext');

const router = express.Router({ mergeParams: true });
router.use(requireAuthOrApiKey);

router.get('/', asyncHandler(async (req, res) => {
  const projectId = await resolveProjectId(req);
  const policies = await queueRepo.listRetryPolicies(projectId);
  res.json({ retryPolicies: policies });
}));

router.post('/', validate(createRetryPolicySchema), asyncHandler(async (req, res) => {
  const projectId = await resolveProjectId(req);
  const policy = await queueRepo.createRetryPolicy({ projectId, ...req.validated });
  res.status(201).json({ retryPolicy: policy });
}));

module.exports = router;
