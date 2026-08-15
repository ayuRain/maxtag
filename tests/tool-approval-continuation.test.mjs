import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileDeliveryStore } from '@opentag/delivery';
import { scheduleToolApprovalContinuation } from '@opentag/runtime-host';
import { SqliteOpenTagStore } from '@opentag/storage-sqlite';

function thread() {
  return {
    id: 'lark:payments:root',
    platform: 'lark',
    externalId: 'payments:root',
    channelId: 'oc-payments',
    rootMessageId: 'om-root',
    topicId: 'om-root',
    workspaceId: 'acme',
    projectId: 'acme:payments',
    visibility: 'private',
  };
}

function message(id = 'message-1') {
  return {
    id,
    threadId: thread().id,
    platform: 'lark',
    text: 'Update the project and verify it.',
    actor: { id: 'user-1', displayName: 'Ada' },
    createdAt: '2026-08-13T01:00:00.000Z',
    mentionsAgent: true,
  };
}

async function persistedApproval(store) {
  const proposed = await store.proposeToolApproval({
    runId: 'source-run',
    toolCallId: 'tool-call-1',
    toolName: 'workspace_write',
    title: 'Write workspace file',
    grantKind: 'shell',
    risk: 'write',
    arguments: { path: 'src/index.ts' },
    argumentSummary: { path: 'src/index.ts' },
    argumentDigest: 'digest',
    thread: thread(),
    requestedBy: 'agent:payments',
    now: new Date('2026-08-13T01:00:10.000Z'),
  });
  await store.approveToolApproval({
    id: proposed.id,
    actorId: 'operator:ada',
    now: new Date('2026-08-13T01:01:00.000Z'),
  });
  await store.claimToolApproval({
    id: proposed.id,
    claimedBy: 'worker-1',
    expectedArgumentDigest: 'digest',
    now: new Date('2026-08-13T01:01:01.000Z'),
  });
  return store.completeToolApproval({
    id: proposed.id,
    claimedBy: 'worker-1',
    resultPreview: 'Write workspace file completed',
    resultUrl: 'https://github.example/acme/payments/issues/77',
    now: new Date('2026-08-13T01:01:02.000Z'),
  });
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-tool-continuation-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return new FileDeliveryStore(root);
}

test('successful tool approval schedules one same-thread continuation after a terminal run', async (context) => {
  const store = await fixture(context);
  await store.createAgentRun({
    runId: 'source-run',
    thread: thread(),
    message: message(),
    bindingId: 'binding-1',
    executorId: 'codex',
    transportMode: 'lark-http',
    metadata: { agentId: 'payments' },
  });
  const claimed = (await store.claimQueuedAgentRuns({ workerId: 'worker-1' }))[0];
  await store.markAgentRunCompleted(claimed.id, 'Waiting for approval.');
  const completedApproval = await persistedApproval(store);

  const first = await scheduleToolApprovalContinuation({
    deliveryStore: store,
    approval: completedApproval,
  });
  const currentApproval = await store.getToolApproval(completedApproval.id);
  const second = await scheduleToolApprovalContinuation({
    deliveryStore: store,
    approval: currentApproval,
  });

  assert.equal(first?.disposition, 'created');
  assert.equal(first?.run.id, `tool-approval:${completedApproval.id}`);
  assert.equal(second, undefined);
  const queued = await store.getAgentRun(`tool-approval:${completedApproval.id}`);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.thread.id, thread().id);
  assert.equal(queued.executorId, 'codex');
  assert.equal(queued.bindingId, 'binding-1');
  assert.equal(queued.metadata.source, 'tool-approval');
  assert.equal(queued.metadata.continuationOfRunId, 'source-run');
  assert.equal(queued.message.replyToMessageId, 'message-1');
  assert.match(queued.message.text, /Continue the original request/u);
  assert.match(
    queued.message.text,
    /External result: https:\/\/github\.example\/acme\/payments\/issues\/77/u,
  );
  assert.equal(
    queued.message.metadata.resultUrl,
    'https://github.example/acme/payments/issues/77',
  );
  assert.doesNotMatch(JSON.stringify(queued), /src\/index\.ts/u);
  assert.equal(
    (await store.listAgentRuns({ workspaceId: 'acme', limit: 20 })).filter(
      (run) => run.id === queued.id,
    ).length,
    1,
  );
  assert.equal(currentApproval.continuationStatus, 'scheduled');
  assert.equal(currentApproval.continuationRunId, queued.id);
});

