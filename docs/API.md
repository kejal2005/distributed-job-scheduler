# API Reference — Distributed Job Scheduler

Base URL: `http://localhost:4000/api`

## Auth

Two schemes, used on different routes:
- **JWT** (`Authorization: Bearer <token>`) — dashboard / human users. Obtained via `/auth/login` or `/auth/register`.
- **API key** (`X-API-Key: <key>`) — workers and external services. One key per project, obtained when the project is created.

---

### `POST /auth/register`
Body: `{ email, password (min 8 chars), name }` → `201 { user, token }`

### `POST /auth/login`
Body: `{ email, password }` → `200 { user, token }`

### `GET /auth/me` *(JWT)*
→ `200 { user }`

### `POST /auth/organizations` *(JWT)*
Body: `{ name }` → `201 { organization }`

### `POST /auth/projects` *(JWT)*
Body: `{ organizationId, name }` → `201 { project }` (includes `api_key`)

### `GET /auth/projects` *(JWT)*
→ `200 { projects: [...] }`

---

## Queues — `/projects/:projectId/queues`

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/` | — | List queues with live pending/running/completed/dead-letter counts |
| POST | `/` | `{ name, description?, priority?, concurrencyLimit?, defaultRetryPolicyId? }` | |
| GET | `/:queueId` | — | |
| PATCH | `/:queueId` | any of the above fields | |
| POST | `/:queueId/pause` | — | Paused queues yield no claimable jobs |
| POST | `/:queueId/resume` | — | |
| GET | `/:queueId/stats` | — | Status breakdown for one queue |
| POST | `/:queueId/claim` | `{ workerId, limit? }` | **Internal** — atomic job claim, used by workers |

## Retry Policies — `/projects/:projectId/retry-policies`

`GET /` and `POST /` with `{ name, strategy: 'fixed'|'linear'|'exponential'|'none', maxAttempts?, baseDelaySeconds?, maxDelaySeconds?, multiplier? }`

## Jobs — `/projects/:projectId/queues/:queueId/jobs`

| Method | Path | Body |
|---|---|---|
| GET | `/?status=&limit=&offset=` | — |
| POST | `/` | `{ name, jobType?, payload?, priority?, runAt?, delaySeconds?, cronExpression?, idempotencyKey?, retryPolicyId?, maxAttemptsOverride?, timeoutSeconds?, dependsOn? }` |
| POST | `/batch` | `{ jobs: [ {...same as above} ] }` (max 1000) |
| GET | `/:jobId` | — |
| POST | `/:jobId/cancel` | — | only from `queued`/`scheduled` |
| POST | `/:jobId/replay` | — | only from `dead_letter` |
| GET | `/:jobId/executions` | — | attempt history |
| GET | `/:jobId/logs` | — | |
| POST | `/:jobId/start` | — | **Internal**, worker → running |
| POST | `/:jobId/complete` | — | **Internal** |
| POST | `/:jobId/fail` | `{ errorMessage }` | **Internal** — resolves retry vs. dead-letter |

## Scheduled (Recurring) Jobs — `/projects/:projectId/queues/:queueId/scheduled-jobs`

`GET /`, `POST / { name, cronExpression, timezone?, payloadTemplate?, retryPolicyId? }`, `PATCH /:id/pause`, `PATCH /:id/resume`

## Workers — `/projects/:projectId/workers`

`POST /register { hostname, pid, queues, concurrency }`, `POST /:workerId/heartbeat { activeJobs, cpuPercent?, memoryMb? }`, `POST /:workerId/drain`, `POST /:workerId/offline`, `GET /`

## Dead Letter Queue — `/projects/:projectId/dead-letter-queue`

`GET /` — jobs that exhausted retries, with a payload snapshot and failure reason.

## Dashboard — `/projects/:projectId/dashboard`

`GET /overview` — status counts, online worker count, 24h throughput.
`GET /health` — per-queue pending/running/dead-letter counts and average job duration.

## WebSocket

Connect to `ws://<host>/ws` for live events: `job.created`, `batch.created`, `job.cancelled`, `job.replayed`, `worker.registered`, `worker.draining`, `worker.offline`.

## Error format

```json
{ "error": "human-readable message", "details": { "optional": "field-level validation errors" } }
```
