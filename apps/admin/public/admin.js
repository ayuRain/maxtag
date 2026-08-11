const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  auth: null,
  health: null,
  capabilities: null,
  workspace: null,
  access: null,
  delivery: null,
  routines: null,
  workflows: null,
  pairings: null,
  runs: [],
  bindings: [],
  selectedProjectId: null,
  selectedAccessProjectId: null,
  selectedRoutineId: null,
  selectedWorkflowId: null,
  selectedRunId: null,
  runFilter: '',
  memoryScope: 'project',
  memoryProjectId: null,
  testProjectId: null,
  pairingProjectId: null,
  latestPairing: null,
  projectDirty: false,
  routineDirty: false,
  workflowDirty: false,
  workflowTriggerKind: 'manual',
  workflowDraftSteps: [],
  workflowGraphMode: 'sequential',
};

const viewCopy = {
  overview: { eyebrow: 'Workspace', title: 'Overview' },
  projects: { eyebrow: 'Routing and access', title: 'Projects' },
  access: { eyebrow: 'Identity and roles', title: 'Access' },
  connectors: { eyebrow: 'Multi-client routing', title: 'Connectors' },
  routines: { eyebrow: 'Proactive work', title: 'Routines' },
  workflows: { eyebrow: 'Event-driven work', title: 'Workflows' },
  activity: { eyebrow: 'Runs and delivery', title: 'Activity' },
  memory: { eyebrow: 'Scoped context', title: 'Memory' },
};

let toastTimer;
let refreshInFlight = false;

async function getJson(url, options) {
  const requestOptions = { ...(options || {}) };
  const method = String(requestOptions.method || 'GET').toUpperCase();
  const headers = new Headers(requestOptions.headers || {});
  if (
    state.auth?.csrfToken &&
    !['GET', 'HEAD', 'OPTIONS'].includes(method)
  ) {
    headers.set('x-opentag-csrf', state.auth.csrfToken);
  }
  requestOptions.headers = headers;
  const response = await fetch(url, requestOptions);
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : { message: await response.text() };
  if (!response.ok) {
    if (response.status === 401 && data.error === 'operator_auth_required') {
      showOperatorLogin('Your operator session expired.');
    }
    throw new Error(data.message || data.error || response.statusText);
  }
  return data;
}

function showOperatorLogin(message = '') {
  state.auth = {
    configured: true,
    authenticated: false,
  };
  $('#app-shell').hidden = true;
  $('#auth-shell').hidden = false;
  const error = $('#auth-error');
  error.textContent = message;
  error.hidden = !message;
  requestAnimationFrame(() => $('#auth-token').focus());
}

function applyOperatorSession(session) {
  state.auth = session;
  const signInRequired = session.configured && !session.authenticated;
  $('#auth-shell').hidden = !signInRequired;
  $('#app-shell').hidden = signInRequired;
  $('#sign-out').hidden = !session.configured;
  const principal = session.principal;
  $('#operator-name').textContent = principal?.displayName || 'Unknown operator';
  const workspaceIds = principal?.workspaceIds || [];
  const scopeLabel = workspaceIds.includes('*')
    ? 'installation'
    : workspaceIds.join(', ') || 'no workspace';
  $('#operator-scope').textContent = `${statusLabel(principal?.role)} / ${scopeLabel}`;
  applyOperatorCapabilities();
  if (!signInRequired) {
    $('#auth-error').hidden = true;
    $('#auth-token').value = '';
  }
  return !signInRequired;
}

function applyOperatorCapabilities() {
  const principal = state.auth?.principal;
  const viewer = principal?.role === 'viewer';
  const installation = Boolean(principal?.workspaceIds?.includes('*'));
  document.body.classList.toggle('operator-viewer', viewer);
  for (const selector of [
    '#new-project',
    '#save-project',
    '#save-binding',
    '#add-access-member',
    '#save-access-policy',
    '#add-project-member',
    '#new-routine',
    '#save-routine',
    '#delete-routine',
    '#new-workflow',
    '#save-workflow',
    '#archive-workflow',
    '#pairing-form button[type="submit"]',
    '#memory-form button[type="submit"]',
    '#forget-memory',
    '#open-test',
    '#recover-delivery',
  ]) {
    const control = $(selector);
    if (control) control.disabled = viewer;
  }
  const routineTrigger = $('#trigger-routine');
  if (routineTrigger) {
    routineTrigger.disabled =
      viewer || state.routineDirty || !routineById(state.selectedRoutineId);
  }
  const workflowTrigger = $('#trigger-workflow');
  if (workflowTrigger) {
    workflowTrigger.disabled =
      viewer || state.workflowDirty || !workflowById(state.selectedWorkflowId);
  }
  for (const selector of [
    '#tick-routines',
    '#tick-workflows',
    '#worker-pass',
    '#recover-runs',
  ]) {
    const control = $(selector);
    if (control) control.disabled = viewer || !installation;
  }
  const globalMemory = $('#memory-scope [data-scope="global"]');
  if (globalMemory) globalMemory.disabled = !installation;
}

async function loadOperatorSession() {
  try {
    return applyOperatorSession(await getJson('/v1/admin/session'));
  } catch (error) {
    showOperatorLogin(error.message || 'OpenTag is unavailable.');
    return false;
  }
}

async function signInOperator(event) {
  event.preventDefault();
  const button = $('#auth-submit');
  const error = $('#auth-error');
  error.hidden = true;
  setButtonBusy(button, true, 'Signing in', 'Continue');
  try {
    const session = await getJson('/v1/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: $('#auth-token').value }),
    });
    applyOperatorSession(session);
    await refreshAll();
  } catch (failure) {
    error.textContent =
      failure.message === 'invalid_operator_token'
        ? 'That access token is not valid.'
        : failure.message;
    error.hidden = false;
    $('#auth-token').select();
  } finally {
    setButtonBusy(button, false, 'Signing in', 'Continue');
  }
}

async function signOutOperator() {
  try {
    await getJson('/v1/admin/session', { method: 'DELETE' });
  } finally {
    showOperatorLogin();
    $('#auth-token').value = '';
  }
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
  if (value.startsWith('workflow:')) return `workflow:${value.slice(-6)}`;
  if (value.startsWith('steering:')) return `follow-up:${value.slice(-6)}`;
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
  const principalWorkspace = state.auth?.principal?.workspaceIds?.find(
    (workspaceId) => workspaceId !== '*',
  );
  return (
    state.workspace?.workspace?.workspace?.id ||
    principalWorkspace ||
    'dev-workspace'
  );
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
  $('#member-count').textContent = String(state.access?.members?.length || 0);
  const clients = state.capabilities?.clients || [];
  $('#client-count').textContent = String(
    clients.filter((client) => client.status !== 'planned').length,
  );
  $('#routine-count').textContent = String(state.routines?.routines?.length || 0);
  $('#workflow-count').textContent = String(state.workflows?.workflows?.length || 0);
  const runSummary = state.delivery?.summary?.agentRuns || {};
  $('#active-count').textContent = String(
    (runSummary.queued || 0) +
      (runSummary.running || 0) +
      (runSummary.cancel_requested || 0),
  );
  const workerMode = state.capabilities?.runWorker?.mode || 'manual';
  const storageLabel =
    state.capabilities?.storage?.driver === 'sqlite' ? 'SQLite WAL' : 'file';
  const activeClients = clients.filter((client) => client.status !== 'planned').length;
  $('#runtime-label').textContent = `${activeClients} clients / ${storageLabel} / ${workerMode}`;
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
    (state.routines?.summary?.executions?.failed || 0) +
    (state.workflows?.summary?.executions?.failed || 0);
  summary.replaceChildren(
    metric(projects.length, 'Projects'),
    metric(clients.filter((client) => client.status !== 'planned').length, 'Active clients'),
    metric(active, 'Active runs'),
    metric(failures, 'Needs attention'),
  );
}

