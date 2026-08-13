import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createEmptyDeliveryState,
  FileDeliveryStore,
} from '../packages/delivery/dist/index.js';
import { SqliteOpenTagStore } from '../packages/storage-sqlite/dist/index.js';

const now = new Date('2026-08-13T12:00:00.000Z');
const old = '2026-01-01T00:00:00.000Z';
const recent = '2026-08-01T00:00:00.000Z';

function route(workspaceId, threadId) {
  return {
    id: `lark:${workspaceId}:${threadId}`,
    platform: 'lark',
    externalId: `oc_${workspaceId}:${threadId}`,
    channelId: `oc_${workspaceId}`,
    workspaceId,
    projectId: 'opentag',
    visibility: 'private',
  };
}

function run(id, workspaceId, threadId, status, updatedAt) {
  const thread = route(workspaceId, threadId);
  return {
    id,
    status,
    platform: 'lark',
    thread,
    threadId: thread.id,
    threadExternalId: thread.externalId,
    workspaceId,
    projectId: 'opentag',
    createdAt: updatedAt,
    updatedAt,
    ...(status === 'completed' ? { completedAt: updatedAt } : {}),
    ...(status === 'failed' ? { failedAt: updatedAt } : {}),
  };
}

function lifecycleState() {
  const state = createEmptyDeliveryState();
  state.agentRuns.push(
    run('delete-a', 'acme', 'shared', 'completed', old),
    run('delete-b', 'acme', 'shared', 'failed', old),
    run('recent-shared', 'acme', 'shared', 'completed', recent),
    run('protected-external', 'acme', 'external', 'completed', old),
    run('recent-external', 'acme', 'external', 'completed', recent),
    run('protected-outbox', 'acme', 'outbox', 'completed', old),
    run('recent-outbox', 'acme', 'outbox', 'completed', recent),
    run('protected-approval', 'acme', 'approval', 'completed', old),
    run('recent-approval', 'acme', 'approval', 'completed', recent),
    run('protected-artifact', 'acme', 'artifact', 'completed', old),
    run('recent-artifact', 'acme', 'artifact', 'completed', recent),
    run('active', 'acme', 'active', 'running', old),
    run('closure-a', 'acme', 'closure', 'completed', old),
    run('closure-b', 'acme', 'closure', 'completed', old),
    run('closure-c', 'acme', 'closure', 'completed', recent),
    run('other-workspace', 'labs', 'other', 'completed', old),
  );
  state.agentRunEvents.push(
    { id: 'event-delete-a', sequence: 1, runId: 'delete-a', type: 'completed', at: old },
    { id: 'event-delete-b', sequence: 2, runId: 'delete-b', type: 'failed', at: old },
    {
      id: 'event-artifact', sequence: 3, runId: 'protected-artifact', type: 'artifact', at: old,
      metadata: { artifact: { id: 'report', kind: 'file', title: 'Report', metadata: { managed: true } } },
    },
  );
  state.outbox.push(
    {
      id: 'outbox-active', sequence: 1, kind: 'lark.text', target: { platform: 'lark' },
      payload: {}, status: 'pending', attempts: 0, maxAttempts: 3, nextAttemptAt: old,
      runId: 'protected-outbox', workspaceId: 'acme', createdAt: old, updatedAt: old,
    },
    {
      id: 'outbox-delete', sequence: 2, kind: 'lark.text', target: { platform: 'lark' },
      payload: {}, status: 'delivered', attempts: 1, maxAttempts: 3, nextAttemptAt: old,
      runId: 'delete-a', workspaceId: 'acme', createdAt: old, updatedAt: old,
    },
  );
  state.turnDeliveries.push({
    id: 'delivery-delete', runId: 'delete-a', outboxId: 'outbox-delete', kind: 'lark.text',
    platform: 'lark', targetId: 'oc_acme', status: 'completed', queuedAt: old,
    completedAt: old, updatedAt: old, workspaceId: 'acme',
  });
  state.agentRunSteering.push({
    id: 'steering-delete', sequence: 1, targetRunId: 'delete-a', continuationRunId: 'delete-b',
    status: 'applied', allowLive: false, platform: 'lark', thread: route('acme', 'shared'),
    message: { id: 'followup', threadId: route('acme', 'shared').id, platform: 'lark', text: 'next', actor: { id: 'user' } },
    threadId: route('acme', 'shared').id, workspaceId: 'acme', receivedAt: old,
    appliedAt: old, updatedAt: old,
  });
  state.agentThreadSessions.push({
    id: 'session-delete', providerId: 'codex', namespace: 'test', sessionId: 'provider-thread',
    status: 'invalidated', platform: 'lark', threadId: route('acme', 'shared').id,
    workspaceId: 'acme', startedByRunId: 'delete-a', lastRunId: 'delete-b',
    createdAt: old, updatedAt: old, invalidatedAt: old,
  });
  state.agentThreadSessions.push(
    {
      id: 'session-closure-a-b', providerId: 'codex', namespace: 'closure-a', sessionId: 'a-b',
      status: 'invalidated', platform: 'lark', threadId: route('acme', 'closure').id,
      workspaceId: 'acme', startedByRunId: 'closure-a', lastRunId: 'closure-b',
      createdAt: old, updatedAt: old, invalidatedAt: old,
    },
    {
      id: 'session-closure-b-c', providerId: 'codex', namespace: 'closure-b', sessionId: 'b-c',
      status: 'invalidated', platform: 'lark', threadId: route('acme', 'closure').id,
      workspaceId: 'acme', startedByRunId: 'closure-b', lastRunId: 'closure-c',
      createdAt: old, updatedAt: old, invalidatedAt: old,
    },
  );
  state.memoryWrapupJobs.push({
    id: 'wrapup-delete', status: 'completed', platform: 'lark', thread: route('acme', 'shared'),
    threadId: route('acme', 'shared').id, workspaceId: 'acme', sourceRunId: 'delete-a',
    attempts: 1, maxAttempts: 3, availableAt: old, createdAt: old, updatedAt: old, completedAt: old,
  });
  state.toolApprovals.push({
    id: 'approval-active', status: 'pending', runId: 'protected-approval', toolCallId: 'call',
    toolName: 'github_issue_create', title: 'Create issue', grantKind: 'github', risk: 'write',
    arguments: {}, argumentSummary: {}, argumentDigest: 'digest', platform: 'lark',
    thread: route('acme', 'approval'), threadId: route('acme', 'approval').id,
    workspaceId: 'acme', requestedBy: 'agent', requestedAt: old, expiresAt: recent,
  });
  state.inboundEvents.push({
    id: 'inbound', platform: 'lark', externalId: 'event', status: 'processed', duplicateCount: 0,
    workspaceId: 'acme', receivedAt: old, processedAt: old, updatedAt: old,
  });
  state.usageRecords.push({
    id: 'usage', runId: 'delete-a', purpose: 'agent', platform: 'lark',
    threadId: route('acme', 'shared').id, threadExternalId: route('acme', 'shared').externalId,
    workspaceId: 'acme', period: '2026-01', source: 'test', runs: 1, costUsd: 1, recordedAt: old,
  });
  state.sourceThreadMessages.push({
    id: 'source', platform: 'lark', threadId: route('acme', 'shared').id,
    threadExternalId: route('acme', 'shared').externalId, workspaceId: 'acme', projectId: 'opentag',
    message: { id: 'source-message', threadId: route('acme', 'shared').id, platform: 'lark', text: 'history', actor: { id: 'user' }, createdAt: old },
    origin: 'event', firstObservedAt: old, lastObservedAt: old,
  });
  return state;
}

