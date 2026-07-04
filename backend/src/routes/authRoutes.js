const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { asyncHandler, ApiError } = require('../middleware/errorHandler');
const { validate, registerSchema, loginSchema, createOrgSchema, createProjectSchema } = require('../utils/validation');
const { signToken, requireAuth } = require('../middleware/auth');
const repo = require('../repositories/authRepository');

const router = express.Router();

router.post('/register', validate(registerSchema), asyncHandler(async (req, res) => {
  const { email, password, name } = req.validated;
  const existing = await repo.findUserByEmail(email);
  if (existing) throw new ApiError(409, 'Email already registered');
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await repo.createUser({ email, passwordHash, name });
  const token = signToken(user);
  res.status(201).json({ user, token });
}));

router.post('/login', validate(loginSchema), asyncHandler(async (req, res) => {
  const { email, password } = req.validated;
  const user = await repo.findUserByEmail(email);
  if (!user) throw new ApiError(401, 'Invalid credentials');
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new ApiError(401, 'Invalid credentials');
  const token = signToken(user);
  res.json({ user: { id: user.id, email: user.email, name: user.name }, token });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await repo.findUserById(req.user.id);
  if (!user) throw new ApiError(404, 'User not found');
  res.json({ user });
}));

router.post('/organizations', requireAuth, validate(createOrgSchema), asyncHandler(async (req, res) => {
  const { name } = req.validated;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + uuidv4().slice(0, 6);
  const org = await repo.createOrganization({ name, slug, ownerId: req.user.id });
  res.status(201).json({ organization: org });
}));

router.post('/projects', requireAuth, validate(createProjectSchema), asyncHandler(async (req, res) => {
  const { organizationId, name } = req.validated;
  const role = await repo.getUserRoleInOrg(req.user.id, organizationId);
  if (!role) throw new ApiError(403, 'You are not a member of this organization');
  const apiKey = 'jsk_' + uuidv4().replace(/-/g, '');
  const project = await repo.createProject({ organizationId, name, apiKey, createdBy: req.user.id });
  res.status(201).json({ project });
}));

router.get('/projects', requireAuth, asyncHandler(async (req, res) => {
  const projects = await repo.listProjectsForUser(req.user.id);
  res.json({ projects });
}));

module.exports = router;
