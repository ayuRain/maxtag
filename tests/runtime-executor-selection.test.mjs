import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenTagRuntime } from '@opentag/core';

test('runtime selects the executor configured by the project identity', async () => {
  const calls = [];
  const progress = [];
  const thread = {
    id: 'lark:payments:root',
    platform: 'lark',
    externalId: 'payments:root',
    workspaceId: 'acme',
    projectId: 'payments',
    channelId: 'payments',
    visibility: 'public',
  };
  const message = {
    id: 'message-1',
    threadId: thread.id,
    platform: 'lark',
    text: 'triage this incident',
    actor: { id: 'user-1' },
    createdAt: new Date().toISOString(),
    mentionsAgent: true,
  };
  const runtime = new OpenTagRuntime({
    platform: {
      kind: 'lark',
      capabilities: {
        supportsThreads: true,
        supportsCards: true,
        supportsFiles: true,
        supportsReactions: true,
        supportsMentions: true,
      },
      createProgressSurface() {
        return {
          async create(value) {
            progress.push(value);
            return { surfaceId: 'surface-1' };
          },
          async update(_id, value) {
            progress.push(value);
          },
          async complete(_id, value) {
            progress.push(value);
          },
        };
      },
      async sendMessage(_thread, text) {
        calls.push(`sent:${text}`);
      },
    },
    executor: {
      id: 'codex',
      label: 'Codex',
      async run() {
        calls.push('codex');
        return { summary: 'codex', artifacts: [] };
      },
    },
    executors: {
      codex: {
        id: 'codex',
        label: 'Codex',
        async run() {
          calls.push('codex');
          return { summary: 'codex', artifacts: [] };
        },
      },
      claude: {
        id: 'claude',
        label: 'Claude',
        async run() {
          calls.push('claude');
          return { summary: 'handled by Claude', artifacts: [] };
        },
      },
    },
    memory: {
      async loadThreadMemory() {
        return '';
      },
      async remember() {},
      async forget() {},
    },
    threadConfig: {
      async getWorkspace() {
        return { id: 'acme', name: 'Acme' };
      },
      async getProject() {
        return { id: 'acme:payments', workspaceId: 'acme', key: 'payments', name: 'Payments' };
      },
      async getIdentity() {
        return {
          id: 'payments-agent',
          displayName: 'Payments Copilot',
          instructions: 'Own payment incidents.',
          defaultExecutorId: 'claude',
        };
      },
      async getAccessBundle() {
        return {
          id: 'access-1',
          threadId: thread.id,
          grants: [],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        };
      },
    },
  });

  const result = await runtime.handleMessage({
    runId: 'run-1',
    thread,
    message,
  });

  assert.equal(result.summary, 'handled by Claude');
  assert.deepEqual(calls, ['claude', 'sent:handled by Claude']);
  assert.ok(
    progress.some((entry) =>
      entry.checklist.some((item) => item.label === 'Run Claude'),
    ),
  );
});

test('runtime closes the progress surface when a configured executor is unavailable', async () => {
  const completed = [];
  const thread = {
    id: 'lark:payments:root',
    platform: 'lark',
    externalId: 'payments:root',
    workspaceId: 'acme',
    projectId: 'payments',
    visibility: 'public',
  };
  const runtime = new OpenTagRuntime({
    platform: {
      kind: 'lark',
      capabilities: {
        supportsThreads: true,
        supportsCards: true,
        supportsFiles: true,
        supportsReactions: true,
        supportsMentions: true,
      },
      createProgressSurface() {
        return {
          async create() {
            return { surfaceId: 'surface-1' };
          },
          async update() {},
          async complete(_id, value) {
            completed.push(value);
          },
        };
      },
      async sendMessage() {},
    },
    executor: {
      id: 'codex',
      label: 'Codex',
      async run() {
        return { summary: 'codex', artifacts: [] };
      },
    },
    executors: {
      codex: {
        id: 'codex',
        label: 'Codex',
        async run() {
          return { summary: 'codex', artifacts: [] };
        },
      },
    },
    memory: {
      async loadThreadMemory() {
        return '';
      },
      async remember() {},
      async forget() {},
    },
    threadConfig: {
      async getIdentity() {
        return {
          id: 'payments-agent',
          displayName: 'Payments Copilot',
          instructions: 'Own payment incidents.',
          defaultExecutorId: 'missing',
        };
      },
      async getAccessBundle() {
        return {
          id: 'access-1',
          threadId: thread.id,
          grants: [],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        };
      },
    },
  });

  await assert.rejects(
    runtime.handleMessage({
      runId: 'run-2',
      thread,
      message: {
        id: 'message-2',
        threadId: thread.id,
        platform: 'lark',
        text: 'handle this',
        actor: { id: 'user-1' },
        createdAt: new Date().toISOString(),
        mentionsAgent: true,
      },
    }),
    /executor_not_available:missing/,
  );

  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, 'failed');
  assert.equal(completed[0].summary, 'executor_not_available:missing');
  assert.equal(completed[0].checklist[0].status, 'failed');
});

