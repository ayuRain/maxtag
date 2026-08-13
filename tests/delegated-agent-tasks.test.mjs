import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FileAgentSkillStore,
  FileDelegatedAgentStore,
  FileDelegatedAgentTaskStore,
  FileKnowledgeSourceStore,
} from '@opentag/config';
import { FileDeliveryStore } from '@opentag/delivery';
import { DelegatedAgentTaskService } from '@opentag/runtime-host';

function thread() {
  return {
    id: 'lark:oc_agents:root',
    platform: 'lark',
    externalId: 'oc_agents:root',
    workspaceId: 'acme',
    projectId: 'payments',
    channelId: 'oc_agents',
    rootMessageId: 'root',
    visibility: 'private',
  };
}

function access(agentIds = ['evidence-reviewer']) {
  return {
    id: 'access:lark:oc_agents:root',
    threadId: thread().id,
    workspaceId: 'acme',
    projectId: 'acme:payments',
    skillIds: [],
    agentIds,
    knowledgeSourceIds: [],
    grants: [
      {
        id: 'shell:project:acme:payments',
        kind: 'shell',
        scope: 'project',
        label: 'Workspace',
        constraints: { permissions: ['read', 'write'], commands: ['npm'] },
      },
    ],
    networkPolicy: {
      mode: 'restricted',
      allowedHosts: ['docs.example.com', 'blocked.example.com'],
    },
  };
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-agent-tasks-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const configRoot = path.join(root, 'config');
  const taskStore = new FileDelegatedAgentTaskStore(configRoot);
  const agentStore = new FileDelegatedAgentStore(configRoot);
  const definition = await agentStore.upsert({
    id: 'evidence-reviewer',
    name: 'Evidence reviewer',
    description: 'Review bounded evidence.',
    instructions: 'Return only verified findings.',
    executorId: 'fake',
    grantKinds: ['shell'],
    networkHosts: ['docs.example.com'],
    timeoutMs: 30_000,
  });
  return {
    root,
    configRoot,
    taskStore,
    agentStore,
    definition,
    skillStore: new FileAgentSkillStore(configRoot),
    knowledgeStore: new FileKnowledgeSourceStore(configRoot),
    deliveryStore: new FileDeliveryStore(path.join(root, 'delivery')),
  };
}

async function createTask(f, overrides = {}) {
  return f.taskStore.create({
    parentRunId: 'parent-run',
    workspaceId: 'acme',
    projectId: 'payments',
    thread: thread(),
    agentId: f.definition.id,
    agentRevision: f.definition.revision,
    task: 'Review release evidence and list the missing proof.',
    createdBy: 'agent:opentag',
    accessSnapshot: {
      skillIds: [],
      knowledgeSourceIds: [],
      grantIds: ['shell:project:acme:payments'],
      memoryScopes: [],
      networkPolicy: {
        mode: 'restricted',
        allowedHosts: ['docs.example.com', 'blocked.example.com'],
      },
    },
    ...overrides,
  });
}

function service(f, executor, overrides = {}) {
  return new DelegatedAgentTaskService({
    store: f.taskStore,
    agentStore: f.agentStore,
    skillStore: f.skillStore,
    knowledgeStore: f.knowledgeStore,
    memoryStore: { loadMemory: async () => ({ text: '', scopes: [] }) },
    threadConfigStore: {
      resolveThreadPolicy: async () => ({
        identity: {
          id: 'opentag',
          displayName: 'MaxTag',
          instructions: 'Coordinate work.',
          defaultExecutorId: 'fake',
        },
        access: access(),
        workspace: { id: 'acme', name: 'Acme' },
        project: {
          id: 'acme:payments',
          workspaceId: 'acme',
          key: 'payments',
          name: 'Payments',
        },
      }),
    },
    deliveryStore: f.deliveryStore,
    resolveExecutor: () => executor,
    workerId: 'worker-a',
    retryBaseMs: 1_000,
    ...overrides,
  });
}

test('delegated task store claims once across processes and rejects credentials', async (context) => {
  const f = await fixture(context);
  const second = new FileDelegatedAgentTaskStore(f.configRoot);
  const task = await createTask(f);
  const claims = await Promise.all([
    f.taskStore.claim({ workerId: 'worker-a', limit: 1 }),
    second.claim({ workerId: 'worker-b', limit: 1 }),
  ]);
  assert.equal(claims.flat().length, 1);
  assert.equal(claims.flat()[0].id, task.id);
  assert.equal((await second.get(task.id)).attempts, 1);

  await assert.rejects(
    createTask(f, { task: 'verification_token = do-not-persist' }),
    /delegated_agent_task_credentials_not_allowed/u,
  );
});

