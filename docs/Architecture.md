# System Architecture

## Architecture Diagram

```mermaid
graph TD
    subgraph Frontend
        Dashboard[Vercel: Dashboard UI]
    end

    subgraph Control Plane
        API[Render: Node.js REST API]
        WS[WebSocket Server]
    end

    subgraph Data Layer
        DB[(Render: PostgreSQL 16)]
    end

    subgraph Compute Layer
        Worker1[Worker Instance 1]
        Worker2[Worker Instance N]
    end

    Dashboard -- REST (JSON) --> API
    Dashboard -- WebSocket --> WS
    API <--> DB
    WS <--> API
    
    Worker1 -- Polling /claim --> API
    Worker2 -- Polling /claim --> API
    Worker1 -- Heartbeat --> API
    Worker2 -- Heartbeat --> API
```

## Flow Description
1. **Job Ingestion:** The user creates a job via the Dashboard UI (REST POST). The API writes the job to PostgreSQL with a `queued` status.
2. **Real-time Updates:** The API triggers a WebSocket broadcast. The Dashboard UI instantly updates the pending count.
3. **Atomic Claiming:** Workers continuously poll the `/claim` endpoint. The API executes a `SELECT ... FOR UPDATE SKIP LOCKED` query on PostgreSQL to lock a batch of jobs atomically, ensuring no duplicates.
4. **Execution & Retry:** The worker executes the job payload. On success, it calls `/complete`. On failure, it calls `/fail`. The API evaluates the retry policy, either pushing the `run_at` timestamp forward (exponential backoff) or moving it to the Dead Letter Queue.
