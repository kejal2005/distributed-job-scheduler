-- =====================================================================
-- Distributed Job Scheduler — Core Schema (PostgreSQL 14+)
-- Design notes are in docs/design-decisions.md
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ---------------------------------------------------------------------
-- ORGANIZATIONS / USERS / MEMBERSHIP (multi-tenant, RBAC-ready)
-- ---------------------------------------------------------------------
CREATE TABLE organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(120) NOT NULL,
    slug            VARCHAR(120) NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    name            VARCHAR(120) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Many-to-many: a user can belong to multiple orgs with different roles (RBAC bonus)
CREATE TYPE org_role AS ENUM ('owner', 'admin', 'member', 'viewer');

CREATE TABLE organization_members (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            org_role NOT NULL DEFAULT 'member',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, user_id)
);

-- ---------------------------------------------------------------------
-- PROJECTS — each project owns multiple queues
-- ---------------------------------------------------------------------
CREATE TABLE projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(120) NOT NULL,
    api_key         VARCHAR(64) NOT NULL UNIQUE, -- for worker/service-to-service auth
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);

-- ---------------------------------------------------------------------
-- RETRY POLICIES — reusable, referenced by queues and individually by jobs
-- ---------------------------------------------------------------------
CREATE TYPE retry_strategy AS ENUM ('fixed', 'linear', 'exponential', 'none');

