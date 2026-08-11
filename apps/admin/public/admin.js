const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  health: null,
  capabilities: null,
  workspace: null,
  delivery: null,
  routines: null,
  runs: [],
  bindings: [],
  selectedProjectId: null,
  selectedRoutineId: null,
  selectedRunId: null,
  runFilter: '',
  memoryScope: 'project',
  memoryProjectId: null,
  testProjectId: null,
  projectDirty: false,
  routineDirty: false,
};

const viewCopy = {
  overview: { eyebrow: 'Workspace', title: 'Overview' },
  projects: { eyebrow: 'Routing and access', title: 'Projects' },
  routines: { eyebrow: 'Proactive work', title: 'Routines' },
  activity: { eyebrow: 'Runs and delivery', title: 'Activity' },
  memory: { eyebrow: 'Scoped context', title: 'Memory' },
};

let toastTimer;
let refreshInFlight = false;

async function getJson(url, options) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : { message: await response.text() };
  if (!response.ok) {
    throw new Error(data.message || data.error || response.statusText);
  }
  return data;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusLabel(value) {
  if (!value) return 'Unknown';
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statePill(value, label = statusLabel(value)) {
  return element('span', `state-pill ${value || 'planned'}`, label);
}

function formatTime(value, includeDate = false) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    ...(includeDate ? { month: 'short', day: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function shortId(value) {
  if (!value) return 'unknown';
  if (value.startsWith('routine:')) return `routine:${value.slice(-6)}`;
  return value.slice(0, 8);
}

function initials(value) {
  return (value || 'OT')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
}

function showToast(message, tone = 'default') {
  const toast = $('#toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = tone === 'error' ? 'toast error' : 'toast';
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function setButtonBusy(button, busy, busyLabel, idleLabel) {
  button.disabled = busy;
  button.textContent = busy ? busyLabel : idleLabel;
}

function currentWorkspaceId() {
  return state.workspace?.workspace?.workspace?.id || 'dev-workspace';
}

function projectMatches(project, value) {
  return value === project?.projectId || value === project?.id;
}

function projectById(value) {
  return (state.workspace?.projects || []).find((project) =>
    projectMatches(project, value),
  );
}

function selectedProject() {
  return projectById(state.selectedProjectId);
}

function showView(view, updateHash = true) {
  const next = viewCopy[view] ? view : 'overview';
  for (const panel of $$('[data-view-panel]')) {
    panel.hidden = panel.dataset.viewPanel !== next;
  }
  for (const button of $$('[data-view]')) {
    button.classList.toggle('active', button.dataset.view === next);
  }
  $('#view-eyebrow').textContent = viewCopy[next].eyebrow;
  $('#view-title').textContent = viewCopy[next].title;
  if (updateHash) history.replaceState(null, '', `#${next}`);
  if (next === 'memory') void refreshMemory();
}

function renderHealth() {
  const health = $('#health');
  const online = Boolean(state.health?.ok);
  health.classList.toggle('online', online);
  health.innerHTML = '<i></i>';
  health.append(document.createTextNode(online ? ' Online' : ' Offline'));

  const worker = state.health?.worker;
  $('#runtime-label').textContent = worker
    ? `${worker.mode} worker / ${worker.activeRuns || 0} active`
    : 'Runtime unavailable';
}

function renderWorkspaceHeader() {
  const workspace = state.workspace?.workspace?.workspace;
  $('#workspace-name').textContent = workspace?.name || 'OpenTag Workspace';
  $('#workspace-id').textContent = workspace?.id || 'dev-workspace';
  $('#project-count').textContent = String(state.workspace?.projects?.length || 0);
  $('#routine-count').textContent = String(state.routines?.routines?.length || 0);
  const runSummary = state.delivery?.summary?.agentRuns || {};
  $('#active-count').textContent = String(
    (runSummary.queued || 0) +
      (runSummary.running || 0) +
      (runSummary.cancel_requested || 0),
  );
  const transport = state.capabilities?.larkTransport?.mode || 'memory';
  const workerMode = state.capabilities?.runWorker?.mode || 'manual';
  const executorMode = state.capabilities?.executorRuntime?.mode || 'dry-run';
  $('#runtime-label').textContent = `${transport} / ${executorMode} / ${workerMode}`;
}

function metric(value, label) {
  const node = element('div', 'summary-metric');
  node.append(element('strong', '', String(value)), element('span', '', label));
  return node;
}

function renderSummary() {
  const summary = $('#summary-strip');
  const projects = state.workspace?.projects || [];
  const clients = state.capabilities?.clients || [];
  const runs = state.delivery?.summary?.agentRuns || {};
  const outbox = state.delivery?.summary?.outbox || {};
  const active =
    (runs.queued || 0) + (runs.running || 0) + (runs.cancel_requested || 0);
  const failures =
    (runs.failed || 0) +
    (outbox.failed || 0) +
    (state.routines?.summary?.executions?.failed || 0);
  summary.replaceChildren(
    metric(projects.length, 'Projects'),
    metric(clients.filter((client) => client.status !== 'planned').length, 'Active clients'),
    metric(active, 'Active runs'),
    metric(failures, 'Needs attention'),
  );
}

function projectRunState(project) {
  const summary = project.runSummary || {};
  if ((summary.running || 0) + (summary.queued || 0) > 0) return 'running';
  if ((summary.failed || 0) > 0) return 'failed';
  return 'ready';
}

function renderOverviewProjects() {
  const root = $('#overview-projects');
  root.replaceChildren();
  const projects = state.workspace?.projects || [];
  if (!projects.length) {
    root.append(element('div', 'empty-state', 'No projects'));
    return;
  }
  for (const project of projects) {
    const card = element('article', 'project-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const head = element('div', 'project-card-head');
    const identity = element('div', 'project-card-head');
    identity.append(
      element('span', 'avatar', initials(project.identity?.displayName)),
      element('strong', '', project.name),
    );
    head.append(identity, statePill(projectRunState(project)));

    const body = element('div', 'project-card-body');
    body.append(
      element('span', '', project.identity?.displayName || 'OpenTag'),
      element(
        'span',
        '',
        `${statusLabel(project.identity?.defaultExecutorId)} / ${project.grants?.length || 0} tools`,
      ),
      element(
        'span',
        '',
        project.clients?.length ? project.clients.join(', ') : 'No client binding',
      ),
    );

    const foot = element('div', 'project-card-foot');
    foot.append(
      element('span', '', `${project.bindingCount || 0} bindings`),
      element('span', '', project.lastRunAt ? formatTime(project.lastRunAt, true) : 'No runs'),
    );
    card.append(head, body, foot);
    const open = () => {
      selectProject(project.projectId);
      showView('projects');
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') open();
    });
    root.append(card);
  }
}

function renderConnectors() {
  const root = $('#connector-list');
  root.replaceChildren();
  for (const client of state.capabilities?.clients || []) {
    const row = element('div', 'connector-row');
    const copy = element('div');
    copy.append(
      element('strong', '', client.label || client.id),
      element('small', '', `${client.inbound || 'not wired'} / ${client.surface || 'no surface'}`),
    );
    row.append(copy, statePill(client.status));
    root.append(row);
  }
}

function renderOverviewRuns() {
  const root = $('#overview-runs');
  root.replaceChildren();
  if (!state.runs.length) {
    root.append(element('div', 'empty-state', 'No runs yet'));
    return;
  }
  for (const run of state.runs.slice(0, 5)) {
    const row = element('div', 'compact-run');
    const copy = element('div');
    copy.append(
      element('strong', '', run.title || run.summary?.split('\n')[0] || shortId(run.id)),
      element('small', '', `${run.projectId || 'general'} / ${formatTime(run.updatedAt, true)}`),
    );
    row.append(copy, statePill(run.status));
    root.append(row);
  }
}

function renderToolGrid(project) {
  const root = $('#tool-grid');
  const selected = new Set((project?.grants || []).map((grant) => grant.kind));
  root.replaceChildren();
  for (const tool of state.workspace?.availableTools || []) {
    const label = element('label', 'tool-option');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = tool.id;
    input.checked = selected.has(tool.id);
    input.addEventListener('change', markProjectDirty);
    label.append(input, element('span', '', tool.label));
    root.append(label);
  }
}

function fillExecutorOptions(selected) {
  const select = $('#agent-executor');
  select.replaceChildren();
  for (const executor of state.workspace?.executors || []) {
    const option = document.createElement('option');
    option.value = executor.id;
    option.textContent = executor.mode
      ? `${executor.label} (${executor.mode})`
      : executor.label;
    option.selected = executor.id === selected;
    select.append(option);
  }
}

function projectBindings(project) {
  return state.bindings.filter(
    (binding) =>
      binding.workspaceId === project?.workspaceId &&
      projectMatches(project, binding.projectId),
  );
}

function renderProjectBindings(project) {
  const root = $('#project-bindings');
  root.replaceChildren();
  const items = project ? projectBindings(project) : [];
  $('#binding-count-label').textContent = `${items.length} bindings`;
  for (const binding of items) {
    const row = element('div', 'binding-row');
    const copy = element('div');
    copy.append(
      element('strong', '', statusLabel(binding.platform)),
      element('small', '', binding.externalId),
    );
    row.append(
      element('span', '', binding.source || 'configured'),
      copy,
      statePill(binding.activationMode || 'mention'),
    );
    root.append(row);
  }
  if (!items.length) root.append(element('div', 'empty-state', 'No channel bindings'));
}

function renderProjectList() {
  const root = $('#project-list');
  root.replaceChildren();
  for (const project of state.workspace?.projects || []) {
    const button = element('button', 'project-list-item');
    button.type = 'button';
    button.classList.toggle('active', projectMatches(project, state.selectedProjectId));
    button.append(
      element('strong', '', project.name),
      element('span', '', `${project.identity?.displayName || 'OpenTag'} / ${project.projectId}`),
    );
    button.addEventListener('click', () => selectProject(project.projectId));
    root.append(button);
  }
}

function fillProjectForm(project) {
  const isNew = !project;
  const fallbackIdentity = state.workspace?.workspace?.identity || {};
  const identity = project?.identity || fallbackIdentity;
  $('#project-editor-title').textContent = project?.name || 'New project';
  $('#project-policy-state').textContent = isNew ? 'Draft' : 'Configured';
  $('#project-policy-state').className = `state-pill ${isNew ? 'planned' : 'ready'}`;
  $('#project-name').value = project?.name || '';
  $('#project-id').value = project?.projectId || '';
  $('#project-id').disabled = !isNew;
  $('#project-description').value = project?.description || '';
  $('#agent-name').value = identity.displayName || 'OpenTag';
  $('#agent-instructions').value = identity.instructions || '';
  $('#agent-id-label').textContent = identity.id || 'new-agent';
  fillExecutorOptions(identity.defaultExecutorId || 'codex');
  $('#network-mode').value = project?.networkPolicy?.mode || 'deny-by-default';
  $('#allowed-hosts').value = (project?.networkPolicy?.allowedHosts || []).join(', ');
  renderToolGrid(project);
  renderProjectBindings(project);
  state.projectDirty = false;
  $('#project-save-state').textContent = 'No unsaved changes';
}

function selectProject(projectId) {
  const project = projectById(projectId);
  state.selectedProjectId = project?.projectId || projectId;
  if (!state.memoryProjectId || project) state.memoryProjectId = project?.projectId || projectId;
  renderProjectList();
  fillProjectForm(project);
  fillProjectSelects();
}

function markProjectDirty() {
  state.projectDirty = true;
  $('#project-save-state').textContent = 'Unsaved changes';
}

function newProject() {
  state.selectedProjectId = '__new__';
  renderProjectList();
  fillProjectForm(null);
  $('#project-id').focus();
}

function currentAgentId() {
  const project = selectedProject();
  if (project?.identity?.id) return project.identity.id;
  const projectId = $('#project-id').value.trim() || 'project';
  return `${projectId}-agent`;
}

async function saveProject(event) {
  event.preventDefault();
  const button = $('#save-project');
  const projectId = $('#project-id').value.trim();
  if (!projectId) {
    showToast('Project ID is required', 'error');
    $('#project-id').focus();
    return;
  }
  setButtonBusy(button, true, 'Saving', 'Save project');
  try {
    await getJson('/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(),
        projectId,
        name: $('#project-name').value.trim() || projectId,
        description: $('#project-description').value,
        agentId: currentAgentId(),
        agentName: $('#agent-name').value.trim() || 'OpenTag',
        instructions: $('#agent-instructions').value,
        executorId: $('#agent-executor').value,
        tools: $$('#tool-grid input:checked').map((input) => input.value),
        networkMode: $('#network-mode').value,
        allowedHosts: $('#allowed-hosts')
          .value.split(',')
          .map((host) => host.trim())
          .filter(Boolean),
        actor: 'admin-console',
      }),
    });
    state.selectedProjectId = projectId;
    await refreshAll({ quiet: true });
    showToast('Project policy saved');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Save project');
  }
}

async function saveBinding() {
  const button = $('#save-binding');
  const project = selectedProject();
  const externalId = $('#binding-external-id').value.trim();
  if (!project || !externalId) {
    showToast('Select a project and enter a channel ID', 'error');
    return;
  }
  setButtonBusy(button, true, 'Binding', 'Bind');
  try {
    await getJson('/v1/bindings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: $('#binding-platform').value,
        externalId,
        channelId: externalId,
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        scope: 'channel',
        source: 'configured',
        activationMode: $('#binding-activation-mode').value,
        requireMention: $('#binding-require-mention').checked,
      }),
    });
    $('#binding-external-id').value = '';
    await refreshAll({ quiet: true });
    showToast('Channel bound');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Binding', 'Bind');
  }
}

