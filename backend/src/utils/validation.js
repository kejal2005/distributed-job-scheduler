const { z } = require('zod');

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const createOrgSchema = z.object({
  name: z.string().min(1),
});

const createProjectSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().min(1),
});

const createQueueSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  priority: z.number().int().optional(),
  concurrencyLimit: z.number().int().positive().optional(),
  defaultRetryPolicyId: z.string().uuid().optional().nullable(),
});

const updateQueueSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: z.number().int().optional(),
  concurrencyLimit: z.number().int().positive().optional(),
  defaultRetryPolicyId: z.string().uuid().optional().nullable(),
  isPaused: z.boolean().optional(),
});

const createRetryPolicySchema = z.object({
  name: z.string().min(1),
  strategy: z.enum(['fixed', 'linear', 'exponential', 'none']).optional(),
  maxAttempts: z.number().int().min(0).optional(),
  baseDelaySeconds: z.number().int().min(0).optional(),
  maxDelaySeconds: z.number().int().min(0).optional(),
  multiplier: z.number().positive().optional(),
});

const createJobSchema = z.object({
  name: z.string().min(1),
  jobType: z.enum(['immediate', 'delayed', 'scheduled', 'recurring', 'batch']).default('immediate'),
  payload: z.record(z.any()).optional(),
  priority: z.number().int().optional(),
  runAt: z.string().datetime().optional(), // for delayed/scheduled
  delaySeconds: z.number().int().positive().optional(), // convenience alternative to runAt
  cronExpression: z.string().optional(), // for recurring
  timezone: z.string().optional(),
  idempotencyKey: z.string().optional(),
  retryPolicyId: z.string().uuid().optional(),
  maxAttemptsOverride: z.number().int().min(0).optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  dependsOn: z.array(z.string().uuid()).optional(),
});

const batchJobSchema = z.object({
  jobs: z.array(createJobSchema).min(1).max(1000),
});

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    req.validated = result.data;
    next();
  };
}

module.exports = {
  validate, registerSchema, loginSchema, createOrgSchema, createProjectSchema,
  createQueueSchema, updateQueueSchema, createRetryPolicySchema, createJobSchema, batchJobSchema,
};
