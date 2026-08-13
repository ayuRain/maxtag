import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StaticExecutorRegistry } from '@opentag/core';
import { FileDeliveryStore } from '@opentag/delivery';
import { ScopedFileMemoryStore } from '@opentag/memory';
import { MemoryRetrievalService } from '@opentag/runtime-host';

function descriptor() {
  return {
    id: 'codex',
    label: 'Codex',
    provider: 'codex',
    mode: 'local-cli',
    model: 'gpt-5.6-luna',
    status: 'ready',
    capabilities: {
      steering: 'next_turn',
      providerSessions: true,
      transcriptFallback: true,
      brokeredTools: true,
      nativeTools: true,
      inputAttachments: true,
      managedArtifacts: true,
      automaticMemoryCandidates: true,
      contextRecovery: true,
      nativeCompaction: true,
    },
  };
}

function route(projectId = 'project-a') {
  const workspace = { id: 'workspace-a', name: 'Workspace A' };
  const project = {
    id: `workspace-a:${projectId}`,
    workspaceId: workspace.id,
    key: projectId,
    name: projectId === 'project-a' ? 'Project A' : 'Project B',
  };
  const thread = {
    id: `lark:oc_${projectId}:root`,
    platform: 'lark',
    externalId: `oc_${projectId}:root`,
    workspaceId: workspace.id,
    projectId,
    channelId: `oc_${projectId}`,
    rootMessageId: `om_${projectId}`,
    topicId: `om_${projectId}`,
    visibility: 'private',
  };
  return { workspace, project, thread };
}

function access(thread) {
  return {
    id: 'agent-access',
    threadId: thread.id,
    workspaceId: thread.workspaceId,
    projectId: thread.projectId,
    grants: [
      ...['workspace', 'project', 'channel', 'thread'].map((scope) => ({
        id: `memory:${scope}`,
        kind: 'memory',
        scope,
        label: `${scope} memory`,
        constraints: { permissions: ['read', 'write'] },
      })),
      {
        id: 'repository:write',
        kind: 'repository',
        label: 'Repository write',
        constraints: { permissions: ['read', 'write'] },
      },
    ],
    networkPolicy: { mode: 'allow-list', allowedHosts: ['example.com'] },
  };
}

function message(thread, text = 'Which database should distributed workers use?') {
  return {
    id: 'message-retrieval',
    threadId: thread.id,
    platform: 'lark',
    text,
    actor: { id: 'owner', displayName: 'Owner' },
    createdAt: new Date().toISOString(),
    mentionsAgent: true,
  };
}

async function memoryFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-retrieval-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ScopedFileMemoryStore(root);
  const current = route('project-a');
  const other = route('project-b');
  await store.rememberScoped({
    ...current,
    scope: 'workspace',
    text: 'Workspace incidents use the severity rubric.',
    actorId: 'operator:owner',
  });
  await store.rememberScoped({
    ...current,
    scope: 'project',
    text: 'Use Postgres for distributed workers.',
    actorId: 'operator:owner',
  });
  await store.rememberScoped({
    ...other,
    scope: 'project',
    text: 'apollo-secret belongs only to Project B.',
    actorId: 'operator:owner',
  });
  const snapshot = await store.loadMemory({
    ...current,
    scopes: ['workspace', 'project', 'channel', 'thread'],
  });
  return { current, other, snapshot };
}

function registry(executor) {
  return new StaticExecutorRegistry({
    defaultExecutorId: 'codex',
    registrations: [{ descriptor: descriptor(), executor }],
  });
}