function selectedAccessProject() {
  return projectById(state.selectedAccessProjectId);
}

function projectAccessPolicy(project) {
  return (state.access?.projectPolicies || []).find((policy) =>
    projectMatches(project, policy.projectId),
  );
}

function projectAccessMemberships(project) {
  return (state.access?.projectMemberships || []).filter((membership) =>
    projectMatches(project, membership.projectId),
  );
}

function accessMember(memberId) {
  return (state.access?.members || []).find((member) => member.id === memberId);
}

function renderAccessSummary() {
  const root = $('#access-summary');
  const members = state.access?.members || [];
  const policies = state.access?.projectPolicies || [];
  root.replaceChildren(
    metric(members.length, 'Workspace members'),
    metric(members.filter((member) => member.status === 'active').length, 'Active'),
    metric(
      members.filter(
        (member) => member.role === 'owner' || member.role === 'admin',
      ).length,
      'Owners and admins',
    ),
    metric(policies.filter((policy) => policy.mode !== 'open').length, 'Managed projects'),
  );
}

function accessIdentityLabel(member) {
  return (member.identities || [])
    .map((identity) => `${statusLabel(identity.platform)}: ${identity.externalId}`)
    .join(' / ');
}

function renderAccessMembers() {
  const root = $('#access-member-list');
  const members = state.access?.members || [];
  root.replaceChildren();
  if (!members.length) {
    root.append(element('div', 'empty-state compact-empty', 'No workspace members'));
    $('#access-member-role').value = 'owner';
    return;
  }
  for (const member of members) {
    const row = element('div', 'access-row');
    const copy = element('div', 'access-row-copy');
    copy.append(
      element('strong', '', member.displayName),
      element('small', '', accessIdentityLabel(member)),
    );
    const status = element('div', 'access-row-status');
    status.append(statePill(member.role), statePill(member.status));
    const actions = element('div', 'access-row-actions');
    const toggle = element(
      'button',
      '',
      member.status === 'active' ? 'Suspend' : 'Activate',
    );
    toggle.type = 'button';
    toggle.addEventListener('click', () =>
      void updateAccessMember(member, {
        status: member.status === 'active' ? 'suspended' : 'active',
      }),
    );
    const remove = element('button', 'remove-access', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => void removeAccessMember(member));
    actions.append(toggle, remove);
    row.append(copy, status, actions);
    root.append(row);
  }
}

function fillAccessProjectControls() {
  const projects = state.workspace?.projects || [];
  const projectSelect = $('#access-project');
  const memberSelect = $('#access-project-member');
  const selected = projectById(state.selectedAccessProjectId) || projects[0];
  state.selectedAccessProjectId = selected?.projectId || null;
  projectSelect.replaceChildren();
  for (const project of projects) {
    const option = element('option', '', project.name);
    option.value = project.projectId;
    option.selected = projectMatches(project, state.selectedAccessProjectId);
    projectSelect.append(option);
  }

  memberSelect.replaceChildren();
  for (const member of state.access?.members || []) {
    if (member.status !== 'active') continue;
    const option = element('option', '', `${member.displayName} / ${statusLabel(member.role)}`);
    option.value = member.id;
    memberSelect.append(option);
  }
  memberSelect.disabled = !memberSelect.options.length;
  $('#add-project-member').disabled = !selected || !memberSelect.options.length;
}

function renderProjectAccess() {
  const root = $('#access-project-member-list');
  const project = selectedAccessProject();
  const policy = project ? projectAccessPolicy(project) : undefined;
  $('#access-mode').value = policy?.mode || 'open';
  root.replaceChildren();
  if (!project) {
    root.append(element('div', 'empty-state compact-empty', 'No project selected'));
    return;
  }
  const memberships = projectAccessMemberships(project);
  if (!memberships.length) {
    root.append(element('div', 'empty-state compact-empty', 'No project members'));
    return;
  }
  for (const membership of memberships) {
    const member = accessMember(membership.memberId);
    const row = element('div', 'access-row');
    const copy = element('div', 'access-row-copy');
    copy.append(
      element('strong', '', member?.displayName || membership.memberId),
      element('small', '', member ? accessIdentityLabel(member) : membership.memberId),
    );
    const role = statePill(membership.role);
    const actions = element('div', 'access-row-actions');
    const remove = element('button', 'remove-access', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () =>
      void removeProjectMembership(project, membership),
    );
    actions.append(remove);
    row.append(copy, role, actions);
    root.append(row);
  }
}

function renderAccess() {
  renderAccessSummary();
  renderAccessMembers();
  fillAccessProjectControls();
  renderProjectAccess();
}

function accessErrorMessage(error) {
  const messages = {
    workspace_first_member_must_be_owner: 'The first workspace member must be an owner.',
    workspace_last_owner_required: 'Add another active owner before changing this owner.',
    workspace_member_identity_already_linked: 'That client user ID is already linked.',
  };
  return messages[error.message] || error.message;
}

async function saveAccessMember(event) {
  event.preventDefault();
  const button = $('#add-access-member');
  setButtonBusy(button, true, 'Adding', 'Add member');
  try {
    const data = await getJson('/v1/access/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(),
        displayName: $('#access-member-name').value,
        role: $('#access-member-role').value,
        platform: $('#access-member-platform').value,
        externalId: $('#access-member-external-id').value,
      }),
    });
    state.access = data.access;
    $('#access-member-form').reset();
    $('#access-member-role').value = state.access.members.length ? 'member' : 'owner';
    await refreshAll({ quiet: true });
    showToast('Workspace member added');
  } catch (error) {
    showToast(accessErrorMessage(error), 'error');
  } finally {
    setButtonBusy(button, false, 'Adding', 'Add member');
  }
}

async function updateAccessMember(member, updates) {
  try {
    const data = await getJson('/v1/access/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...member,
        ...updates,
      }),
    });
    state.access = data.access;
    renderAccess();
    showToast(`${member.displayName} updated`);
  } catch (error) {
    showToast(accessErrorMessage(error), 'error');
  }
}

