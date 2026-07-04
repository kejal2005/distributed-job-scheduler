const { pool } = require('../src/config/db');

async function truncateAll() {
  await pool.query(`
    TRUNCATE TABLE
      dead_letter_queue, job_logs, job_executions, job_dependencies, jobs,
      scheduled_jobs, worker_heartbeats, workers, retry_policies, queues,
      projects, organization_members, organizations, users
    RESTART IDENTITY CASCADE
  `);
}

async function closeDb() {
  await pool.end();
}

/** Build a full fixture chain (user -> org -> project -> queue) via the real app, returning handles for tests. */
async function buildFixtures(request, app) {
  const email = `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await request(app).post('/api/auth/register').send({ email, password: 'password123', name: 'Test User' });
  const token = reg.body.token;

  const org = await request(app).post('/api/auth/organizations').set('Authorization', `Bearer ${token}`).send({ name: 'Test Org' });
  const organizationId = org.body.organization.id;

  const proj = await request(app).post('/api/auth/projects').set('Authorization', `Bearer ${token}`)
    .send({ organizationId, name: 'Test Project' });
  const projectId = proj.body.project.id;
  const apiKey = proj.body.project.api_key;

  const rp = await request(app).post(`/api/projects/${projectId}/retry-policies`).set('X-API-Key', apiKey)
    .send({ name: 'default', strategy: 'fixed', maxAttempts: 2, baseDelaySeconds: 1 });
  const retryPolicyId = rp.body.retryPolicy.id;

  const queue = await request(app).post(`/api/projects/${projectId}/queues`).set('X-API-Key', apiKey)
    .send({ name: 'test-queue', concurrencyLimit: 5, defaultRetryPolicyId: retryPolicyId });
  const queueId = queue.body.queue.id;

  return { token, organizationId, projectId, apiKey, retryPolicyId, queueId };
}

module.exports = { truncateAll, closeDb, buildFixtures };