test('workspace lifecycle dry-run is read-only and apply preserves active and referenced evidence', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-data-lifecycle-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'delivery-state.json');
  await fs.writeFile(stateFile, JSON.stringify(lifecycleState()), 'utf8');
  const store = new FileDeliveryStore(root);
  const before = await fs.readFile(stateFile, 'utf8');
  const preview = await store.pruneWorkspaceData({
    workspaceId: 'acme', retentionDays: 90, keepLatestPerThread: 1,
    protectedRunIds: ['protected-external'], now,
  });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.removed.agentRuns, 2);
  assert.equal(preview.removed.agentRunEvents, 2);
  assert.equal(preview.removed.outbox, 1);
  assert.equal(preview.removed.invalidatedSessions, 1);
  assert.equal(preview.preserved.activeRuns, 1);
  assert.equal(preview.preserved.managedArtifactRuns, 1);
  assert.equal(await fs.readFile(stateFile, 'utf8'), before);
  assert.equal('candidateRunIds' in preview, false);

  const applied = await store.pruneWorkspaceData({
    workspaceId: 'acme', retentionDays: 90, keepLatestPerThread: 1,
    protectedRunIds: ['protected-external'], now, dryRun: false, actor: 'operator:owner',
  });
  assert.equal(applied.dryRun, false);
  assert.deepEqual(
    (await store.listAgentRuns({ workspaceId: 'acme', limit: 50 })).map((item) => item.id).sort(),
    ['active', 'closure-a', 'closure-b', 'closure-c', 'protected-approval', 'protected-artifact', 'protected-external', 'protected-outbox', 'recent-approval', 'recent-artifact', 'recent-external', 'recent-outbox', 'recent-shared'].sort(),
  );
  assert.ok(await store.getAgentRun('other-workspace'));
  assert.equal((await store.listInboundEvents({ workspaceId: 'acme' })).length, 1);
  assert.equal((await store.usageSnapshot({ workspaceId: 'acme', period: '2026-01' })).recordCount, 1);
  assert.equal((await store.loadThreadTranscript({ thread: route('acme', 'shared') })).entries.length, 1);
  const [audit] = await store.listDataLifecycleAudit({ workspaceId: 'acme' });
  assert.equal(audit.actor, 'operator:owner');
  assert.equal(audit.removed.agentRuns, 2);
});

test('workspace lifecycle apply is immediately visible across SQLite store instances', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-data-lifecycle-sqlite-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'delivery-state.json');
  const databasePath = path.join(root, 'opentag.sqlite');
  await fs.writeFile(legacy, JSON.stringify(lifecycleState()), 'utf8');
  const first = new SqliteOpenTagStore({ databasePath, legacyDeliveryFile: legacy });
  const second = new SqliteOpenTagStore({ databasePath });
  context.after(() => first.close());
  context.after(() => second.close());
  const applied = await first.deliveryStore.pruneWorkspaceData({
    workspaceId: 'acme', retentionDays: 90, keepLatestPerThread: 1,
    protectedRunIds: ['protected-external'], now, dryRun: false, actor: 'operator:owner',
  });
  assert.equal(applied.removed.agentRuns, 2);
  assert.equal(await second.deliveryStore.getAgentRun('delete-a'), undefined);
  assert.ok(await second.deliveryStore.getAgentRun('protected-outbox'));
  assert.equal((await second.deliveryStore.listDataLifecycleAudit({ workspaceId: 'acme' })).length, 1);
});