async function removeAccessMember(member) {
  if (!window.confirm(`Remove ${member.displayName} from this workspace?`)) return;
  try {
    const query = new URLSearchParams({ workspaceId: currentWorkspaceId() });
    const data = await getJson(
      `/v1/access/members/${encodeURIComponent(member.id)}?${query}`,
      { method: 'DELETE' },
    );
    state.access = data.access;
    await refreshAll({ quiet: true });
    showToast(`${member.displayName} removed`);
  } catch (error) {
    showToast(accessErrorMessage(error), 'error');
  }
}

async function saveAccessPolicy(event) {
  event.preventDefault();
  const project = selectedAccessProject();
  if (!project) return;
  const button = $('#save-access-policy');
  setButtonBusy(button, true, 'Saving', 'Save mode');
  try {
    const data = await getJson('/v1/access/project-policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(),
        projectId: project.projectId,
        mode: $('#access-mode').value,
      }),
    });
    state.access = data.access;
    await refreshAll({ quiet: true });
    showToast(`${project.name} access updated`);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Save mode');
  }
}

async function assignProjectMember(event) {
  event.preventDefault();
  const project = selectedAccessProject();
  const memberId = $('#access-project-member').value;
  if (!project || !memberId) return;
  const button = $('#add-project-member');
  setButtonBusy(button, true, 'Assigning', 'Assign');
  try {
    const data = await getJson('/v1/access/project-memberships', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(),
        projectId: project.projectId,
        memberId,
        role: $('#access-project-role').value,
      }),
    });
    state.access = data.access;
    await refreshAll({ quiet: true });
    showToast('Project role assigned');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Assigning', 'Assign');
  }
}

async function removeProjectMembership(project, membership) {
  try {
    const query = new URLSearchParams({
      workspaceId: currentWorkspaceId(),
      projectId: project.projectId,
      memberId: membership.memberId,
    });
    const data = await getJson(`/v1/access/project-memberships?${query}`, {
      method: 'DELETE',
    });
    state.access = data.access;
    await refreshAll({ quiet: true });
    showToast('Project role removed');
  } catch (error) {
    showToast(error.message, 'error');
  }
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
    const transport = clientTransport(client);
    copy.append(
      element('strong', '', client.label || client.id),
      element(
        'small',
        '',
        `${client.inbound || 'not wired'} / ${transport?.mode || 'planned'}`,
      ),
    );
    row.append(copy, statePill(client.status));
    root.append(row);
  }
}

function clientTransport(client) {
  if (client.id === 'lark') return state.capabilities?.larkTransport;
  if (client.id === 'telegram') return state.capabilities?.telegramTransport;
  return null;
}

function clientEndpoint(client) {
  if (client.id === 'lark') return '/v1/lark/events';
  if (client.id === 'telegram') return '/v1/telegram/events';
  return '/v1/client/events';
}

function clientRuntimeLabel(client) {
  const transport = clientTransport(client);
  if (!transport) return client.status === 'planned' ? 'Not wired' : 'Generic receipt';
  if (client.id === 'lark') {
    return transport.mode === 'http'
      ? 'HTTP / credentials set'
      : `Memory / ${transport.hasCredentials ? 'credentials set' : 'no credentials'}`;
  }
  return transport.mode === 'http'
    ? `HTTP / ${transport.webhookSecretConfigured ? 'secret set' : 'no secret'}`
    : `Memory / ${transport.webhookSecretConfigured ? 'secret set' : 'no secret'}`;
}

function clientCell(label, value, className = '') {
  const cell = element('div', `client-cell ${className}`.trim());
  cell.append(
    element('span', 'client-cell-label', label),
    element('span', '', value),
  );
  return cell;
}

function renderLatestPairing() {
  const root = $('#pairing-result');
  const pairing = state.latestPairing;
  root.hidden = !pairing;
  if (!pairing) return;
  $('#pairing-command').textContent = pairing.command;
  $('#pairing-expiry').textContent = `Expires ${formatTime(pairing.invitation.expiresAt, true)}`;
}

function renderPairingInvitations() {
  const root = $('#pairing-invitations');
  root.replaceChildren();
  const invitations = state.pairings?.invitations || [];
  if (!invitations.length) {
    root.append(element('div', 'empty-state compact-empty', 'No invitations yet'));
    return;
  }
  for (const invitation of invitations.slice(0, 8)) {
    const row = element('div', 'pairing-invitation-row');
    const identity = element('div', 'pairing-invitation-copy');
    identity.append(
      element('strong', '', `${statusLabel(invitation.platform)} / ${invitation.projectId}`),
      element('small', '', `Created ${formatTime(invitation.createdAt, true)}`),
    );
    const expiry = element(
      'span',
      'pairing-invitation-expiry',
      invitation.status === 'pending'
        ? `Expires ${formatTime(invitation.expiresAt, true)}`
        : invitation.consumedAt
          ? `Used ${formatTime(invitation.consumedAt, true)}`
          : statusLabel(invitation.status),
    );
    const actions = element('div', 'pairing-row-actions');
    if (invitation.status === 'pending') {
      const revoke = element('button', 'danger-text-button', 'Revoke');
      revoke.type = 'button';
      revoke.addEventListener('click', () => void revokePairing(invitation.id));
      actions.append(revoke);
    }
    row.append(identity, expiry, statePill(invitation.status), actions);
    root.append(row);
  }
}

