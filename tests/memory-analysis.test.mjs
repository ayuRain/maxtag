import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StaticExecutorRegistry } from '@opentag/core';
import { FileDeliveryStore } from '@opentag/delivery';
import { ScopedFileMemoryStore } from '@opentag/memory';
import { MemoryAnalysisService } from '@opentag/runtime-host';

function thread() {
  return {
    id: 'lark:oc_memory:root',
    platform: 'lark',
    externalId: 'oc_memory:root',
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    channelId: 'oc_memory',
    rootMessageId: 'om_root',
    topicId: 'om_root',
    visibility: 'private',
  };
}

function message(sourceThread) {
  return {
    id: 'message-memory-source',
    threadId: sourceThread.id,
    platform: 'lark',
    text: 'SQLite is no longer sufficient. Use Postgres for distributed workers.',
    actor: { id: 'user-1', displayName: 'Owner' },
    createdAt: new Date().toISOString(),
    mentionsAgent: true,
  };
}

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

test('memory runner synthesizes a full transcript into version-bound merge proposals', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-analysis-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const deliveryStore = new FileDeliveryStore(path.join(root, 'delivery'));
  const memoryStore = new ScopedFileMemoryStore(path.join(root, 'memory'));
  const sourceThread = thread();
  await memoryStore.rememberScoped({
    thread: sourceThread,
    workspace: { id: 'workspace-a', name: 'Workspace A' },
    project: {
      id: 'workspace-a:project-a',
      workspaceId: 'workspace-a',
      key: 'project-a',
      name: 'Project A',
    },
    scope: 'project',
    text: 'Use SQLite WAL for shared workers.',
    actorId: 'operator:owner',
  });
  await memoryStore.rememberScoped({
    thread: sourceThread,
    workspace: { id: 'workspace-a', name: 'Workspace A' },
    project: {
      id: 'workspace-a:project-a',
      workspaceId: 'workspace-a',
      key: 'project-a',
      name: 'Project A',
    },
    scope: 'project',
    text: 'Keep shared-worker database backups for 30 days.',
    actorId: 'operator:owner',
  });
  await deliveryStore.createAgentRun({
    runId: 'run-memory-source',
    thread: sourceThread,
    message: message(sourceThread),
    executorId: 'codex',
  });
  await deliveryStore.markAgentRunCompleted(
    'run-memory-source',
    'Confirmed Postgres as the new storage decision.',
  );

  const requests = [];
  const executor = {
    id: 'codex',
    label: 'Codex',
    async run(request) {
      requests.push(request);
      if (request.purpose === 'memory_query') {
        return {
          summary: 'Postgres replaced SQLite for distributed workers. [project v1]',
          artifacts: [],
          usage: { runs: 1, costUsd: 0.002, inputTokens: 40, outputTokens: 8 },
        };
      }
      return {
        summary: '',
        artifacts: [],
        usage: { runs: 1, costUsd: 0.003, inputTokens: 60, outputTokens: 12 },
        memoryDecisions: [
          {
            operation: 'merge',
            scope: 'project',
            text: 'Use Postgres for distributed workers with 30-day backups.',
            selectors: [
              'Use SQLite WAL for shared workers.',
              'Keep shared-worker database backups for 30 days.',
            ],
            expectedDocumentVersion: 2,
            aliases: ['shared worker storage policy'],
            reason: 'The user superseded storage while retaining backup policy.',
            confidence: 0.96,
          },
          {
            operation: 'remember',
            scope: 'thread',
            text: 'This turn is still running.',
            reason: 'Transient status.',
            confidence: 0.2,
          },
          {
            operation: 'merge',
            scope: 'project',
            text: 'An over-broad merge.',
            selectors: Array.from({ length: 9 }, (_, index) => `fact-${index}`),
            expectedDocumentVersion: 2,
            reason: 'Too many independent facts.',
            confidence: 0.99,
          },
          {
            operation: 'index',
            scope: 'project',
            selector: 'Use SQLite WAL for shared workers.',
            expectedDocumentVersion: 2,
            aliases: ['共享 worker 数据库', 'shared worker persistence'],
            reason: 'Backfill semantic retrieval for approved memory.',
            confidence: 0.92,
          },
          {
            operation: 'index',
            scope: 'project',
            selector: 'Use SQLite WAL for shared workers.',
            expectedDocumentVersion: 2,
            aliases: ['api_key=must-not-index'],
            reason: 'Unsafe alias.',
            confidence: 0.99,
          },
        ],
      };
    },
  };
  const registry = new StaticExecutorRegistry({
    defaultExecutorId: 'codex',
    registrations: [{ executor, descriptor: descriptor() }],
  });
  const threadConfigStore = {
    async getWorkspace() {
      return { id: 'workspace-a', name: 'Workspace A' };
    },
    async getProject() {
      return {
        id: 'workspace-a:project-a',
        workspaceId: 'workspace-a',
        key: 'project-a',
        name: 'Project A',
      };
    },
    async getIdentity() {
      throw new Error('not_used');
    },
    async getAccessBundle() {
      return {
        id: 'memory-access',
        threadId: sourceThread.id,
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        grants: ['workspace', 'project', 'channel', 'thread'].map((scope) => ({
          id: `memory-${scope}`,
          kind: 'memory',
          scope,
          label: `${scope} memory`,
          constraints: { permissions: ['read', 'write'] },
        })),
        networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        memoryRetentionDays: { project: 60, thread: 7 },
      };
    },
  };
  const service = new MemoryAnalysisService({
    deliveryStore,
    memoryStore,
    threadConfigStore,
    executorRegistry: registry,
    executorId: 'codex',
    minConfidence: 0.65,
  });

  const report = await service.analyze({
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    runId: 'run-memory-source',
    actorId: 'operator:owner',
  });
  assert.equal(report.executor.model, 'gpt-5.6-luna');
  assert.equal(report.transcript.entries, 2);
  assert.equal(report.proposed.length, 2);
  assert.equal(report.proposed[0].action, 'merge');
  assert.deepEqual(report.proposed[0].selectors, [
    'Use SQLite WAL for shared workers.',
    'Keep shared-worker database backups for 30 days.',
  ]);
  assert.equal(report.proposed[0].expectedDocumentVersion, 2);
  assert.equal(report.proposed[0].retentionDays, 60);
  assert.equal(report.proposed[1].action, 'index');
  assert.deepEqual(report.proposed[1].searchAliases, [
    '共享 worker 数据库',
    'shared worker persistence',
  ]);
  assert.ok(report.skipped.some((item) => item.reason === 'sensitive_value'));
  assert.ok(
    report.skipped.some(
      (item) => item.reason === 'merge_selectors_limit_exceeded',
    ),
  );
  assert.equal(report.skipped[0].reason, 'low_confidence');
  assert.equal(requests[0].purpose, 'memory_analysis');
  assert.equal(requests[0].providerSession, undefined);
  assert.equal(requests[0].access.networkPolicy.mode, 'deny-by-default');
  assert.ok(requests[0].transcript.entries.some((entry) => entry.role === 'user'));

  const semantic = await service.query({
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    runId: 'run-memory-source',
    query: 'Which database should distributed workers use?',
    scopes: ['project'],
  });
  assert.match(semantic.answer, /Postgres/);
  assert.equal(requests[1].purpose, 'memory_query');
  assert.equal(requests[1].transcript, undefined);
  assert.ok(
    requests[1].access.grants.every(
      (grant) =>
        grant.kind === 'memory' &&
        grant.constraints?.permissions?.length === 1 &&
        grant.constraints.permissions[0] === 'read',
    ),
  );

  const usage = await deliveryStore.usageSnapshot({
    workspaceId: 'workspace-a',
  });
  assert.equal(usage.recordCount, 2);
  assert.deepEqual(
    usage.purposeTotals.map((line) => ({
      purpose: line.purpose,
      calls: line.calls,
      runs: line.runs,
      inputTokens: line.inputTokens,
      outputTokens: line.outputTokens,
    })),
    [
      {
        purpose: 'memory_query',
        calls: 1,
        runs: 0,
        inputTokens: 40,
        outputTokens: 8,
      },
      {
        purpose: 'memory_analysis',
        calls: 1,
        runs: 0,
        inputTokens: 60,
        outputTokens: 12,
      },
    ],
  );

  const events = await deliveryStore.listAgentRunEvents('run-memory-source');
  assert.ok(events.some((event) => event.type === 'memory_analysis_started'));
  assert.ok(events.some((event) => event.type === 'memory_analysis_completed'));
  assert.ok(events.some((event) => event.type === 'memory_query_completed'));
});

