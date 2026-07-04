// ===================== State =====================
const state = {
  user: null,
  projects: [],
  currentProject: null,
  queues: [],
  selectedQueue: null,
  retryPolicies: [],
  ws: null,
  throughputChart: null,
};

// ===================== Helpers =====================
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
function fmtTime(iso) { return iso ? new Date(iso).toLocaleString(undefined, { hour12: false }) : '—'; }
function fmtShortTime(iso) { return iso ? new Date(iso).toLocaleTimeString(undefined, { hour12: false }) : '—'; }
function shortId(id) { return id ? id.slice(0, 8) : '—'; }

function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function openModal(html) {
  $('#modal-box').innerHTML = html;
  $('#modal-backdrop').classList.remove('hidden');
}
function closeModal() {
  $('#modal-backdrop').classList.add('hidden');
  $('#modal-box').innerHTML = '';
}
$('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });

function streamLine(cls, text) {
  const stream = $('#job-stream');
  if (stream.querySelector('.stream-muted')) stream.innerHTML = '';
  const line = document.createElement('div');
  line.className = 'stream-line';
  line.innerHTML = `<span class="ts">${fmtShortTime(new Date().toISOString())}</span><span class="${cls}">${text}</span>`;
  stream.appendChild(line);
  stream.scrollTop = stream.scrollHeight;
  while (stream.children.length > 60) stream.removeChild(stream.firstChild);
}

// ===================== Auth =====================
$all('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $all('.auth-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    $('#login-form').classList.toggle('hidden', tab.dataset.tab !== 'login');
    $('#register-form').classList.toggle('hidden', tab.dataset.tab !== 'register');
  });
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const { user, token } = await Api.login($('#login-email').value, $('#login-password').value);
    onAuthed(user, token);
  } catch (err) { $('#login-error').textContent = err.message; }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#register-error').textContent = '';
  try {
    const { user, token } = await Api.register($('#register-email').value, $('#register-password').value, $('#register-name').value);
    onAuthed(user, token);
  } catch (err) { $('#register-error').textContent = err.message; }
});

$('#logout-btn').addEventListener('click', () => {
  localStorage.removeItem('scheduler_token');
  location.reload();
});

async function onAuthed(user, token) {
  state.user = user;
  Api.token = token;
  localStorage.setItem('scheduler_token', token);
  $('#auth-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  $('#user-chip').textContent = user.email;
  await loadProjects();
}

// ===================== Projects =====================
async function loadProjects() {
  const { projects } = await Api.listProjects();
  state.projects = projects;
  const select = $('#project-select');
  select.innerHTML = projects.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');

  if (projects.length === 0) {
    return promptCreateProject();
  }
  await selectProject(projects[0].id);
}

async function selectProject(projectId) {
  state.currentProject = state.projects.find((p) => p.id === projectId);
  $('#project-select').value = projectId;
  $('#api-key-value').textContent = state.currentProject.api_key;
  Api.apiKey = state.currentProject.api_key;
  connectWebSocket();
  await Promise.all([loadRetryPolicies(), loadQueues()]);
  await refreshCurrentView();
}

$('#project-select').addEventListener('change', (e) => selectProject(e.target.value));

$('#new-project-btn').addEventListener('click', () => promptCreateProject());

function promptCreateProject() {
  openModal(`
    <h3>New project</h3>
    <form class="modal-form" id="form-new-project">
      <label>Organization name<input type="text" id="np-org" placeholder="e.g. Acme Inc" required /></label>
      <label>Project name<input type="text" id="np-name" placeholder="e.g. Production" required /></label>
      <p class="modal-error" id="np-error"></p>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Create</button>
      </div>
    </form>
  `);
  $('#form-new-project').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { organization } = await Api.createOrganization($('#np-org').value);
      const { project } = await Api.createProject(organization.id, $('#np-name').value);
      state.projects.push(project);
      closeModal();
      await loadProjects();
      toast('Project created', 'success');
    } catch (err) { $('#np-error').textContent = err.message; }
  });
}

$('#api-key-chip').addEventListener('click', () => {
  navigator.clipboard.writeText(state.currentProject.api_key);
  toast('API key copied to clipboard', 'success');
});

