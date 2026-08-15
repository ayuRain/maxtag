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
        contextSummary: `Summary batch ${calls.length}`,
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

test('group context consolidation stages at 200 new entries, not on every message', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-wrapup-threshold-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const deliveryStore = new FileDeliveryStore(path.join(root, 'delivery'));
  const sourceThread = thread();
  const base = Date.now() - 60_000;
  const messages = Array.from({ length: 199 }, (_, index) => ({
    id: `recent-${index + 1}`,
    threadId: sourceThread.id,
    platform: 'lark',
    text: `Recent message ${index + 1}`,
    actor: { id: 'member', displayName: 'Member' },
    createdAt: new Date(base + index).toISOString(),
    mentionsAgent: false,
  }));
  await deliveryStore.upsertSourceThreadMessages({
    thread: sourceThread,
    messages,
    origin: 'event',
  });
  const service = new MemoryWrapupService({
    deliveryStore,
    analysisService: analysisStub(deliveryStore, []),
    workerId: 'memory-worker',
    minEntries: 200,
    maxAgeMs: 24 * 60 * 60_000,
    debounceMs: 0,
  });

  assert.equal(await service.observeThread(sourceThread, messages.at(-1).id), undefined);
  await deliveryStore.upsertSourceThreadMessages({
    thread: sourceThread,
    messages: [{
      ...messages.at(-1),
      id: 'recent-200',
      text: 'Recent message 200',
      createdAt: new Date(base + 200).toISOString(),
    }],
    origin: 'event',
  });
  const staged = await service.observeThread(sourceThread, 'recent-200');
  assert.equal(staged?.status, 'pending');
  assert.equal(
    (await deliveryStore.listMemoryWrapups({ threadId: sourceThread.id }))
      .filter((job) => job.status === 'pending').length,
    1,
  );
});

test('successful consolidation replaces covered raw context and purges it after grace', async (context) => {
  const { deliveryStore, sourceThread, run } = await fixture(context);
  const calls = [];
  const service = new MemoryWrapupService({
    deliveryStore,
    analysisService: analysisStub(deliveryStore, calls),
    workerId: 'memory-worker',
    minEntries: 2,
    debounceMs: 0,
    rawGraceMs: 60_000,
  });

  await service.enqueueRun(run);
  const pass = await service.runPass();
  assert.equal(pass.completed, 1);
  const summaries = await deliveryStore.listThreadContextSummaries({
    thread: sourceThread,
  });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].entryCount, 2);
  assert.equal(summaries[0].contentHash.length, 64);
  assert.equal(summaries[0].rawPurgedAt, undefined);

  const visible = await deliveryStore.loadThreadTranscript({
    thread: sourceThread,
    maxEntries: 20,
    maxChars: 40_000,
  });
  assert.ok(visible.entries.some((entry) => entry.source === 'context_summary'));
  assert.ok(!visible.entries.some((entry) => entry.text === 'Decision 1'));
  assert.equal((await deliveryStore.listSourceThreadMessages({ thread: sourceThread })).length, 5);

  const purged = await deliveryStore.purgeThreadContextRaw({
    now: new Date(Date.now() + 120_000),
  });
  assert.equal(purged.summaries, 1);
  assert.equal(purged.sourceMessages, 2);
  assert.equal((await deliveryStore.listSourceThreadMessages({ thread: sourceThread })).length, 3);
  assert.ok(
    (await deliveryStore.listThreadContextSummaries({ thread: sourceThread }))[0]
      .rawPurgedAt,
  );
});

test('consolidation auto-approves only non-destructive Project additions', async (context) => {
  const { deliveryStore, sourceThread, run } = await fixture(context);
  const approved = [];
  const notified = [];
  const base = analysisStub(deliveryStore, []);
  const analysisService = {
    ...base,
    async analyze(input) {
      const report = await base.analyze(input);
      return {
        ...report,
        proposed: [
          { id: 'project-add', status: 'pending', action: 'remember', scope: 'project' },
          { id: 'company-add', status: 'pending', action: 'remember', scope: 'workspace' },
          { id: 'project-replace', status: 'pending', action: 'replace', scope: 'project' },
        ],
      };
    },
  };
  const service = new MemoryWrapupService({
    deliveryStore,
    analysisService,
    workerId: 'memory-worker',
    minEntries: 2,
    debounceMs: 0,
    autoApprove: async ({ proposal }) => {
      approved.push(proposal.id);
      return { ...proposal, status: 'approved' };
    },
    onProposals: async ({ proposals }) => {
      notified.push(...proposals.map((proposal) => proposal.id));
    },
  });

  await service.enqueueRun(run);
  await service.runPass();
  assert.deepEqual(approved, ['project-add']);
  assert.deepEqual(notified, ['company-add', 'project-replace']);
  const completed = (await deliveryStore.listMemoryWrapups({
    threadId: sourceThread.id,
  })).find((job) => job.status === 'completed');
  assert.deepEqual(completed.autoApprovedProposalIds, ['project-add']);
});
