const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/authRoutes');
const queueRoutes = require('./routes/queueRoutes');
const retryPolicyRoutes = require('./routes/retryPolicyRoutes');
const jobRoutes = require('./routes/jobRoutes');
const scheduledJobRoutes = require('./routes/scheduledJobRoutes');
const workerRoutes = require('./routes/workerRoutes');
const dlqRoutes = require('./routes/dlqRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

  // Global rate limit — protects the API from abusive polling/submission bursts.
  // Per-project/queue rate limiting (bonus feature) is layered on top for job submission.
  const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });
  app.use(globalLimiter);

  app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  app.use('/api/auth', authRoutes);
  app.use('/api/projects/:projectId/queues', queueRoutes);
  app.use('/api/projects/:projectId/retry-policies', retryPolicyRoutes);
  app.use('/api/projects/:projectId/queues/:queueId/jobs', jobRoutes);
  app.use('/api/projects/:projectId/queues/:queueId/scheduled-jobs', scheduledJobRoutes);
  app.use('/api/projects/:projectId/workers', workerRoutes);
  app.use('/api/projects/:projectId/dead-letter-queue', dlqRoutes);
  app.use('/api/projects/:projectId/dashboard', dashboardRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