// ===================== Navigation =====================
$all('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    $all('.nav-item').forEach((i) => i.classList.remove('active'));
    item.classList.add('active');
    $all('.view').forEach((v) => v.classList.add('hidden'));
    $(`#view-${item.dataset.view}`).classList.remove('hidden');
    refreshCurrentView();
  });
});

function currentView() {
  return $('.nav-item.active').dataset.view;
}

async function refreshCurrentView() {
  if (!state.currentProject) return;
  const view = currentView();
  try {
    if (view === 'overview') await renderOverview();
    else if (view === 'queues') await renderQueues();
    else if (view === 'workers') await renderWorkers();
    else if (view === 'dlq') await renderDlq();
    else if (view === 'schedules') await renderSchedules();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ===================== Overview =====================
async function renderOverview() {
  const [{ statusCounts, onlineWorkers, throughputByHour }, { queueHealth }] = await Promise.all([
    Api.overview(state.currentProject.id),
    Api.health(state.currentProject.id),
  ]);

  const counts = Object.fromEntries(statusCounts.map((s) => [s.status, s.count]));
  const pending = (counts.queued || 0) + (counts.scheduled || 0) + (counts.claimed || 0);
  $('#stat-pending').textContent = pending;
  $('#stat-running').textContent = counts.running || 0;
  $('#stat-completed').textContent = counts.completed || 0;
  $('#stat-dead').textContent = counts.dead_letter || 0;
  $('#stat-workers').textContent = onlineWorkers;

  renderThroughputChart(throughputByHour);

  const tbody = $('#health-table tbody');
  tbody.innerHTML = queueHealth.map((q) => `
    <tr>
      <td>${escapeHtml(q.name)}</td>
      <td class="mono">${q.pending}</td>
      <td class="mono">${q.running}</td>
      <td class="mono">${q.dead_letter}</td>
      <td class="mono">${q.avg_duration_seconds ? Number(q.avg_duration_seconds).toFixed(2) + 's' : '—'}</td>
      <td>${q.is_paused ? '<span class="badge badge-dead_letter">paused</span>' : '<span class="badge badge-online">active</span>'}</td>
    </tr>
  `).join('') || `<tr><td colspan="6" class="empty-state">No queues yet.</td></tr>`;
}

function renderThroughputChart(data) {
  const hours = [];
  const now = new Date();
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600 * 1000);
    hours.push(d.toISOString().slice(0, 13));
  }
  const map = Object.fromEntries(data.map((d) => [new Date(d.hour).toISOString().slice(0, 13), d.completed]));
  const values = hours.map((h) => map[h] || 0);
  const labels = hours.map((h) => h.slice(11, 13) + ':00');

  const ctx = document.getElementById('throughput-chart');
  if (state.throughputChart) state.throughputChart.destroy();
  state.throughputChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: '#2DD4E8',
        backgroundColor: 'rgba(45,212,232,0.08)',
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#4B5563', font: { family: 'IBM Plex Mono', size: 10 } }, grid: { color: '#1B212B' } },
        y: { ticks: { color: '#4B5563', font: { family: 'IBM Plex Mono', size: 10 } }, grid: { color: '#1B212B' }, beginAtZero: true },
      },
    },
  });
}

// ===================== Queues =====================
async function loadQueues() {
  const { queues } = await Api.listQueues(state.currentProject.id);
  state.queues = queues;
}

async function loadRetryPolicies() {
  const { retryPolicies } = await Api.listRetryPolicies(state.currentProject.id);
  state.retryPolicies = retryPolicies;
}

