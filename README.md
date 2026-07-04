# Distributed Job Scheduler

A multi-process, Postgres-backed distributed job scheduler: atomic job claiming, retries with backoff, a dead letter queue, cron-based recurring jobs, and a live operations dashboard.

## What's in here

```
backend/          Express API + Worker service + Cron scheduler
  migrations/      SQL schema
  src/
    routes/        REST endpoints
    repositories/   All SQL lives here (jobRepository.js has the atomic claim)
    workers/        Standalone worker process (npm run worker)
    scheduler/      Standalone cron scheduler process (npm run scheduler)
  tests/           Jest + Supertest, including the concurrency-correctness suite
frontend/         Static dashboard (no build step) — open frontend/index.html or serve the folder
docs/
  Design-Decisions.docx    Architecture + DB design + reliability write-up (read this first)
  architecture-diagram.png
  er-diagram.png
  API.md                   Full endpoint reference
```

## Running it

**1. Database**
```bash
createdb job_scheduler
psql -d job_scheduler -f backend/migrations/001_init_schema.sql
```

**2. API server**
```bash
cd backend
npm install
cp .env.example .env   # adjust PG* vars if needed
npm start               # http://localhost:4000
```

**3. Worker(s)** — run as many as you like, even on different machines, against the same project:
```bash
cd backend
PROJECT_ID=<id> PROJECT_API_KEY=<key> WORKER_QUEUES=emails,reports npm run worker
```

**4. Cron scheduler** (one instance):
```bash
cd backend
npm run scheduler
```

**5. Dashboard**
```bash
cd frontend
python3 -m http.server 5173   # or any static file server
# open http://localhost:5173
```
Register an account in the dashboard, create a project, and copy its API key into the worker's env vars above.

**6. Tests**
```bash
cd backend
createdb job_scheduler_test
psql -d job_scheduler_test -f migrations/001_init_schema.sql
npm test
```

## Read first

`docs/Design-Decisions.docx` explains *why* things are built this way — the atomic claim query, the concurrency_limit race that was found and fixed, the retry/backoff math, and the cascade-rule reasoning for every foreign key. It's written to be read standalone, without the code open.
