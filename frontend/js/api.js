const API_BASE = window.SCHEDULER_API_BASE || 'http://localhost:4000/api';

const Api = {
  token: null,
  apiKey: null,

  async request(path, { method = 'GET', body, useApiKey = false } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (useApiKey && this.apiKey) headers['X-API-Key'] = this.apiKey;
    else if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const isJson = res.headers.get('content-type')?.includes('application/json');
    const data = isJson ? await res.json() : null;
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.details = data && data.details;
      throw err;
    }
    return data;
  },

  register: (email, password, name) => Api.request('/auth/register', { method: 'POST', body: { email, password, name } }),
  login: (email, password) => Api.request('/auth/login', { method: 'POST', body: { email, password } }),
  me: () => Api.request('/auth/me'),
  createOrganization: (name) => Api.request('/auth/organizations', { method: 'POST', body: { name } }),
  createProject: (organizationId, name) => Api.request('/auth/projects', { method: 'POST', body: { organizationId, name } }),
  listProjects: () => Api.request('/auth/projects'),

  listQueues: (projectId) => Api.request(`/projects/${projectId}/queues`, { useApiKey: true }),
  createQueue: (projectId, body) => Api.request(`/projects/${projectId}/queues`, { method: 'POST', body, useApiKey: true }),
  pauseQueue: (projectId, queueId) => Api.request(`/projects/${projectId}/queues/${queueId}/pause`, { method: 'POST', useApiKey: true }),
  resumeQueue: (projectId, queueId) => Api.request(`/projects/${projectId}/queues/${queueId}/resume`, { method: 'POST', useApiKey: true }),

  listRetryPolicies: (projectId) => Api.request(`/projects/${projectId}/retry-policies`, { useApiKey: true }),
  createRetryPolicy: (projectId, body) => Api.request(`/projects/${projectId}/retry-policies`, { method: 'POST', body, useApiKey: true }),

  listJobs: (projectId, queueId, status) =>
    Api.request(`/projects/${projectId}/queues/${queueId}/jobs${status ? `?status=${status}` : ''}`, { useApiKey: true }),
  createJob: (projectId, queueId, body) => Api.request(`/projects/${projectId}/queues/${queueId}/jobs`, { method: 'POST', body, useApiKey: true }),
  cancelJob: (projectId, queueId, jobId) => Api.request(`/projects/${projectId}/queues/${queueId}/jobs/${jobId}/cancel`, { method: 'POST', useApiKey: true }),
  replayJob: (projectId, queueId, jobId) => Api.request(`/projects/${projectId}/queues/${queueId}/jobs/${jobId}/replay`, { method: 'POST', useApiKey: true }),

  listWorkers: (projectId) => Api.request(`/projects/${projectId}/workers`, { useApiKey: true }),
  listDeadLetters: (projectId) => Api.request(`/projects/${projectId}/dead-letter-queue`, { useApiKey: true }),
  overview: (projectId) => Api.request(`/projects/${projectId}/dashboard/overview`, { useApiKey: true }),
  health: (projectId) => Api.request(`/projects/${projectId}/dashboard/health`, { useApiKey: true }),

  listSchedules: (projectId, queueId) => Api.request(`/projects/${projectId}/queues/${queueId}/scheduled-jobs`, { useApiKey: true }),
  createSchedule: (projectId, queueId, body) =>
    Api.request(`/projects/${projectId}/queues/${queueId}/scheduled-jobs`, { method: 'POST', body, useApiKey: true }),
};
