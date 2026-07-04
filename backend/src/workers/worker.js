/**
 * Worker Service
 * ---------------
 * A standalone process that:
 *  - registers itself with the API
 *  - polls its assigned queues on an interval
 *  - claims jobs atomically (via the API's /claim endpoint, which uses
 *    FOR UPDATE SKIP LOCKED under the hood)
 *  - executes jobs concurrently up to its configured concurrency limit
 *  - sends periodic heartbeats
 *  - shuts down gracefully on SIGTERM/SIGINT: stops polling, waits for
 *    in-flight jobs to finish (or times out), then exits.
 *
 * Run multiple instances of this process to scale out horizontally --
 * that's the "distributed" in Distributed Job Scheduler. The atomic
 * claim on the server guarantees they never step on each other.
 */
require('dotenv').config();
const fetchFn = global.fetch; // Node 18+ ships fetch natively -- no extra HTTP dependency needed

const API_BASE = process.env.API_BASE || 'http://localhost:4000/api';
const API_KEY = process.env.PROJECT_API_KEY;
const PROJECT_ID = process.env.PROJECT_ID;
const QUEUE_NAMES = (process.env.WORKER_QUEUES || '').split(',').filter(Boolean);
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 5);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 5000);

if (!API_KEY || !PROJECT_ID) {
  console.error('WORKER FATAL: PROJECT_API_KEY and PROJECT_ID env vars are required');
  process.exit(1);
}

async function api(path, options = {}) {
  const res = await fetchFn(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${options.method || 'GET'} ${path} -> ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Job handler registry. In a real system, job "name" would map to a
 * business-logic function (send_email, generate_report, etc). This demo
 * registers a few illustrative handlers plus a fallback.
 */
const handlers = {
  default: async (job) => {
    // Simulate work; jobs whose payload includes `shouldFail: true` are used
    // by tests/demos to exercise the retry -> DLQ path deterministically.
    await sleep(200 + Math.random() * 400);
    if (job.payload && job.payload.shouldFail) {
      throw new Error(job.payload.failureMessage || 'Simulated job failure');
    }
    return { ok: true };
  },
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class Worker {
  constructor() {
    this.id = null;
    this.activeCount = 0;
    this.draining = false;
    this.stopped = false;
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.queueIds = new Map(); // name -> id
  }

  async start() {
    const worker = await api(`/projects/${PROJECT_ID}/workers/register`, {
      method: 'POST',
      body: JSON.stringify({
        hostname: require('os').hostname(),
        pid: process.pid,
        queues: QUEUE_NAMES,
        concurrency: CONCURRENCY,
      }),
    });
    this.id = worker.worker.id;
    console.log(`[worker ${this.id}] registered (requested queues: ${QUEUE_NAMES.join(', ') || 'ALL'})`);

    const { queues } = await api(`/projects/${PROJECT_ID}/queues`);
    for (const q of queues) {
      if (QUEUE_NAMES.length === 0 || QUEUE_NAMES.includes(q.name)) {
        this.queueIds.set(q.name, q.id);
      }
    }
    if (this.queueIds.size === 0) {
      console.error(`[worker ${this.id}] WARNING: 0 of the requested queues (${QUEUE_NAMES.join(', ')}) were found in the project. Available queues were: ${queues.map(q => q.name).join(', ') || '(none)'}. This worker will poll nothing until restarted with a correct queue name.`);
    } else {
      console.log(`[worker ${this.id}] resolved ${this.queueIds.size} queue(s) to watch: ${[...this.queueIds.keys()].join(', ')}`);
    }

    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.pollTimer = setInterval(() => this.pollAll(), POLL_INTERVAL_MS);
    this.pollAll(); // kick off immediately instead of waiting for first interval
  }

  async heartbeat() {
    try {
      await api(`/projects/${PROJECT_ID}/workers/${this.id}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ activeJobs: this.activeCount }),
      });
    } catch (err) {
      console.error(`[worker ${this.id}] heartbeat failed:`, err.message);
    }
  }

  async pollAll() {
    if (this.draining || this.stopped) return;
    const available = CONCURRENCY - this.activeCount;
    if (available <= 0) return;

    for (const [name, queueId] of this.queueIds) {
      if (this.activeCount >= CONCURRENCY) break;
      try {
        const { jobs } = await api(`/projects/${PROJECT_ID}/queues/${queueId}/claim`, {
          method: 'POST',
          body: JSON.stringify({ workerId: this.id, limit: CONCURRENCY - this.activeCount }),
        });
        for (const job of jobs) this.execute(queueId, job);
      } catch (err) {
        console.error(`[worker ${this.id}] poll error on queue ${name}:`, err.message);
      }
    }
  }

  async execute(queueId, job) {
    this.activeCount += 1;
    try {
      await api(`/projects/${PROJECT_ID}/queues/${queueId}/jobs/${job.id}/start`, { method: 'POST' });
      const handler = handlers[job.name] || handlers.default;
      console.log(`[worker ${this.id}] running job ${job.id} (${job.name}), attempt ${job.attempt_count}`);
      await handler(job);
      await api(`/projects/${PROJECT_ID}/queues/${queueId}/jobs/${job.id}/complete`, { method: 'POST' });
      console.log(`[worker ${this.id}] completed job ${job.id}`);
    } catch (err) {
      console.error(`[worker ${this.id}] job ${job.id} failed:`, err.message);
      try {
        await api(`/projects/${PROJECT_ID}/queues/${queueId}/jobs/${job.id}/fail`, {
          method: 'POST',
          body: JSON.stringify({ errorMessage: err.message }),
        });
      } catch (innerErr) {
        console.error(`[worker ${this.id}] failed to report failure:`, innerErr.message);
      }
    } finally {
      this.activeCount -= 1;
    }
  }

  /** Graceful shutdown: stop claiming new work, wait for in-flight jobs (bounded), then exit. */
  async shutdown(timeoutMs = 15000) {
    console.log(`[worker ${this.id}] draining... (${this.activeCount} job(s) in flight)`);
    this.draining = true;
    clearInterval(this.pollTimer);
    clearInterval(this.heartbeatTimer);
    try { await api(`/projects/${PROJECT_ID}/workers/${this.id}/drain`, { method: 'POST' }); } catch (_) {}

    const start = Date.now();
    while (this.activeCount > 0 && Date.now() - start < timeoutMs) {
      await sleep(200);
    }
    try { await api(`/projects/${PROJECT_ID}/workers/${this.id}/offline`, { method: 'POST' }); } catch (_) {}
    this.stopped = true;
    console.log(`[worker ${this.id}] shutdown complete.`);
  }
}

const worker = new Worker();
worker.start().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await worker.shutdown();
    process.exit(0);
  });
}

module.exports = { Worker };
