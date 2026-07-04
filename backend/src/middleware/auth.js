const jwt = require('jsonwebtoken');
const { findProjectByApiKey } = require('../repositories/authRepository');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

/** Requires a valid JWT (dashboard / human users). */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Requires a valid project API key (worker / programmatic clients). */
async function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing X-API-Key header' });
  const project = await findProjectByApiKey(key);
  if (!project) return res.status(401).json({ error: 'Invalid API key' });
  req.project = project;
  next();
}

/** Accepts either a JWT or an API key -- used on routes both the dashboard and workers call. */
async function requireAuthOrApiKey(req, res, next) {
  if (req.headers['x-api-key']) return requireApiKey(req, res, next);
  return requireAuth(req, res, next);
}

/** Role-based access control (bonus feature). Usage: requireRole('admin') */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.membershipRole || !allowedRoles.includes(req.membershipRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { signToken, requireAuth, requireApiKey, requireAuthOrApiKey, requireRole, JWT_SECRET };