test('async delegated task uses the current read-only access intersection and schedules continuation', async (context) => {
  const f = await fixture(context);
  const task = await createTask(f);
  let childRequest;
  const continuations = [];
  const worker = service(
    f,
    {
      id: 'fake',
      label: 'Fake',
      async run(request) {
        childRequest = request;
        return {
          summary: 'Verified build and tests; real client receipt remains missing.',
          artifacts: [],
          usage: { runs: 1, costUsd: 0.001, inputTokens: 90, outputTokens: 20 },
        };
      },
    },
    {
      onCompleted: async (completed) => {
        continuations.push(completed.id);
        return `delegated-result:${completed.id}`;
      },
    },
  );
  const result = await worker.runPass();
  assert.equal(result.claimed, 1);
  assert.equal(result.completed, 1);
  assert.deepEqual(continuations, [task.id]);
  assert.equal(childRequest.delegation.depth, 1);
  assert.deepEqual(childRequest.delegatedAgents, []);
  assert.equal(childRequest.access.toolApprovalPolicy.mode, 'disabled');
  assert.deepEqual(childRequest.access.grants[0].constraints.permissions, ['read']);
  assert.deepEqual(childRequest.access.networkPolicy, {
    mode: 'restricted',
    allowedHosts: ['docs.example.com'],
  });
  const stored = await f.taskStore.get(task.id);
  assert.equal(stored.status, 'completed');
  assert.equal(stored.continuationRunId, `delegated-result:${task.id}`);
  assert.equal(stored.policy.recursiveDelegation, false);

  await worker.runPass();
  assert.deepEqual(continuations, [task.id]);
});

test('route changes make a queued task stale before executor invocation', async (context) => {
  const f = await fixture(context);
  const task = await createTask(f);
  let invoked = false;
  const continuations = [];
  const worker = service(
    f,
    {
      id: 'fake',
      label: 'Fake',
      async run() {
        invoked = true;
        return { summary: 'should not run', artifacts: [] };
      },
    },
    {
      threadConfigStore: {
        resolveThreadPolicy: async () => ({
          identity: {
            id: 'opentag',
            displayName: 'MaxTag',
            instructions: 'Coordinate work.',
            defaultExecutorId: 'fake',
          },
          access: access([]),
        }),
      },
      onCompleted: async (terminal) => {
        continuations.push(terminal.status);
        return `delegated-result:${terminal.id}`;
      },
    },
  );
  const result = await worker.runPass();
  assert.equal(result.stale, 1);
  assert.equal(invoked, false);
  assert.equal((await f.taskStore.get(task.id)).error, 'delegated_agent_task_route_changed');
  assert.deepEqual(continuations, ['stale']);
});

test('cross-process cancellation aborts a running executor and never requeues it', async (context) => {
  const f = await fixture(context);
  const task = await createTask(f);
  const operatorStore = new FileDelegatedAgentTaskStore(f.configRoot);
  let started;
  const running = new Promise((resolve) => {
    started = resolve;
  });
  const worker = service(f, {
    id: 'fake',
    label: 'Fake',
    run(request) {
      started();
      return new Promise((resolve, reject) => {
        request.abortSignal.addEventListener(
          'abort',
          () => reject(new Error(String(request.abortSignal.reason))),
          { once: true },
        );
      });
    },
  });
  const pass = worker.runPass();
  await running;
  await operatorStore.cancel({ id: task.id, actor: 'operator:admin' });
  const result = await pass;
  assert.equal(result.cancelled, 1);
  assert.equal(result.retried, 0);
  const stored = await f.taskStore.get(task.id);
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.cancelledBy, 'operator:admin');
});

test('completed tasks recover a missing continuation on a later pass', async (context) => {
  const f = await fixture(context);
  const task = await createTask(f);
  await f.taskStore.claim({ workerId: 'manual-worker', limit: 1 });
  await f.taskStore.complete({
    id: task.id,
    workerId: 'manual-worker',
    summary: 'Verified bounded result.',
  });
  const scheduled = [];
  const worker = service(
    f,
    { id: 'fake', label: 'Fake', async run() { throw new Error('not expected'); } },
    {
      onCompleted: async (completed) => {
        scheduled.push(completed.id);
        return `recovered:${completed.id}`;
      },
    },
  );
  const result = await worker.runPass();
  assert.equal(result.claimed, 0);
  assert.deepEqual(scheduled, [task.id]);
  assert.equal((await f.taskStore.get(task.id)).continuationRunId, `recovered:${task.id}`);
});

test('a transient continuation failure leaves terminal work recoverable', async (context) => {
  const f = await fixture(context);
  const task = await createTask(f);
  let attempts = 0;
  const worker = service(
    f,
    {
      id: 'fake',
      label: 'Fake',
      async run() {
        return { summary: 'Verified result.', artifacts: [] };
      },
    },
    {
      onCompleted: async (completed) => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary_continuation_failure');
        return `recovered:${completed.id}`;
      },
    },
  );
  const first = await worker.runPass();
  assert.equal(first.completed, 1);
  assert.equal((await f.taskStore.get(task.id)).continuationRunId, undefined);
  const second = await worker.runPass();
  assert.equal(second.claimed, 0);
  assert.equal((await f.taskStore.get(task.id)).continuationRunId, `recovered:${task.id}`);
  assert.equal(attempts, 2);
});