async function renderQueues() {
  await loadQueues();
  const grid = $('#queue-grid');
  grid.innerHTML = state.queues.map((q) => `
    <div class="queue-card ${state.selectedQueue === q.id ? 'selected' : ''}" data-id="${q.id}">
      <div class="queue-card-top">
        <div class="queue-card-name">${escapeHtml(q.name)}</div>
        <div class="queue-card-priority">P${q.priority}</div>
      </div>
      <div class="queue-card-stats">
        <div class="queue-card-stat"><span class="n">${q.pending_count}</span><span class="l">Pending</span></div>
        <div class="queue-card-stat"><span class="n">${q.running_count}</span><span class="l">Running</span></div>
        <div class="queue-card-stat"><span class="n">${q.dead_letter_count}</span><span class="l">Dead</span></div>
      </div>
      ${q.is_paused ? '<div class="queue-paused-tag">⏸ paused</div>' : ''}
      <div class="modal-actions" style="margin-top:12px;">
        <button class="btn-ghost btn-sm" data-action="toggle-pause" data-id="${q.id}" data-paused="${q.is_paused}">${q.is_paused ? 'Resume' : 'Pause'}</button>
      </div>
    </div>
  `).join('') || `<div class="empty-state">No queues yet. Create one to start submitting jobs.</div>`;

  $all('.queue-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.dataset.action) return;
      selectQueue(card.dataset.id);
    });
  });
  $all('[data-action="toggle-pause"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const paused = btn.dataset.paused === 'true';
      await (paused ? Api.resumeQueue(state.currentProject.id, id) : Api.pauseQueue(state.currentProject.id, id));
      toast(paused ? 'Queue resumed' : 'Queue paused', 'success');
      renderQueues();
    });
  });

  if (state.selectedQueue && state.queues.some((q) => q.id === state.selectedQueue)) {
    renderJobsPanel();
  }
}

function selectQueue(queueId) {
  state.selectedQueue = queueId;
  renderQueues();
  renderJobsPanel();
}

async function renderJobsPanel() {
  const queue = state.queues.find((q) => q.id === state.selectedQueue);
  if (!queue) return;
  $('#jobs-panel').style.display = 'block';
  $('#jobs-panel-title').textContent = `Jobs — ${queue.name}`;
  const status = $('#jobs-status-filter').value;
  const { jobs } = await Api.listJobs(state.currentProject.id, queue.id, status);
  const tbody = $('#jobs-table tbody');
  tbody.innerHTML = jobs.map((j) => `
    <tr>
      <td>${escapeHtml(j.name)}<div class="id-cell">${shortId(j.id)}</div></td>
      <td><span class="badge badge-${j.status}">${j.status}</span></td>
      <td class="mono">${j.priority}</td>
      <td class="mono">${j.attempt_count}</td>
      <td class="mono">${fmtTime(j.run_at)}</td>
      <td class="mono">${fmtTime(j.updated_at)}</td>
      <td>${j.status === 'queued' || j.status === 'scheduled' ? `<button class="btn-ghost btn-sm" data-cancel="${j.id}">Cancel</button>` : ''}</td>
    </tr>
  `).join('') || `<tr><td colspan="7" class="empty-state">No jobs match this filter.</td></tr>`;

  $all('[data-cancel]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await Api.cancelJob(state.currentProject.id, queue.id, btn.dataset.cancel);
      toast('Job cancelled', 'success');
      renderJobsPanel();
    });
  });
}

$('#jobs-status-filter').addEventListener('change', renderJobsPanel);

$('#new-queue-btn').addEventListener('click', () => {
  const policyOptions = state.retryPolicies.map((p) => `<option value="${p.id}">${p.name} (${p.strategy})</option>`).join('');
  openModal(`
    <h3>New queue</h3>
    <form class="modal-form" id="form-new-queue">
      <label>Name<input type="text" id="nq-name" required placeholder="e.g. emails" /></label>
      <label>Priority (higher = served first)<input type="number" id="nq-priority" value="0" /></label>
      <label>Concurrency limit<input type="number" id="nq-concurrency" value="5" min="1" /></label>
      <label>Default retry policy
        <select id="nq-retry"><option value="">None</option>${policyOptions}</select>
      </label>
      <p class="modal-error" id="nq-error"></p>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Create queue</button>
      </div>
    </form>
  `);
  $('#form-new-queue').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await Api.createQueue(state.currentProject.id, {
        name: $('#nq-name').value,
        priority: Number($('#nq-priority').value),
        concurrencyLimit: Number($('#nq-concurrency').value),
        defaultRetryPolicyId: $('#nq-retry').value || undefined,
      });
      closeModal();
      toast('Queue created', 'success');
      renderQueues();
    } catch (err) { $('#nq-error').textContent = err.message; }
  });
});

