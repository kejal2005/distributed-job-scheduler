const { query } = require('../config/db');

async function createQueue(data) {
  const { projectId, name, description, priority, concurrencyLimit, defaultRetryPolicyId } = data;
  const { rows } = await query(
    `INSERT INTO queues (project_id, name, description, priority, concurrency_limit, default_retry_policy_id)
     VALUES ($1,$2,$3,COALESCE($4,0),COALESCE($5,5),$6) RETURNING *`,
    [projectId, name, description, priority, concurrencyLimit, defaultRetryPolicyId]
  );
  return rows[0];
}

async function listQueuesByProject(projectId) {
  const { rows } = await query(
    `SELECT q.*,
        (SELECT count(*) FROM jobs j WHERE j.queue_id = q.id AND j.status IN ('queued','scheduled')) AS pending_count,
        (SELECT count(*) FROM jobs j WHERE j.queue_id = q.id AND j.status = 'running') AS running_count,
        (SELECT count(*) FROM jobs j WHERE j.queue_id = q.id AND j.status = 'completed') AS completed_count,
        (SELECT count(*) FROM jobs j WHERE j.queue_id = q.id AND j.status = 'dead_letter') AS dead_letter_count
     FROM queues q WHERE q.project_id = $1 ORDER BY q.priority DESC, q.created_at ASC`,
    [projectId]
  );
  return rows;
}

async function findQueueById(id) {
  const { rows } = await query('SELECT * FROM queues WHERE id = $1', [id]);
  return rows[0];
}

async function updateQueue(id, fields) {
  const allowed = ['name', 'description', 'priority', 'concurrency_limit', 'default_retry_policy_id', 'is_paused'];
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(fields)) {
    const col = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
    if (allowed.includes(col)) {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (sets.length === 0) return findQueueById(id);
  params.push(id);
  const { rows } = await query(
    `UPDATE queues SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return rows[0];
}

async function setPaused(id, isPaused) {
  const { rows } = await query('UPDATE queues SET is_paused = $2 WHERE id = $1 RETURNING *', [id, isPaused]);
  return rows[0];
}

async function queueStats(queueId) {
  const { rows } = await query(
    `SELECT status, count(*)::int AS count FROM jobs WHERE queue_id = $1 GROUP BY status`,
    [queueId]
  );
  return rows;
}

async function createRetryPolicy(data) {
  const { projectId, name, strategy, maxAttempts, baseDelaySeconds, maxDelaySeconds, multiplier } = data;
  const { rows } = await query(
    `INSERT INTO retry_policies (project_id, name, strategy, max_attempts, base_delay_seconds, max_delay_seconds, multiplier)
     VALUES ($1,$2,COALESCE($3::retry_strategy,'exponential'::retry_strategy),COALESCE($4,5),COALESCE($5,10),COALESCE($6,3600),COALESCE($7,2.0))
     RETURNING *`,
    [projectId, name, strategy, maxAttempts, baseDelaySeconds, maxDelaySeconds, multiplier]
  );
  return rows[0];
}

async function listRetryPolicies(projectId) {
  const { rows } = await query('SELECT * FROM retry_policies WHERE project_id = $1 ORDER BY created_at', [projectId]);
  return rows;
}

module.exports = {
  createQueue, listQueuesByProject, findQueueById, updateQueue, setPaused, queueStats,
  createRetryPolicy, listRetryPolicies,
};