test('memory analysis resolves a real topic by configured channel instead of a synthetic admin thread', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-channel-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const deliveryStore = new FileDeliveryStore(path.join(root, 'delivery'));
  const memoryStore = new ScopedFileMemoryStore(path.join(root, 'memory'));
  const sourceThread = thread();
  await deliveryStore.createAgentRun({
    runId: 'run-real-topic',
    thread: sourceThread,
    message: message(sourceThread),
  });
  await deliveryStore.markAgentRunCompleted('run-real-topic', 'done');
  const executor = {
    id: 'codex',
    label: 'Codex',
    async run(request) {
      assert.equal(request.thread.id, sourceThread.id);
      return { summary: 'Found the real topic.', artifacts: [] };
    },
  };
  const service = new MemoryAnalysisService({
    deliveryStore,
    memoryStore,
    threadConfigStore: {
      async getWorkspace() { return { id: 'workspace-a', name: 'Workspace A' }; },
      async getProject() {
        return { id: 'workspace-a:project-a', workspaceId: 'workspace-a', key: 'project-a', name: 'Project A' };
      },
      async getIdentity() { throw new Error('not_used'); },
      async getAccessBundle() {
        return {
          id: 'read-access',
          threadId: sourceThread.id,
          grants: [{
            id: 'project-memory',
            kind: 'memory',
            scope: 'project',
            label: 'Project memory',
            constraints: { permissions: ['read', 'write'] },
          }],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        };
      },
    },
    executorRegistry: new StaticExecutorRegistry({
      defaultExecutorId: 'codex',
      registrations: [{ executor, descriptor: descriptor() }],
    }),
  });
  const synthetic = {
    ...sourceThread,
    id: 'lark:oc_memory:admin',
    externalId: 'oc_memory',
  };
  const result = await service.query({
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    thread: synthetic,
    scopes: ['project'],
    query: 'Find the latest decision.',
  });
  assert.equal(result.sourceRunId, 'run-real-topic');
});
