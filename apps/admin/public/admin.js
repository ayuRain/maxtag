const health = document.querySelector('#health');
const capabilityLine = document.querySelector('#capability-line');
const promptInput = document.querySelector('#prompt');
const runButton = document.querySelector('#run');
const card = document.querySelector('#card');
const output = document.querySelector('#output');
const clients = document.querySelector('#clients');
const memoryScopes = document.querySelector('#memory-scopes');
const parity = document.querySelector('#parity');
const routeLine = document.querySelector('#route-line');
const delivery = document.querySelector('#delivery');
const recoverDeliveryButton = document.querySelector('#recover-delivery');
const cancelDeliveryButton = document.querySelector('#cancel-delivery');
const bindings = document.querySelector('#bindings');
const bindingForm = document.querySelector('#binding-form');
const bindingExternalId = document.querySelector('#binding-external-id');
const bindingWorkspaceId = document.querySelector('#binding-workspace-id');
const bindingProjectId = document.querySelector('#binding-project-id');
const bindingActivationMode = document.querySelector('#binding-activation-mode');
const bindingRequireMention = document.querySelector('#binding-require-mention');
const saveBindingButton = document.querySelector('#save-binding');
const memoryForm = document.querySelector('#memory-form');
const memoryScope = document.querySelector('#memory-scope');
const memoryText = document.querySelector('#memory-text');
const memoryOutput = document.querySelector('#memory-output');
const showMemoryButton = document.querySelector('#show-memory');
const saveMemoryButton = document.querySelector('#save-memory');
const forgetMemoryButton = document.querySelector('#forget-memory');

async function getJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || data.error || response.statusText);
  }
  return data;
}

function appendText(parent, className, text) {
  const element = document.createElement('div');
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function appendState(parent, status) {
  const element = document.createElement('span');
  element.className = `state ${status || 'planned'}`;
  element.textContent = status || 'planned';
  parent.append(element);
  return element;
}

function renderRows(parent, rows, createRow) {
  parent.replaceChildren();
  for (const rowData of rows) parent.append(createRow(rowData));
}

function findCardText(cardDoc, prefix) {
  for (const element of cardDoc.elements || []) {
    const content = element.text?.content;
    if (typeof content === 'string' && content.startsWith(prefix)) {
      return content.replace(prefix, '').trim();
    }
  }
  return '';
}

function findChecklist(cardDoc) {
  const statusMarkers = ['○ ', '● ', '✓ ', '! ', '- '];
  for (const element of cardDoc.elements || []) {
    const content = element.text?.content;
    if (typeof content !== 'string') continue;
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => statusMarkers.some((marker) => line.startsWith(marker)));
    if (lines.length) return lines;
  }
  return [];
}

function renderCard(cardDoc) {
  const title = cardDoc.header?.title?.content || 'OpenTag run';
  const template = cardDoc.header?.template || '';
  const status = findCardText(cardDoc, '**Status:**');
  const summary = findCardText(cardDoc, '**Summary:**');
  const checklist = findChecklist(cardDoc);

  card.className = 'lark-card';
  card.replaceChildren();

  appendText(card, `card-header ${template}`, title);
  const body = document.createElement('div');
  body.className = 'card-body';
  appendText(body, 'card-line', `Status: ${status || 'unknown'}`);
  if (summary) appendText(body, 'card-line', `Summary: ${summary}`);

  const list = document.createElement('div');
  list.className = 'checklist';
  for (const item of checklist) {
    const row = document.createElement('div');
    row.className = 'check-item';
    const symbol = document.createElement('span');
    symbol.className = 'check-symbol';
    symbol.textContent = item.slice(0, 1);
    const label = document.createElement('span');
    label.textContent = item.slice(2);
    row.append(symbol, label);
    list.append(row);
  }
  body.append(list);
  card.append(body);
}

function renderClients(items) {
  renderRows(clients, items, (item) => {
    const row = document.createElement('div');
    row.className = 'client-row';
    appendText(row, 'row-main', item.label || item.id);
    appendState(row, item.status);
    appendText(row, 'row-detail', item.surface || item.inbound || '');
    return row;
  });
}

function renderMemoryScopes(items) {
  renderRows(memoryScopes, items, (item) => {
    const row = document.createElement('div');
    row.className = 'scope-row';
    appendText(row, 'row-main', item.label || item.id);
    appendState(row, item.status);
    appendText(row, 'row-detail', item.description || '');
    return row;
  });
}