test('runtime exposes a live steering channel to a capable executor', async () => {
  const calls = [];
  const thread = {
    id: 'lark:live:root',
    platform: 'lark',
    externalId: 'live:root',
    workspaceId: 'acme',
    projectId: 'live',
    visibility: 'public',
  };
  const followUp = {
    id: 'steering-1',
    targetRunId: 'run-live',
    receivedAt: new Date().toISOString(),
    thread,
    message: {
      id: 'message-follow-up',
      threadId: thread.id,
      platform: 'lark',
      text: 'Check the database first.',
      actor: { id: 'user-2' },
    },
  };
  const runtime = new OpenTagRuntime({
    platform: {
      kind: 'lark',
      capabilities: {
        supportsThreads: true,
        supportsCards: true,
        supportsFiles: true,
        supportsReactions: true,
        supportsMentions: true,
      },
      createProgressSurface() {
        return {
          async create() {
            return { surfaceId: 'surface-live' };
          },
          async update() {},
          async complete() {},
        };
      },
      async sendMessage() {},
    },
    executor: {
      id: 'live',
      label: 'Live executor',
      steeringMode: 'live',
      async run(request) {
        assert.equal(request.steering.mode, 'live');
        const input = await request.steering.receive({ waitMs: 10 });
        calls.push(input.message.text);
        await request.steering.acknowledge(input.id, 'Applied in place');
        return { summary: 'Steered result', artifacts: [] };
      },
    },
    memory: {
      async loadThreadMemory() {
        return '';
      },
      async remember() {},
      async forget() {},
    },
    threadConfig: {
      async getIdentity() {
        return {
          id: 'live-agent',
          displayName: 'Live agent',
          instructions: 'Handle live input.',
          defaultExecutorId: 'live',
        };
      },
      async getAccessBundle() {
        return {
          id: 'access-live',
          threadId: thread.id,
          grants: [],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        };
      },
    },
  });

  const result = await runtime.handleMessage({
    runId: 'run-live',
    thread,
    message: {
      id: 'message-live',
      threadId: thread.id,
      platform: 'lark',
      text: 'Investigate the incident.',
      actor: { id: 'user-1' },
    },
    steering: {
      async open(mode) {
        calls.push(`mode:${mode}`);
        let delivered = false;
        return {
          mode,
          async receive() {
            if (delivered) return undefined;
            delivered = true;
            return followUp;
          },
          async acknowledge(id, detail) {
            calls.push(`ack:${id}:${detail}`);
          },
        };
      },
    },
  });

  assert.equal(result.summary, 'Steered result');
  assert.deepEqual(calls, [
    'mode:live',
    'Check the database first.',
    'ack:steering-1:Applied in place',
  ]);
});

test('runtime loads only memory scopes granted by the resolved project policy', async () => {
  const loaded = [];
  const received = [];
  const thread = {
    id: 'lark:legal:root',
    platform: 'lark',
    externalId: 'legal:root',
    workspaceId: 'acme',
    projectId: 'legal',
    visibility: 'public',
  };
  const runtime = new OpenTagRuntime({
    platform: {
      kind: 'lark',
      capabilities: {
        supportsThreads: true,
        supportsCards: true,
        supportsFiles: true,
        supportsReactions: true,
        supportsMentions: true,
      },
      createProgressSurface() {
        return {
          async create() {
            return { surfaceId: 'surface-memory' };
          },
          async update() {},
          async complete() {},
        };
      },
      async sendMessage() {},
    },
    executor: {
      id: 'codex',
      label: 'Codex',
      async run(request) {
        received.push({
          scopes: request.memorySnapshot.scopes.map((item) => item.scope.kind),
          workspacePermissions: request.access.grants.find(
            (grant) => grant.kind === 'memory' && grant.scope === 'workspace',
          )?.constraints?.permissions,
        });
        return { summary: 'done', artifacts: [] };
      },
    },
    memory: {
      async loadMemory(query) {
        loaded.push(query.scopes);
        return {
          loadedAt: new Date().toISOString(),
          scopes: query.scopes.map((kind) => ({
            scope: { kind, label: kind },
            content: kind,
          })),
          text: query.scopes.join(','),
        };
      },
      async loadThreadMemory() {
        throw new Error('legacy memory path should not be used');
      },
      async remember() {},
      async forget() {},
    },
    threadConfig: {
      async getWorkspace() {
        return { id: 'acme', name: 'Acme' };
      },
      async getProject() {
        return { id: 'acme:legal', workspaceId: 'acme', key: 'legal', name: 'Legal' };
      },
      async getIdentity() {
        return {
          id: 'acme-agent',
          displayName: 'Acme Tag',
          instructions: 'Serve Acme.',
          defaultExecutorId: 'codex',
        };
      },
      async getAccessBundle() {
        return {
          id: 'access-legal',
          threadId: thread.id,
          workspaceId: 'acme',
          projectId: 'acme:legal',
          grants: [
            {
              id: 'memory:global',
              kind: 'memory',
              scope: 'global',
              label: 'Legacy installation memory',
              constraints: { permissions: ['read'] },
            },
            {
              id: 'memory:project',
              kind: 'memory',
              scope: 'project',
              label: 'Project memory',
              constraints: { permissions: ['read', 'write'] },
            },
            {
              id: 'memory:workspace',
              kind: 'memory',
              scope: 'workspace',
              label: 'Workspace memory',
              constraints: { permissions: ['read', 'write'] },
            },
            {
              id: 'memory:thread',
              kind: 'memory',
              scope: 'thread',
              label: 'Thread memory',
              constraints: { permissions: ['read', 'write'] },
            },
          ],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        };
      },
    },
  });

  await runtime.handleMessage({
    runId: 'run-memory-policy',
    thread,
    workspaceMemoryWriteAllowed: false,
    message: {
      id: 'message-memory-policy',
      threadId: thread.id,
      platform: 'lark',
      text: 'Review the contract.',
      actor: { id: 'user-1' },
      createdAt: new Date().toISOString(),
      mentionsAgent: true,
    },
  });

  assert.deepEqual(loaded, [['workspace', 'project', 'thread']]);
  assert.deepEqual(received, [
    {
      scopes: ['workspace', 'project', 'thread'],
      workspacePermissions: ['read'],
    },
  ]);
});
