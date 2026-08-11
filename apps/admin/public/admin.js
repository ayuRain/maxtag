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
  pairings: null,
  runs: [],
  bindings: [],
  selectedProjectId: null,
  selectedAccessProjectId: null,
  selectedRoutineId: null,
  selectedRunId: null,
  runFilter: '',
  memoryScope: 'project',
  memoryProjectId: null,
  testProjectId: null,
  pairingProjectId: null,
  latestPairing: null,
  projectDirty: false,
  routineDirty: false,
};

const viewCopy = {
  overview: { eyebrow: 'Workspace', title: 'Overview' },
  projects: { eyebrow: 'Routing and access', title: 'Projects' },
  access: { eyebrow: 'Identity and roles', title: 'Access' },
  connectors: { eyebrow: 'Multi-client routing', title: 'Connectors' },
  routines: { eyebrow: 'Proactive work', title: 'Routines' },
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
    '#trigger-routine',
    '#delete-routine',
    '#pairing-form button[type="submit"]',
    '#memory-form button[type="submit"]',
    '#forget-memory',
    '#open-test',
    '#recover-delivery',
  ]) {
    const control = $(selector);
    if (control) control.disabled = viewer;
  }
  for (const selector of ['#tick-routines', '#worker-pass', '#recover-runs']) {
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
    (state.routines?.summary?.executions?.failed || 0);
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
    !state.routineDirty
  ) {
    void refreshAll({ quiet: true });
  }
}, 10000);