test('successful tool approval queues a next turn when the source run is still active', async (context) => {
  const store = await fixture(context);
  await store.createAgentRun({
    runId: 'source-run',
    thread: thread(),
    message: message(),
    executorId: 'claude',
    transportMode: 'lark-http',
  });
  await store.claimQueuedAgentRuns({ workerId: 'worker-1' });
  const completedApproval = await persistedApproval(store);

  const staged = await scheduleToolApprovalContinuation({
    deliveryStore: store,
    approval: completedApproval,
  });
  assert.equal(staged?.disposition, 'steered');
  assert.equal(staged?.run.id, 'source-run');
  assert.equal(staged?.steering.allowLive, false);
  assert.equal(
    staged?.steering.message.id,
    `tool-approval:${completedApproval.id}`,
  );
  const scheduledApproval = await store.getToolApproval(completedApproval.id);
  assert.equal(scheduledApproval.continuationStatus, 'scheduled');
  assert.equal(
    scheduledApproval.continuationRunId,
    `steering:${staged.steering.id}`,
  );

  await store.markAgentRunCompleted('source-run', 'Waiting for approval.');
  const continuation = await store.getAgentRun(
    `steering:${staged.steering.id}`,
  );
  assert.equal(continuation?.status, 'queued');
  assert.equal(continuation?.executorId, 'claude');
  assert.equal(continuation?.metadata.source, 'steering');
  assert.equal(continuation?.metadata.toolApprovalId, completedApproval.id);
});

test('failed or rejected tool approvals do not continue the agent', async (context) => {
  const store = await fixture(context);
  await store.createAgentRun({
    runId: 'source-run',
    thread: thread(),
    message: message(),
    executorId: 'codex',
  });
  const failed = {
    ...(await persistedApproval(store)),
    status: 'failed',
  };
  assert.equal(
    await scheduleToolApprovalContinuation({
      deliveryStore: store,
      approval: failed,
    }),
    undefined,
  );
  assert.equal((await store.listAgentRuns({ limit: 20 })).length, 1);
});

test('pending successful approval continuation recovers across SQLite processes', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-tool-continuation-sqlite-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'opentag.sqlite');
  const first = new SqliteOpenTagStore({ databasePath });
  await first.deliveryStore.createAgentRun({
    runId: 'source-run',
    thread: thread(),
    message: message(),
    bindingId: 'binding-1',
    executorId: 'codex',
    transportMode: 'lark-http',
  });
  const [claimed] = await first.deliveryStore.claimQueuedAgentRuns({
    workerId: 'worker-1',
  });
  await first.deliveryStore.markAgentRunCompleted(
    claimed.id,
    'Waiting for approval.',
  );
  const completedApproval = await persistedApproval(first.deliveryStore);
  first.close();

  const replacement = new SqliteOpenTagStore({ databasePath });
  context.after(() => replacement.close());
  const recovered = (
    await replacement.deliveryStore.listToolApprovals({
      status: 'succeeded',
      limit: 20,
    })
  ).find((candidate) => candidate.id === completedApproval.id);
  assert.equal(recovered?.continuationStatus, 'pending');
  const staged = await scheduleToolApprovalContinuation({
    deliveryStore: replacement.deliveryStore,
    approval: recovered,
  });
  assert.equal(staged?.disposition, 'created');

  const finalApproval = await replacement.deliveryStore.getToolApproval(
    completedApproval.id,
  );
  assert.equal(finalApproval.continuationStatus, 'scheduled');
  assert.equal(
    (await replacement.deliveryStore.getAgentRun(finalApproval.continuationRunId))
      ?.status,
    'queued',
  );
});
