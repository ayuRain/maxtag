import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  OpenTagRuntime,
  StaticExecutorRegistry,
} from '@opentag/core';
import {
  createDefaultExecutorRegistry,
  createOpenTagWorkerHost,
} from '@opentag/runtime-host';

function descriptor(id, label, steering = 'next_turn') {
  return {
    id,
    label,
    provider: id,
    mode: 'test',
    status: 'ready',
    capabilities: {
      steering,
      providerSessions: true,
      transcriptFallback: true,
      brokeredTools: true,
      nativeTools: false,
      inputAttachments: true,
      managedArtifacts: true,
      automaticMemoryCandidates: true,
      contextRecovery: true,
      nativeCompaction: false,
    },
  };
}

test('executor registry validates registrations and returns immutable descriptors', () => {
  const executor = {
    id: 'remote-agent',
    label: 'Remote Agent',
    async run() {
      return { summary: 'remote result', artifacts: [] };
    },
  };
  const registry = new StaticExecutorRegistry({
    defaultExecutorId: executor.id,
    registrations: [{ executor, descriptor: descriptor(executor.id, executor.label) }],
  });

  assert.equal(registry.has('remote-agent'), true);
  assert.equal(registry.get('remote-agent'), executor);
  const listed = registry.list();
  listed[0].capabilities.providerSessions = false;
  assert.equal(registry.describe('remote-agent').capabilities.providerSessions, true);
  assert.throws(
    () => registry.register({ executor, descriptor: descriptor(executor.id, executor.label) }),
    /executor_already_registered/,
  );
  assert.throws(
    () =>
      new StaticExecutorRegistry({
        defaultExecutorId: 'missing',
        registrations: [{ executor, descriptor: descriptor(executor.id, executor.label) }],
      }),
    /default_executor_not_registered/,
  );
});

test('runtime selects a third-party executor entirely through the registry', async () => {
  const calls = [];
  const thread = {
    id: 'lark:acme:root',
    platform: 'lark',
    externalId: 'acme:root',
    workspaceId: 'acme',
    projectId: 'search',
    channelId: 'search',
    visibility: 'public',
  };
  const remote = {
    id: 'remote-agent',
    label: 'Remote Agent',
    steeringMode: 'live',
    async run() {
      calls.push('remote-agent');
      return { summary: 'handled by registry runner', artifacts: [] };
    },
  };
  const registry = new StaticExecutorRegistry({
    defaultExecutorId: remote.id,
    registrations: [
      { executor: remote, descriptor: descriptor(remote.id, remote.label, 'live') },
    ],
  });
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
          async create() { return { surfaceId: 'surface-1' }; },
          async update() {},
          async complete() {},
        };
      },
      async sendMessage(_thread, text) { calls.push(text); },
    },
    executor: remote,
    executorRegistry: registry,
    memory: {
      async loadThreadMemory() { return ''; },
      async remember() {},
      async forget() {},
    },
    threadConfig: {
      async getIdentity() {
        return {
          id: 'search-agent',
          displayName: 'Search Agent',
          instructions: 'Search.',
          defaultExecutorId: remote.id,
        };
      },
      async getAccessBundle() {
        return {
          id: 'access',
          threadId: thread.id,
          grants: [],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        };
      },
    },
  });

  const result = await runtime.handleMessage({
    runId: 'registry-run',
    thread,
    message: {
      id: 'message-1',
      threadId: thread.id,
      platform: 'lark',
      text: 'run remotely',
      actor: { id: 'ada' },
      createdAt: new Date().toISOString(),
      mentionsAgent: true,
    },
  });
  assert.equal(result.summary, 'handled by registry runner');
  assert.deepEqual(calls, ['remote-agent', 'handled by registry runner']);
});