function renderConnectorConsole() {
  const clients = state.capabilities?.clients || [];
  const transports = clients
    .map((client) => clientTransport(client))
    .filter(Boolean);
  const configuredBindings = state.bindings.filter(
    (binding) => binding.source === 'configured',
  );
  $('#connector-summary').replaceChildren(
    metric(clients.filter((client) => client.status === 'ready').length, 'Native clients'),
    metric(transports.filter((transport) => transport.mode === 'http').length, 'Live transports'),
    metric(configuredBindings.length, 'Configured routes'),
    metric(state.pairings?.summary?.pending || 0, 'Pending invites'),
  );

  renderLatestPairing();
  renderPairingInvitations();

  const table = $('#client-table');
  table.replaceChildren();
  const header = element('div', 'client-table-header');
  for (const label of ['Client', 'Ingress', 'Surface', 'Runtime', 'State']) {
    header.append(element('span', '', label));
  }
  table.append(header);
  for (const client of clients) {
    const row = element('div', 'client-table-row');
    const identity = element('div', 'client-identity');
    identity.append(
      element('strong', '', client.label || client.id),
      element('small', '', client.id),
    );
    const ingress = clientCell('Ingress', client.inbound || 'Not wired', 'client-ingress');
    ingress.append(element('code', '', clientEndpoint(client)));
    row.append(
      identity,
      ingress,
      clientCell('Surface', client.surface || 'Planned'),
      clientCell('Runtime', clientRuntimeLabel(client)),
      statePill(client.status),
    );
    table.append(row);
  }

  const bindingList = $('#connector-bindings');
  bindingList.replaceChildren();
  if (!configuredBindings.length) {
    bindingList.append(element('div', 'empty-state compact-empty', 'No chats connected'));
    return;
  }
  for (const binding of configuredBindings) {
    const row = element('div', 'connector-binding-row');
    const identity = element('div');
    identity.append(
      element('strong', '', binding.title || binding.externalId),
      element(
        'small',
        '',
        `${statusLabel(binding.platform)} / ${binding.scope || 'thread'} / ${binding.source || 'observed'}`,
      ),
    );
    const project = element('div', 'binding-project');
    project.append(
      element('span', 'client-cell-label', 'Project'),
      element('strong', '', binding.projectId || 'general'),
    );
    const actions = element('div', 'binding-actions');
    if (binding.source === 'configured') {
      const unbind = element('button', 'danger-text-button', 'Unbind');
      unbind.type = 'button';
      unbind.addEventListener('click', () => void removeBinding(binding.id));
      actions.append(unbind);
    }
    row.append(
      identity,
      project,
      statePill(binding.activationMode, statusLabel(binding.activationMode)),
      actions,
    );
    bindingList.append(row);
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

async function generatePairing(event) {
  event.preventDefault();
  const button = $('#generate-pairing');
  const projectId = $('#pairing-project').value;
  const project = projectById(projectId);
  if (!project) {
    showToast('Select a project first', 'error');
    return;
  }
  state.pairingProjectId = project.projectId;
  setButtonBusy(button, true, 'Generating', 'Generate code');
  try {
    state.latestPairing = await getJson('/v1/pairing-invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: $('#pairing-platform').value,
        workspaceId: project.workspaceId || currentWorkspaceId(),
        projectId: project.projectId,
        activationMode: $('#pairing-activation-mode').value,
        requireMention: $('#pairing-require-mention').checked,
      }),
    });
    await refreshAll({ quiet: true });
    showToast('Pairing command ready');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Generating', 'Generate code');
  }
}

async function copyPairingCommand() {
  const command = state.latestPairing?.command;
  if (!command) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(command);
    } else {
      const input = document.createElement('textarea');
      input.value = command;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.append(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    showToast('Command copied');
  } catch (error) {
    showToast(error.message || 'Could not copy command', 'error');
  }
}