function renderParity(items) {
  renderRows(parity, items, (item) => {
    const row = document.createElement('div');
    row.className = 'parity-row';
    appendText(row, 'row-main', item.capability);
    appendState(row, item.status);
    appendText(row, 'row-detail', item.opentag);
    return row;
  });
}

function renderMetricStrip(keys, summary) {
  const metrics = document.createElement('div');
  metrics.className = 'metric-strip';
  for (const key of keys) {
    const metric = document.createElement('div');
    metric.className = 'metric';
    const value = document.createElement('strong');
    value.textContent = String(summary?.[key] || 0);
    const label = document.createElement('span');
    label.textContent = key;
    metric.append(value, label);
    metrics.append(metric);
  }
  return metrics;
}

function renderDelivery(data) {
  delivery.replaceChildren();

  appendText(delivery, 'subhead', 'Outbound');
  delivery.append(renderMetricStrip(
    ['delivered', 'pending', 'sending', 'failed', 'cancelled'],
    data?.summary?.outbox,
  ));

  const outboundList = document.createElement('div');
  outboundList.className = 'delivery-list';
  for (const item of (data?.outbox || []).slice(0, 4)) {
    const row = document.createElement('div');
    row.className = 'delivery-row';
    appendText(row, 'row-main', item.kind);
    appendState(row, item.status);
    appendText(
      row,
      'row-detail',
      `${item.target?.chatId || item.target?.cardId || 'target'} · #${item.sequence}`,
    );
    outboundList.append(row);
  }

  appendText(delivery, 'subhead', 'Inbound');
  delivery.append(renderMetricStrip(
    ['processed', 'duplicates', 'rejected', 'failed'],
    data?.summary?.inboundEvents,
  ));

  const inboundList = document.createElement('div');
  inboundList.className = 'delivery-list';
  for (const item of (data?.inboundEvents || []).slice(0, 4)) {
    const row = document.createElement('div');
    row.className = 'delivery-row';
    appendText(row, 'row-main', item.eventType || item.platform);
    appendState(row, item.status);
    appendText(
      row,
      'row-detail',
      `${item.externalId}${item.duplicateCount ? ` · dup ${item.duplicateCount}` : ''}`,
    );
    inboundList.append(row);
  }

  delivery.append(outboundList, inboundList);
}

function renderBindings(items) {
  renderRows(bindings, items, (item) => {
    const row = document.createElement('div');
    row.className = 'binding-row';
    appendText(row, 'row-main', item.externalId);
    appendText(row, 'row-detail', `${item.workspaceId} / ${item.projectId}`);
    appendState(row, item.activationMode || 'mention');
    return row;
  });
}

async function refreshHealth() {
  try {
    await getJson('/health');
    health.textContent = 'online';
    health.classList.add('ok');
  } catch (error) {
    health.textContent = 'offline';
    health.classList.remove('ok');
  }
}

async function refreshCapabilities() {
  const data = await getJson('/v1/capabilities');
  const lark = (data.clients || []).find((client) => client.id === 'lark');
  const activeClients = (data.clients || []).length;
  const activeScopes = (data.memoryScopes || []).length;
  const transport = data.larkTransport?.mode || 'memory';
  capabilityLine.textContent = `${lark?.label || 'Lark'} ${lark?.status || 'ready'} · ${transport} transport · ${activeClients} clients · ${activeScopes} memory scopes`;
  renderClients(data.clients || []);
  renderMemoryScopes(data.memoryScopes || []);
  renderParity(data.parity || []);
}

async function refreshDelivery() {
  try {
    renderDelivery(await getJson('/v1/deliveries?limit=4'));
  } catch (error) {
    delivery.textContent = error.message;
  }
}

async function recoverDelivery() {
  recoverDeliveryButton.disabled = true;
  recoverDeliveryButton.textContent = 'Recovering';
  try {
    const data = await getJson('/v1/deliveries/recover-stale', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        olderThanMs: 120000,
        reason: 'admin_recover_stale',
      }),
    });
    renderDelivery(data.delivery);
    routeLine.textContent = `requeued ${data.result?.requeued || 0}`;
  } catch (error) {
    routeLine.textContent = error.message;
  } finally {
    recoverDeliveryButton.disabled = false;
    recoverDeliveryButton.textContent = 'Recover';
  }
}