function routineById(value) {
  return (state.routines?.routines || []).find((routine) => routine.id === value);
}

function routineScheduleLabel(schedule) {
  if (schedule?.kind === 'daily') {
    return `${schedule.time} daily / ${schedule.timeZone}`;
  }
  return `Every ${schedule?.everyMinutes || 0} min`;
}

function fillRoutineProjectOptions(selectedValue) {
  const select = $('#routine-project');
  select.replaceChildren();
  const workspaceOption = document.createElement('option');
  workspaceOption.value = '';
  workspaceOption.textContent = 'Workspace default';
  workspaceOption.selected = !selectedValue;
  select.append(workspaceOption);
  for (const project of state.workspace?.projects || []) {
    const option = document.createElement('option');
    option.value = project.projectId;
    option.textContent = project.name;
    option.selected = projectMatches(project, selectedValue);
    select.append(option);
  }
}

function updateRoutineScheduleFields() {
  const daily = $('#routine-schedule-kind').value === 'daily';
  $('#routine-interval-field').hidden = daily;
  $('#routine-daily-time-field').hidden = !daily;
  $('#routine-time-zone-field').hidden = !daily;
}

function preferredRoutineBinding(projectId, platform) {
  const project = projectById(projectId);
  const candidates = project
    ? projectBindings(project)
    : state.bindings.filter((binding) => binding.workspaceId === currentWorkspaceId());
  return candidates.find((binding) => binding.platform === platform) || candidates[0];
}

