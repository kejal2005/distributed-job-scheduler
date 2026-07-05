# Database Design & ER Diagram

## Entity-Relationship Diagram

```mermaid
erDiagram
    USERS ||--o{ PROJECTS : owns
    PROJECTS ||--o{ QUEUES : contains
    PROJECTS ||--o{ WORKERS : registers
    PROJECTS ||--o{ SCHEDULES : configures
    QUEUES ||--o{ JOBS : holds
    WORKERS ||--o{ JOBS : executes

    USERS {
        uuid id PK
        string name
        string email
        string password_hash
    }

    PROJECTS {
        uuid id PK
        uuid user_id FK
        string name
        string api_key
    }

    QUEUES {
        uuid id PK
        uuid project_id FK
        string name
        boolean is_paused
    }

    JOBS {
        uuid id PK
        uuid project_id FK
        uuid queue_id FK
        string name
        jsonb payload
        string status
        int priority
        int attempt_count
        int max_retries
        timestamp run_at
        timestamp locked_at
        uuid locked_by FK
    }

    WORKERS {
        uuid id PK
        uuid project_id FK
        string hostname
        int active_jobs
        timestamp last_seen
    }
```

## Performance & Normalization Considerations
- **Concurrency Control:** The `jobs` table uses `locked_at` and `locked_by` to track ownership. Using Postgres row-level locks prevents duplicate processing.
- **Indexes:** B-Tree indexes are heavily utilized on `(project_id, queue_id, status, run_at)` to optimize the `FOR UPDATE SKIP LOCKED` query, ensuring rapid job fetching even with millions of rows.
- **Cascading Behavior:** Foreign keys from `jobs` to `projects` are set up with `ON DELETE CASCADE` to ensure data integrity when tenants are removed.
