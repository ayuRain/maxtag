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

  const mainStarted = await jsonRequest(baseUrl, '/v1/client/events', {
    method: 'POST',
    body: {
      platform: 'lark',
      eventId: 'event-main-start',
      thread: {
        id: 'lark:oc_incidents:main',
        externalId: 'oc_incidents:main',
        workspaceId: 'dev-workspace',
        channelId: 'oc_incidents',
        rootMessageId: 'message-main-start',
        visibility: 'public',
        metadata: { larkConversationMode: 'main' },
      },
      message: {
        id: 'message-main-start',
        text: '@MaxTag start a task',
        actor: { id: 'ou-user' },
        mentionsAgent: true,
      },
    },
  });
  assert.equal(mainStarted.response.status, 202);
  assert.equal(mainStarted.data.accepted, true);

  const mainChatter = await jsonRequest(baseUrl, '/v1/client/events', {
    method: 'POST',
    body: {
      platform: 'lark',
      eventId: 'event-main-chatter',
      thread: {
        id: 'lark:oc_incidents:main',
        externalId: 'oc_incidents:main',
        workspaceId: 'dev-workspace',
        channelId: 'oc_incidents',
        rootMessageId: 'message-main-chatter',
        visibility: 'public',
        metadata: { larkConversationMode: 'main' },
      },
      message: {
        id: 'message-main-chatter',
        text: 'ordinary channel conversation',
        actor: { id: 'ou-user' },
        mentionsAgent: false,
      },
    },
  });
  assert.equal(mainChatter.response.status, 202);
  assert.equal(mainChatter.data.accepted, false);
  assert.equal(mainChatter.data.reason, 'mention_required');

  const topicStarted = await jsonRequest(baseUrl, '/v1/client/events', {
    method: 'POST',
    body: {
      platform: 'lark',
      eventId: 'event-topic-start',
      thread: {
        id: 'lark:oc_incidents:topic-1',
        externalId: 'oc_incidents:topic-1',
        workspaceId: 'dev-workspace',
        channelId: 'oc_incidents',
        rootMessageId: 'root-topic-1',
        topicId: 'topic-1',
        visibility: 'public',
        metadata: { larkConversationMode: 'thread' },
      },
      message: {
        id: 'message-topic-start',
        text: '@MaxTag start this topic task',
        actor: { id: 'ou-user' },
        mentionsAgent: true,
      },
    },
  });
  assert.equal(topicStarted.response.status, 202);
  assert.equal(topicStarted.data.accepted, true);

  const topicFollowUp = await jsonRequest(baseUrl, '/v1/client/events', {
    method: 'POST',
    body: {
      platform: 'lark',
      eventId: 'event-topic-follow-up',
      thread: {
        id: 'lark:oc_incidents:topic-1',
        externalId: 'oc_incidents:topic-1',
        workspaceId: 'dev-workspace',
        channelId: 'oc_incidents',
        rootMessageId: 'root-topic-1',
        topicId: 'topic-1',
        visibility: 'public',
        metadata: { larkConversationMode: 'thread' },
      },
      message: {
        id: 'message-topic-follow-up',
        text: 'continue the topic task without mentioning again',
        actor: { id: 'ou-user' },
        mentionsAgent: false,
      },
    },
  });
  assert.equal(topicFollowUp.response.status, 202);
  assert.equal(topicFollowUp.data.accepted, true);

  const questionsBinding = await jsonRequest(baseUrl, '/v1/bindings', {
    method: 'POST',
    body: {
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      platform: 'lark',
      externalId: 'oc_questions',
      channelId: 'oc_questions',
      scope: 'channel',
      activationMode: 'questions',
      requireMention: true,
    },
  });
  assert.equal(questionsBinding.response.status, 200);
  assert.equal(questionsBinding.data.binding.activationMode, 'questions');

  const questionsStatement = await jsonRequest(baseUrl, '/v1/client/events', {
    method: 'POST',
    body: {
      platform: 'lark',
      eventId: 'event-questions-statement',
      thread: {
        id: 'lark:oc_questions:main',
        externalId: 'oc_questions:main',
        workspaceId: 'dev-workspace',
        channelId: 'oc_questions',
        rootMessageId: 'message-questions-statement',
        visibility: 'public',
        metadata: { larkConversationMode: 'main' },
      },
      message: {
        id: 'message-questions-statement',
        text: '今天继续发布',
        actor: { id: 'ou-user' },
        mentionsAgent: false,
      },
    },
  });
  assert.equal(questionsStatement.response.status, 202);
  assert.equal(questionsStatement.data.reason, 'mention_required');

  const questionsQuestion = await jsonRequest(baseUrl, '/v1/client/events', {
    method: 'POST',
    body: {
      platform: 'lark',
      eventId: 'event-questions-question',
      thread: {
        id: 'lark:oc_questions:main',
        externalId: 'oc_questions:main',
        workspaceId: 'dev-workspace',
        channelId: 'oc_questions',
        rootMessageId: 'message-questions-question',
        visibility: 'public',
        metadata: { larkConversationMode: 'main' },
      },
      message: {
        id: 'message-questions-question',
        text: '这个发布成功了吗',
        actor: { id: 'ou-user' },
        mentionsAgent: false,
      },
    },
  });
  assert.equal(questionsQuestion.response.status, 202);
  assert.equal(questionsQuestion.data.accepted, true);

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

  const createdBundle = await jsonRequest(baseUrl, '/v1/capability-bundles', {
    method: 'POST',
    body: {
      workspaceId: 'dev-workspace',
      id: 'incident-docs',
      name: 'Incident documents',
      preset: 'data-readonly',
      tools: ['lark-docs'],
      toolConstraints: {
        'lark-docs': { documentIds: ['dox_incidents'], permissions: ['read'] },
      },
      networkMode: 'restricted',
      allowedHosts: ['open.feishu.cn'],
    },
  });
  assert.equal(createdBundle.response.status, 200);
  assert.equal(createdBundle.data.bundle.id, 'incident-docs');
  assert.equal(createdBundle.data.bundle.revision, 1);

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
      bundleIds: ['incident-docs'],
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
  assert.deepEqual(created.data.channelPolicy.bundleIds, ['incident-docs']);
  assert.equal(created.data.channelPolicy.grants[0].scope, 'channel');
  assert.equal(created.data.channelPolicy.budgetPolicy.scope, 'channel');

  const listedBundles = await jsonRequest(
    baseUrl,
    '/v1/capability-bundles?workspaceId=dev-workspace',
  );
  assert.equal(listedBundles.response.status, 200);
  assert.deepEqual(
    listedBundles.data.bundles.map((bundle) => bundle.id),
    ['incident-docs'],
  );
  const staleBundleUpdate = await jsonRequest(baseUrl, '/v1/capability-bundles', {
    method: 'POST',
    body: {
      workspaceId: 'dev-workspace',
      id: 'incident-docs',
      name: 'Stale update',
      expectedRevision: 0,
      tools: [],
    },
  });
  assert.equal(staleBundleUpdate.response.status, 409);
  assert.equal(staleBundleUpdate.data.error, 'capability_bundle_revision_conflict');
  const referencedBundleDelete = await jsonRequest(
    baseUrl,
    '/v1/capability-bundles/incident-docs?workspaceId=dev-workspace&expectedRevision=1',
    { method: 'DELETE' },
  );
  assert.equal(referencedBundleDelete.response.status, 409);
  assert.equal(referencedBundleDelete.data.error, 'capability_bundle_in_use');

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

  const deletedBundle = await jsonRequest(
    baseUrl,
    '/v1/capability-bundles/incident-docs?workspaceId=dev-workspace&expectedRevision=1',
    { method: 'DELETE' },
  );
  assert.equal(deletedBundle.response.status, 200);
  assert.equal(deletedBundle.data.bundle.id, 'incident-docs');
  assert.deepEqual(deletedBundle.data.workspace.capabilityBundles, []);
});