test('semantic retrieval accepts only current route references and reconstructs original lines', async (context) => {
  const { current, snapshot } = await memoryFixture(context);
  const deliveryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'opentag-retrieval-usage-'),
  );
  context.after(() => fs.rm(deliveryRoot, { recursive: true, force: true }));
  const deliveryStore = new FileDeliveryStore(deliveryRoot);
  await deliveryStore.createAgentRun({
    runId: 'run-semantic',
    thread: current.thread,
    message: message(current.thread),
  });
  const projectDocument = snapshot.scopes.find(
    (entry) => entry.scope.kind === 'project',
  ).document;
  const workspaceDocument = snapshot.scopes.find(
    (entry) => entry.scope.kind === 'workspace',
  ).document;
  const requests = [];
  const executor = {
    id: 'codex',
    label: 'Codex',
    async run(request) {
      requests.push(request);
      return {
        summary: '',
        artifacts: [],
        usage: { costUsd: 0.001, inputTokens: 120, outputTokens: 8 },
        memorySelections: [
          {
            documentKey: projectDocument.key,
            version: projectDocument.version,
            lineNumber: 1,
            confidence: 0.97,
          },
          {
            documentKey: 'project:workspace-a:project-b',
            version: 1,
            lineNumber: 1,
            confidence: 1,
          },
          {
            documentKey: projectDocument.key,
            version: projectDocument.version + 1,
            lineNumber: 1,
            confidence: 1,
          },
          {
            documentKey: workspaceDocument.key,
            version: workspaceDocument.version,
            lineNumber: 1,
            confidence: 0.1,
          },
        ],
      };
    },
  };
  const service = new MemoryRetrievalService({
    executorRegistry: registry(executor),
    deliveryStore,
    minConfidence: 0.5,
  });

  const result = await service.retrieve({
    runId: 'run-semantic',
    ...current,
    message: message(current.thread),
    access: access(current.thread),
    memorySnapshot: snapshot,
  });

  assert.equal(result.strategy, 'semantic');
  assert.equal(result.selectedLines, 1);
  assert.match(result.snapshot.text, /Use Postgres for distributed workers/u);
  assert.doesNotMatch(result.snapshot.text, /severity rubric|apollo-secret/u);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].purpose, 'memory_retrieval');
  assert.doesNotMatch(requests[0].memory, /apollo-secret/u);
  assert.deepEqual(
    requests[0].access.grants.map((grant) => grant.kind),
    ['memory', 'memory', 'memory', 'memory'],
  );
  assert.deepEqual(requests[0].access.networkPolicy, {
    mode: 'deny-by-default',
    allowedHosts: [],
  });
  const usage = await deliveryStore.usageSnapshot({
    workspaceId: current.workspace.id,
  });
  assert.deepEqual(usage.purposeTotals, [
    {
      purpose: 'memory_retrieval',
      calls: 1,
      runs: 0,
      costUsd: 0.001,
      inputTokens: 120,
      outputTokens: 8,
      costReportedCalls: 1,
      tokenReportedCalls: 1,
    },
  ]);
});

test('retrieval failure and timeout degrade to bounded lexical memory', async (context) => {
  const { current, snapshot } = await memoryFixture(context);
  for (const [name, executor, expectedReason] of [
    [
      'failure',
      {
        id: 'codex',
        label: 'Codex',
        async run() {
          throw new Error('provider secret detail must not escape');
        },
      },
      'memory_retrieval_executor_failed',
    ],
    [
      'timeout',
      {
        id: 'codex',
        label: 'Codex',
        async run() {
          return new Promise(() => undefined);
        },
      },
      'memory_retrieval_timeout:25ms',
    ],
  ]) {
    const service = new MemoryRetrievalService({
      executorRegistry: registry(executor),
      timeoutMs: name === 'timeout' ? 25 : 1_000,
    });
    const result = await service.retrieve({
      runId: `run-${name}`,
      ...current,
      message: message(current.thread),
      access: access(current.thread),
      memorySnapshot: snapshot,
    });
    assert.equal(result.strategy, 'lexical');
    assert.equal(result.fallbackReason, expectedReason);
    assert.match(result.snapshot.text, /Use Postgres for distributed workers/u);
    assert.doesNotMatch(result.snapshot.text, /apollo-secret/u);
  }
});

test('user cancellation interrupts retrieval instead of becoming a fallback', async (context) => {
  const { current, snapshot } = await memoryFixture(context);
  const executor = {
    id: 'codex',
    label: 'Codex',
    async run() {
      return new Promise(() => undefined);
    },
  };
  const service = new MemoryRetrievalService({
    executorRegistry: registry(executor),
    timeoutMs: 1_000,
  });
  const controller = new AbortController();
  const pending = service.retrieve({
    runId: 'run-stop',
    ...current,
    message: message(current.thread),
    access: access(current.thread),
    memorySnapshot: snapshot,
    abortSignal: controller.signal,
  });
  const reason = new Error('user_stop');
  setTimeout(() => controller.abort(reason), 10);
  await assert.rejects(pending, (error) => error === reason);
});