test('registry mode fails closed when a project names an unavailable executor', async () => {
  const fallback = {
    id: 'fallback',
    label: 'Fallback',
    async run() {
      throw new Error('fallback_must_not_run');
    },
  };
  const registry = new StaticExecutorRegistry({
    defaultExecutorId: fallback.id,
    registrations: [
      { executor: fallback, descriptor: descriptor(fallback.id, fallback.label) },
    ],
  });
  const thread = {
    id: 'lark:acme:missing',
    platform: 'lark',
    externalId: 'acme:missing',
    workspaceId: 'acme',
    projectId: 'missing',
    channelId: 'missing',
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
          async create() { return { surfaceId: 'surface-1' }; },
          async update() {},
          async complete() {},
        };
      },
      async sendMessage() {},
    },
    executor: fallback,
    executorRegistry: registry,
    memory: {
      async loadThreadMemory() { return ''; },
      async remember() {},
      async forget() {},
    },
    threadConfig: {
      async getIdentity() {
        return {
          id: 'missing-agent',
          displayName: 'Missing Agent',
          instructions: '',
          defaultExecutorId: 'not-installed',
        };
      },
      async getAccessBundle() {
        return {
          id: 'access',
          threadId: thread.id,
          grants: [],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        };
      },
    },
  });

  await assert.rejects(
    runtime.handleMessage({
      runId: 'missing-run',
      thread,
      message: {
        id: 'message-1',
        threadId: thread.id,
        platform: 'lark',
        text: 'run',
        actor: { id: 'ada' },
        createdAt: new Date().toISOString(),
        mentionsAgent: true,
      },
    }),
    /executor_not_available:not-installed/,
  );
});

test('default registry publishes truthful Codex and Claude capability descriptors', () => {
  const registry = createDefaultExecutorRegistry({ mode: 'local-cli' });
  assert.equal(registry.defaultExecutorId, 'codex');
  assert.deepEqual(registry.list().map((runner) => runner.id), ['codex', 'claude']);
  assert.equal(registry.describe('codex').capabilities.steering, 'live');
  assert.equal(registry.describe('claude').capabilities.steering, 'live');
  assert.equal(registry.describe('codex').capabilities.nativeCompaction, true);
  assert.equal(registry.describe('claude').capabilities.nativeCompaction, false);
  assert.equal(registry.describe('claude').capabilities.automaticMemoryCandidates, true);
});

test('transcript mode does not advertise provider-owned session continuity', () => {
  const registry = createDefaultExecutorRegistry({
    mode: 'local-cli',
    sessionMode: 'transcript',
  });
  assert.equal(registry.describe('codex').capabilities.providerSessions, false);
  assert.equal(registry.describe('claude').capabilities.providerSessions, false);
  assert.equal(registry.describe('codex').capabilities.transcriptFallback, true);
  assert.equal(registry.describe('codex').capabilities.nativeCompaction, false);
});

test('custom Codex wrappers retain the legacy steering contract unless app-server is explicit', () => {
  const legacy = createDefaultExecutorRegistry({
    mode: 'local-cli',
    codexCommand: '/opt/opentag/custom-codex-wrapper',
  });
  const appServer = createDefaultExecutorRegistry({
    mode: 'local-cli',
    codexCommand: '/opt/opentag/custom-codex-wrapper',
    codexAppServer: true,
  });

  assert.equal(legacy.describe('codex').capabilities.steering, 'next_turn');
  assert.equal(appServer.describe('codex').capabilities.steering, 'live');
  assert.equal(legacy.describe('codex').capabilities.nativeCompaction, false);
  assert.equal(appServer.describe('codex').capabilities.nativeCompaction, true);
});

test('memory runner can select independent models by purpose with one inherited default', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-models-'));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const host = createOpenTagWorkerHost({
    dataDir,
    executors: { mode: 'dry-run' },
    memoryAnalysis: {
      model: 'luna-default',
      analysisModel: 'luna-merge',
      queryModel: 'luna-query',
      retrievalModel: 'luna-rerank',
    },
  });

  const analysis = host.memoryAnalysisService.status();
  const retrieval = host.memoryRetrievalService.status();
  assert.equal(analysis.executor.model, 'luna-merge');
  assert.equal(analysis.queryExecutor.model, 'luna-query');
  assert.equal(analysis.wrapupExecutor.model, 'luna-default');
  assert.equal(retrieval.executor.model, 'luna-rerank');
});
