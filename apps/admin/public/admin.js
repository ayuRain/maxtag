const health = document.querySelector('#health');
const capabilities = document.querySelector('#capabilities');
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

function renderCapabilities(data) {
  const articles = capabilities.querySelectorAll('article strong');
  articles[0].textContent = data.platforms.join(', ');
  articles[1].textContent = data.executors.join(', ');
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

function renderCard(cardDoc) {
  const title = cardDoc.header?.title?.content || 'OpenTag run';
  const template = cardDoc.header?.template || 'blue';
  const status = findCardText(cardDoc, '**Status:**');
  const summary = findCardText(cardDoc, '**Summary:**');
  const checklist =
    (cardDoc.elements || []).find((element) =>
      element.text?.content?.includes('Understand request'),
    )?.text?.content || 'No checklist.';

  card.className = 'card-preview';
  card.innerHTML = `
    <div class="card-header ${template}">${title}</div>
    <div class="card-body">
      <div class="card-line"><strong>Status:</strong> ${status}</div>
      ${summary ? `<div class="card-line"><strong>Summary:</strong> ${summary}</div>` : ''}
      <div class="checklist">${checklist}</div>
    </div>
  `;
}

async function refreshHealth() {
  try {
    await getJson('/health');
    health.textContent = 'Server online';
    health.classList.add('ok');
  } catch (error) {
    health.textContent = `Server offline: ${error.message}`;
    health.classList.remove('ok');
  }
}

async function refreshCapabilities() {
  const data = await getJson('/v1/capabilities');
  renderCapabilities(data);
}

async function runDryRun() {
  runButton.disabled = true;
  runButton.textContent = 'Running...';
  output.textContent = 'Running dry-run...';
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
