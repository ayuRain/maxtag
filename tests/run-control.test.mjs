import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDurableSteeringProvider,
  monitorDurableRunCancellation,
} from '@opentag/runtime-host';
import { SqliteOpenTagStore } from '@opentag/storage-sqlite';

function sourceThread() {
  return {
    id: 'telegram:project:topic-9',
    platform: 'telegram',
    externalId: 'project:topic-9',
    workspaceId: 'acme',
    projectId: 'payments',
    visibility: 'public',
  };
}

function sourceMessage(thread, id, text) {
  return {
    id,
    threadId: thread.id,
    platform: thread.platform,
    text,
    actor: { id: `actor-${id}` },
    createdAt: new Date().toISOString(),
    mentionsAgent: true,
  };
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-control-'));
  const databasePath = path.join(root, 'opentag.sqlite');
  const first = new SqliteOpenTagStore({ databasePath });
  const second = new SqliteOpenTagStore({ databasePath });
  context.after(async () => {
    first.close();
    second.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { first, second };
}

test('durable cancellation reaches a run owned by another process', async (context) => {
  const { first, second } = await fixture(context);
  const thread = sourceThread();
  await first.deliveryStore.createAgentRun({
    runId: 'cross-process-run',
    thread,
    message: sourceMessage(thread, 'first', 'Start a long task.'),
  });
  await first.deliveryStore.claimQueuedAgentRuns({
    workerId: 'worker-a',
  });
  const controller = new AbortController();
  const stop = monitorDurableRunCancellation({
    deliveryStore: first.deliveryStore,
    runId: 'cross-process-run',
    abortController: controller,
    pollMs: 25,
  });
  context.after(stop);

  await second.deliveryStore.requestAgentRunCancel(
    'cross-process-run',
    'operator_requested',
  );
  await Promise.race([
    new Promise((resolve) =>
      controller.signal.addEventListener('abort', resolve, { once: true }),
    ),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('cancel_poll_timeout')), 1_000),
    ),
  ]);
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason, 'operator_requested');
});

test('live steering mailbox is visible across SQLite store instances', async (context) => {
  const { first, second } = await fixture(context);
  const thread = sourceThread();
  await first.deliveryStore.createAgentRun({
    runId: 'live-cross-process-run',
    thread,
    message: sourceMessage(thread, 'initial', 'Investigate.'),
  });
  await first.deliveryStore.claimQueuedAgentRuns({ workerId: 'worker-a' });
  const provider = createDurableSteeringProvider({
    deliveryStore: first.deliveryStore,
    runId: 'live-cross-process-run',
    workerId: 'worker-a',
    pollMs: 25,
  });
  const channel = await provider.open('live');
  const pending = channel.receive({ waitMs: 1_000 });

  const followUp = await second.deliveryStore.createAgentRunOrSteer({
    runId: 'unused-follow-up-run',
    thread,
    message: sourceMessage(thread, 'follow-up', 'Check PostgreSQL first.'),
  });
  assert.equal(followUp.disposition, 'steered');
  const received = await pending;
  assert.equal(received.message.text, 'Check PostgreSQL first.');
  await channel.acknowledge(received.id, 'Merged into active prompt');

  const stored = (
    await second.deliveryStore.listAgentRunSteering({
      runId: 'live-cross-process-run',
    })
  )[0];
  assert.equal(stored.status, 'applied');
  assert.equal(stored.mode, 'live');
});
