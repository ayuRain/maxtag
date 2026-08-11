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
  capabilityLine.textContent = `${lark?.label || 'Lark'} ${lark?.status || 'ready'} · ${activeClients} clients · ${activeScopes} memory scopes`;
  renderClients(data.clients || []);
  renderMemoryScopes(data.memoryScopes || []);
  renderParity(data.parity || []);
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

await refreshHealth();
await refreshCapabilities();