async function cancelProjectDelivery() {
  cancelDeliveryButton.disabled = true;
  cancelDeliveryButton.textContent = 'Cancelling';
  try {
    const data = await getJson('/v1/deliveries/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: bindingWorkspaceId.value,
        projectId: bindingProjectId.value,
        reason: 'admin_cancel_project',
      }),
    });
    renderDelivery(data.delivery);
    routeLine.textContent = `cancelled ${data.result?.cancelled || 0}`;
  } catch (error) {
    routeLine.textContent = error.message;
  } finally {
    cancelDeliveryButton.disabled = false;
    cancelDeliveryButton.textContent = 'Cancel project';
  }
}

async function refreshBindings() {
  try {
    const data = await getJson('/v1/bindings?limit=8');
    renderBindings(data.bindings || []);
  } catch (error) {
    bindings.textContent = error.message;
  }
}

async function saveBinding(event) {
  event.preventDefault();
  saveBindingButton.disabled = true;
  saveBindingButton.textContent = 'Saving';
  try {
    await getJson('/v1/bindings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'lark',
        externalId: bindingExternalId.value,
        channelId: bindingExternalId.value,
        workspaceId: bindingWorkspaceId.value,
        projectId: bindingProjectId.value,
        scope: 'channel',
        activationMode: bindingActivationMode.value,
        requireMention: bindingRequireMention.checked,
      }),
    });
    await refreshBindings();
    await refreshDelivery();
  } catch (error) {
    routeLine.textContent = error.message;
  } finally {
    saveBindingButton.disabled = false;
    saveBindingButton.textContent = 'Save';
  }
}

function memoryRouteParams() {
  return {
    platform: 'lark',
    externalId: bindingExternalId.value,
    channelId: bindingExternalId.value,
    workspaceId: bindingWorkspaceId.value,
    projectId: bindingProjectId.value,
    scope: memoryScope.value,
  };
}

function renderMemorySnapshot(data) {
  const scope = data?.snapshot?.scopes?.[0];
  const content = scope?.content?.trim();
  memoryOutput.textContent = content || 'No memory in this scope yet.';
}

async function refreshMemory() {
  const query = new URLSearchParams(memoryRouteParams());
  renderMemorySnapshot(await getJson(`/v1/memory?${query.toString()}`));
}

async function saveMemory(event) {
  event.preventDefault();
  saveMemoryButton.disabled = true;
  saveMemoryButton.textContent = 'Saving';
  try {
    await getJson('/v1/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...memoryRouteParams(),
        action: 'remember',
        text: memoryText.value,
      }),
    });
    await refreshMemory();
  } catch (error) {
    memoryOutput.textContent = error.message;
  } finally {
    saveMemoryButton.disabled = false;
    saveMemoryButton.textContent = 'Save';
  }
}

async function forgetMemory() {
  forgetMemoryButton.disabled = true;
  forgetMemoryButton.textContent = 'Forgetting';
  try {
    await getJson('/v1/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...memoryRouteParams(),
        action: 'forget',
        selector: memoryText.value,
      }),
    });
    await refreshMemory();
  } catch (error) {
    memoryOutput.textContent = error.message;
  } finally {
    forgetMemoryButton.disabled = false;
    forgetMemoryButton.textContent = 'Forget';
  }
}

async function runDryRun() {
  runButton.disabled = true;
  runButton.textContent = 'Running';
  output.textContent = 'Running...';
  routeLine.textContent = 'running';
  try {
    const data = await getJson('/v1/dev/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: promptInput.value }),
    });
    const firstCard = data.larkDryRun?.cards?.[0]?.card;
    const firstText = data.larkDryRun?.texts?.[0]?.text;
    if (firstCard) renderCard(firstCard);
    output.textContent = firstText || JSON.stringify(data.result, null, 2);
    renderDelivery(data.delivery);
    routeLine.textContent = data.route
      ? `${data.route.workspaceId || 'workspace'} / ${data.route.projectId || 'project'}`
      : 'completed';
  } catch (error) {
    output.textContent = error.message;
    routeLine.textContent = 'failed';
  } finally {
    runButton.disabled = false;
    runButton.textContent = 'Run';
  }
}

runButton.addEventListener('click', () => {
  void runDryRun();
});

recoverDeliveryButton.addEventListener('click', () => {
  void recoverDelivery();
});

cancelDeliveryButton.addEventListener('click', () => {
  void cancelProjectDelivery();
});

bindingForm.addEventListener('submit', (event) => {
  void saveBinding(event);
});

memoryForm.addEventListener('submit', (event) => {
  void saveMemory(event);
});

showMemoryButton.addEventListener('click', () => {
  void refreshMemory();
});

forgetMemoryButton.addEventListener('click', () => {
  void forgetMemory();
});

await refreshHealth();
await refreshCapabilities();
await refreshDelivery();
await refreshBindings();
