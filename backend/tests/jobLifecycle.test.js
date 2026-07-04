const request = require('supertest');
const { createApp } = require('../src/app');
const { truncateAll, closeDb, buildFixtures } = require('./helpers');

const app = createApp();
let fx;

beforeEach(async () => {
  await truncateAll();
  fx = await buildFixtures(request, app);
});
afterAll(async () => { await closeDb(); });

async function registerWorker() {
  const res = await request(app).post(`/api/projects/${fx.projectId}/workers/register`)
    .set('X-API-Key', fx.apiKey).send({ hostname: 'test-host', pid: 1, queues: ['test-queue'], concurrency: 5 });
  return res.body.worker.id;
}

describe('Job lifecycle', () => {
  test('creates a job in queued state', async () => {
    const res = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs`)
      .set('X-API-Key', fx.apiKey).send({ name: 'my-job', payload: { x: 1 } });
    expect(res.status).toBe(201);
    expect(res.body.job.status).toBe('queued');
  });

  test('idempotency key prevents duplicate job creation on the same queue', async () => {
    const body = { name: 'dup-job', payload: {}, idempotencyKey: 'unique-123' };
    const first = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs`).set('X-API-Key', fx.apiKey).send(body);
    const second = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs`).set('X-API-Key', fx.apiKey).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });

  test('a worker can claim, start, and complete a job', async () => {
    const workerId = await registerWorker();
    const job = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs`)
      .set('X-API-Key', fx.apiKey).send({ name: 'happy-path', payload: {} });

    const claim = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/claim`)
      .set('X-API-Key', fx.apiKey).send({ workerId, limit: 1 });
    expect(claim.body.jobs).toHaveLength(1);
    expect(claim.body.jobs[0].status).toBe('claimed');

    const start = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs/${job.body.job.id}/start`)
      .set('X-API-Key', fx.apiKey);
    expect(start.body.job.status).toBe('running');

    const complete = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs/${job.body.job.id}/complete`)
      .set('X-API-Key', fx.apiKey);
    expect(complete.body.job.status).toBe('completed');

    const executions = await request(app).get(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs/${job.body.job.id}/executions`)
      .set('X-API-Key', fx.apiKey);
    expect(executions.body.executions).toHaveLength(1);
    expect(executions.body.executions[0].result).toBe('success');
  });

  test('a job that exceeds max_attempts moves to the dead letter queue', async () => {
    const workerId = await registerWorker();
    const job = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs`)
      .set('X-API-Key', fx.apiKey).send({ name: 'doomed', payload: {}, retryPolicyId: fx.retryPolicyId });
    const jobId = job.body.job.id;

    // fixture retry policy: maxAttempts=2, fixed 1s delay
    for (let i = 0; i < 2; i++) {
      const claim = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/claim`)
        .set('X-API-Key', fx.apiKey).send({ workerId, limit: 5 });
      expect(claim.body.jobs.some((j) => j.id === jobId)).toBe(true);

      await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs/${jobId}/start`).set('X-API-Key', fx.apiKey);
      const fail = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs/${jobId}/fail`)
        .set('X-API-Key', fx.apiKey).send({ errorMessage: 'boom' });

      if (i === 0) {
        expect(fail.body.outcome).toBe('retry');
        await new Promise((r) => setTimeout(r, 1100)); // wait out the backoff
      } else {
        expect(fail.body.outcome).toBe('dead_letter');
      }
    }

    const dlq = await request(app).get(`/api/projects/${fx.projectId}/dead-letter-queue`).set('X-API-Key', fx.apiKey);
    expect(dlq.body.deadLetters.some((d) => d.job_id === jobId)).toBe(true);
  });

  test('cancelling a queued job prevents it from being claimed', async () => {
    const workerId = await registerWorker();
    const job = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs`)
      .set('X-API-Key', fx.apiKey).send({ name: 'to-cancel', payload: {} });

    const cancel = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs/${job.body.job.id}/cancel`)
      .set('X-API-Key', fx.apiKey);
    expect(cancel.body.job.status).toBe('cancelled');

    const claim = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/claim`)
      .set('X-API-Key', fx.apiKey).send({ workerId, limit: 5 });
    expect(claim.body.jobs.some((j) => j.id === job.body.job.id)).toBe(false);
  });

  test('a paused queue yields no claimable jobs', async () => {
    const workerId = await registerWorker();
    await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs`).set('X-API-Key', fx.apiKey).send({ name: 'job-a', payload: {} });
    await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/pause`).set('X-API-Key', fx.apiKey);

    const claim = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/claim`)
      .set('X-API-Key', fx.apiKey).send({ workerId, limit: 5 });
    expect(claim.body.jobs).toHaveLength(0);
  });

  test('delayed jobs are not claimable until run_at has passed', async () => {
    const workerId = await registerWorker();
    await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs`)
      .set('X-API-Key', fx.apiKey).send({ name: 'later-job', payload: {}, delaySeconds: 30 });

    const claim = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/claim`)
      .set('X-API-Key', fx.apiKey).send({ workerId, limit: 5 });
    expect(claim.body.jobs).toHaveLength(0);
  });
});