function fillRoutineDestination(force = false) {
  const externalId = $('#routine-external-id');
  if (!force && externalId.value.trim()) return;
  const binding = preferredRoutineBinding(
    $('#routine-project').value,
    $('#routine-platform').value,
  );
  if (!binding) {
    if (force) externalId.value = '';
    return;
  }
  $('#routine-platform').value = binding.platform;
  externalId.value = binding.externalId;
}

function routineExecutions(routineId) {
  return (state.routines?.executions || []).filter(
    (execution) => execution.routineId === routineId,
  );
}

function renderRoutineExecutions(routine) {
  const root = $('#routine-executions');
  root.replaceChildren();
  const executions = routine ? routineExecutions(routine.id) : [];
  $('#routine-execution-count').textContent = `${executions.length} recorded`;
  if (!executions.length) {
    root.append(
      element(
        'div',
        'empty-state',
        routine ? 'No executions yet' : 'Save the routine to create executions',
      ),
    );
    return;
  }
  for (const execution of executions.slice(0, 20)) {
    const row = element('div', 'routine-execution-row');
    const copy = element('div', 'routine-execution-copy');
    copy.append(
      element(
        'strong',
        '',
        `${statusLabel(execution.trigger)} / ${formatTime(execution.scheduledFor, true)}`,
      ),
      element(
        'small',
        '',
        execution.error ||
          execution.summary ||
          (execution.runId ? `Run ${shortId(execution.runId)}` : execution.dedupKey),
      ),
    );
    row.append(
      statePill(execution.status),
      copy,
      element('span', 'routine-execution-time', formatTime(execution.updatedAt, true)),
    );
    if (execution.runId) {
      const open = element('button', 'routine-run-link', 'Open run');
      open.type = 'button';
      open.addEventListener('click', () => void openRoutineRun(execution.runId));
      row.append(open);
    } else {
      row.append(element('span', 'routine-execution-time', 'Not queued'));
    }
    root.append(row);
  }
}

