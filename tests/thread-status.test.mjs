import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createOpenTagWorkerHost,
  parseThreadStatusCommand,
} from '@opentag/runtime-host';

test('thread status parser accepts explicit bilingual commands only', () => {
  for (const text of [
    '/status',
    '/maxtag status',
    '@MaxTag capabilities',
    '@MaxTag what can you access?',
    '@MaxTag 你能访问什么？',
    '/opentag 状态',
  ]) {
    assert.deepEqual(parseThreadStatusCommand(text), { kind: 'status' }, text);
  }
  for (const text of [
    'summarize status changes',
    'what can you access in this document',
    '能力建设计划',
    '/maxtag status of CI',
  ]) {
    assert.equal(parseThreadStatusCommand(text), null, text);
  }
});

test('thread status claims independently while a model run owns the topic', async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'maxtag-thread-status-live-'),
  );
  try {
    const host = createOpenTagWorkerHost({
      dataDir,
      workerId: 'thread-status-live-worker',
      lark: { transportMode: 'memory' },
      executors: { mode: 'dry-run' },
    });
    const thread = {
      id: 'lark:oc_live:om_live_root',
      platform: 'lark',
      externalId: 'oc_live:om_live_root',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      channelId: 'oc_live',
      rootMessageId: 'om_live_root',
      visibility: 'private',
    };
    const message = (id, text) => ({
      id,
      threadId: thread.id,
      platform: 'lark',
      text,
      actor: { id: 'ou_member' },
      createdAt: new Date().toISOString(),
      mentionsAgent: true,
    });
    await host.deliveryStore.createAgentRun({
      runId: 'active-model-run',
      thread,
      message: message('om_active', '@MaxTag keep working'),
      transportMode: 'lark-memory',
    });
    await host.deliveryStore.markAgentRunRunning('active-model-run', {
      workerId: 'another-worker',
    });
    await host.deliveryStore.createAgentRun({
      runId: 'parallel-status-run',
      thread,
      message: message('om_parallel_status', '/status'),
      executorId: 'thread-status',
      transportMode: 'lark-memory',
    });

    const pass = await host.runAgentWorkerPass(1);
    assert.equal(pass.claimed, 1);
    assert.equal(pass.completed, 1);
    assert.equal(pass.runs[0].id, 'parallel-status-run');
    assert.equal(pass.runs[0].status, 'completed');
    assert.equal(
      (await host.deliveryStore.getAgentRun('active-model-run')).status,
      'running',
    );
    host.close();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('standalone worker reports only current-thread capabilities even when model budget is exhausted', async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'maxtag-thread-status-'),
  );
  try {
    const host = createOpenTagWorkerHost({
      dataDir,
      workerId: 'thread-status-worker-test',
      lark: { transportMode: 'memory' },
      executors: { mode: 'dry-run' },
    });
    await Promise.all([
      host.skillStore.upsert({
        id: 'release-review',
        name: 'Release Review',
        description: 'Current project skill',
        content: 'Review release evidence.',
      }),
      host.skillStore.upsert({
        id: 'secret-planning',
        name: 'Secret Planning',
        description: 'Sibling project skill',
        content: 'Plan private work.',
      }),
      host.delegatedAgentStore.upsert({
        id: 'release-checker',
        name: 'Release Checker',
        description: 'Current project agent',
        instructions: 'Check the release.',
        executorId: 'codex',
      }),
      host.delegatedAgentStore.upsert({
        id: 'secret-researcher',
        name: 'Secret Researcher',
        description: 'Sibling project agent',
        instructions: 'Research the secret project.',
        executorId: 'codex',
      }),
      host.knowledgeSourceStore.upsert({
        workspaceId: 'dev-workspace',
        id: 'release-runbook',
        name: 'Release Runbook',
        description: 'Current project source',
        kind: 'text',
        content: 'Release checklist.',
      }),
      host.knowledgeSourceStore.upsert({
        workspaceId: 'dev-workspace',
        id: 'secret-notes',
        name: 'Secret Notes',
        description: 'Sibling project source',
        kind: 'text',
        content: 'Do not expose across projects.',
      }),
    ]);
    await host.threadConfigStore.upsertWorkspacePolicy({
      workspaceId: 'dev-workspace',
      budgetPolicy: {
        mode: 'custom',
        scope: 'workspace',
        maxRunsPerMonth: 0,
      },
      actor: 'operator:owner',
    });
    await host.threadConfigStore.upsertProjectPolicy({
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      name: 'MaxTag',
      capabilityMode: 'custom',
      skillIds: ['release-review'],
      agentIds: ['release-checker'],
      knowledgeSourceIds: ['release-runbook'],
      grants: [
        {
          id: 'github:release',
          kind: 'github',
          scope: 'project',
          label: 'Release repository',
        },
      ],
      networkPolicy: {
        mode: 'restricted',
        allowedHosts: ['api.github.com'],
      },
      actor: 'operator:owner',
    });
    await host.threadConfigStore.upsertProjectPolicy({
      workspaceId: 'dev-workspace',
      projectId: 'secret',
      name: 'Secret Project',
      skillIds: ['secret-planning'],
      agentIds: ['secret-researcher'],
      knowledgeSourceIds: ['secret-notes'],
      actor: 'operator:owner',
    });

    const thread = {
      id: 'lark:oc_maxtag:om_status_root',
      platform: 'lark',
      externalId: 'oc_maxtag:om_status_root',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      channelId: 'oc_maxtag',
      rootMessageId: 'om_status_root',
      topicId: 'om_status_root',
      title: 'MaxTag',
      visibility: 'private',
    };
    await host.routineStore.upsertRoutine({
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      name: 'Release pulse',
      instructions: 'Check release status.',
      schedule: { kind: 'interval', everyMinutes: 60 },
      destination: {
        platform: 'lark',
        externalId: thread.externalId,
        channelId: thread.channelId,
        rootMessageId: thread.rootMessageId,
        topicId: thread.topicId,
        visibility: thread.visibility,
      },
    });
    await host.routineStore.upsertRoutine({
      workspaceId: 'dev-workspace',
      projectId: 'secret',
      name: 'Secret pulse',
      instructions: 'Check secret status.',
      schedule: { kind: 'interval', everyMinutes: 60 },
      destination: {
        platform: 'lark',
        externalId: 'oc_secret:om_secret_root',
        channelId: 'oc_secret',
        rootMessageId: 'om_secret_root',
        topicId: 'om_secret_root',
        visibility: 'private',
      },
    });
    const message = (id, text) => ({
      id,
      threadId: thread.id,
      platform: 'lark',
      text,
      actor: { id: 'ou_member', displayName: 'Member' },
      createdAt: new Date().toISOString(),
      mentionsAgent: true,
    });
    await host.deliveryStore.createAgentRun({
      runId: 'thread-status-run',
      thread,
      message: message('om_status', '@MaxTag 你能访问什么？'),
      executorId: 'thread-status',
      transportMode: 'lark-memory',
      metadata: {
        actorAuthorization: {
          mode: 'members',
          workspaceRole: 'member',
          projectRole: 'contributor',
          capabilities: ['invoke_agent', 'write_memory'],
        },
      },
    });
    const statusPass = await host.runAgentWorkerPass(1);
    assert.equal(statusPass.completed, 1);
    assert.equal(statusPass.failed, 0);
    const summary = statusPass.runs[0].summary;
    assert.match(summary, /MaxTag · 群内设置/);
    assert.match(summary, /工作区：Development Workspace \[dev-workspace\]/);
    assert.match(summary, /Project：MaxTag \[opentag\]/);
    assert.match(summary, /Release Review/);
    assert.match(summary, /Release Checker/);
    assert.match(summary, /Release Runbook/);
    assert.match(summary, /Release repository \(github\)/);
    assert.match(summary, /持续任务：1 个运行中/);
    assert.match(summary, /下一次模型调用：已阻止/);
    assert.match(summary, /查看本卡片不消耗模型调用/);
    assert.doesNotMatch(summary, /Secret Planning/);
    assert.doesNotMatch(summary, /Secret Researcher/);
    assert.doesNotMatch(summary, /Secret Notes/);
    assert.doesNotMatch(summary, /Secret pulse/);
    const statusEvents = await host.deliveryStore.listAgentRunEvents(
      'thread-status-run',
    );
    assert.ok(statusEvents.some((event) => event.type === 'thread_status'));
    const statusOutbox = await host.deliveryStore.listOutbox({
      runId: 'thread-status-run',
      limit: 10,
    });
    const statusCard = statusOutbox.find(
      (item) => item.kind === 'lark.card.create',
    );
    assert.ok(statusCard);
    assert.match(
      JSON.stringify(statusCard.payload.card),
      /群内设置/u,
    );
    assert.equal(
      statusOutbox.filter((item) => item.kind === 'lark.text').length,
      0,
    );
    const afterStatusUsage = await host.deliveryStore.usageSnapshot({
      workspaceId: 'dev-workspace',
    });
    assert.equal(afterStatusUsage.records.length, 0);

    await host.deliveryStore.createAgentRun({
      runId: 'blocked-model-run',
      thread,
      message: message('om_model', '@MaxTag summarize this topic'),
      transportMode: 'lark-memory',
    });
    const modelPass = await host.runAgentWorkerPass(1);
    assert.equal(modelPass.completed, 0);
    assert.equal(modelPass.failed, 1);
    assert.equal(modelPass.runs[0].status, 'cancelled');
    assert.match(modelPass.runs[0].lastError, /run budget exceeded/);
    host.close();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
