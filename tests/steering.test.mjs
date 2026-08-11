import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileDeliveryStore } from '@opentag/delivery';

function thread(id = 'incident-42') {
  return {
    id: `lark:project:${id}`,
    platform: 'lark',
    externalId: `project:${id}`,
    channelId: 'project',
    rootMessageId: id,
    workspaceId: 'acme',
    projectId: 'payments',
    visibility: 'public',
  };
}

function message(sourceThread, id, text, actorId = 'user-1') {
  return {
    id,
    threadId: sourceThread.id,
    platform: sourceThread.platform,
    text,
    actor: { id: actorId, displayName: actorId },
    createdAt: new Date().toISOString(),
    mentionsAgent: true,
  };
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-steering-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return new FileDeliveryStore(root);
}

async function inbound(store, sourceThread, sourceMessage) {
  return store.recordInboundEvent({
    platform: sourceThread.platform,
    externalId: sourceMessage.id,
    eventType: 'im.message.receive_v1',
    workspaceId: sourceThread.workspaceId,
    projectId: sourceThread.projectId,
    threadId: sourceThread.id,
    messageId: sourceMessage.id,
  });
}

test('same-thread follow-ups serialize into durable next-turn runs', async (context) => {
  const store = await fixture(context);
  const sourceThread = thread();
  const firstMessage = message(sourceThread, 'message-1', 'Investigate the alert.');
  const secondMessage = message(
    sourceThread,
    'message-2',
    'Also compare the last deploy.',
    'user-2',
  );
  const firstInbound = await inbound(store, sourceThread, firstMessage);
  const secondInbound = await inbound(store, sourceThread, secondMessage);

  const first = await store.createAgentRunOrSteer({
    runId: 'run-1',
    thread: sourceThread,
    message: firstMessage,
    inboundEventId: firstInbound.record.id,
    executorId: 'codex',
  });
  const second = await store.createAgentRunOrSteer({
    runId: 'run-2',
    thread: sourceThread,
    message: secondMessage,
    inboundEventId: secondInbound.record.id,
    executorId: 'codex',
  });

  assert.equal(first.disposition, 'created');
  assert.equal(second.disposition, 'steered');
  assert.equal(second.run.id, first.run.id);
  assert.equal(second.steering.status, 'pending');
  assert.equal((await store.listAgentRuns()).length, 1);
  assert.equal((await store.claimQueuedAgentRuns({ limit: 5 })).length, 1);

  await store.markAgentRunCompleted(first.run.id, 'Initial investigation done.');
  const staged = (await store.listAgentRunSteering({ runId: first.run.id }))[0];
  assert.equal(staged.status, 'scheduled');
  assert.equal(staged.mode, 'next_turn');
  assert.ok(staged.continuationRunId);
  assert.equal(
    (await store.listInboundEvents()).find(
      (item) => item.id === secondInbound.record.id,
    ).status,
    'received',
  );

  const continuation = (
    await store.claimQueuedAgentRuns({ limit: 5, workerId: 'worker-2' })
  )[0];
  assert.equal(continuation.id, staged.continuationRunId);
  assert.equal(continuation.message.text, secondMessage.text);
  assert.equal(continuation.metadata.continuationOfRunId, first.run.id);
  await store.markAgentRunCompleted(continuation.id, 'Deploy compared.');

  const applied = (await store.listAgentRunSteering({ runId: first.run.id }))[0];
  assert.equal(applied.status, 'applied');
  assert.equal(applied.mode, 'next_turn');
  assert.equal(
    (await store.listInboundEvents()).find(
      (item) => item.id === secondInbound.record.id,
    ).status,
    'processed',
  );
  assert.equal((await store.summarize('acme')).steering.applied, 1);
});