async function openRoutineRun(runId) {
  try {
    const data = await getJson('/v1/runs?limit=50');
    state.runs = data.runs || [];
    state.selectedRunId = runId;
    showView('activity');
    renderRunTable();
    await openRun(runId);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderRoutineList() {
  const root = $('#routine-list');
  root.replaceChildren();
  const routines = state.routines?.routines || [];
  if (!routines.length) {
    root.append(element('div', 'empty-state', 'No routines configured'));
    return;
  }
  for (const routine of routines) {
    const project = projectById(routine.projectId);
    const button = element('button', 'project-list-item');
    button.type = 'button';
    button.classList.toggle('active', routine.id === state.selectedRoutineId);
    button.append(
      element('strong', '', routine.name),
      element(
        'span',
        '',
        `${routine.enabled ? 'Enabled' : 'Disabled'} / ${project?.name || 'Workspace'} / ${routineScheduleLabel(routine.schedule)}`,
      ),
    );
    button.addEventListener('click', () => selectRoutine(routine.id));
    root.append(button);
  }
}

function fillRoutineForm(routine) {
  const isNew = !routine;
  const defaultProjectId = state.workspace?.projects?.[0]?.projectId || '';
  const projectId = routine?.projectId || (isNew ? defaultProjectId : '');
  $('#routine-editor-title').textContent = routine?.name || 'New routine';
  $('#routine-state').textContent = isNew
    ? 'Draft'
    : routine.enabled
      ? 'Enabled'
      : 'Disabled';
  $('#routine-state').className = `state-pill ${isNew ? 'planned' : routine.enabled ? 'enabled' : 'disabled'}`;
  $('#routine-name').value = routine?.name || '';
  fillRoutineProjectOptions(projectId);
  $('#routine-instructions').value = routine?.instructions || '';
  $('#routine-enabled').checked = routine?.enabled ?? true;
  $('#routine-schedule-kind').value = routine?.schedule?.kind || 'interval';
  $('#routine-every-minutes').value =
    routine?.schedule?.kind === 'interval' ? routine.schedule.everyMinutes : 60;
  $('#routine-daily-time').value =
    routine?.schedule?.kind === 'daily' ? routine.schedule.time : '09:00';
  $('#routine-time-zone').value =
    routine?.schedule?.kind === 'daily' ? routine.schedule.timeZone : 'Asia/Shanghai';
  updateRoutineScheduleFields();
  $('#routine-platform').value = routine?.destination?.platform || 'lark';
  $('#routine-external-id').value = routine?.destination?.externalId || '';
  $('#routine-visibility').value = routine?.destination?.visibility || 'public';
  $('#routine-thread-id').value = routine?.destination?.threadId || '';
  if (isNew) fillRoutineDestination();
  $('#routine-next-run').textContent = routine?.nextRunAt
    ? `Next ${formatTime(routine.nextRunAt, true)}`
    : 'Not scheduled';
  $('#delete-routine').hidden = isNew;
  $('#trigger-routine').disabled = isNew;
  renderRoutineExecutions(routine);
  state.routineDirty = false;
  $('#routine-save-state').textContent = isNew ? 'New routine' : 'No unsaved changes';
}

function selectRoutine(routineId) {
  if (state.routineDirty && !window.confirm('Discard unsaved routine changes?')) return;
  state.selectedRoutineId = routineId;
  renderRoutineList();
  fillRoutineForm(routineById(routineId));
}

function newRoutine() {
  if (state.routineDirty && !window.confirm('Discard unsaved routine changes?')) return;
  state.selectedRoutineId = '__new__';
  renderRoutineList();
  fillRoutineForm(null);
  $('#routine-name').focus();
}

function markRoutineDirty() {
  state.routineDirty = true;
  $('#routine-save-state').textContent = 'Unsaved changes';
  $('#trigger-routine').disabled = true;
}

function routinePayload() {
  const kind = $('#routine-schedule-kind').value;
  const everyMinutes = Number($('#routine-every-minutes').value);
  const name = $('#routine-name').value.trim();
  const instructions = $('#routine-instructions').value.trim();
  const externalId = $('#routine-external-id').value.trim();
  if (!name || !instructions || !externalId) {
    throw new Error('Name, instructions, and channel ID are required');
  }
  if (kind === 'interval' && (!Number.isFinite(everyMinutes) || everyMinutes < 1)) {
    throw new Error('Interval must be at least one minute');
  }
  const existing = routineById(state.selectedRoutineId);
  return {
    id: existing?.id,
    workspaceId: currentWorkspaceId(),
    projectId: $('#routine-project').value || undefined,
    name,
    instructions,
    enabled: $('#routine-enabled').checked,
    schedule:
      kind === 'daily'
        ? {
            kind,
            time: $('#routine-daily-time').value,
            timeZone: $('#routine-time-zone').value.trim(),
          }
        : { kind, everyMinutes },
    destination: {
      platform: $('#routine-platform').value,
      externalId,
      channelId: externalId,
      threadId: $('#routine-thread-id').value.trim() || undefined,
      visibility: $('#routine-visibility').value,
      title: name,
    },
    actor: 'admin-console',
  };
}

async function saveRoutine(event) {
  event.preventDefault();
  const button = $('#save-routine');
  setButtonBusy(button, true, 'Saving', 'Save routine');
  try {
    const data = await getJson('/v1/routines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(routinePayload()),
    });
    state.routines = data.routines;
    state.selectedRoutineId = data.routine.id;
    state.routineDirty = false;
    renderRoutines();
    renderWorkspaceHeader();
    renderSummary();
    showToast('Routine saved');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Save routine');
  }
}

async function triggerRoutine() {
  const routine = routineById(state.selectedRoutineId);
  if (!routine) return;
  const button = $('#trigger-routine');
  setButtonBusy(button, true, 'Starting', 'Run now');
  try {
    const data = await getJson(`/v1/routines/${encodeURIComponent(routine.id)}/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'admin-console' }),
    });
    state.routines = data.routines;
    renderRoutines();
    showToast(`Routine accepted / ${statusLabel(data.execution.status)}`);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Starting', 'Run now');
  }
}

async function deleteRoutine() {
  const routine = routineById(state.selectedRoutineId);
  if (!routine || !window.confirm(`Delete ${routine.name}?`)) return;
  const button = $('#delete-routine');
  setButtonBusy(button, true, 'Deleting', 'Delete');
  try {
    const data = await getJson(`/v1/routines/${encodeURIComponent(routine.id)}`, {
      method: 'DELETE',
    });
    state.routines = data.routines;
    state.selectedRoutineId = state.routines.routines?.[0]?.id || '__new__';
    state.routineDirty = false;
    renderRoutines();
    renderWorkspaceHeader();
    showToast('Routine deleted');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Deleting', 'Delete');
  }
}

async function tickRoutines() {
  const button = $('#tick-routines');
  setButtonBusy(button, true, 'Ticking', 'Tick now');
  try {
    const data = await getJson('/v1/routines/tick', { method: 'POST' });
    state.routines = data.routines;
    renderRoutines();
    showToast(
      `Staged ${data.result.staged} / queued ${data.result.queued} / failed ${data.result.failed}`,
    );
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Ticking', 'Tick now');
  }
}

function renderRoutines() {
  const scheduler = state.routines?.scheduler || {};
  $('#scheduler-state').textContent = scheduler.enabled ? 'Enabled' : 'Disabled';
  $('#scheduler-state').className = `state-pill ${scheduler.enabled ? 'enabled' : 'disabled'}`;
  const nextRunAt = state.routines?.summary?.nextRunAt;
  $('#scheduler-detail').textContent = scheduler.lastTickAt
    ? `Last ${formatTime(scheduler.lastTickAt, true)} / ${nextRunAt ? `next ${formatTime(nextRunAt, true)}` : 'nothing due'}`
    : nextRunAt
      ? `No tick recorded / next ${formatTime(nextRunAt, true)}`
      : 'No tick recorded / no enabled routines';
  const available = state.routines?.routines || [];
  if (
    state.selectedRoutineId !== '__new__' &&
    !routineById(state.selectedRoutineId)
  ) {
    state.selectedRoutineId = available[0]?.id || '__new__';
  }
  renderRoutineList();
  if (!state.routineDirty) {
    fillRoutineForm(routineById(state.selectedRoutineId));
  }
}

function runTitle(run) {
  return (
    run.metadata?.routineName ||
    run.title ||
    run.message?.text ||
    run.summary?.split('\n')[0] ||
    shortId(run.id)
  );
}

function filteredRuns() {
  return state.runs.filter((run) => !state.runFilter || run.status === state.runFilter);
}

function renderRunTable() {
  const root = $('#run-table');
  root.replaceChildren();
  const header = element('div', 'run-table-header');
  for (const label of ['Task', 'Status', 'Project', 'Client', 'Updated']) {
    header.append(element('span', '', label));
  }
  root.append(header);
  const items = filteredRuns();
  if (!items.length) {
    root.append(element('div', 'empty-state', 'No runs in this view'));
    return;
  }
  for (const run of items) {
    const row = element('button', 'run-table-row');
    row.type = 'button';
    row.classList.toggle('active', run.id === state.selectedRunId);
    row.append(
      element('strong', '', runTitle(run)),
      statePill(run.status),
      element('span', '', run.projectId || 'general'),
      element('span', '', statusLabel(run.platform)),
      element('span', '', formatTime(run.updatedAt, true)),
    );
    row.addEventListener('click', () => void openRun(run.id));
    root.append(row);
  }
}

async function openRun(runId) {
  state.selectedRunId = runId;
  renderRunTable();
  const detail = $('#run-detail');
  detail.replaceChildren(element('div', 'empty-state', 'Loading run'));
  try {
    const data = await getJson(`/v1/runs/${encodeURIComponent(runId)}/events?limit=100`);
    renderRunDetail(data.run, data.events || []);
  } catch (error) {
    detail.replaceChildren(element('div', 'empty-state', error.message));
  }
}

function renderRunDetail(run, events) {
  const detail = $('#run-detail');
  detail.replaceChildren();
  const head = element('div', 'run-detail-head');
  const copy = element('div');
  copy.append(
    element('strong', '', runTitle(run)),
    element('small', '', `${shortId(run.id)} / ${run.executorId || 'executor'} / ${run.workerId || 'unclaimed'}`),
  );
  head.append(copy, statePill(run.status));
  detail.append(head);
  if (run.summary) detail.append(element('div', 'run-summary', run.summary));

  if (['queued', 'running', 'cancel_requested'].includes(run.status)) {
    const cancel = element('button', 'secondary-button', 'Cancel run');
    cancel.type = 'button';
    cancel.addEventListener('click', () => void cancelRun(run.id, cancel));
    detail.append(cancel);
  }

  const timeline = element('div', 'timeline');
  for (const event of events) {
    const row = element('div', 'timeline-row');
    const eventCopy = element('div');
    eventCopy.append(
      element('strong', '', event.message || statusLabel(event.type)),
      element('small', '', `${statusLabel(event.type)} / ${formatTime(event.at, true)}`),
    );
    row.append(eventCopy);
    timeline.append(row);
  }
  if (!events.length) timeline.append(element('div', 'empty-state', 'No timeline events'));
  detail.append(timeline);
}

async function cancelRun(runId, button) {
  setButtonBusy(button, true, 'Cancelling', 'Cancel run');
  try {
    await getJson(`/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'admin_console_cancelled' }),
    });
    await refreshAll({ quiet: true });
    await openRun(runId);
    showToast('Cancellation requested');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Cancelling', 'Cancel run');
  }
}

