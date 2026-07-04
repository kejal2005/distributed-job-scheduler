/**
 * Resolve which project the current request is scoped to.
 * - If authenticated via API key, req.project is already set (one key = one project).
 * - If authenticated via JWT (dashboard user), the project comes from the :projectId route param,
 *   and we don't re-verify org membership here for brevity -- see docs/design-decisions.md
 *   ("Authorization scope" section) for the trade-off this makes.
 */
async function resolveProjectId(req) {
  if (req.project) return req.project.id;
  if (req.params.projectId) return req.params.projectId;
  const err = new Error('Unable to resolve project context');
  err.statusCode = 400;
  throw err;
}

module.exports = { resolveProjectId };
