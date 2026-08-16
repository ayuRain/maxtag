import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHealth(baseUrl, child, logs) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response.json();
    } catch {
      // The listener can refuse connections briefly during startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server startup timed out\n${logs.join('')}`);
}

async function startServer(dataDir, ownerToken, larkBaseUrl) {
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENTAG_PORT: String(port),
      OPENTAG_HOST: '127.0.0.1',
      OPENTAG_DATA_DIR: dataDir,
      OPENTAG_ADMIN_TOKEN: ownerToken,
      OPENTAG_ADMIN_COOKIE_SECURE: 'false',
      OPENTAG_AGENT_WORKER: 'manual',
      OPENTAG_CLIENT_INGRESS_TOKEN: 'managed-lark-client-ingress-token',
      OPENTAG_ROUTINES_ENABLED: 'false',
      OPENTAG_LARK_TRANSPORT: 'memory',
      OPENTAG_LARK_EVENT_MODE: 'long-connection',
      OPENTAG_LARK_BASE_URL: larkBaseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(baseUrl, child, logs);
  return { child, baseUrl, health, logs };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

test('installation owner saves a validated Lark Bot and restart activates HTTP transport', { timeout: 30_000 }, async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-config-api-'));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const larkPort = await freePort();
  const requests = [];
  const lark = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, body: Buffer.concat(chunks).toString('utf8') });
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') {
      response.end(JSON.stringify({
        code: 0,
        tenant_access_token: 'tenant-test-token',
        expire: 7200,
      }));
      return;
    }
    if (request.method === 'GET' && request.url === '/open-apis/im/v1/chats/oc_onboarding') {
      response.end(JSON.stringify({
        code: 0,
        data: {
          chat_id: 'oc_onboarding',
          name: 'Onboarding group',
          chat_mode: 'group',
          chat_type: 'private',
          external: false,
        },
      }));
      return;
    }
    if (
      request.method === 'POST' &&
      (request.url === '/open-apis/im/v1/messages?receive_id_type=chat_id' ||
        /^\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/u.test(request.url || ''))
    ) {
      response.end(JSON.stringify({ code: 0, data: { message_id: 'om_onboarding_card' } }));
      return;
    }
    if (
      request.method === 'PATCH' &&
      request.url === '/open-apis/im/v1/messages/om_onboarding_card'
    ) {
      response.end(JSON.stringify({ code: 0, data: {} }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: 404, msg: 'unexpected request' }));
  });
  await new Promise((resolve) => lark.listen(larkPort, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => lark.close(resolve)));

  const ownerToken = 'managed-lark-owner-token-that-is-long-enough';
  let running = await startServer(
    dataDir,
    ownerToken,
    `http://127.0.0.1:${larkPort}`,
  );
  context.after(() => stopServer(running.child));
  assert.equal(running.health.clients.lark.mode, 'memory');

  const save = await fetch(`${running.baseUrl}/v1/config/lark`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${ownerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      appId: 'cli_platform_managed',
      appSecret: 'platform-managed-secret-value',
      verificationToken: 'platform-managed-verification-token',
      encryptKey: 'platform-managed-encrypt-key',
      domain: 'feishu',
      expectedRevision: 0,
    }),
  });
  assert.equal(save.status, 200);
  const savedText = await save.text();
  assert.equal(savedText.includes('platform-managed-secret-value'), false);
  assert.equal(savedText.includes('platform-managed-verification-token'), false);
  assert.equal(savedText.includes('platform-managed-encrypt-key'), false);
  const saved = JSON.parse(savedText);
  assert.equal(saved.config.configured, true);
  assert.equal(saved.config.revision, 1);
  assert.equal(saved.config.verificationTokenConfigured, true);
  assert.equal(saved.config.encryptionKeyConfigured, true);
  assert.equal(saved.reloadPending, true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /tenant_access_token\/internal/u);

  const persisted = await fs.readFile(path.join(dataDir, 'lark-bot.enc.json'), 'utf8');
  assert.equal(persisted.includes('cli_platform_managed'), false);
  assert.equal(persisted.includes('platform-managed-secret-value'), false);
  assert.equal(persisted.includes('platform-managed-verification-token'), false);
  assert.equal(persisted.includes('platform-managed-encrypt-key'), false);

  await stopServer(running.child);
  running = await startServer(
    dataDir,
    ownerToken,
    `http://127.0.0.1:${larkPort}`,
  );
  assert.equal(running.health.clients.lark.mode, 'http');
  assert.equal(running.health.clients.lark.hasCredentials, true);
  assert.equal(running.health.clients.lark.credentialSource, 'managed');
  assert.equal(running.health.clients.lark.verificationTokenConfigured, true);
  assert.equal(running.health.clients.lark.encryptionKeyConfigured, true);

  const read = await fetch(`${running.baseUrl}/v1/config/lark`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(read.status, 200);
  const readText = await read.text();
  assert.equal(readText.includes('platform-managed-secret-value'), false);
  assert.equal(readText.includes('platform-managed-verification-token'), false);
  assert.equal(readText.includes('platform-managed-encrypt-key'), false);
  assert.equal(JSON.parse(readText).config.appId, 'cli_platform_managed');

  const project = await fetch(`${running.baseUrl}/v1/projects`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ownerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      workspaceId: 'dev-workspace',
      projectId: 'second-project',
      name: 'Second project',
      agentMode: 'inherit',
      capabilityMode: 'inherit',
      memoryMode: 'workspace',
    }),
  });
  assert.equal(project.status, 200);

  const onboarding = await fetch(`${running.baseUrl}/v1/client/events`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer managed-lark-client-ingress-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      platform: 'lark',
      eventId: 'onboarding-event-1',
      thread: {
        externalId: 'oc_onboarding:main',
        channelId: 'oc_onboarding',
        workspaceId: 'dev-workspace',
        projectId: 'general',
        visibility: 'private',
      },
      message: {
        id: 'om_onboarding_request',
        text: '@MaxTag hello',
        actor: { id: 'ou-onboarding-owner' },
        mentionsAgent: true,
      },
    }),
  });
  assert.equal(onboarding.status, 202);
  const onboardingResult = await onboarding.json();
  assert.equal(onboardingResult.accepted, true);
  assert.equal(onboardingResult.queued, false);
  assert.equal(onboardingResult.reason, 'lark_history_onboarding_required');
  assert.equal(onboardingResult.run, undefined);
  const cardRequest = requests.find(
    (request) =>
      request.url === '/open-apis/im/v1/messages/om_onboarding_request/reply',
  );
  assert.ok(cardRequest);
  assert.match(cardRequest.body, /maxtag\.history\.select_project/u);
  assert.match(cardRequest.body, /maxtag\.history\.create_project/u);
  assert.match(cardRequest.body, /new_project_name/u);
  assert.match(cardRequest.body, /second-project/u);

  const runs = await fetch(
    `${running.baseUrl}/v1/runs?workspaceId=dev-workspace`,
    { headers: { authorization: `Bearer ${ownerToken}` } },
  ).then((response) => response.json());
  assert.equal(runs.runs.length, 0);

  const onboardingRepeat = await fetch(`${running.baseUrl}/v1/client/events`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer managed-lark-client-ingress-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      platform: 'lark',
      eventId: 'onboarding-event-repeat-1',
      thread: {
        externalId: 'oc_onboarding:main',
        channelId: 'oc_onboarding',
        workspaceId: 'dev-workspace',
        projectId: 'general',
        visibility: 'private',
      },
      message: {
        id: 'om_onboarding_repeat',
        text: '@MaxTag are you there?',
        actor: { id: 'ou-onboarding-owner' },
        mentionsAgent: true,
      },
    }),
  });
  assert.equal(onboardingRepeat.status, 202);
  const repeatResult = await onboardingRepeat.json();
  assert.equal(repeatResult.accepted, true);
  assert.equal(repeatResult.queued, false);
  assert.equal(repeatResult.reason, 'lark_history_onboarding_required');
  const reminder = requests.find(
    (request) =>
      request.url === '/open-apis/im/v1/messages/om_onboarding_repeat/reply',
  );
  assert.ok(reminder);
  assert.match(reminder.body, /接入尚未完成/u);
  assert.match(reminder.body, /选择或新建 Project/u);

  const repeatRuns = await fetch(
    `${running.baseUrl}/v1/runs?workspaceId=dev-workspace`,
    { headers: { authorization: `Bearer ${ownerToken}` } },
  ).then((response) => response.json());
  assert.equal(repeatRuns.runs.length, 0);

  const callbackBody = JSON.stringify({
    schema: '2.0',
    header: {
      event_id: 'onboarding-select-project-1',
      event_type: 'card.action.trigger',
      token: 'platform-managed-verification-token',
      tenant_key: 'dev-workspace',
    },
    event: {
      operator: { open_id: 'ou-onboarding-owner', tenant_key: 'dev-workspace' },
      action: {
        tag: 'button',
        value: {
          action: 'maxtag.history.select_project',
          project_id: 'second-project',
        },
      },
      context: {
        open_message_id: 'om_onboarding_card',
        open_chat_id: 'oc_onboarding',
      },
      host: 'im_message',
    },
  });
  const callbackTimestamp = String(Math.floor(Date.now() / 1000));
  const callbackNonce = 'managed-callback-nonce';
  const callbackSignature = createHash('sha256')
    .update(
      `${callbackTimestamp}${callbackNonce}platform-managed-encrypt-key${callbackBody}`,
    )
    .digest('hex');
  const cardUpdatesBeforeSelect = requests.filter(
    (request) => request.url === '/open-apis/im/v1/messages/om_onboarding_card',
  ).length;
  const selectStartedAt = Date.now();
  const selectProject = await fetch(`${running.baseUrl}/v1/lark/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lark-request-timestamp': callbackTimestamp,
      'x-lark-request-nonce': callbackNonce,
      'x-lark-signature': callbackSignature,
    },
    body: callbackBody,
  });
  assert.ok(
    Date.now() - selectStartedAt < 2_500,
    'Project selection callback must stay below Lark\'s 3 second deadline',
  );
  assert.equal(selectProject.status, 200);
  const projectAction = await selectProject.json();
  assert.equal(projectAction.toast.type, 'success');
  assert.equal(projectAction.card.type, 'raw');
  assert.equal(projectAction.card.data.schema, '2.0');
  assert.match(JSON.stringify(projectAction.card.data), /Second project/u);

  const imports = await fetch(
    `${running.baseUrl}/v1/lark/history-imports?workspaceId=dev-workspace`,
    { headers: { authorization: `Bearer ${ownerToken}` } },
  ).then((response) => response.json());
  assert.equal(imports.jobs[0].status, 'awaiting_choice');
  assert.equal(imports.jobs[0].projectId, 'second-project');
  assert.equal(
    requests.filter(
      (request) => request.url === '/open-apis/im/v1/messages/om_onboarding_card',
    ).length,
    cardUpdatesBeforeSelect,
  );

  const cardUpdatesBeforeCreate = requests.filter(
    (request) => request.url === '/open-apis/im/v1/messages/om_onboarding_card',
  ).length;
  const createProject = await fetch(`${running.baseUrl}/v1/lark/card-actions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer managed-lark-client-ingress-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type: 'card.action.trigger',
      event_id: 'onboarding-create-project-1',
      operator_id: 'ou-onboarding-owner',
      message_id: 'om_onboarding_card',
      chat_id: 'oc_onboarding',
      action_tag: 'input',
      action_value: JSON.stringify({
        action: 'maxtag.history.create_project',
      }),
      input_value: 'Mobile Rebuild',
    }),
  });
  assert.equal(createProject.status, 200);
  const createAction = await createProject.json();
  assert.equal(createAction.toast.type, 'success');
  assert.match(createAction.toast.content, /Mobile Rebuild/u);
  assert.equal(createAction.card.type, 'raw');
  assert.equal(createAction.card.data.schema, '2.0');
  assert.match(JSON.stringify(createAction.card.data), /Mobile Rebuild/u);

  const createdImports = await fetch(
    `${running.baseUrl}/v1/lark/history-imports?workspaceId=dev-workspace`,
    { headers: { authorization: `Bearer ${ownerToken}` } },
  ).then((response) => response.json());
  assert.equal(createdImports.jobs[0].status, 'awaiting_choice');
  assert.equal(createdImports.jobs[0].projectId, 'mobile-rebuild');
  assert.equal(
    requests.filter(
      (request) => request.url === '/open-apis/im/v1/messages/om_onboarding_card',
    ).length,
    cardUpdatesBeforeCreate,
  );
});