function renderLedgerList(root, items, kind) {
  root.replaceChildren();
  if (!items.length) {
    root.append(element('div', 'empty-state', `No ${kind} records`));
    return;
  }
  for (const item of items.slice(0, 8)) {
    const row = element('div', 'ledger-row');
    const copy = element('div');
    const title =
      kind === 'outbound'
        ? item.kind
        : item.eventType || item.platform || 'event';
    const detail =
      kind === 'outbound'
        ? `${item.target?.chatId || item.target?.cardId || 'target'} / #${item.sequence}`
        : `${item.externalId}${item.duplicateCount ? ` / ${item.duplicateCount} duplicates` : ''}`;
    copy.append(element('strong', '', title), element('small', '', detail));
    row.append(copy, statePill(item.status));
    root.append(row);
  }
}

function renderDelivery() {
  renderLedgerList($('#outbox-list'), state.delivery?.outbox || [], 'outbound');
  renderLedgerList($('#inbound-list'), state.delivery?.inboundEvents || [], 'inbound');
}

function fillProjectSelect(select, selectedValue) {
  select.replaceChildren();
  for (const project of state.workspace?.projects || []) {
    const option = document.createElement('option');
    option.value = project.projectId;
    option.textContent = project.name;
    option.selected = projectMatches(project, selectedValue);
    select.append(option);
  }
}

