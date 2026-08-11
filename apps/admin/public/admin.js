const health = document.querySelector('#health');
const capabilityLine = document.querySelector('#capability-line');
const promptInput = document.querySelector('#prompt');
const runButton = document.querySelector('#run');
const card = document.querySelector('#card');
const output = document.querySelector('#output');

async function getJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || data.error || response.statusText);
  }
  return data;
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
  const element = (cardDoc.elements || []).find((candidate) =>
    candidate.text?.content?.includes('Understand request'),
  );
  const raw = element?.text?.content;
  return typeof raw === 'string' ? raw.split('\n').filter(Boolean) : [];
}

function appendText(parent, className, text) {
  const element = document.createElement('div');
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function renderCard(cardDoc) {
  const title = cardDoc.header?.title?.content || 'OpenTag run';
  const template = cardDoc.header?.template || '';
  const status = findCardText(cardDoc, '**Status:**');
  const summary = findCardText(cardDoc, '**Summary:**');
  const checklist = findChecklist(cardDoc);

  card.className = 'card-preview';
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
  const primaryPlatform = data.platforms?.[0] || 'lark';
  const primaryExecutor = data.executors?.[0] || 'codex';
  capabilityLine.textContent = `${primaryPlatform} ready · ${primaryExecutor} · multi-client core`;
}

async function runDryRun() {
  runButton.disabled = true;
  runButton.textContent = 'Running';
  output.textContent = 'Running...';
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
  } catch (error) {
    output.textContent = error.message;
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
