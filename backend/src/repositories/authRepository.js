const { query } = require('../config/db');

async function createUser({ email, passwordHash, name }) {
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id, email, name, created_at`,
    [email, passwordHash, name]
  );
  return rows[0];
}

async function findUserByEmail(email) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0];
}

async function findUserById(id) {
  const { rows } = await query('SELECT id, email, name, created_at FROM users WHERE id = $1', [id]);
  return rows[0];
}

async function createOrganization({ name, slug, ownerId }) {
  const { rows } = await query(
    `INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING *`,
    [name, slug]
  );
  const org = rows[0];
  await query(
    `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'owner')`,
    [org.id, ownerId]
  );
  return org;
}

async function getUserRoleInOrg(userId, organizationId) {
  const { rows } = await query(
    `SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2`,
    [userId, organizationId]
  );
  return rows[0]?.role || null;
}

async function createProject({ organizationId, name, apiKey, createdBy }) {
  const { rows } = await query(
    `INSERT INTO projects (organization_id, name, api_key, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
    [organizationId, name, apiKey, createdBy]
  );
  return rows[0];
}

async function findProjectById(id) {
  const { rows } = await query('SELECT * FROM projects WHERE id = $1', [id]);
  return rows[0];
}

async function findProjectByApiKey(apiKey) {
  const { rows } = await query('SELECT * FROM projects WHERE api_key = $1', [apiKey]);
  return rows[0];
}

async function listProjectsForUser(userId) {
  const { rows } = await query(
    `SELECT p.* FROM projects p
     JOIN organization_members om ON om.organization_id = p.organization_id
     WHERE om.user_id = $1 ORDER BY p.created_at DESC`,
    [userId]
  );
  return rows;
}

module.exports = {
  createUser, findUserByEmail, findUserById,
  createOrganization, getUserRoleInOrg,
  createProject, findProjectById, findProjectByApiKey, listProjectsForUser,
};