CREATE TABLE retry_policies (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name                VARCHAR(80) NOT NULL,
    strategy            retry_strategy NOT NULL DEFAULT 'exponential',
    max_attempts        INT NOT NULL DEFAULT 5 CHECK (max_attempts >= 0),
    base_delay_seconds  INT NOT NULL DEFAULT 10 CHECK (base_delay_seconds >= 0),
    max_delay_seconds   INT NOT NULL DEFAULT 3600 CHECK (max_delay_seconds >= 0),
    multiplier          NUMERIC(4,2) NOT NULL DEFAULT 2.0, -- used by exponential
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

-- ---------------------------------------------------------------------
-- QUEUES
-- ---------------------------------------------------------------------
CREATE TABLE queues (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name                VARCHAR(120) NOT NULL,
    description         TEXT,
    priority            SMALLINT NOT NULL DEFAULT 0,       -- higher = served first
    concurrency_limit   INT NOT NULL DEFAULT 5 CHECK (concurrency_limit > 0),
    default_retry_policy_id UUID REFERENCES retry_policies(id) ON DELETE SET NULL,
    is_paused           BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

CREATE INDEX idx_queues_project ON queues(project_id);

-- ---------------------------------------------------------------------
-- JOBS — the central entity. Lifecycle: queued -> scheduled -> claimed
--         -> running -> completed | failed -> dead_letter
-- ---------------------------------------------------------------------
CREATE TYPE job_status AS ENUM (
    'queued', 'scheduled', 'claimed', 'running',
    'completed', 'failed', 'dead_letter', 'cancelled'
);
CREATE TYPE job_type AS ENUM ('immediate', 'delayed', 'scheduled', 'recurring', 'batch');

CREATE TABLE jobs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    queue_id            UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    batch_id            UUID, -- self-referential grouping for batch jobs, nullable
    job_type            job_type NOT NULL DEFAULT 'immediate',
    name                VARCHAR(150) NOT NULL,
    payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              job_status NOT NULL DEFAULT 'queued',
    priority            SMALLINT NOT NULL DEFAULT 0,
    run_at              TIMESTAMPTZ NOT NULL DEFAULT now(), -- when it becomes eligible to claim
    cron_expression     VARCHAR(100),                       -- for recurring jobs
    timezone            VARCHAR(64) DEFAULT 'UTC',
    idempotency_key     VARCHAR(150),                        -- caller-supplied, prevents duplicate submission
    retry_policy_id     UUID REFERENCES retry_policies(id) ON DELETE SET NULL,
    max_attempts_override INT,
    attempt_count       INT NOT NULL DEFAULT 0,
    claimed_by_worker_id UUID,
    claimed_at          TIMESTAMPTZ,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    timeout_seconds     INT NOT NULL DEFAULT 300,
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_idempotency UNIQUE (queue_id, idempotency_key)
);

-- The hot-path index: worker polling filters on (queue_id, status, run_at)
-- and orders by priority — this composite index is what makes claiming fast
-- under load instead of degrading into a sequential scan.
CREATE INDEX idx_jobs_claim_scan ON jobs (queue_id, status, run_at)
    WHERE status IN ('queued', 'scheduled');
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_batch ON jobs(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX idx_jobs_cron ON jobs(job_type, run_at) WHERE job_type = 'recurring';
CREATE INDEX idx_jobs_created_at ON jobs(created_at DESC);

-- ---------------------------------------------------------------------
-- WORKERS — worker processes that poll and execute jobs
-- ---------------------------------------------------------------------
CREATE TYPE worker_status AS ENUM ('online', 'offline', 'draining');

CREATE TABLE workers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    hostname        VARCHAR(150) NOT NULL,
    pid             INT,
    queues          TEXT[] NOT NULL DEFAULT '{}', -- names of queues this worker consumes
    status          worker_status NOT NULL DEFAULT 'online',
    concurrency     INT NOT NULL DEFAULT 5,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_workers_project ON workers(project_id);
CREATE INDEX idx_workers_status ON workers(status);

-- Now that `workers` exists, jobs.claimed_by_worker_id can be a real FK.
ALTER TABLE jobs
    ADD CONSTRAINT fk_jobs_claimed_worker
    FOREIGN KEY (claimed_by_worker_id) REFERENCES workers(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- WORKER HEARTBEATS — time-series ping history (append-only, trimmed by a
-- retention job; kept separate from `workers.last_seen_at` so we retain
-- history for the health/throughput charts on the dashboard)
-- ---------------------------------------------------------------------
CREATE TABLE worker_heartbeats (
    id              BIGSERIAL PRIMARY KEY,
    worker_id       UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    reported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    active_jobs     INT NOT NULL DEFAULT 0,
    cpu_percent     NUMERIC(5,2),
    memory_mb       NUMERIC(10,2)
);

CREATE INDEX idx_heartbeats_worker_time ON worker_heartbeats(worker_id, reported_at DESC);

-- ---------------------------------------------------------------------
-- JOB EXECUTIONS — one row per attempt (audit trail; jobs.attempt_count
-- is the denormalized fast-read counter, this table is the source of truth)
-- ---------------------------------------------------------------------
CREATE TYPE execution_result AS ENUM ('success', 'failure', 'timeout', 'cancelled');

CREATE TABLE job_executions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    worker_id       UUID REFERENCES workers(id) ON DELETE SET NULL,
    attempt_number  INT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    duration_ms     INT,
    result          execution_result,
    error_message   TEXT,
    error_stack     TEXT,
    UNIQUE (job_id, attempt_number)
);

CREATE INDEX idx_executions_job ON job_executions(job_id);
CREATE INDEX idx_executions_worker ON job_executions(worker_id);

-- ---------------------------------------------------------------------
-- JOB LOGS — structured log lines emitted during execution (stdout/stderr,
-- lifecycle events). High write volume -> kept lean, indexed for lookup.
-- ---------------------------------------------------------------------
CREATE TYPE log_level AS ENUM ('debug', 'info', 'warn', 'error');

CREATE TABLE job_logs (
    id          BIGSERIAL PRIMARY KEY,
    job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    execution_id UUID REFERENCES job_executions(id) ON DELETE CASCADE,
    level       log_level NOT NULL DEFAULT 'info',
    message     TEXT NOT NULL,
    logged_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_job_logs_job ON job_logs(job_id, logged_at);

-- ---------------------------------------------------------------------
-- SCHEDULED JOBS — the "template" for recurring/cron jobs. Each firing of
-- the cron template spawns a concrete row in `jobs`. Kept separate from
-- `jobs` because a template has no lifecycle/status of its own — it just
-- generates job instances.
-- ---------------------------------------------------------------------
CREATE TABLE scheduled_jobs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    queue_id            UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    name                VARCHAR(150) NOT NULL,
    cron_expression     VARCHAR(100) NOT NULL,
    timezone            VARCHAR(64) NOT NULL DEFAULT 'UTC',
    payload_template    JSONB NOT NULL DEFAULT '{}'::jsonb,
    retry_policy_id     UUID REFERENCES retry_policies(id) ON DELETE SET NULL,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    last_run_at         TIMESTAMPTZ,
    next_run_at         TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (queue_id, name)
);

CREATE INDEX idx_scheduled_jobs_due ON scheduled_jobs(next_run_at) WHERE is_active = true;

-- ---------------------------------------------------------------------
-- DEAD LETTER QUEUE — permanently failed jobs land here for manual
-- inspection / replay. Stores a snapshot so it survives even if the
-- original job row is later purged.
-- ---------------------------------------------------------------------
CREATE TABLE dead_letter_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    queue_id        UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    payload_snapshot JSONB NOT NULL,
    failure_reason  TEXT NOT NULL,
    attempt_count   INT NOT NULL,
    moved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    replayed_at     TIMESTAMPTZ,
    replayed_by     UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_dlq_queue ON dead_letter_queue(queue_id);
CREATE INDEX idx_dlq_unreplayed ON dead_letter_queue(moved_at) WHERE replayed_at IS NULL;

-- ---------------------------------------------------------------------
-- WORKFLOW DEPENDENCIES (bonus) — DAG edges between jobs; a job only
-- becomes eligible once all its dependencies are 'completed'.
-- ---------------------------------------------------------------------
CREATE TABLE job_dependencies (
    job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    depends_on_job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    PRIMARY KEY (job_id, depends_on_job_id),
    CHECK (job_id <> depends_on_job_id)
);

-- ---------------------------------------------------------------------
-- updated_at auto-touch trigger (applied to mutable tables)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_queues_updated BEFORE UPDATE ON queues
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_jobs_updated BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
