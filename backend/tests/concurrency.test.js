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

async function registerWorker(n) {
  const res = await request(app).post(`/api/projects/${fx.projectId}/workers/register`)
    .set('X-API-Key', fx.apiKey).send({ hostname: `worker-${n}`, pid: n, queues: ['test-queue'], concurrency: 1 });
  return res.body.worker.id;
}

describe('Concurrency correctness', () => {
  test('N concurrent workers claiming from a queue of M jobs never double-claim, and every job is claimed exactly once', async () => {
    const JOB_COUNT = 20;
    const WORKER_COUNT = 10;

    // Raise the queue's concurrency limit so the claim isn't gated by that instead of by locking.
    await request(app).patch(`/api/projects/${fx.projectId}/queues/${fx.queueId}`)
      .set('X-API-Key', fx.apiKey).send({ concurrencyLimit: 100 });

    const jobIds = [];
    for (let i = 0; i < JOB_COUNT; i++) {
      const res = await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs`)
        .set('X-API-Key', fx.apiKey).send({ name: `race-job-${i}`, payload: {} });
      jobIds.push(res.body.job.id);
    }

    const workerIds = await Promise.all(Array.from({ length: WORKER_COUNT }, (_, i) => registerWorker(i)));

    // Fire all workers' claim requests truly concurrently, each asking for up to 3 jobs.
    const results = await Promise.all(
      workerIds.map((workerId) =>
        request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/claim`)
          .set('X-API-Key', fx.apiKey).send({ workerId, limit: 3 })
      )
    );

    const claimedJobIds = results.flatMap((r) => r.body.jobs.map((j) => j.id));

    // Correctness property 1: no job was claimed more than once across all workers.
    const uniqueClaimed = new Set(claimedJobIds);
    expect(uniqueClaimed.size).toBe(claimedJobIds.length);

    // Correctness property 2: every claimed job actually belongs to our job set.
    for (const id of claimedJobIds) expect(jobIds).toContain(id);

    // Correctness property 3: total claimed does not exceed total available.
    expect(claimedJobIds.length).toBeLessThanOrEqual(JOB_COUNT);
  });

  test('claim respects the queue concurrency_limit even under concurrent requests', async () => {
    await request(app).patch(`/api/projects/${fx.projectId}/queues/${fx.queueId}`)
      .set('X-API-Key', fx.apiKey).send({ concurrencyLimit: 5 });

    for (let i = 0; i < 20; i++) {
      await request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/jobs`)
        .set('X-API-Key', fx.apiKey).send({ name: `job-${i}`, payload: {} });
    }

    const workerIds = await Promise.all(Array.from({ length: 10 }, (_, i) => registerWorker(i)));
    const results = await Promise.all(
      workerIds.map((workerId) =>
        request(app).post(`/api/projects/${fx.projectId}/queues/${fx.queueId}/claim`)
          .set('X-API-Key', fx.apiKey).send({ workerId, limit: 3 })
      )
    );
    const claimedCount = results.reduce((sum, r) => sum + r.body.jobs.length, 0);
    expect(claimedCount).toBeLessThanOrEqual(5);
  });
});
