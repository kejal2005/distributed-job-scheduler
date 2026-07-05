# Design Decisions & Trade-offs

## 1. PostgreSQL as a Queue Engine vs. Redis/RabbitMQ
**Decision:** We chose to use PostgreSQL as the central queue engine using `SELECT ... FOR UPDATE SKIP LOCKED` instead of introducing a dedicated message broker like Redis or RabbitMQ.
**Trade-off:** 
- *Pros:* Reduces infrastructural complexity (one database for both metadata and queues), guarantees ACID compliance, and simplifies transactional state changes.
- *Cons:* Slightly lower raw throughput compared to in-memory brokers like Redis, and can cause index bloat under extremely high loads (requires aggressive Postgres vacuuming).

## 2. Multi-Tenant Distributed Workers
**Decision:** Workers are decoupled from the API and authenticate via `PROJECT_API_KEY`.
**Trade-off:**
- *Pros:* Security and isolation. Tenants can host their own execution compute, keeping untrusted job execution out of the Control Plane. Highly scalable.
- *Cons:* Adds operational overhead for clients who just want simple background jobs, as they must manage a separate worker process.

## 3. WebSockets vs. Polling for Live Updates
**Decision:** We implemented a WebSocket hub that broadcasts JSON state events rather than having the dashboard poll the REST API.
**Trade-off:**
- *Pros:* Significantly reduces database load. The UI updates instantly (milliseconds) when a job completes.
- *Cons:* Requires a persistent stateful connection. If the Node.js API was scaled horizontally across multiple instances, a Redis Pub/Sub backplane would be required to sync WebSocket connections across nodes.
