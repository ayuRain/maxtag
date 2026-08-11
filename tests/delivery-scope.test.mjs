import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileDeliveryStore } from '../packages/delivery/dist/index.js';

function thread(workspaceId) {
  return {
    id: `lark:${workspaceId}:root`,
    platform: 'lark',
    externalId: `${workspaceId}:root`,
    channelId: `channel-${workspaceId}`,
    workspaceId,
    projectId: 'project',
    visibility: 'public',
  };
}

function message(sourceThread) {
  return {
    id: `message-${sourceThread.workspaceId}`,
    threadId: sourceThread.id,
    platform: 'lark',
    text: 'status',
    actor: { id: `actor-${sourceThread.workspaceId}` },
    mentionsAgent: true,
  };
}

test('delivery collections and summaries filter by workspace before limiting', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-delivery-scope-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);

  for (const workspaceId of ['acme', 'labs']) {
    const sourceThread = thread(workspaceId);
    await store.createAgentRun({
      runId: `run-${workspaceId}`,
      thread: sourceThread,
      message: message(sourceThread),
    });
    await store.enqueue({
      kind: 'lark.text',
      target: { platform: 'lark', chatId: sourceThread.channelId },
      payload: { text: workspaceId },
      runId: `run-${workspaceId}`,
      thread: sourceThread,
    });
    await store.configureThreadBinding({
      platform: 'lark',
      externalId: sourceThread.channelId,
      workspaceId,
      projectId: 'project',
    });
    await store.recordInboundEvent({
      platform: 'lark',
      externalId: `event-${workspaceId}`,
      workspaceId,
      projectId: 'project',
      threadId: sourceThread.id,
    });
  }

  assert.deepEqual(
    (await store.listOutbox({ workspaceId: 'acme', limit: 1 })).map(
      (record) => record.workspaceId,
    ),
    ['acme'],
  );
  assert.deepEqual(
    (await store.listTurnDeliveries({ workspaceId: 'acme' })).map(
      (record) => record.workspaceId,
    ),
    ['acme'],
  );
  assert.deepEqual(
    (await store.listInboundEvents({ workspaceId: 'acme' })).map(
      (record) => record.workspaceId,
    ),
    ['acme'],
  );
  assert.deepEqual(
    (await store.listThreadBindings(10, 'acme')).map(
      (record) => record.workspaceId,
    ),
    ['acme'],
  );

  const scoped = await store.summarize('acme');
  assert.equal(scoped.outbox.pending, 1);
  assert.equal(scoped.turnDeliveries.queued, 1);
  assert.equal(scoped.inboundEvents.received, 1);
  assert.equal(scoped.agentRuns.queued, 1);
  assert.equal(scoped.bindings, 1);
  assert.equal((await store.summarize()).agentRuns.queued, 2);
});
