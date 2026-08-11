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
