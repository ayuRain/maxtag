import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
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
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) throw new Error('failed_to_reserve_test_port');
  return port;
}

async function waitForHealth(baseUrl, child, logs) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become healthy\n${logs.join('')}`);
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { response, data: await response.json() };
}

test('channel policy API persists scoped instructions tools and budget', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-channel-api-'));
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENTAG_PORT: String(port),
      OPENTAG_HOST: '127.0.0.1',
      OPENTAG_DATA_DIR: dataDir,
      OPENTAG_STORAGE_DRIVER: 'sqlite',
      OPENTAG_ADMIN_TOKEN: '',
      OPENTAG_AGENT_WORKER: 'manual',
      OPENTAG_ROUTINES_ENABLED: 'false',
      OPENTAG_WORKFLOWS_ENABLED: 'false',
      OPENTAG_LARK_TRANSPORT: 'memory',
      OPENTAG_TELEGRAM_TRANSPORT: 'memory',
      OPENTAG_GITHUB_TRANSPORT: 'memory',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  context.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child, logs);

  const binding = await jsonRequest(baseUrl, '/v1/bindings', {
    method: 'POST',
    body: {
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      platform: 'lark',
      externalId: 'oc_incidents',
      channelId: 'oc_incidents',
      scope: 'channel',
      activationMode: 'mention',
      requireMention: true,
    },
  });
  assert.equal(binding.response.status, 200);

  const routed = await jsonRequest(baseUrl, '/v1/client/events', {
    method: 'POST',
    body: {
      platform: 'lark',
      eventId: 'event-channel-route',
      thread: {
        id: 'lark:oc_incidents:root-1',
        externalId: 'oc_incidents:root-1',
        workspaceId: 'dev-workspace',
        channelId: 'oc_incidents',
        rootMessageId: 'root-1',
        visibility: 'public',
      },
      message: {
        id: 'message-channel-route',
        text: '@MaxTag route me',
        actor: { id: 'ou-user' },
        mentionsAgent: true,
      },
    },
  });
  assert.equal(routed.response.status, 202);
  assert.equal(routed.data.route.projectId, 'opentag');
  assert.equal(routed.data.route.bindingScope, 'channel');

  const defaulted = await jsonRequest(baseUrl, '/v1/client/events', {
    method: 'POST',
    body: {
      platform: 'lark',
      eventId: 'event-default-route',
      thread: {
        id: 'lark:oc_unbound:root-2',
        externalId: 'oc_unbound:root-2',
        workspaceId: 'dev-workspace',
        channelId: 'oc_unbound',
        rootMessageId: 'root-2',
        visibility: 'public',
      },
      message: {
        id: 'message-default-route',
        text: '@MaxTag route me',
        actor: { id: 'ou-user' },
        mentionsAgent: true,
      },
    },
  });
  assert.equal(defaulted.response.status, 202);
  assert.equal(defaulted.data.route.projectId, 'opentag');

  const privacyFallback = await jsonRequest(baseUrl, '/v1/client/events', {
    method: 'POST',
    body: {
      platform: 'lark',
      eventId: 'event-private-fallback',
      thread: {
        id: 'lark:oc_incidents:root-private',
        externalId: 'oc_incidents:root-private',
        workspaceId: 'dev-workspace',
        channelId: 'oc_incidents',
        rootMessageId: 'root-private',
        visibility: 'public',
      },
      message: {
        id: 'message-private-fallback',
        text: 'do not activate this topic',
        actor: { id: 'ou-user' },
        mentionsAgent: false,
      },
    },
  });
  assert.equal(privacyFallback.response.status, 202);
  assert.equal(privacyFallback.data.reason, 'mention_required');
  assert.equal(privacyFallback.data.route.projectId, 'opentag');
  assert.equal(privacyFallback.data.route.visibility, 'public');
  assert.equal(privacyFallback.data.route.larkChatInfoStatus, undefined);

  const created = await jsonRequest(baseUrl, '/v1/channel-policies', {
    method: 'POST',
    body: {
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      platform: 'lark',
      channelId: 'oc_incidents',
      title: 'Incidents',
      instructionMode: 'append',
      instructions: 'Post a concise incident timeline.',
      capabilityMode: 'extend',
      tools: ['lark-docs'],
      toolConstraints: {
        'lark-docs': { documentIds: ['dox_incidents'], permissions: ['read'] },
      },
      networkMode: 'restricted',
      allowedHosts: ['open.feishu.cn'],
      budgetPolicy: {
        mode: 'custom',
        scope: 'channel',
        maxRunsPerMonth: 25,
        maxCostUsdPerMonth: 10,
      },
    },
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.data.channelPolicy.projectId, 'opentag');
  assert.equal(created.data.channelPolicy.instructionMode, 'append');
  assert.equal(created.data.channelPolicy.grants[0].scope, 'channel');
  assert.equal(created.data.channelPolicy.budgetPolicy.scope, 'channel');

  const workspace = await jsonRequest(
    baseUrl,
    '/v1/workspace?workspaceId=dev-workspace',
  );
  assert.equal(workspace.response.status, 200);
  assert.equal(workspace.data.channelPolicies.length, 1);
  assert.equal(workspace.data.projects[0].channelPolicyCount, 1);

  const removed = await jsonRequest(
    baseUrl,
    '/v1/channel-policies?workspaceId=dev-workspace&projectId=opentag&platform=lark&channelId=oc_incidents',
    { method: 'DELETE' },
  );
  assert.equal(removed.response.status, 200);
  assert.equal(removed.data.channelPolicy.channelId, 'oc_incidents');
  assert.equal(removed.data.workspace.channelPolicies.length, 0);
});
