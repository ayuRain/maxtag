import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FileDeliveryStore } from '@opentag/delivery';
import { MemoryWrapupService } from '@opentag/runtime-host';

function thread() {
  return {
    id: 'lark:oc_wrapup:root',
    platform: 'lark',
    externalId: 'oc_wrapup:root',
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    channelId: 'oc_wrapup',
    rootMessageId: 'om_root',
    visibility: 'private',
  };
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-wrapup-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const deliveryStore = new FileDeliveryStore(path.join(root, 'delivery'));
  const sourceThread = thread();
  const messages = Array.from({ length: 5 }, (_, index) => ({
    id: `message-${index + 1}`,
    threadId: sourceThread.id,
    platform: 'lark',
    text: `Decision ${index + 1}`,
    actor: { id: 'owner', displayName: 'Owner' },
    createdAt: new Date(`2026-01-01T00:00:0${index}.000Z`).toISOString(),
    mentionsAgent: true,
  }));
  await deliveryStore.upsertSourceThreadMessages({
    thread: sourceThread,
    messages,
    origin: 'history',
  });
  const run = await deliveryStore.createAgentRun({
    runId: 'run-wrapup-source',
    thread: sourceThread,
    message: messages.at(-1),
  });
  await deliveryStore.markAgentRunCompleted(run.id, 'All decisions confirmed.');
  return { deliveryStore, sourceThread, run };
}

function analysisStub(deliveryStore, calls, failures = { remaining: 0 }) {
  return {
    status() {
      return {
        enabled: true,
        maxEntries: 2,
        maxChars: 40_000,
        minConfidence: 0.65,
      };
    },
    async analyze(input) {
      assert.equal(input.purpose, 'memory_wrapup');
      assert.match(input.usageRecordKey, /^memory_wrapup:.+:attempt:\d+$/u);
      if (failures.remaining > 0) {
        failures.remaining -= 1;
        throw new Error('temporary_memory_runner_failure');
      }
      const transcript = await deliveryStore.loadThreadTranscript({
        thread: input.thread,
        afterCursor: input.afterCursor,
        order: input.transcriptOrder,
        maxEntries: 2,
        maxChars: 40_000,
      });
      calls.push(transcript.entries.map((entry) => entry.text));
      return {
        id: `analysis-${calls.length}`,
        status: 'completed',
        sourceRunId: input.runId,
        thread: input.thread,
        executor: { id: 'codex', label: 'Codex' },
        transcript: {
          entries: transcript.entries.length,
          totalEntries: transcript.totalEntries,
          omittedEntries: transcript.omittedEntries,
          truncated: transcript.truncated,
          nextCursor: transcript.nextCursor,
        },
        decisions: [],
        proposed: [],
        skipped: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    },
  };
}

test('automatic wrapup drains a long thread in ordered cursor batches', async (context) => {
  const { deliveryStore, run } = await fixture(context);
  const calls = [];
  const service = new MemoryWrapupService({
    deliveryStore,
    analysisService: analysisStub(deliveryStore, calls),
    workerId: 'memory-worker',
    debounceMs: 0,
    retryBaseMs: 1,
  });

  await service.enqueueRun(run);
  const first = await service.runPass();
  const second = await service.runPass();
  const third = await service.runPass();

  assert.deepEqual(calls, [
    ['Decision 1', 'Decision 2'],
    ['Decision 3', 'Decision 4'],
    ['Decision 5', 'All decisions confirmed.'],
  ]);
  assert.equal(first.completed, 1);
  assert.equal(second.completed, 1);
  assert.equal(third.completed, 1);
  const jobs = await deliveryStore.listMemoryWrapups({ threadId: run.threadId });
  assert.equal(jobs.filter((job) => job.status === 'completed').length, 3);
  assert.equal(jobs.filter((job) => job.status === 'pending').length, 0);
  assert.equal(jobs.at(0).transcriptOmittedEntries, 0);
});

test('failed wrapup retries without advancing the durable cursor', async (context) => {
  const { deliveryStore, run } = await fixture(context);
  const calls = [];
  const failures = { remaining: 1 };
  const service = new MemoryWrapupService({
    deliveryStore,
    analysisService: analysisStub(deliveryStore, calls, failures),
    workerId: 'memory-worker',
    debounceMs: 0,
    retryBaseMs: 1,
    maxAttempts: 3,
  });

  await service.enqueueRun(run);
  const failed = await service.runPass();
  assert.equal(failed.retried, 1);
  let jobs = await deliveryStore.listMemoryWrapups({ threadId: run.threadId });
  assert.equal(jobs[0].status, 'pending');
  assert.equal(jobs[0].cursor, undefined);

  await delay(5);
  const recovered = await service.runPass();
  assert.equal(recovered.completed, 1);
  assert.deepEqual(calls[0], ['Decision 1', 'Decision 2']);
  jobs = await deliveryStore.listMemoryWrapups({ threadId: run.threadId });
  assert.ok(jobs.find((job) => job.status === 'completed')?.cursor);
  const events = await deliveryStore.listAgentRunEvents(run.id);
  assert.ok(events.some((event) => event.type === 'memory_wrapup_retry'));
  assert.ok(events.some((event) => event.type === 'memory_wrapup_completed'));
});

test('stale wrapup claims recover to another worker', async (context) => {
  const { deliveryStore, sourceThread, run } = await fixture(context);
  const start = new Date('2026-01-02T00:00:00.000Z');
  await deliveryStore.enqueueMemoryWrapup({
    thread: sourceThread,
    sourceRunId: run.id,
    debounceMs: 0,
    now: start,
  });
  const first = await deliveryStore.claimMemoryWrapups({
    workerId: 'worker-a',
    staleMs: 1_000,
    now: start,
  });
  const recovered = await deliveryStore.claimMemoryWrapups({
    workerId: 'worker-b',
    staleMs: 1_000,
    now: new Date(start.getTime() + 2_000),
  });
  assert.equal(first.length, 1);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, first[0].id);
  assert.equal(recovered[0].claimedBy, 'worker-b');
  assert.equal(recovered[0].attempts, 2);
});