test('approved semantic aliases recall an old fact without crossing project scope', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-indexed-retrieval-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ScopedFileMemoryStore(root);
  const current = route('project-a');
  const other = route('project-b');

  const proposal = await store.proposeMemory({
    ...current,
    scope: 'project',
    action: 'remember',
    value: 'Use Postgres for distributed workers.',
    actorId: 'memory-runner:codex',
    searchAliases: ['分布式任务持久化方案是什么'],
  });
  await store.approveMemoryProposal({
    id: proposal.id,
    actorId: 'operator:owner',
  });
  await store.rememberScoped({
    ...current,
    scope: 'project',
    text: Array.from({ length: 220 }, (_, index) => `Unrelated recent note ${index}.`).join('\n'),
    actorId: 'operator:owner',
  });
  const otherProposal = await store.proposeMemory({
    ...other,
    scope: 'project',
    action: 'remember',
    value: 'cross-project-secret must never enter another route.',
    actorId: 'memory-runner:codex',
    searchAliases: ['分布式任务持久化方案是什么'],
  });
  await store.approveMemoryProposal({
    id: otherProposal.id,
    actorId: 'operator:owner',
  });

  const snapshot = await store.loadMemory({
    ...current,
    scopes: ['project'],
  });
  const projectDocument = snapshot.scopes[0].document;
  const requests = [];
  const executor = {
    id: 'codex',
    label: 'Codex',
    async run(request) {
      requests.push(request);
      return {
        summary: '',
        artifacts: [],
        memorySelections: [
          {
            documentKey: projectDocument.key,
            version: projectDocument.version,
            lineNumber: 1,
            confidence: 0.98,
          },
        ],
      };
    },
  };
  const service = new MemoryRetrievalService({
    executorRegistry: registry(executor),
    memoryStore: store,
    maxCandidateLines: 20,
    maxCandidateChars: 12_000,
  });
  const result = await service.retrieve({
    runId: 'run-indexed-retrieval',
    ...current,
    message: message(current.thread, '分布式任务持久化方案是什么？'),
    access: access(current.thread),
    memorySnapshot: snapshot,
  });

  assert.equal(result.strategy, 'semantic');
  assert.equal(result.candidateLines, 20);
  assert.match(requests[0].memory, /Use Postgres for distributed workers/u);
  assert.doesNotMatch(requests[0].memory, /cross-project-secret/u);
  assert.match(result.snapshot.text, /Use Postgres for distributed workers/u);
  assert.doesNotMatch(result.snapshot.text, /cross-project-secret/u);
});

test('local retrieval uses Chinese word segments and collapses duplicate facts', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-zh-retrieval-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ScopedFileMemoryStore(root);
  const current = route('project-a');
  await store.rememberScoped({
    ...current,
    scope: 'workspace',
    text: '分布式任务使用 Postgres 持久化。',
    actorId: 'operator:owner',
  });
  await store.rememberScoped({
    ...current,
    scope: 'project',
    text: '分布式任务使用 Postgres 持久化。',
    actorId: 'operator:owner',
  });
  await store.rememberScoped({
    ...current,
    scope: 'project',
    text: '前端颜色使用中性色。',
    actorId: 'operator:owner',
  });
  const snapshot = await store.loadMemory({
    ...current,
    scopes: ['workspace', 'project'],
  });
  const service = new MemoryRetrievalService({
    executorRegistry: new StaticExecutorRegistry({
      defaultExecutorId: 'codex',
      registrations: [
        {
          descriptor: { ...descriptor(), status: 'unavailable' },
          executor: { id: 'codex', label: 'Codex', async run() { throw new Error('not used'); } },
        },
      ],
    }),
  });
  const result = await service.retrieve({
    runId: 'run-local-chinese',
    ...current,
    message: message(current.thread, '分布式任务应该用什么持久化方案？'),
    access: access(current.thread),
    memorySnapshot: snapshot,
  });
  assert.equal(result.strategy, 'lexical');
  assert.equal(
    result.snapshot.text.match(/分布式任务使用 Postgres 持久化/gu)?.length,
    1,
  );
  assert.doesNotMatch(result.snapshot.text, /前端颜色/u);
});