function fillProjectSelects() {
  const fallback = state.workspace?.projects?.[0]?.projectId;
  state.memoryProjectId = projectById(state.memoryProjectId)?.projectId || fallback;
  state.testProjectId =
    projectById(state.testProjectId)?.projectId ||
    projectById(state.selectedProjectId)?.projectId ||
    fallback;
  fillProjectSelect($('#memory-project'), state.memoryProjectId);
  fillProjectSelect($('#test-project'), state.testProjectId);
}

function memoryThread() {
  const project = projectById(state.memoryProjectId) || state.workspace?.projects?.[0];
  const binding = projectBindings(project)[0];
  const platform = binding?.platform || 'lark';
  const externalId = binding?.externalId || `admin:${project?.projectId || 'general'}`;
  const threadId = binding?.scope === 'thread'
    ? `${platform}:${externalId}`
    : `${platform}:${externalId}:admin`;
  return {
    platform,
    externalId,
    channelId: binding?.channelId || externalId,
    threadId,
    workspaceId: project?.workspaceId || currentWorkspaceId(),
    projectId: project?.projectId || 'general',
    scope: state.memoryScope,
  };
}

function renderScopeMap(route) {
  const root = $('#scope-map');
  const scopes = [
    ['Global', 'OpenTag installation'],
    ['Workspace', route.workspaceId],
    ['Project', route.projectId],
    ['Thread', route.threadId],
  ];
  root.replaceChildren();
  for (const [label, value] of scopes) {
    const node = element('div', 'scope-node');
    node.append(element('strong', '', label), element('span', '', value || 'not set'));
    root.append(node);
  }
}