test('a live-capable executor can claim and acknowledge steering in-place', async (context) => {
  const store = await fixture(context);
  const sourceThread = thread('live');
  const firstMessage = message(sourceThread, 'live-1', 'Start analysis.');
  const steerMessage = message(
    sourceThread,
    'live-2',
    'Focus on database latency.',
    'user-2',
  );
  const steerInbound = await inbound(store, sourceThread, steerMessage);
  const first = await store.createAgentRunOrSteer({
    runId: 'live-run',
    thread: sourceThread,
    message: firstMessage,
  });
  await store.claimQueuedAgentRuns({ workerId: 'worker-live' });
  const steered = await store.createAgentRunOrSteer({
    runId: 'unused-run',
    thread: sourceThread,
    message: steerMessage,
    inboundEventId: steerInbound.record.id,
  });

  await store.setAgentRunSteeringMode(first.run.id, 'live');
  const claimed = await store.claimNextAgentRunSteering(first.run.id, {
    workerId: 'worker-live',
  });
  assert.equal(claimed.id, steered.steering.id);
  assert.equal(claimed.status, 'claimed');
  await store.markAgentRunSteeringApplied(claimed.id, 'Prompt updated');
  await store.markAgentRunCompleted(first.run.id, 'Latency identified.');

  assert.equal((await store.listAgentRuns()).length, 1);
  const applied = (await store.listAgentRunSteering())[0];
  assert.equal(applied.status, 'applied');
  assert.equal(applied.mode, 'live');
  assert.equal(
    (await store.listInboundEvents()).find(
      (item) => item.id === steerInbound.record.id,
    ).status,
    'processed',
  );
  assert.ok(
    (await store.listAgentRunEvents(first.run.id)).some(
      (event) => event.type === 'steering_applied',
    ),
  );
});

test('command follow-ups cannot be claimed as live executor input', async (context) => {
  const store = await fixture(context);
  const sourceThread = thread('command');
  const first = await store.createAgentRunOrSteer({
    runId: 'command-run',
    thread: sourceThread,
    message: message(sourceThread, 'command-1', 'Long task'),
  });
  await store.claimQueuedAgentRuns({ workerId: 'worker-command' });
  await store.createAgentRunOrSteer({
    runId: 'command-follow-up',
    thread: sourceThread,
    message: message(sourceThread, 'command-2', '/memory show project'),
    allowLiveSteering: false,
  });

  assert.equal(
    await store.claimNextAgentRunSteering(first.run.id, {
      workerId: 'worker-command',
    }),
    undefined,
  );
  await store.markAgentRunCompleted(first.run.id, 'Done');
  assert.equal((await store.listAgentRunSteering())[0].status, 'scheduled');
});

test('cancel requests win finalization without reordering later follow-ups', async (context) => {
  const store = await fixture(context);
  const sourceThread = thread('cancel-race');
  const initial = await store.createAgentRunOrSteer({
    runId: 'cancel-race-run',
    thread: sourceThread,
    message: message(sourceThread, 'cancel-race-1', 'Start long work.'),
  });
  await store.claimQueuedAgentRuns({ workerId: 'worker-cancel' });
  const firstFollowUp = await store.createAgentRunOrSteer({
    runId: 'cancel-race-follow-up-1',
    thread: sourceThread,
    message: message(sourceThread, 'cancel-race-2', 'First follow-up.'),
  });
  await store.requestAgentRunCancel(initial.run.id, 'operator_cancelled');
  const secondFollowUp = await store.createAgentRunOrSteer({
    runId: 'cancel-race-follow-up-2',
    thread: sourceThread,
    message: message(sourceThread, 'cancel-race-3', 'Second follow-up.'),
  });

  assert.equal(secondFollowUp.disposition, 'steered');
  assert.equal(secondFollowUp.run.id, initial.run.id);
  const finalized = await store.markAgentRunCompleted(
    initial.run.id,
    'Late executor result',
  );
  assert.equal(finalized.status, 'cancelled');

  const steering = await store.listAgentRunSteering({
    threadId: sourceThread.id,
  });
  const firstStored = steering.find(
    (item) => item.id === firstFollowUp.steering.id,
  );
  const secondStored = steering.find(
    (item) => item.id === secondFollowUp.steering.id,
  );
  assert.equal(firstStored.status, 'scheduled');
  assert.equal(secondStored.status, 'pending');
  assert.equal(
    (await store.listAgentRuns({ status: 'queued', threadId: sourceThread.id }))
      .length,
    1,
  );
});