$('#new-job-btn').addEventListener('click', () => {
  if (!state.selectedQueue) return toast('Select a queue first', 'error');
  const policyOptions = state.retryPolicies.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  openModal(`
    <h3>New job</h3>
    <form class="modal-form" id="form-new-job">
      <label>Name<input type="text" id="nj-name" required placeholder="e.g. send-welcome-email" /></label>
      <label>Payload (JSON)<textarea id="nj-payload">{}</textarea></label>
      <label>Priority<input type="number" id="nj-priority" value="0" /></label>
      <label>Delay (seconds, 0 = immediate)<input type="number" id="nj-delay" value="0" min="0" /></label>
      <label>Retry policy<select id="nj-retry"><option value="">None</option>${policyOptions}</select></label>
      <p class="modal-error" id="nj-error"></p>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Submit job</button>
      </div>
    </form>
  `);
  $('#form-new-job').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      let payload = {};
      try { payload = JSON.parse($('#nj-payload').value || '{}'); } catch { throw new Error('Payload must be valid JSON'); }
      const delaySeconds = Number($('#nj-delay').value);
      await Api.createJob(state.currentProject.id, state.selectedQueue, {
        name: $('#nj-name').value,
        payload,
        priority: Number($('#nj-priority').value),
        ...(delaySeconds > 0 ? { delaySeconds } : {}),
        retryPolicyId: $('#nj-retry').value || undefined,
      });
      closeModal();
      toast('Job submitted', 'success');
      renderJobsPanel();
      renderQueues();
    } catch (err) { $('#nj-error').textContent = err.message; }
  });
});

// ===================== Workers =====================
async function renderWorkers() {
  const { workers } = await Api.listWorkers(state.currentProject.id);
  const tbody = $('#workers-table tbody');
  tbody.innerHTML = workers.map((w) => `
    <tr>
      <td>${escapeHtml(w.hostname)}<div class="id-cell">${shortId(w.id)}</div></td>
      <td><span class="badge badge-${w.status}">${w.status}</span></td>
      <td class="mono">${(w.queues || []).join(', ') || '—'}</td>
      <td class="mono">${w.concurrency}</td>
      <td class="mono">${w.active_job_count}</td>
      <td class="mono">${fmtTime(w.last_seen_at)}</td>
    </tr>
  `).join('') || `<tr><td colspan="6" class="empty-state">No workers have registered yet. Start one with <code>npm run worker</code>.</td></tr>`;
}

// ===================== Dead Letter Queue =====================
async function renderDlq() {
  const { deadLetters } = await Api.listDeadLetters(state.currentProject.id);
  const tbody = $('#dlq-table tbody');
  tbody.innerHTML = deadLetters.map((d) => `
    <tr>
      <td>${escapeHtml(d.job_name)}<div class="id-cell">${shortId(d.job_id)}</div></td>
      <td>${escapeHtml(d.queue_name)}</td>
      <td class="mono">${d.attempt_count}</td>
      <td>${escapeHtml((d.failure_reason || '').slice(0, 80))}</td>
      <td class="mono">${fmtTime(d.moved_at)}</td>
      <td>${d.replayed_at ? '<span class="badge badge-completed">replayed</span>' : `<button class="btn-ghost btn-sm" data-replay="${d.job_id}" data-queue="${d.queue_id}">Replay</button>`}</td>
    </tr>
  `).join('') || `<tr><td colspan="6" class="empty-state">Nothing here — every job has either succeeded or is still retrying.</td></tr>`;

  $all('[data-replay]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await Api.replayJob(state.currentProject.id, btn.dataset.queue, btn.dataset.replay);
      toast('Job re-queued', 'success');
      renderDlq();
    });
  });
}

// ===================== Recurring schedules =====================
async function renderSchedules() {
  await loadQueues();
  const all = [];
  for (const q of state.queues) {
    const { scheduledJobs } = await Api.listSchedules(state.currentProject.id, q.id);
    scheduledJobs.forEach((s) => all.push({ ...s, queueName: q.name }));
  }
  const tbody = $('#schedules-table tbody');
  tbody.innerHTML = all.map((s) => `
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.queueName)}</td>
      <td class="mono">${escapeHtml(s.cron_expression)}</td>
      <td class="mono">${fmtTime(s.next_run_at)}</td>
      <td>${s.is_active ? '<span class="badge badge-online">active</span>' : '<span class="badge badge-cancelled">paused</span>'}</td>
      <td></td>
    </tr>
  `).join('') || `<tr><td colspan="6" class="empty-state">No recurring jobs configured.</td></tr>`;
}