async function refreshMemory() {
  if (!state.workspace) return;
  const route = memoryThread();
  const query = new URLSearchParams(route);
  $('#memory-route').textContent = `${statusLabel(state.memoryScope)} / ${route.projectId}`;
  renderScopeMap(route);
  try {
    const data = await getJson(`/v1/memory?${query.toString()}`);
    const content = data.snapshot?.scopes?.[0]?.content?.trim();
    $('#memory-output').textContent = content || 'No memory in this scope.';
  } catch (error) {
    $('#memory-output').textContent = error.message;
  }
}

async function rememberMemory(event) {
  event.preventDefault();
  const button = $('#save-memory');
  const text = $('#memory-text').value.trim();
  if (!text) {
    showToast('Enter a memory note', 'error');
    return;
  }
  setButtonBusy(button, true, 'Saving', 'Remember');
  try {
    await getJson('/v1/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...memoryThread(), action: 'remember', text }),
    });
    $('#memory-text').value = '';
    await refreshMemory();
    showToast('Memory saved');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Remember');
  }
}

async function forgetMemory() {
  const button = $('#forget-memory');
  const selector = $('#memory-text').value.trim();
  if (!selector) {
    showToast('Enter text to match', 'error');
    return;
  }
  setButtonBusy(button, true, 'Forgetting', 'Forget matching');
  try {
    await getJson('/v1/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...memoryThread(), action: 'forget', selector }),
    });
    await refreshMemory();
    showToast('Matching memory removed');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Forgetting', 'Forget matching');
  }
}

function findCardText(cardDoc, prefix) {
  for (const item of cardDoc.elements || []) {
    const content = item.text?.content;
    if (typeof content === 'string' && content.startsWith(prefix)) {
      return content.replace(prefix, '').trim();
    }
  }
  return '';
}

function findChecklist(cardDoc) {
  const markers = ['○ ', '● ', '✓ ', '! ', '- '];
  for (const item of cardDoc.elements || []) {
    const content = item.text?.content;
    if (typeof content !== 'string') continue;
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => markers.some((marker) => line.startsWith(marker)));
    if (lines.length) return lines;
  }
  return [];
}

function renderCard(cardDoc) {
  const card = $('#card');
  card.className = 'lark-card';
  card.replaceChildren();
  const title = cardDoc.header?.title?.content || 'OpenTag run';
  const template = cardDoc.header?.template || '';
  card.append(element('div', `card-header ${template}`, title));
  const body = element('div', 'card-body');
  const status = findCardText(cardDoc, '**Status:**');
  const summary = findCardText(cardDoc, '**Summary:**');
  body.append(element('div', 'card-line', `Status: ${status || 'unknown'}`));
  if (summary) body.append(element('div', 'card-line', `Summary: ${summary}`));
  const checklist = element('div', 'checklist');
  for (const item of findChecklist(cardDoc)) {
    const row = element('div', 'check-item');
    row.append(
      element('span', 'check-symbol', item.slice(0, 1)),
      element('span', '', item.slice(2)),
    );
    checklist.append(row);
  }
  body.append(checklist);
  card.append(body);
}

async function runTest(event) {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') {
    $('#test-dialog').close();
    return;
  }
  const button = $('#run-test');
  state.testProjectId = $('#test-project').value;
  const project = projectById(state.testProjectId);
  setButtonBusy(button, true, 'Running', 'Run');
  $('#test-route').textContent = 'Running';
  $('#test-result').hidden = false;
  $('#test-output').textContent = 'Waiting for result...';
  try {
    const data = await getJson('/v1/dev/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: $('#test-prompt').value,
        workspaceId: project?.workspaceId || currentWorkspaceId(),
        projectId: project?.projectId || 'opentag',
        projectName: project?.name,
      }),
    });
    const cards = data.larkDryRun?.cards || [];
    const texts = data.larkDryRun?.texts || [];
    if (cards.length) renderCard(cards.at(-1).card);
    $('#test-output').textContent =
      texts.at(-1)?.text || data.result?.summary || JSON.stringify(data.result, null, 2);
    $('#test-route').textContent = `${data.route?.workspaceId || 'workspace'} / ${data.route?.projectId || 'project'}`;
    await refreshAll({ quiet: true });
  } catch (error) {
    $('#test-output').textContent = error.message;
    $('#test-route').textContent = 'Failed';
  } finally {
    setButtonBusy(button, false, 'Running', 'Run');
  }
}

async function runControl(endpoint, button, labels, body = {}) {
  setButtonBusy(button, true, labels.busy, labels.idle);
  try {
    const data = await getJson(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await refreshAll({ quiet: true });
    showToast(data.result ? JSON.stringify(data.result) : 'Operation completed');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, labels.busy, labels.idle);
  }
}

function renderAll() {
  renderHealth();
  renderWorkspaceHeader();
  renderSummary();
  renderOverviewProjects();
  renderConnectors();
  renderOverviewRuns();
  renderProjectList();
  renderRoutines();
  renderRunTable();
  renderDelivery();
  fillProjectSelects();

  const fallback = state.workspace?.projects?.[0]?.projectId;
  if (!projectById(state.selectedProjectId)) state.selectedProjectId = fallback;
  fillProjectForm(selectedProject());
}

