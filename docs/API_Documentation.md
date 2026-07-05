# REST API Documentation

All endpoints (except Authentication) require the `X-API-Key` header mapped to a valid Project API Key.

## Authentication
- `POST /api/auth/register` - Register a new User account.
- `POST /api/auth/login` - Authenticate and receive a JWT.

## Projects & Queues
- `GET /api/projects` - List all projects for the authenticated user (Requires JWT).
- `POST /api/projects` - Create a new project.
- `GET /api/projects/:projectId/queues` - List queues.
- `POST /api/projects/:projectId/queues` - Create a queue.

## Job Ingestion & Management
- `POST /api/projects/:projectId/queues/:queueId/jobs` - Schedule a new job.
  - Body: `{ name: string, payload: object, runAt?: timestamp }`
- `GET /api/projects/:projectId/jobs` - Paginated list of jobs with filters (status, queue).
- `POST /api/projects/:projectId/jobs/:jobId/retry` - Manually requeue a dead-lettered job.

## Worker Coordination (Internal)
- `POST /api/projects/:projectId/workers/register` - Register a new worker node.
- `POST /api/projects/:projectId/workers/:workerId/heartbeat` - Update worker liveness.
- `POST /api/projects/:projectId/queues/:queueId/claim` - Atomically claim up to N jobs.
- `POST /api/projects/:projectId/queues/:queueId/jobs/:jobId/complete` - Mark success.
- `POST /api/projects/:projectId/queues/:queueId/jobs/:jobId/fail` - Mark failure (triggers retry logic).