async function revokePairing(id) {
  try {
    await getJson(
      `/v1/pairing-invitations/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (state.latestPairing?.invitation?.id === id) state.latestPairing = null;
    await refreshAll({ quiet: true });
    showToast('Invitation revoked');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function removeBinding(id) {
  try {
    const result = await getJson(`/v1/bindings/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    await refreshAll({ quiet: true });
    const count = result.removed?.length || 1;
    showToast(count > 1 ? `Chat and ${count - 1} topic routes unbound` : 'Chat unbound');
  } catch (error) {
    showToast(error.message, 'error');
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
      body: '{}',
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
  const schedulerLabel = !scheduler.enabled
    ? 'Disabled'
    : scheduler.mode === 'external'
      ? 'External'
      : scheduler.mode === 'manual'
        ? 'Manual'
        : 'Inline';
  $('#scheduler-state').textContent = schedulerLabel;
  $('#scheduler-state').className = `state-pill ${scheduler.enabled ? 'enabled' : 'disabled'}`;
  const nextRunAt = state.routines?.summary?.nextRunAt;
  const modeDetail = scheduler.mode === 'external'
    ? 'Independent scheduler'
    : scheduler.mode === 'manual'
      ? 'Manual ticks only'
      : 'Server scheduler';
  $('#scheduler-detail').textContent = scheduler.lastTickAt
    ? `${modeDetail} / last ${formatTime(scheduler.lastTickAt, true)} / ${nextRunAt ? `next ${formatTime(nextRunAt, true)}` : 'nothing due'}`
    : nextRunAt
      ? `${modeDetail} / next ${formatTime(nextRunAt, true)}`
      : `${modeDetail} / no enabled routines`;
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

function workflowById(value) {
  return (state.workflows?.workflows || []).find((workflow) => workflow.id === value);
}

function workflowTriggerLabel(trigger) {
  return trigger?.kind === 'event' ? trigger.eventType || 'Event' : 'Manual';
}

function workflowExecutions(workflowId) {
  return (state.workflows?.executions || []).filter(
    (execution) => execution.workflowId === workflowId,
  );
}

function fillWorkflowProjectOptions(selectedValue) {
  const select = $('#workflow-project');
  select.replaceChildren();
  for (const project of state.workspace?.projects || []) {
    const option = document.createElement('option');
    option.value = project.projectId;
    option.textContent = project.name;
    option.selected = projectMatches(project, selectedValue);
    select.append(option);
  }
}

function fillWorkflowDestination(force = false) {
  const externalId = $('#workflow-external-id');
  if (!force && externalId.value.trim()) return;
  const binding = preferredRoutineBinding(
    $('#workflow-project').value,
    $('#workflow-platform').value,
  );
  if (!binding) {
    if (force) externalId.value = '';
    return;
  }
  $('#workflow-platform').value = binding.platform;
  externalId.value = binding.externalId;
}

function defaultWorkflowSteps() {
  return [
    {
      id: 'collect',
      name: 'Collect context',
      instructions: '',
      publish: false,
    },
    {
      id: 'analyze',
      name: 'Analyze',
      instructions: '',
      dependsOn: ['collect'],
      publish: false,
    },
    {
      id: 'publish',
      name: 'Publish',
      instructions: '',
      dependsOn: ['analyze'],
      publish: true,
    },
  ];
}

function sequentialWorkflowNodes(nodes) {
  return nodes.every((node, index) => {
    const dependencies = node.dependsOn || [];
    return index === 0
      ? dependencies.length === 0
      : dependencies.length === 1 && dependencies[0] === nodes[index - 1].id;
  });
}

function nextWorkflowStepId() {
  const ids = new Set(state.workflowDraftSteps.map((step) => step.id));
  let index = state.workflowDraftSteps.length + 1;
  while (ids.has(`step-${index}`)) index += 1;
  return `step-${index}`;
}

function markWorkflowDirty() {
  state.workflowDirty = true;
  $('#workflow-save-state').textContent = 'Unsaved changes';
  $('#trigger-workflow').disabled = true;
}

function setWorkflowTriggerKind(kind, dirty = false) {
  state.workflowTriggerKind = kind === 'event' ? 'event' : 'manual';
  for (const button of $$('#workflow-trigger-kind button')) {
    button.classList.toggle(
      'active',
      button.dataset.workflowTrigger === state.workflowTriggerKind,
    );
  }
  const eventTrigger = state.workflowTriggerKind === 'event';
  $('#workflow-event-type-field').hidden = !eventTrigger;
  $('#workflow-trigger-label').textContent = eventTrigger
    ? $('#workflow-event-type').value.trim() || 'Event'
    : 'Manual';
  if (dirty) markWorkflowDirty();
}

function moveWorkflowStep(index, offset) {
  const target = index + offset;
  if (target < 0 || target >= state.workflowDraftSteps.length) return;
  const [step] = state.workflowDraftSteps.splice(index, 1);
  state.workflowDraftSteps.splice(target, 0, step);
  renderWorkflowSteps();
  markWorkflowDirty();
}

function removeWorkflowStep(index) {
  if (state.workflowDraftSteps.length <= 1) return;
  state.workflowDraftSteps.splice(index, 1);
  renderWorkflowSteps();
  markWorkflowDirty();
}

function renderWorkflowSteps() {
  const root = $('#workflow-steps');
  root.replaceChildren();
  const advanced = state.workflowGraphMode === 'advanced';
  const dependencyIds = new Set(
    state.workflowDraftSteps.flatMap((step) => step.dependsOn || []),
  );
  $('#workflow-step-count').textContent = advanced
    ? `${state.workflowDraftSteps.length} graph nodes`
    : `${state.workflowDraftSteps.length} steps`;
  $('#add-workflow-step').hidden = advanced;

  state.workflowDraftSteps.forEach((step, index) => {
    const row = element('div', 'workflow-step-row');
    const marker = element('div', 'workflow-step-marker');
    marker.append(
      element('strong', '', String(index + 1)),
      element(
        'small',
        '',
        advanced
          ? step.publish ?? !dependencyIds.has(step.id)
            ? 'Publish'
            : 'Node'
          : index === state.workflowDraftSteps.length - 1
            ? 'Publish'
            : 'Agent',
      ),
    );

    const fields = element('div', 'workflow-step-fields');
    const nameLabel = element('label', 'field workflow-step-name');
    nameLabel.append(element('span', '', 'Step name'));
    const name = document.createElement('input');
    name.value = step.name || '';
    name.required = true;
    name.autocomplete = 'off';
    name.addEventListener('input', () => {
      step.name = name.value;
      markWorkflowDirty();
    });
    nameLabel.append(name);

    const instructionLabel = element('label', 'field workflow-step-instructions');
    instructionLabel.append(element('span', '', 'Instructions'));
    const instructions = document.createElement('textarea');
    instructions.rows = 3;
    instructions.required = true;
    instructions.spellcheck = true;
    instructions.placeholder = 'What should this agent produce?';
    instructions.value = step.instructions || '';
    instructions.addEventListener('input', () => {
      step.instructions = instructions.value;
      markWorkflowDirty();
    });
    instructionLabel.append(instructions);
    fields.append(nameLabel, instructionLabel);

    const actions = element('div', 'workflow-step-actions');
    for (const action of [
      { label: 'Move step up', symbol: '↑', disabled: index === 0, offset: -1 },
      {
        label: 'Move step down',
        symbol: '↓',
        disabled: index === state.workflowDraftSteps.length - 1,
        offset: 1,
      },
    ]) {
      const button = element('button', 'square-button workflow-step-button', action.symbol);
      button.type = 'button';
      button.title = action.label;
      button.setAttribute('aria-label', action.label);
      button.disabled = advanced || action.disabled;
      button.addEventListener('click', () => moveWorkflowStep(index, action.offset));
      actions.append(button);
    }
    const remove = element('button', 'square-button workflow-step-button remove', '×');
    remove.type = 'button';
    remove.title = 'Remove step';
    remove.setAttribute('aria-label', 'Remove step');
    remove.disabled = advanced || state.workflowDraftSteps.length <= 1;
    remove.addEventListener('click', () => removeWorkflowStep(index));
    actions.append(remove);

    row.append(marker, fields, actions);
    root.append(row);
  });
}

function workflowNodeLabel(execution, nodeId) {
  return (
    execution.workflow?.nodes?.find((node) => node.id === nodeId)?.name || nodeId
  );
}

function renderWorkflowExecutions(workflow) {
  const root = $('#workflow-executions');
  root.replaceChildren();
  const executions = workflow ? workflowExecutions(workflow.id) : [];
  $('#workflow-execution-count').textContent = `${executions.length} recorded`;
  if (!executions.length) {
    root.append(
      element(
        'div',
        'empty-state',
        workflow ? 'No executions yet' : 'Save the workflow to create executions',
      ),
    );
    return;
  }
  for (const execution of executions.slice(0, 20)) {
    const row = element('div', 'workflow-execution-row');
    const copy = element('div', 'workflow-execution-copy');
    copy.append(
      element(
        'strong',
        '',
        `${workflowTriggerLabel(execution.trigger)} / ${formatTime(execution.createdAt, true)}`,
      ),
      element(
        'small',
        '',
        execution.error || execution.summary || shortId(execution.id),
      ),
    );
    const nodes = element('div', 'workflow-node-statuses');
    for (const node of execution.nodes || []) {
      const nodeStatus = element('span', `workflow-node-status ${node.status}`);
      nodeStatus.title = statusLabel(node.status);
      nodeStatus.append(
        element('i'),
        document.createTextNode(workflowNodeLabel(execution, node.nodeId)),
      );
      nodes.append(nodeStatus);
    }
    copy.append(nodes);
    row.append(
      statePill(execution.status),
      copy,
      element('span', 'workflow-execution-time', formatTime(execution.updatedAt, true)),
    );
    const latestRun = [...(execution.nodes || [])].reverse().find((node) => node.runId);
    if (latestRun) {
      const open = element('button', 'routine-run-link', 'Open run');
      open.type = 'button';
      open.addEventListener('click', () => void openRoutineRun(latestRun.runId));
      row.append(open);
    } else {
      row.append(element('span', 'workflow-execution-time', 'Not queued'));
    }
    root.append(row);
  }
}

function renderWorkflowList() {
  const root = $('#workflow-list');
  root.replaceChildren();
  const workflows = state.workflows?.workflows || [];
  if (!workflows.length) {
    root.append(element('div', 'empty-state', 'No workflows configured'));
    return;
  }
  for (const workflow of workflows) {
    const project = projectById(workflow.projectId);
    const button = element('button', 'project-list-item');
    button.type = 'button';
    button.classList.toggle('active', workflow.id === state.selectedWorkflowId);
    button.append(
      element('strong', '', workflow.name),
      element(
        'span',
        '',
        `${workflow.enabled ? 'Enabled' : 'Disabled'} / ${project?.name || workflow.projectId} / ${workflowTriggerLabel(workflow.trigger)}`,
      ),
    );
    button.addEventListener('click', () => selectWorkflow(workflow.id));
    root.append(button);
  }
}

function fillWorkflowForm(workflow) {
  const isNew = !workflow;
  const defaultProjectId = state.workspace?.projects?.[0]?.projectId || '';
  const projectId = workflow?.projectId || defaultProjectId;
  $('#workflow-editor-title').textContent = workflow?.name || 'New workflow';
  $('#workflow-state').textContent = isNew
    ? 'Draft'
    : workflow.enabled
      ? 'Enabled'
      : 'Disabled';
  $('#workflow-state').className = `state-pill ${isNew ? 'planned' : workflow.enabled ? 'enabled' : 'disabled'}`;
  $('#workflow-name').value = workflow?.name || '';
  $('#workflow-description').value = workflow?.description || '';
  $('#workflow-enabled').checked = workflow?.enabled ?? true;
  fillWorkflowProjectOptions(projectId);
  $('#workflow-event-type').value =
    workflow?.trigger?.kind === 'event' ? workflow.trigger.eventType : '';
  setWorkflowTriggerKind(workflow?.trigger?.kind || 'manual');
  $('#workflow-platform').value = workflow?.destination?.platform || 'lark';
  $('#workflow-external-id').value = workflow?.destination?.externalId || '';
  $('#workflow-visibility').value = workflow?.destination?.visibility || 'public';
  $('#workflow-thread-id').value = workflow?.destination?.threadId || '';
  if (isNew) fillWorkflowDestination();
  const nodes = workflow?.nodes || defaultWorkflowSteps();
  state.workflowGraphMode = sequentialWorkflowNodes(nodes) ? 'sequential' : 'advanced';
  $('#workflow-destination-label').textContent =
    state.workflowGraphMode === 'advanced' ? 'Sink nodes' : 'Final step';
  state.workflowDraftSteps = nodes.map((node) => ({
    id: node.id,
    name: node.name || '',
    instructions: node.instructions || '',
    dependsOn: node.dependsOn ? [...node.dependsOn] : undefined,
    publish: node.publish,
  }));
  renderWorkflowSteps();
  $('#archive-workflow').hidden = isNew;
  $('#trigger-workflow').disabled = isNew;
  renderWorkflowExecutions(workflow);
  state.workflowDirty = false;
  $('#workflow-save-state').textContent = isNew
    ? 'New workflow'
    : `Version ${workflow.version}`;
}

function selectWorkflow(workflowId) {
  if (state.workflowDirty && !window.confirm('Discard unsaved workflow changes?')) return;
  state.selectedWorkflowId = workflowId;
  renderWorkflowList();
  fillWorkflowForm(workflowById(workflowId));
}

function newWorkflow() {
  if (state.workflowDirty && !window.confirm('Discard unsaved workflow changes?')) return;
  state.selectedWorkflowId = '__new__';
  renderWorkflowList();
  fillWorkflowForm(null);
  $('#workflow-name').focus();
}

function addWorkflowStep() {
  if (state.workflowGraphMode === 'advanced') return;
  state.workflowDraftSteps.push({
    id: nextWorkflowStepId(),
    name: '',
    instructions: '',
  });
  renderWorkflowSteps();
  markWorkflowDirty();
  $('#workflow-steps .workflow-step-row:last-child input')?.focus();
}

function workflowPayload() {
  const existing = workflowById(state.selectedWorkflowId);
  const name = $('#workflow-name').value.trim();
  const projectId = $('#workflow-project').value;
  const externalId = $('#workflow-external-id').value.trim();
  const eventType = $('#workflow-event-type').value.trim();
  if (!name || !projectId || !externalId) {
    throw new Error('Name, project, and channel ID are required');
  }
  if (state.workflowTriggerKind === 'event' && !eventType) {
    throw new Error('Event type is required');
  }
  if (!state.workflowDraftSteps.length) throw new Error('Add at least one step');
  for (const step of state.workflowDraftSteps) {
    if (!step.name.trim() || !step.instructions.trim()) {
      throw new Error('Every step needs a name and instructions');
    }
  }
  const sequential = state.workflowGraphMode === 'sequential';
  return {
    id: existing?.id,
    workspaceId: currentWorkspaceId(),
    projectId,
    name,
    description: $('#workflow-description').value.trim() || undefined,
    enabled: $('#workflow-enabled').checked,
    trigger:
      state.workflowTriggerKind === 'event'
        ? { kind: 'event', eventType }
        : { kind: 'manual' },
    nodes: state.workflowDraftSteps.map((step, index) => ({
      id: step.id,
      name: step.name.trim(),
      instructions: step.instructions.trim(),
      dependsOn: sequential
        ? index > 0
          ? [state.workflowDraftSteps[index - 1].id]
          : undefined
        : step.dependsOn,
      publish: sequential
        ? index === state.workflowDraftSteps.length - 1
        : step.publish,
    })),
    destination: {
      platform: $('#workflow-platform').value,
      externalId,
      channelId: externalId,
      threadId: $('#workflow-thread-id').value.trim() || undefined,
      visibility: $('#workflow-visibility').value,
      title: name,
    },
  };
}

async function saveWorkflow(event) {
  event.preventDefault();
  const button = $('#save-workflow');
  setButtonBusy(button, true, 'Saving', 'Save workflow');
  try {
    const data = await getJson('/v1/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflowPayload()),
    });
    state.workflows = data.workflows;
    state.selectedWorkflowId = data.workflow.id;
    state.workflowDirty = false;
    renderWorkflows();
    renderWorkspaceHeader();
    renderSummary();
    showToast('Workflow saved');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Save workflow');
  }
}

async function triggerWorkflow() {
  const workflow = workflowById(state.selectedWorkflowId);
  if (!workflow) return;
  const button = $('#trigger-workflow');
  setButtonBusy(button, true, 'Starting', 'Run now');
  try {
    const data = await getJson(
      `/v1/workflows/${encodeURIComponent(workflow.id)}/trigger`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    state.workflows = data.workflows;
    renderWorkflows();
    showToast(`Workflow accepted / ${statusLabel(data.execution.status)}`);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Starting', 'Run now');
  }
}

async function archiveWorkflow() {
  const workflow = workflowById(state.selectedWorkflowId);
  if (!workflow || !window.confirm(`Archive ${workflow.name}?`)) return;
  const button = $('#archive-workflow');
  setButtonBusy(button, true, 'Archiving', 'Archive');
  try {
    const data = await getJson(`/v1/workflows/${encodeURIComponent(workflow.id)}`, {
      method: 'DELETE',
    });
    state.workflows = data.workflows;
    state.selectedWorkflowId = state.workflows.workflows?.[0]?.id || '__new__';
    state.workflowDirty = false;
    renderWorkflows();
    renderWorkspaceHeader();
    showToast('Workflow archived');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Archiving', 'Archive');
  }
}

async function tickWorkflows() {
  const button = $('#tick-workflows');
  setButtonBusy(button, true, 'Ticking', 'Tick now');
  try {
    const data = await getJson('/v1/workflows/tick', { method: 'POST' });
    state.workflows = data.workflows;
    renderWorkflows();
    showToast(
      `Claimed ${data.result.claimed} / queued ${data.result.queued} / failed ${data.result.failed}`,
    );
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Ticking', 'Tick now');
  }
}

function renderWorkflows() {
  const coordinator = state.workflows?.coordinator || {};
  const coordinatorLabel = !coordinator.enabled
    ? 'Disabled'
    : coordinator.mode === 'external'
      ? 'External'
      : coordinator.mode === 'manual'
        ? 'Manual'
        : 'Inline';
  $('#workflow-coordinator-state').textContent = coordinatorLabel;
  $('#workflow-coordinator-state').className = `state-pill ${coordinator.enabled ? 'enabled' : 'disabled'}`;
  const modeDetail = coordinator.mode === 'external'
    ? 'Independent coordinator'
    : coordinator.mode === 'manual'
      ? 'Manual ticks only'
      : 'Server coordinator';
  const interval = coordinator.tickIntervalMs
    ? `${Math.max(1, Math.round(coordinator.tickIntervalMs / 1000))}s poll`
    : 'on demand';
  $('#workflow-coordinator-detail').textContent = coordinator.lastTickAt
    ? `${modeDetail} / ${interval} / last ${formatTime(coordinator.lastTickAt, true)}`
    : `${modeDetail} / ${interval}`;
  const available = state.workflows?.workflows || [];
  if (
    state.selectedWorkflowId !== '__new__' &&
    !workflowById(state.selectedWorkflowId)
  ) {
    state.selectedWorkflowId = available[0]?.id || '__new__';
  }
  renderWorkflowList();
  if (!state.workflowDirty) {
    fillWorkflowForm(workflowById(state.selectedWorkflowId));
  }
}

function runTitle(run) {
  if (run.metadata?.source === 'steering') {
    return `Follow-up: ${run.message?.text || run.summary?.split('\n')[0] || shortId(run.id)}`;
  }
  return (
    run.metadata?.workflowName ||
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
  const steering = state.delivery?.summary?.steering || {};
  const waiting = (steering.pending || 0) + (steering.claimed || 0) + (steering.scheduled || 0);
  $('#steering-count').textContent = `${waiting} follow-up${waiting === 1 ? '' : 's'} waiting`;
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
    renderRunDetail(data.run, data.events || [], data.steering || []);
  } catch (error) {
    detail.replaceChildren(element('div', 'empty-state', error.message));
  }
}

function renderRunDetail(run, events, steering = []) {
  const detail = $('#run-detail');
  detail.replaceChildren();
  const head = element('div', 'run-detail-head');
  const copy = element('div');
  copy.append(
    element('strong', '', runTitle(run)),
    element(
      'small',
      '',
      `${shortId(run.id)} / ${run.executorId || 'executor'} / ${run.metadata?.steeringMode ? statusLabel(run.metadata.steeringMode) : 'Steering pending'} / ${run.workerId || 'unclaimed'}`,
    ),
  );
  head.append(copy, statePill(run.status));
  detail.append(head);
  if (run.summary) detail.append(element('div', 'run-summary', run.summary));

  if (['queued', 'running', 'cancel_requested'].includes(run.status)) {
    const controls = element('div', 'run-controls');
    if (run.status !== 'cancel_requested') {
      const form = element('form', 'run-steer-form');
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'text';
      input.placeholder = 'Add a follow-up';
      input.maxLength = 4000;
      input.required = true;
      const send = element('button', 'primary-button', 'Send');
      send.type = 'submit';
      form.append(input, send);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void steerRun(run.id, input, send);
      });
      controls.append(form);
    }
    const cancel = element('button', 'secondary-button', 'Cancel run');
    cancel.type = 'button';
    cancel.addEventListener('click', () => void cancelRun(run.id, cancel));
    controls.append(cancel);
    detail.append(controls);
  }

  if (steering.length) {
    const followUps = element('div', 'run-followups');
    followUps.append(element('h3', '', 'Follow-ups'));
    for (const item of [...steering].sort((a, b) => a.sequence - b.sequence)) {
      const row = element('div', 'run-followup-row');
      const copy = element('div');
      copy.append(
        element('strong', '', item.message?.text || shortId(item.id)),
        element(
          'small',
          '',
          `${item.message?.actor?.displayName || item.message?.actor?.id || 'Operator'} / ${item.mode ? statusLabel(item.mode) : 'Waiting'}`,
        ),
      );
      row.append(copy, statePill(item.status));
      followUps.append(row);
    }
    detail.append(followUps);
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

async function steerRun(runId, input, button) {
  const text = input.value.trim();
  if (!text) return;
  setButtonBusy(button, true, 'Sending', 'Send');
  try {
    await getJson(`/v1/runs/${encodeURIComponent(runId)}/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    input.value = '';
    await refreshAll({ quiet: true });
    await openRun(runId);
    showToast('Follow-up queued');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Sending', 'Send');
  }
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
  state.pairingProjectId =
    projectById(state.pairingProjectId)?.projectId ||
    projectById(state.selectedProjectId)?.projectId ||
    fallback;
  fillProjectSelect($('#memory-project'), state.memoryProjectId);
  fillProjectSelect($('#test-project'), state.testProjectId);
  fillProjectSelect($('#pairing-project'), state.pairingProjectId);
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

function memoryRevisionSummary(revision) {
  if (revision.action === 'forget') {
    return revision.selector
      ? `Removed lines matching "${revision.selector}"`
      : 'Removed matching lines';
  }
  if (revision.action === 'restore') return 'Restored an earlier snapshot';
  if (revision.action === 'import') return 'Imported legacy memory';
  const lines = String(revision.content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines
      .at(-1)
      ?.replace(/^-\s+/, '')
      .replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, '') || 'Saved an empty snapshot'
  );
}

function renderMemoryHistory(history) {
  const root = $('#memory-history-list');
  const revisions = history?.revisions || [];
  root.replaceChildren();
  if (!revisions.length) {
    root.append(element('div', 'empty-state', 'No revisions in this scope.'));
    return;
  }
  const currentRevisionId = history?.document?.latestRevisionId;
  const viewer = state.auth?.principal?.role === 'viewer';
  for (const revision of revisions) {
    const row = element('div', 'memory-revision-row');
    const version = element('div', 'memory-revision-version');
    version.append(
      element('strong', '', `v${revision.version}`),
      element('span', '', statusLabel(revision.action)),
    );
    const detail = element('div', 'memory-revision-detail');
    detail.append(
      element('strong', '', memoryRevisionSummary(revision)),
      element(
        'span',
        '',
        `${revision.actorId || 'Unknown actor'} / ${formatTime(revision.at, true)}`,
      ),
    );
    const current = revision.id === currentRevisionId;
    const restore = element(
      'button',
      'secondary-button',
      current ? 'Current' : 'Restore',
    );
    restore.type = 'button';
    restore.disabled = viewer || current;
    restore.addEventListener('click', () => void restoreMemory(revision.id));
    row.append(version, detail, restore);
    root.append(row);
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
    const document = data.history?.document;
    $('#memory-output').textContent = content || 'No memory in this scope.';
    $('#memory-meta').textContent = document
      ? `v${document.version} / ${formatTime(document.updatedAt, true)}`
      : 'No revisions';
    renderMemoryHistory(data.history);
  } catch (error) {
    $('#memory-output').textContent = error.message;
    $('#memory-meta').textContent = 'Unavailable';
    renderMemoryHistory();
  }
}

async function restoreMemory(revisionId) {
  try {
    await getJson('/v1/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...memoryThread(),
        action: 'restore',
        revisionId,
      }),
    });
    await refreshMemory();
    showToast('Memory revision restored');
  } catch (error) {
    showToast(error.message, 'error');
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
        platform: $('#test-client').value,
        workspaceId: project?.workspaceId || currentWorkspaceId(),
        projectId: project?.projectId || 'opentag',
        projectName: project?.name,
      }),
    });
    const cards = data.larkDryRun?.cards || [];
    const texts = data.larkDryRun?.texts || [];
    const telegramTexts = data.telegramDryRun?.texts || [];
    const telegramEdits = data.telegramDryRun?.edits || [];
    if (cards.length) {
      renderCard(cards.at(-1).card);
    } else if (data.telegramDryRun) {
      const receipt = $('#card');
      receipt.className = 'lark-card telegram-receipt';
      receipt.textContent =
        telegramEdits.at(-1)?.text || telegramTexts[0]?.text || 'No progress receipt';
    }
    $('#test-output').textContent =
      telegramTexts.at(-1)?.text ||
      texts.at(-1)?.text ||
      data.result?.summary ||
      JSON.stringify(data.result, null, 2);
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
  renderAccess();
  fillProjectSelects();
  renderConnectorConsole();
  renderOverviewRuns();
  renderProjectList();
  renderRoutines();
  renderWorkflows();
  renderRunTable();
  renderDelivery();

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
    const workspaceId = encodeURIComponent(currentWorkspaceId());
    const [
      health,
      capabilities,
      workspace,
      access,
      delivery,
      runs,
      bindings,
      routines,
      workflows,
      pairings,
    ] =
      await Promise.all([
        getJson('/health'),
        getJson(`/v1/capabilities?workspaceId=${workspaceId}`),
        getJson(`/v1/workspace?workspaceId=${workspaceId}`),
        getJson(`/v1/access?workspaceId=${workspaceId}`),
        getJson(`/v1/deliveries?limit=20&workspaceId=${workspaceId}`),
        getJson(`/v1/runs?limit=50&workspaceId=${workspaceId}`),
        getJson(`/v1/bindings?limit=100&workspaceId=${workspaceId}`),
        getJson(`/v1/routines?workspaceId=${workspaceId}`),
        getJson(`/v1/workflows?workspaceId=${workspaceId}`),
        getJson(`/v1/pairing-invitations?workspaceId=${workspaceId}`),
      ]);
    state.health = health;
    state.capabilities = capabilities;
    state.workspace = workspace;
    state.access = access;
    state.delivery = delivery;
    state.runs = runs.runs || [];
    state.bindings = bindings.bindings || [];
    state.routines = routines;
    state.workflows = workflows;
    state.pairings = pairings;
    const fallback = workspace.projects?.[0]?.projectId;
    state.selectedProjectId = projectById(state.selectedProjectId)?.projectId || fallback;
    state.selectedAccessProjectId =
      projectById(state.selectedAccessProjectId)?.projectId || fallback;
    state.memoryProjectId = projectById(state.memoryProjectId)?.projectId || fallback;
    renderAll();
    applyOperatorCapabilities();
    $('#sync-label').textContent = `Synced ${formatTime(new Date().toISOString())}`;
    if (!$('#view-memory').hidden) await refreshMemory();
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

$('#auth-form').addEventListener('submit', (event) => void signInOperator(event));
$('#sign-out').addEventListener('click', () => void signOutOperator());
$('#refresh-all').addEventListener('click', () => void refreshAll());
$('#open-test').addEventListener('click', () => $('#test-dialog').showModal());
$('#test-form').addEventListener('submit', (event) => void runTest(event));
$('#new-project').addEventListener('click', newProject);
$('#project-form').addEventListener('submit', (event) => void saveProject(event));
$('#access-member-form').addEventListener('submit', (event) => void saveAccessMember(event));
$('#access-policy-form').addEventListener('submit', (event) => void saveAccessPolicy(event));
$('#access-membership-form').addEventListener('submit', (event) =>
  void assignProjectMember(event),
);
$('#save-binding').addEventListener('click', () => void saveBinding());
$('#pairing-form').addEventListener('submit', (event) => void generatePairing(event));
$('#copy-pairing').addEventListener('click', () => void copyPairingCommand());
$('#new-routine').addEventListener('click', newRoutine);
$('#routine-form').addEventListener('submit', (event) => void saveRoutine(event));
$('#trigger-routine').addEventListener('click', () => void triggerRoutine());
$('#delete-routine').addEventListener('click', () => void deleteRoutine());
$('#tick-routines').addEventListener('click', () => void tickRoutines());
$('#new-workflow').addEventListener('click', newWorkflow);
$('#workflow-form').addEventListener('submit', (event) => void saveWorkflow(event));
$('#trigger-workflow').addEventListener('click', () => void triggerWorkflow());
$('#archive-workflow').addEventListener('click', () => void archiveWorkflow());
$('#tick-workflows').addEventListener('click', () => void tickWorkflows());
$('#add-workflow-step').addEventListener('click', addWorkflowStep);
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

for (const input of $$('#workflow-form input, #workflow-form select')) {
  input.addEventListener('input', markWorkflowDirty);
  input.addEventListener('change', markWorkflowDirty);
}

for (const button of $$('#workflow-trigger-kind button')) {
  button.addEventListener('click', () =>
    setWorkflowTriggerKind(button.dataset.workflowTrigger, true),
  );
}

$('#workflow-event-type').addEventListener('input', () =>
  setWorkflowTriggerKind('event'),
);

$('#routine-schedule-kind').addEventListener('change', updateRoutineScheduleFields);
$('#routine-project').addEventListener('change', () => fillRoutineDestination(true));
$('#routine-platform').addEventListener('change', () => fillRoutineDestination(true));
$('#workflow-project').addEventListener('change', () => fillWorkflowDestination(true));
$('#workflow-platform').addEventListener('change', () => fillWorkflowDestination(true));

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

$('#pairing-project').addEventListener('change', (event) => {
  state.pairingProjectId = event.target.value;
});

$('#access-project').addEventListener('change', (event) => {
  state.selectedAccessProjectId = event.target.value;
  renderProjectAccess();
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
    {
      workspaceId: currentWorkspaceId(),
      olderThanMs: 120000,
      reason: 'admin_console_recovery',
    },
  ),
);

const initialView = location.hash.slice(1);
showView(viewCopy[initialView] ? initialView : 'overview', false);
if (await loadOperatorSession()) await refreshAll();

setInterval(() => {
  if (
    document.visibilityState === 'visible' &&
    state.auth?.authenticated &&
    !state.projectDirty &&
    !state.routineDirty &&
    !state.workflowDirty
  ) {
    void refreshAll({ quiet: true });
  }
}, 10000);