test('semantic retrieval reranks bounded fact context and preserves exact source lines', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-fact-context-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ScopedFileMemoryStore(root);
  const current = route('project-a');
  await store.rememberScoped({
    ...current,
    scope: 'project',
    text: 'Release checklist:\nrun the canary in staging\nwait 30 minutes before production',
    actorId: 'operator:owner',
  });
  await store.rememberScoped({
    ...current,
    scope: 'project',
    text: 'Frontend colors use neutral tones.',
    actorId: 'operator:owner',
  });
  const snapshot = await store.loadMemory({ ...current, scopes: ['project'] });
  const document = snapshot.scopes[0].document;
  const requests = [];
  const service = new MemoryRetrievalService({
    executorRegistry: registry({
      id: 'codex',
      label: 'Codex',
      async run(request) {
        requests.push(request);
        const reference = JSON.parse(
          request.memory.match(/^REF (\{[^\n]+\})/mu)[1],
        );
        return {
          summary: '',
          artifacts: [],
          memorySelections: [{
            documentKey: reference.documentKey,
            version: reference.version,
            lineNumber: reference.lineNumber,
            confidence: 0.99,
          }],
        };
      },
    }),
    memoryStore: store,
  });

  const result = await service.retrieve({
    runId: 'run-fact-context',
    ...current,
    message: message(current.thread, 'What is the staging canary release policy?'),
    access: access(current.thread),
    memorySnapshot: snapshot,
  });

  assert.equal(result.strategy, 'semantic');
  assert.match(requests[0].memory, /\[line 1\].*Release checklist/u);
  assert.match(requests[0].memory, /\[line 2\] run the canary/u);
  assert.match(requests[0].memory, /\[line 3\] wait 30 minutes/u);
  assert.match(result.snapshot.text, /\[line 1\].*Release checklist/u);
  assert.match(result.snapshot.text, /\[line 2\] run the canary/u);
  assert.match(result.snapshot.text, /\[line 3\] wait 30 minutes/u);
  assert.doesNotMatch(result.snapshot.text, /Frontend colors/u);
});

test('expired lines stay out of semantic candidates while visible lines retain original references', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-expired-retrieval-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ScopedFileMemoryStore(root);
  const current = route('project-a');
  await store.rememberScoped({
    ...current,
    scope: 'project',
    text: 'Expired secret is obsolete.',
    expiresAt: '2000-01-01T00:00:00.000Z',
    actorId: 'operator:owner',
  });
  await store.rememberScoped({
    ...current,
    scope: 'project',
    text: 'Visible deployment owner is the platform team.',
    actorId: 'operator:owner',
  });
  const snapshot = await store.loadMemory({ ...current, scopes: ['project'] });
  assert.deepEqual(snapshot.scopes[0].lineNumbers, [2]);
  assert.doesNotMatch(snapshot.scopes[0].document.content, /Expired secret/u);
  const document = snapshot.scopes[0].document;
  const requests = [];
  const executor = {
    id: 'codex',
    label: 'Codex',
    async run(request) {
      requests.push(request);
      return {
        summary: '',
        artifacts: [],
        memorySelections: [{
          documentKey: document.key,
          version: document.version,
          lineNumber: 2,
          confidence: 0.99,
        }],
      };
    },
  };
  const service = new MemoryRetrievalService({
    executorRegistry: registry(executor),
    memoryStore: store,
  });
  const result = await service.retrieve({
    runId: 'run-expired-retrieval',
    ...current,
    message: message(current.thread, 'Who owns deployment?'),
    access: access(current.thread),
    memorySnapshot: snapshot,
  });
  assert.equal(result.strategy, 'semantic');
  assert.match(requests[0].memory, /"lineNumber":2/u);
  assert.doesNotMatch(requests[0].memory, /Expired secret/u);
  assert.match(result.snapshot.text, /\[line 2\].*platform team/u);
});