$('#new-schedule-btn').addEventListener('click', async () => {
  await loadQueues();
  const queueOptions = state.queues.map((q) => `<option value="${q.id}">${q.name}</option>`).join('');
  openModal(`
    <h3>New recurring job</h3>
    <form class="modal-form" id="form-new-schedule">
      <label>Queue<select id="ns-queue">${queueOptions}</select></label>
      <label>Name<input type="text" id="ns-name" required placeholder="e.g. nightly-report" /></label>
      <label>Cron expression<input type="text" id="ns-cron" required placeholder="0 2 * * *" /></label>
      <label>Timezone<input type="text" id="ns-tz" value="UTC" /></label>
      <label>Payload template (JSON)<textarea id="ns-payload">{}</textarea></label>
      <p class="modal-error" id="ns-error"></p>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Create schedule</button>
      </div>
    </form>
  `);
  $('#form-new-schedule').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      let payloadTemplate = {};
      try { payloadTemplate = JSON.parse($('#ns-payload').value || '{}'); } catch { throw new Error('Payload must be valid JSON'); }
      await Api.createSchedule(state.currentProject.id, $('#ns-queue').value, {
        name: $('#ns-name').value,
        cronExpression: $('#ns-cron').value,
        timezone: $('#ns-tz').value,
        payloadTemplate,
      });
      closeModal();
      toast('Recurring job scheduled', 'success');
      renderSchedules();
    } catch (err) { $('#ns-error').textContent = err.message; }
  });
});

// ===================== WebSocket live stream =====================
function connectWebSocket() {
  if (state.ws) state.ws.close();
  const wsUrl = API_BASE.replace(/^http/, 'ws').replace(/\/api$/, '') + '/ws';
  const dot = $('.ws-dot'); const label = $('#ws-label');
  try {
    state.ws = new WebSocket(wsUrl);
    state.ws.onopen = () => { dot.className = 'ws-dot connected'; label.textContent = 'live'; };
    state.ws.onclose = () => { dot.className = 'ws-dot'; label.textContent = 'disconnected'; setTimeout(connectWebSocket, 3000); };
    state.ws.onerror = () => { dot.className = 'ws-dot error'; label.textContent = 'error'; };
    state.ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      handleWsEvent(msg);
    };
  } catch (err) { label.textContent = 'unavailable'; }
}

function handleWsEvent(msg) {
  switch (msg.type) {
    case 'connected': return;
    case 'job.created': streamLine('evt-created', `job.created  ${msg.job.name} (${shortId(msg.job.id)})`); break;
    case 'batch.created': streamLine('evt-created', `batch.created  ${msg.count} jobs`); break;
    case 'job.cancelled': streamLine('evt-cancelled', `job.cancelled  ${shortId(msg.job.id)}`); break;
    case 'job.replayed': streamLine('evt-replayed', `job.replayed  ${shortId(msg.job.id)}`); break;
    case 'worker.registered': streamLine('evt-worker', `worker.online  ${msg.worker.hostname}`); break;
    case 'worker.draining': streamLine('evt-worker', `worker.draining  ${msg.worker.hostname}`); break;
    case 'worker.offline': streamLine('evt-worker', `worker.offline  ${msg.worker.hostname}`); break;
    default: streamLine('stream-muted', msg.type);
  }
  if (currentView() === 'overview') scheduleOverviewRefresh();
}

let overviewRefreshTimer = null;
function scheduleOverviewRefresh() {
  clearTimeout(overviewRefreshTimer);
  overviewRefreshTimer = setTimeout(renderOverview, 800);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ===================== Boot =====================
(function boot() {
  const savedToken = localStorage.getItem('scheduler_token');
  if (savedToken) {
    Api.token = savedToken;
    Api.me().then(({ user }) => onAuthed(user, savedToken)).catch(() => localStorage.removeItem('scheduler_token'));
  }
  setInterval(() => { if (state.currentProject) refreshCurrentView(); }, 15000);
})();