async function refreshAll({ quiet = false } = {}) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const button = $('#refresh-all');
  if (!quiet) setButtonBusy(button, true, 'Refreshing', 'Refresh');
  try {
    const [health, capabilities, workspace, delivery, runs, bindings, routines] =
      await Promise.all([
        getJson('/health'),
        getJson('/v1/capabilities'),
        getJson(`/v1/workspace?workspaceId=${encodeURIComponent(currentWorkspaceId())}`),
        getJson('/v1/deliveries?limit=20'),
        getJson('/v1/runs?limit=50'),
        getJson('/v1/bindings?limit=100'),
        getJson(`/v1/routines?workspaceId=${encodeURIComponent(currentWorkspaceId())}`),
      ]);
    state.health = health;
    state.capabilities = capabilities;
    state.workspace = workspace;
    state.delivery = delivery;
    state.runs = runs.runs || [];
    state.bindings = bindings.bindings || [];
    state.routines = routines;
    const fallback = workspace.projects?.[0]?.projectId;
    state.selectedProjectId = projectById(state.selectedProjectId)?.projectId || fallback;
    state.memoryProjectId = projectById(state.memoryProjectId)?.projectId || fallback;
    renderAll();
    $('#sync-label').textContent = `Synced ${formatTime(new Date().toISOString())}`;
  } catch (error) {
    state.health = null;
    renderHealth();
    $('#sync-label').textContent = 'Sync failed';
    if (!quiet) showToast(error.message, 'error');
  } finally {
    refreshInFlight = false;
    if (!quiet) setButtonBusy(button, false, 'Refreshing', 'Refresh');
  }
}

for (const button of $$('[data-view]')) {
  button.addEventListener('click', () => showView(button.dataset.view));
}
for (const button of $$('[data-go-view]')) {
  button.addEventListener('click', () => showView(button.dataset.goView));
}

$('#refresh-all').addEventListener('click', () => void refreshAll());
$('#open-test').addEventListener('click', () => $('#test-dialog').showModal());
$('#test-form').addEventListener('submit', (event) => void runTest(event));
$('#new-project').addEventListener('click', newProject);
$('#project-form').addEventListener('submit', (event) => void saveProject(event));
$('#save-binding').addEventListener('click', () => void saveBinding());
$('#new-routine').addEventListener('click', newRoutine);
$('#routine-form').addEventListener('submit', (event) => void saveRoutine(event));
$('#trigger-routine').addEventListener('click', () => void triggerRoutine());
$('#delete-routine').addEventListener('click', () => void deleteRoutine());
$('#tick-routines').addEventListener('click', () => void tickRoutines());
$('#memory-form').addEventListener('submit', (event) => void rememberMemory(event));
$('#forget-memory').addEventListener('click', () => void forgetMemory());
$('#reload-memory').addEventListener('click', () => void refreshMemory());

for (const input of $$('#project-form input, #project-form textarea, #project-form select')) {
  input.addEventListener('input', markProjectDirty);
  input.addEventListener('change', markProjectDirty);
}

for (const input of $$('#routine-form input, #routine-form textarea, #routine-form select')) {
  input.addEventListener('input', markRoutineDirty);
  input.addEventListener('change', markRoutineDirty);
}

$('#routine-schedule-kind').addEventListener('change', updateRoutineScheduleFields);
$('#routine-project').addEventListener('change', () => fillRoutineDestination(true));
$('#routine-platform').addEventListener('change', () => fillRoutineDestination(true));

$('#project-id').addEventListener('input', () => {
  if (state.selectedProjectId === '__new__') {
    $('#agent-id-label').textContent = currentAgentId();
  }
});

$('#memory-project').addEventListener('change', (event) => {
  state.memoryProjectId = event.target.value;
  void refreshMemory();
});

$('#test-project').addEventListener('change', (event) => {
  state.testProjectId = event.target.value;
});

for (const button of $$('#memory-scope button')) {
  button.addEventListener('click', () => {
    state.memoryScope = button.dataset.scope;
    for (const item of $$('#memory-scope button')) {
      item.classList.toggle('active', item === button);
    }
    void refreshMemory();
  });
}

for (const button of $$('#run-filter button')) {
  button.addEventListener('click', () => {
    state.runFilter = button.dataset.status || '';
    for (const item of $$('#run-filter button')) {
      item.classList.toggle('active', item === button);
    }
    renderRunTable();
  });
}

$('#worker-pass').addEventListener('click', (event) =>
  void runControl(
    '/v1/runs/worker-pass',
    event.currentTarget,
    { busy: 'Working', idle: 'Worker pass' },
    { limit: 1 },
  ),
);
$('#recover-runs').addEventListener('click', (event) =>
  void runControl(
    '/v1/runs/recover-stale',
    event.currentTarget,
    { busy: 'Recovering', idle: 'Recover runs' },
    { olderThanMs: 120000, reason: 'admin_console_recovery' },
  ),
);
$('#recover-delivery').addEventListener('click', (event) =>
  void runControl(
    '/v1/deliveries/recover-stale',
    event.currentTarget,
    { busy: 'Recovering', idle: 'Recover delivery' },
    { olderThanMs: 120000, reason: 'admin_console_recovery' },
  ),
);

const initialView = location.hash.slice(1);
showView(viewCopy[initialView] ? initialView : 'overview', false);
await refreshAll();

setInterval(() => {
  if (
    document.visibilityState === 'visible' &&
    !state.projectDirty &&
    !state.routineDirty
  ) {
    void refreshAll({ quiet: true });
  }
}, 10000);
